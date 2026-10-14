// Browser-facing flows over HTTP: quick-start test credits, origin labelling, sandbox seller, testnet escrow helper.
// LOCAL INTEGRATION with fakes; the sandbox network is in-process. Nothing touches a chain or the internet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCatalog } from '../src/catalog.ts';
import { openDb } from '../src/db.ts';
import { createDemoNetwork, createSandboxNetwork, seedDemo } from '../src/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import type { EscrowClient, OnChainHold } from '../src/escrow.ts';
import { holdIdFor } from '../src/escrow.ts';
import { verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/websim.ts';

const mk = generateMasterKey('k1');
const WALLET = '0x00000000000000000000000000000000000dEaD3';
const buyCat = normalizeCatalog(
  { payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, tokens: [] }, capabilities: [{ id: 'buy.search', title: 'Buy search', method: 'POST', url: 'https://gateway.usebuy.ai/v1/social/x/posts/search', available: true, platform: 'x', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } }] },
  Date.now(),
);

function fakeEscrow() {
  const holds = new Map<string, OnChainHold>();
  let bal = 0n;
  const client: EscrowClient = {
    holdTimeoutSeconds: 86_400,
    available: async () => bal,
    hold: async (id) => holds.get(id) ?? { state: 'None', buyer: '', seller: '', amount: 0n, createdAt: 0 },
    async placeHold(id, buyer, seller, amount) {
      bal -= amount;
      holds.set(id, { state: 'Held', buyer, seller, amount, createdAt: 0 });
      return '0xhold';
    },
    async capture(id) { holds.get(id)!.state = 'Captured'; return '0xcapture'; },
    async release(id) { const h = holds.get(id)!; h.state = 'Released'; bal += h.amount; return '0xrelease'; },
    async expire() { return '0xexpire'; },
  };
  return { client, deposit: async (a: bigint) => { bal += a; return '0xdeposit'; }, holds };
}

