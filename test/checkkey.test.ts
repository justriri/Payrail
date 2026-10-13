// The key-file checker must show the PUBLIC address and never the key. Uses a throwaway key generated here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempDir } from './support.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/check-key-file.ts', import.meta.url));

function run(envLines: string[], extra: string[] = []) {
  const f = join(tempDir(), 'throwaway.env');
  writeFileSync(f, envLines.join('\n') + '\n');
  const env = { ...process.env };
  delete env.PAYRAIL_PRIVATE_KEY;
  delete env.PAYRAIL_WALLET_ADDRESS;
  return spawnSync(process.execPath, [`--env-file=${f}`, SCRIPT, ...extra], { encoding: 'utf8', env });
}

test('check-key-file: prints the derived address, passes on a match, and NEVER prints the key', () => {
  const key = generatePrivateKey();
  const addr = privateKeyToAccount(key).address;
  const r = run([`PAYRAIL_PRIVATE_KEY=${key}`], ['--expect', addr]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(addr));
  assert.match(r.stdout, /\[PASS\]/);
  assert.ok(!r.stdout.includes(key.slice(2)) && !r.stderr.includes(key.slice(2)), 'the key must not appear in any output');
});

test('check-key-file: a different expected wallet is a MISMATCH (exit 2); a missing or malformed key fails (exit 1)', () => {
  const key = generatePrivateKey();
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const mismatch = run([`PAYRAIL_PRIVATE_KEY=${key}`], ['--expect', other]);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stdout, /MISMATCH/);
  assert.ok(!mismatch.stdout.includes(key.slice(2)));

  assert.equal(run(['SOMETHING_ELSE=1']).status, 1);
  const bad = run(['PAYRAIL_PRIVATE_KEY=0xnot-a-key']);
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes('not-a-key'), 'a malformed value is not echoed back');
});
