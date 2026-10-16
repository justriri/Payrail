// STRUCTURAL GUARANTEE: the production entry point (scripts/serve.ts) never loads development-only code.
// It follows every runtime import (type-only imports are erased and do not count) and fails if the graph reaches a simulator,
// the demo/sandbox network, the testnet escrow helper or anything under a dev/ folder.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** runtime (non type-only) relative imports of one file */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type`
    const spec = m[4] ?? m[5] ?? m[6];
    if (!spec) continue;
    // `import { type A, type B } from` is erased only when EVERY specifier is type-only; be conservative and count it
    out.push(normalize(join(dirname(file), spec)));
  }
  return out;
}

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    for (const i of runtimeImports(f)) stack.push(i);
  }
  return [...seen].map((f) => relative(ROOT, f).split(sep).join('/')).sort();
}

test('the production server never loads simulators, the demo network, the testnet escrow helper or any dev/ code', () => {
  const graph = reachable(join(ROOT, 'scripts', 'serve.ts'));
  assert.ok(graph.length > 20 && graph.includes('src/market.ts') && graph.includes('src/funding.ts'), `the walk found the real graph (${graph.length} files)`);
  const offenders = graph.filter((f) => /(^|\/)dev\//.test(f) || /(demoapis|simconversion|simfunding|websim|escrowtestnet)\.ts$/.test(f));
  assert.deepEqual(offenders, [], `production must not load: ${offenders.join(', ')}`);
});

test('the dev-only modules do exist, so the guarantee above is not vacuous', () => {
  for (const f of ['src/dev/demoapis.ts', 'src/dev/simconversion.ts', 'src/dev/simfunding.ts', 'src/dev/websim.ts', 'src/dev/escrowtestnet.ts', 'src/dev/scenarios.ts']) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
  // and the test harness DOES reach them (proving the walker can see such imports)
  const viaTests = reachable(join(ROOT, 'test', 'production.test.ts'));
  assert.ok(viaTests.some((f) => f.startsWith('src/dev/')), 'the walker sees dev imports when they exist');
});

test('the production server refuses the removed simulation flags and offers no simulation npm script', () => {
  const serve = readFileSync(join(ROOT, 'scripts', 'serve.ts'), 'utf8');
  for (const flag of ['--simulate', '--no-demo', '--escrow-testnet', '--scenario']) assert.ok(serve.includes(`'${flag}'`), `${flag} is explicitly refused`);
  assert.ok(!/seedDemo|createSandboxNetwork|createSimProvider|createSimulatedRuntime|createTestnetEscrow|TESTUSDT/.test(serve), 'serve.ts references no demo, simulation or test-credit builder');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(!Object.keys(pkg.scripts).some((k) => /sim|demo/i.test(k)), `no simulation script: ${Object.keys(pkg.scripts).join(', ')}`);
});