async function start(o: { sandbox?: boolean; escrow?: boolean; live?: boolean } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mk);
  const sb = createSandboxNetwork(db);
  const demo = createDemoNetwork();
  const esc = fakeEscrow();
  const market: MarketRuntime = {
    db,
    keys: [mk],
    activeKey: mk,
    sandbox: o.sandbox ?? true,
    buySimulated: true,
    buyCatalog: async () => buyCat,
    execute: {
      call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
      demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 500 } },
    },
    testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
    domain: { txt: sb.txt, fetchOptions: { resolver: sb.resolver, transport: sb.transport } },
    ...(o.escrow ? { escrow: { client: esc.client, asset: 'TESTUSDT', testnet: { chainId: 11142220, escrow: '0xE5C0', token: '0x70CE', wallet: WALLET, explorer: 'https://explorer.test', deposit: esc.deposit } } } : {}),
    ...(o.live ? { live: { funding: { chainId: 42220, token: '0x1', asset: 'USDT', depositAddress: WALLET, minConfirmations: 1, maxDepositAtomic: 1n, reader: { blockNumber: async () => 1n, receipt: async () => null } }, payout: { payableAssets: ['USDT'], minAtomic: 1n, maxAtomic: 1n } } } : {}),
  };
  const rt = createSimulatedRuntime({ scenario: 'ok', delayMs: 5 });
  const { server, token } = createWebServer(rt, { token: 'sb-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string, body?: unknown) => {
    const r = await fetch(`${base}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, base, call, esc, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('quick start: a buyer with 5 test credits needs no wallet; the catalog labels every origin', async () => {
  const h = await start();
  try {
    const b = await h.call('POST', '/buyer');
    const token = b.body.token as string;
    assert.equal((await h.call('POST', '/credits', token, { amount: '5' })).status, 200);
    assert.equal((await h.call('GET', '/me', token)).body.available, '5');

    const cfg = await h.call('GET', '/config');
    assert.equal(cfg.body.mode, 'test-credits');
    assert.equal(cfg.body.sandbox, true);
    assert.equal(cfg.body.escrow, null);
    assert.ok(Object.keys(cfg.body.legend).length === 5);

    const items = (await h.call('GET', '/catalog')).body.items as any[];
    const origins = items.map((i) => `${i.origin}:${i.title}`).sort();
    assert.deepEqual(origins, ['buy-gateway-simulated:Buy search', 'payrail-demo:Demo text echo', 'payrail-demo:Demo token price (fresh within 60s)']);
    assert.ok(items.every((i) => typeof i.originLabel === 'string' && i.originLabel.length > 10));
    assert.equal(items.find((i) => i.source === 'buy').payOnlyForQualifying, false);
  } finally {
    await h.close();
  }
});

test('sandbox seller walks the whole dashboard flow with no wallet, and a buyer then pays them', async () => {
  const h = await start();
  try {
    const login = await h.call('POST', '/seller/sandbox/login', undefined, {});
    assert.equal(login.status, 200, login.text);
    const st = login.body.token as string;
    const seed = login.body.seed as string;
    // the same seed returns the same seller
    const again = await h.call('POST', '/seller/sandbox/login', undefined, { seed });
    assert.equal(again.body.accountId, login.body.accountId);

    const created = await h.call('POST', '/seller/listings', st, { name: 'My sandbox price API', description: 'x', endpointUrl: 'https://my-abc123.sandbox.payrail.example/v1/price', method: 'GET', price: '0.01' });
    assert.equal(created.status, 201, created.text);
    const l = created.body.listing;
    assert.equal(l.sandbox, true);

    // not verified yet -> test is refused and nothing was sent
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/test`, st, { input: { id: 'eth' } })).body.report.failure.code, 'LISTING_NOT_VERIFIED');
    // the wrong seed cannot sign for this account
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, st, { sandbox: true, seed: 'x'.repeat(20) })).status, 403);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, st, { sandbox: true, seed })).status, 200);
    // domain proof through the sandbox DNS and through the sandbox well-known file
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/domain-proof`, st, { method: 'well_known' })).body.listing.status, 'verified');

    const t = await h.call('POST', `/seller/listing/${l.id}/test`, st, { input: { id: 'eth' } });
    assert.equal(t.body.report.httpStatus, 200, t.text);
    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, st, { input: { id: 'eth' } });
    assert.equal(sug.status, 200, sug.text);
    const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, st, { contract: sug.body.suggestion });
    assert.equal(prop.status, 201, prop.text);
    assert.equal((await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, st)).status, 200);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, st)).body.listing.status, 'published');

    // appears in the catalog as a sandbox seller API
    const items = (await h.call('GET', '/catalog')).body.items as any[];
    assert.equal(items.find((i) => i.id === l.id).origin, 'payrail-sandbox');

    // a buyer uses it
    const bt = (await h.call('POST', '/buyer')).body.token as string;
    await h.call('POST', '/credits', bt, { amount: '1' });
    const run = await h.call('POST', '/execute', bt, { listingId: l.id, input: { id: 'eth' }, idempotencyKey: 'sbx-run-0001' });
    assert.equal(run.body.result.charged, true, run.text);
    const stale = await h.call('POST', '/execute', bt, { listingId: l.id, input: { id: 'eth', scenario: 'stale' }, idempotencyKey: 'sbx-run-0002' });
    assert.equal(stale.body.result.charged, false);

    const earn = await h.call('GET', '/seller/earnings', st);
    assert.equal(earn.body.earnings, '0.0097');
    assert.deepEqual(earn.body.byState.map((s: any) => s.state).sort(), ['NOT_QUALIFIED', 'QUALIFIED']);
    assert.equal(earn.body.recent.length, 2);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('sandbox hosts never let a listing reach internal addresses or other hosts through the sandbox network', async () => {
  const h = await start();
  try {
    const st = (await h.call('POST', '/seller/sandbox/login', undefined, {})).body.token as string;
    for (const url of ['https://127.0.0.1/v1/price', 'https://metadata.google.internal/', 'https://evil.sandbox.payrail.example.attacker.com/v1/price']) {
      const r = await h.call('POST', '/seller/listings', st, { name: 'Bad host', endpointUrl: url, method: 'GET', price: '0.01' });
      // either refused outright, or created but unverifiable (never served by the sandbox)
      if (r.status === 201) assert.equal(r.body.listing.sandbox, false);
      else assert.equal(r.status, 400);
    }
  } finally {
    await h.close();
  }
});

test('sandbox login is unavailable when disabled or in real-funds mode', async () => {
  const off = await start({ sandbox: false });
  const live = await start({ live: true });
  try {
    assert.equal((await off.call('POST', '/seller/sandbox/login', undefined, {})).body.code, 'SANDBOX_DISABLED');
    assert.equal((await live.call('POST', '/seller/sandbox/login', undefined, {})).body.code, 'SANDBOX_DISABLED');
    assert.equal((await live.call('GET', '/config')).body.sandbox, false);
    assert.equal((await live.call('GET', '/config')).body.mode, 'real-funds');
  } finally {
    await off.close();
    await live.close();
  }
});

test('testnet escrow helper: deposit funds the buyer, a request settles through escrow, and it is closed when not configured', async () => {
  const closed = await start();
  const h = await start({ escrow: true });
  try {
    const bt0 = (await closed.call('POST', '/buyer')).body.token as string;
    assert.equal((await closed.call('GET', '/escrow', bt0)).body.enabled, false);
    assert.equal((await closed.call('POST', '/escrow/testnet-deposit', bt0, { amount: '0.1' })).body.code, 'ESCROW_DISABLED');

    const bt = (await h.call('POST', '/buyer')).body.token as string;
    assert.equal((await h.call('GET', '/config')).body.escrow.network, 'Celo Sepolia TESTNET');
    // the demo seller needs a payee wallet on the testnet path
    h.db.prepare("UPDATE accounts SET wallet_address = '0x00000000000000000000000000000000000000e1' WHERE id = 'seller_demo'").run();
    const dep = await h.call('POST', '/escrow/testnet-deposit', bt, { amount: '0.1' });
    assert.equal(dep.status, 201, dep.text);
    assert.equal((await h.call('POST', '/escrow/testnet-deposit', bt, { amount: '5' })).status, 400, 'limited to 1 test token');
    assert.equal((await h.call('GET', '/escrow', bt)).body.available, '0.1');

    const items = (await h.call('GET', '/catalog')).body.items as any[];
    const price = items.find((i) => i.title.startsWith('Demo token price'));
    const run = await h.call('POST', '/execute', bt, { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'esc-ui-0001', settlement: 'escrow' });
    assert.equal(run.status, 201, run.text);
    assert.equal(run.body.settlement, 'escrow');
    assert.equal(run.body.result.charged, true);
    assert.equal(h.esc.holds.get(holdIdFor(run.body.result.executionId))!.state, 'Captured');
    // the receipt for an escrow-settled request points at the on-chain hold, not at ledger entries
    const rc = (await h.call('GET', `/receipt/${run.body.result.executionId}`, bt)).body.receipt;
    assert.equal(rc.settlement, 'escrow');
    assert.equal(rc.escrow.holdId, holdIdFor(run.body.result.executionId));
    assert.deepEqual([rc.escrow.txs.hold, rc.escrow.txs.settle], ['0xhold', '0xcapture']);
    assert.deepEqual(rc.ledger, []);
    // and it is reported in its own bucket of the buyer statement
    const sm = (await h.call('GET', '/me/statement', bt)).body.statement;
    assert.ok(sm.buckets.some((b: any) => b.settlement === 'escrow' && b.qualified === 1));
    assert.equal((await h.call('GET', '/escrow', bt)).body.available, '0.08');

    // a second buyer cannot reuse the same testnet wallet
    const bt2 = (await h.call('POST', '/buyer')).body.token as string;
    assert.equal((await h.call('POST', '/escrow/testnet-deposit', bt2, { amount: '0.1' })).body.code, 'WALLET_TAKEN');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await closed.close();
    await h.close();
  }
});
