// Funding routes over HTTP (simulation). The buyer sees quote -> approve -> verified credit and nothing else is spendable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/dev/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import { verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import type { FundingConfig } from '../src/marketfunding.ts';
import { createSimFunding } from '../src/dev/simfunding.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { DEV_SCENARIOS } from '../src/dev/scenarios.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const mk = generateMasterKey('k1');
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;

async function start(o: { mode?: 'simulated' | 'live'; noFunding?: boolean } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mk);
  const dn = createDemoNetwork();
  const sim = createSimFunding({ usdt: USDT, reactor: TEXTILE_REACTOR });
  const converter = o.mode === 'live' ? { ...sim.converter, mode: 'live' as const } : sim.converter;
  const funding: FundingConfig = {
    converter, reader: sim.reader, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 3,
    limits: { minSellAtomic: 100_000_000n, maxSellAtomic: 7_000_000_000n, maxPerDaySellAtomic: 14_000_000_000n, maxOpenOps: 3 }, creditAsset: 'TESTUSDT',
  };
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, sandbox: true, dev: DEV_SCENARIOS,
    execute: { demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: dn.resolver, transport: dn.transport, timeoutMs: 300 } } },
    ...(o.noFunding ? {} : { funding }),
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'fund-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string, body?: unknown) => {
    const r = await fetch(`${base}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, call, sim, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const buyer = async (h: Awaited<ReturnType<typeof start>>) => (await h.call('POST', '/buyer')).body.token as string;

test('funding over HTTP: config says SIMULATED; a quote converts nothing; approval with the digest credits the verified amount once', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    const cfg = await h.call('GET', '/fund/config', bt);
    assert.equal(cfg.body.mode, 'simulated');
    assert.match(cfg.body.banner, /SIMULATED/);
    assert.equal(cfg.body.creditAsset, 'TESTUSDT');
    assert.equal(cfg.body.limits.min, '100');

    const q = await h.call('POST', '/fund/quote', bt, { amount: '1364' });
    assert.equal(q.status, 201, q.text);
    const op = q.body.operation;
    assert.equal(op.state, 'QUOTED');
    assert.equal(op.simulated, true);
    assert.equal(op.spendable, false);
    assert.equal(op.rate, '1 USDT = 1364 cNGN');
    assert.ok(op.approvalDigest);
    assert.equal(h.sim.executions, 0);
    assert.equal((await h.call('GET', '/me', bt)).body.available, '0');

    assert.equal((await h.call('POST', '/fund/approve', bt, { opId: op.id, digest: 'wrong' })).body.code, 'DIGEST_MISMATCH');
    assert.equal(h.sim.executions, 0);
    const ok = await h.call('POST', '/fund/approve', bt, { opId: op.id, digest: op.approvalDigest });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.operation.state, 'CREDITED');
    assert.equal(ok.body.operation.spendable, true);
    const credited = ok.body.operation.credited as string;
    assert.equal((await h.call('GET', '/me', bt)).body.available, credited);
    assert.deepEqual(ok.body.events.map((e: any) => e.state), ['QUOTED', 'CONVERTING', 'VERIFYING', 'CREDITED']);

    // approving again, or checking again, changes nothing
    await h.call('POST', '/fund/approve', bt, { opId: op.id, digest: op.approvalDigest });
    await h.call('POST', '/fund/check', bt, { opId: op.id });
    assert.equal(h.sim.executions, 1);
    assert.equal((await h.call('GET', '/me', bt)).body.available, credited);
    const ops = await h.call('GET', '/fund/ops', bt);
    assert.equal(ops.body.operations.length, 1);
    assert.equal(ops.body.balances.asset, 'TESTUSDT');

    // spending the funded balance uses the normal billing path
    const items = (await h.call('GET', '/catalog')).body.items as any[];
    const price = items.find((i) => /token price/i.test(i.title));
    const run = await h.call('POST', '/execute', bt, { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'fund-http-0001' });
    assert.equal(run.body.result.charged, true);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('funding failures are reported accurately over HTTP and never spendable; delayed confirmation completes on re-check', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    const run = async (scenario: string, amount = '1364') => {
      const q = await h.call('POST', '/fund/quote', bt, { amount, scenario });
      assert.equal(q.status, 201, q.text);
      return h.call('POST', '/fund/approve', bt, { opId: q.body.operation.id, digest: q.body.operation.approvalDigest });
    };
    const rev = await run('reverted');
    assert.equal(rev.body.operation.state, 'FAILED');
    assert.match(rev.body.operation.statusText, /nothing was credited/);
    const wrong = await run('wrong_token');
    assert.equal(wrong.body.operation.state, 'REVIEW');
    const unc = await run('uncertain');
    assert.equal(unc.body.operation.state, 'UNRESOLVED');
    assert.equal((await h.call('GET', '/me', bt)).body.available, '0');

    const slow = await run('slow', '1000');
    assert.equal(slow.body.operation.state, 'VERIFYING');
    assert.equal(slow.body.operation.spendable, false);
    h.sim.advance(5);
    const checked = await h.call('POST', '/fund/check', bt, { opId: slow.body.operation.id });
    assert.equal(checked.body.operation.state, 'CREDITED');
    assert.equal((await h.call('GET', '/me', bt)).body.available, checked.body.operation.credited);

    // limits and bad input
    assert.equal((await h.call('POST', '/fund/quote', bt, { amount: '5' })).body.code, 'BELOW_MINIMUM');
    assert.equal((await h.call('POST', '/fund/quote', bt, { amount: '99999' })).body.code, 'ABOVE_MAXIMUM');
    assert.equal((await h.call('POST', '/fund/quote', bt, { amount: 'abc' })).status, 400);
    assert.equal((await h.call('POST', '/fund/quote', bt, { amount: '500', scenario: 'quote_unavailable' })).body.code, 'QUOTE_UNAVAILABLE');
  } finally {
    await h.close();
  }
});

test('funding is isolated per buyer, closed to agents, closed without configuration, and a live converter needs real-funds mode', async () => {
  const h = await start();
  const closed = await start({ noFunding: true });
  const live = await start({ mode: 'live' });
  try {
    const a = await buyer(h);
    const b = await buyer(h);
    const q = await h.call('POST', '/fund/quote', a, { amount: '1364' });
    const id = q.body.operation.id;
    assert.equal((await h.call('POST', '/fund/approve', b, { opId: id, digest: q.body.operation.approvalDigest })).body.code, 'NOT_OWNER');
    assert.equal((await h.call('GET', `/fund/ops/${id}`, b)).status, 404);
    assert.equal((await h.call('POST', '/fund/check', b, { opId: id })).status, 404);
    assert.equal((await h.call('GET', '/fund/ops', b)).body.operations.length, 0);

    const agentKey = (await h.call('POST', '/agents', a, { name: 'fund-bot', perRequestCap: '0.05', dailyCap: '0.1' })).body.key as string;
    assert.equal((await h.call('GET', '/fund/ops', agentKey)).status, 401, 'an agent key cannot touch funding');
    assert.equal((await h.call('POST', '/fund/quote', agentKey, { amount: '1364' })).status, 401);

    const cb = await buyer(closed);
    assert.equal((await closed.call('POST', '/fund/quote', cb, { amount: '1364' })).body.code, 'FUNDING_DISABLED');
    const lb = await buyer(live);
    assert.equal((await live.call('POST', '/fund/quote', lb, { amount: '1364' })).body.code, 'LIVE_DISABLED');
    assert.equal(live.sim.executions, 0);
  } finally {
    await h.close();
    await closed.close();
    await live.close();
  }
});
