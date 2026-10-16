// DEVELOPMENT ENVIRONMENT ONLY. Builds the marketplace the developer browses and tests: demo APIs, a sandbox seller network, test
// credits, simulated Buy gateway. It uses its OWN database inside data/dev/ (guarded by envguard.ts) and its own vault key file, never
// the production database, never PAYRAIL_* production settings, and moves no real money.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../db.ts';
import { RateLimiter } from '../egress.ts';
import { assertDevelopmentDatabase, stampEnvironment } from '../envguard.ts';
import type { MarketRuntime } from '../market.ts';
import { generateMasterKey, masterKeyFrom } from '../vault.ts';
import type { WebRuntime } from '../webapi.ts';
import { createDemoNetwork, createSandboxNetwork, seedDemo } from './demoapis.ts';
import { DEV_SCENARIOS } from './scenarios.ts';
import { createSimulatedRuntime } from './websim.ts';

export const DEV_DEFAULT_DB = 'data/dev/marketplace-dev.db';

export function createDevMarket(o: { dbPath?: string; devRoot?: string; keyFile?: string; log?: (l: string) => void } = {}): { market: MarketRuntime; runtime: WebRuntime; dbPath: string } {
  const dbPath = o.dbPath ?? DEV_DEFAULT_DB;
  assertDevelopmentDatabase(dbPath, o.devRoot); // throws before anything is opened or written if this is not a development database
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  stampEnvironment(db, 'development');
  // a development-only vault key kept next to the development database (never a production key)
  const keyFile = o.keyFile ?? (dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'dev-vault.key'));
  let key;
  if (keyFile && existsSync(keyFile)) key = masterKeyFrom('dev1', readFileSync(keyFile, 'utf8').trim());
  else {
    const g = generateMasterKey('dev1');
    if (keyFile) writeFileSync(keyFile, `${g.key.toString('hex')}\n`, { mode: 0o600 });
    key = g;
  }
  seedDemo(db, key);
  const sandbox = createSandboxNetwork(db);
  const demo = createDemoNetwork();
  const limiter = () => new RateLimiter(60, 10);
  const runtime = createSimulatedRuntime({ scenario: 'ok' });
  const market: MarketRuntime = {
    db,
    keys: [key],
    activeKey: key,
    sandbox: true,
    dev: DEV_SCENARIOS,
    execute: {
      call: { limiter: limiter(), fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport, timeoutMs: 8_000 } },
      demoCall: { limiter: limiter(), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 3_000 } },
    },
    testCall: { limiter: limiter(), fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport, timeoutMs: 8_000 } },
    domain: { txt: sandbox.txt, fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport } },
    buyCatalog: () => runtime.catalog(),
    buySimulated: true,
  };
  o.log?.(`DEVELOPMENT marketplace: test credits, demo and sandbox APIs, simulated Buy gateway. Database: ${dbPath}.`);
  return { market, runtime, dbPath };
}
