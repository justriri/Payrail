// TWO SEPARATE ENVIRONMENTS, tested side by side.
//   development : scripts/dev-serve.ts   test credits, demo and sandbox APIs, no real funds, its own database in data/dev/
//   production  : scripts/serve.ts       real USDT only, refuses everything above, never opens a development database
// Everything here runs in-process against temporary files; no server is started on a fixed port and nothing touches data/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createDevMarket } from '../src/dev/devmarket.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { openDb } from '../src/db.ts';
import { EnvironmentError, assertDevelopmentDatabase, assertProductionDatabase, probeDatabase, stampEnvironment } from '../src/envguard.ts';
import { SetupError, setupMarket } from '../src/marketsetup.ts';
import type { SetupDeps } from '../src/marketsetup.ts';
import { createWebServer } from '../src/webapi.ts';
import type { MarketRuntime } from '../src/market.ts';

const root = mkdtempSync(join(tmpdir(), 'payrail-env-'));
const devRoot = join(root, 'data', 'dev');
mkdirSync(devRoot, { recursive: true });
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
let n = 0;

async function serve(environment: 'production' | 'development' | undefined, market: MarketRuntime | undefined) {
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'env-test', ...(market ? { market } : {}), ...(environment ? { environment } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => {
    const r = await fetch(base + path);
    const t = await r.text();
    let body: any;
    try { body = JSON.parse(t); } catch { body = t; }
    return { status: r.status, body };
  };
  const call = async (method: 'GET' | 'POST', path: string, o: { body?: unknown; bearer?: string } = {}) => {
    const r = await fetch(base + '/api/market' + path, {
      method,
      headers: { ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(o.body ?? {}) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { get, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const devMarket = () => createDevMarket({ dbPath: join(devRoot, `m${++n}.db`), devRoot, keyFile: join(devRoot, `k${n}.key`) });
const prodDeps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1' },
  dbPath: join(root, `prod${++n}.db`),
  configuredChainId: 42220,
  attributionTag: 'celo_b2fff2ac9413',
  readChainId: async () => 42220,
  makeReader: () => ({ blockNumber: async () => 5_000n, receipt: async () => null }),
  readAllowance: async () => 0n,
  buyCatalog: undefined as unknown as SetupDeps['buyCatalog'],
  log: () => undefined,
  ...over,
});

// ------------------------------------------------------------------ DEVELOPMENT works without real funds
test('DEVELOPMENT: the marketplace, dashboard and API usage work with test credits and no real funds', async () => {
  const dev = devMarket();
  const s = await serve('development', dev.market);
  try {
    assert.deepEqual((await s.get('/api/environment')).body, { ok: true, environment: 'development', marketplace: true });
    const cfg = (await s.call('GET', '/config')).body;
    assert.equal(cfg.environment, 'development');
    assert.equal(cfg.realFunds, false);
    assert.equal(cfg.currency, 'TESTUSDT');
    assert.equal(cfg.network, undefined, 'a development server claims no blockchain network');
    // browse and inspect
    const cat = (await s.call('GET', '/catalog')).body;
    assert.equal(cat.mode, 'test-credits');
    const demo = (cat.items as any[]).filter((i) => i.source === 'payrail' && i.demo);
    assert.ok(demo.length >= 2, 'the demo listings are browsable in development');
    const detail = await s.call('GET', `/listing/${demo[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.quote.available, true);
    // a development session: anonymous test buyer + test credits
    const b = (await s.call('POST', '/buyer')).body;
    assert.ok(b.token);
    assert.equal((await s.call('POST', '/credits', { bearer: b.token, body: { amount: '5' } })).status, 200);
    const me = (await s.call('GET', '/me', { bearer: b.token })).body;
    assert.equal(me.mode, 'test-credits');
    assert.equal(me.asset, 'TESTUSDT');
    assert.equal(me.available, '5');
    // use an API: charged in TEST credits, with the 3% fee accounting
    const run = (await s.call('POST', '/execute', { bearer: b.token, body: { listingId: demo[0].id, input: { id: 'eth' }, idempotencyKey: 'dev-run-0001' } })).body;
    assert.equal(run.result.charged, true);
    assert.equal(run.result.asset, 'TESTUSDT');
    assert.equal((await s.call('GET', '/me', { bearer: b.token })).body.available, '4.98');
    // a sandbox seller can sign in
    assert.ok((await s.call('POST', '/seller/sandbox/login', { body: {} })).body.token);
    // funding is NOT presented as on-chain: there is no deposit address, wallet or confirmation route
    assert.equal((await s.call('GET', '/funding', { bearer: b.token })).body.enabled, false);
    const dep = await s.call('POST', '/funding/confirm', { bearer: b.token, body: { txHash: `0x${'ab'.repeat(32)}` } });
    assert.equal(dep.body.code, 'LIVE_DISABLED', 'a transaction hash can never credit anything in development');
    // the development-only scripts are served here
    assert.equal((await s.get('/dev.js')).status, 200);
    assert.equal((await s.get('/dev-api.js')).status, 200);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ PRODUCTION is real money only
test('PRODUCTION: only real-money flows exist; development scripts and test-credit routes are not available', async () => {
  const market = (await setupMarket(prodDeps()))!;
  const s = await serve(undefined, market); // the default environment is production
  try {
    assert.deepEqual((await s.get('/api/environment')).body, { ok: true, environment: 'production', marketplace: true });
    const cfg = (await s.call('GET', '/config')).body;
    assert.equal(cfg.environment, 'production');
    assert.equal(cfg.realFunds, true);
    assert.equal(cfg.currency, 'USDT');
    assert.equal(cfg.network.chainId, 42220);
    assert.equal((await s.call('POST', '/buyer')).body.code, 'NOT_AVAILABLE');
    assert.equal((await s.call('POST', '/credits', { bearer: 'x', body: { amount: '1' } })).body.code, 'NOT_AVAILABLE');
    assert.equal((await s.call('POST', '/seller/sandbox/login', { body: {} })).body.code, 'SANDBOX_DISABLED');
    assert.equal((await s.get('/dev.js')).status, 404, 'a production server has no route for the development script');
    assert.equal((await s.get('/dev-api.js')).status, 404);
    // an unconfirmed transaction hash credits nothing
    const k = privateKeyToAccount(generatePrivateKey());
    const st = (await s.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } })).body;
    const tok = (await s.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: st.nonce, signature: await k.signMessage({ message: st.message }) } })).body.token;
    const conf = await s.call('POST', '/funding/confirm', { bearer: tok, body: { txHash: `0x${'cd'.repeat(32)}` } });
    assert.ok(conf.status >= 400);
    assert.equal((await s.call('GET', '/me', { bearer: tok })).body.live.available, '0');
  } finally {
    await s.close();
  }
});

test('PRODUCTION with the marketplace switched off says so honestly (this is what a plain `npm run serve` is)', async () => {
  const s = await serve(undefined, undefined);
  try {
    assert.deepEqual((await s.get('/api/environment')).body, { ok: true, environment: 'production', marketplace: false });
    const cfg = await s.call('GET', '/config');
    assert.equal(cfg.status, 404);
    assert.equal(cfg.body.ok, false);
    assert.equal((await s.get('/dev.js')).status, 404);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ the two databases never mix
test('DATABASES: neither environment can open the other\'s database, and a refusal never modifies the file', async () => {
  // the exact production file name is refused by the development server before anything is opened
  assert.throws(() => assertDevelopmentDatabase('data/marketplace-live.db'), EnvironmentError);
  assert.throws(() => assertDevelopmentDatabase('data/marketplace.db'), EnvironmentError);
  assert.throws(() => createDevMarket({ dbPath: 'data/marketplace-live.db' }), EnvironmentError);
  assert.equal(existsSync(join(devRoot, 'marketplace-live.db')), false);
  assert.throws(() => assertDevelopmentDatabase(join(devRoot, 'marketplace-live.db'), devRoot), /looks like a production database/);

  // a production-shaped file: has a verified on-chain deposit, as the real marketplace-live.db does
  const prodPath = join(root, 'looks-real.db');
  const p = openDb(prodPath);
  p.prepare("INSERT INTO accounts (id, kind, display_name, created_at) VALUES ('buyer_x', 'buyer', 'B', 't')").run();
  p.prepare("INSERT INTO chain_deposits (ref, buyer_id, tx_hash, log_index, from_address, amount_atomic, asset, block_number, credited_at) VALUES ('r', 'buyer_x', '0xab', 1, '0x1', 500000, 'USDT', 1, 't')").run();
  p.close();
  assert.equal(probeDatabase(prodPath).onChainDeposits, 1);
  // not under data/dev, so the path check fails first; copy it INTO data/dev to prove the content check also refuses it
  const disguised = join(devRoot, 'disguised.db');
  const d = openDb(disguised);
  d.prepare("INSERT INTO accounts (id, kind, display_name, created_at) VALUES ('buyer_x', 'buyer', 'B', 't')").run();
  d.prepare("INSERT INTO chain_deposits (ref, buyer_id, tx_hash, log_index, from_address, amount_atomic, asset, block_number, credited_at) VALUES ('r', 'buyer_x', '0xab', 1, '0x1', 500000, 'USDT', 1, 't')").run();
  d.close();
  const before = sha(disguised);
  assert.throws(() => assertDevelopmentDatabase(disguised, devRoot), /verified on-chain deposits/);
  assert.throws(() => createDevMarket({ dbPath: disguised, devRoot }), /verified on-chain deposits/);
  assert.equal(sha(disguised), before, 'the refused file was not modified');

  // production accepts that legacy-shaped file (unstamped), then stamps it; afterwards development can never open it
  const prod = await setupMarket(prodDeps({ dbPath: prodPath }));
  assert.ok(prod);
  assert.equal(probeDatabase(prodPath).environment, 'production');
  const copyIntoDev = join(devRoot, 'stamped.db');
  const s2 = openDb(copyIntoDev);
  stampEnvironment(s2, 'production');
  s2.close();
  const before2 = sha(copyIntoDev);
  assert.throws(() => assertDevelopmentDatabase(copyIntoDev, devRoot), /stamped as a PRODUCTION database/);
  assert.equal(sha(copyIntoDev), before2);

  // development databases are stamped, and production refuses them (by stamp and by location)
  const dev = createDevMarket({ dbPath: join(devRoot, 'real-dev.db'), devRoot, keyFile: join(devRoot, 'real-dev.key') });
  assert.ok(dev.market);
  assert.equal(probeDatabase(join(devRoot, 'real-dev.db')).environment, 'development');
  assert.throws(() => assertProductionDatabase(join(devRoot, 'real-dev.db'), devRoot), /development location/);
  const sneaky = join(root, 'dev-stamped-elsewhere.db');
  const sd = openDb(sneaky);
  stampEnvironment(sd, 'development');
  sd.close();
  const before3 = sha(sneaky);
  await assert.rejects(() => setupMarket(prodDeps({ dbPath: sneaky })), (e: unknown) => e instanceof SetupError && /stamped as a DEVELOPMENT database/.test(e.message));
  assert.equal(sha(sneaky), before3, 'production refused a development file without touching it');

  // a database with test-credit accounts that production never used is refused too
  const tc = join(root, 'test-credits.db');
  const t = openDb(tc);
  t.prepare("INSERT INTO ledger_accounts (owner_id, kind, asset) VALUES ('platform', 'platform_fee', 'TESTUSDT')").run();
  t.close();
  await assert.rejects(() => setupMarket(prodDeps({ dbPath: tc })), /test-credit ledger accounts/);

  // a stamp can never be flipped
  const flip = openDb(join(root, 'flip.db'));
  stampEnvironment(flip, 'production');
  assert.throws(() => stampEnvironment(flip, 'development'), EnvironmentError);
  flip.close();
});

test('SEPARATION: the development entry point cannot run with production settings, and production never imports development code', () => {
  const dev = readFileSync(new URL('../scripts/dev-serve.ts', import.meta.url), 'utf8');
  assert.match(dev, /PAYRAIL_MARKET_LIVE is set/);
  assert.ok(!/marketsetup|PAYRAIL_DEPOSIT_ADDRESS|PAYRAIL_VAULT_KEY|keystore/.test(dev.replace(/\/\/.*$/gm, '')), 'dev-serve reads no production settings');
  const prod = readFileSync(new URL('../scripts/serve.ts', import.meta.url), 'utf8');
  assert.ok(!/dev-serve|devmarket|environment: 'development'/.test(prod), 'serve.ts has no path into development mode');
});

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
