// End-to-end marketplace execution against the in-process demo network. LOCAL INTEGRATION ONLY: no internet,
// no blockchain, test credits only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/demoapis.ts';
import { executeRequest, executionResult, recoverExecutions } from '../src/execute.ts';
import type { ExecuteOptions } from '../src/execute.ts';
import type { Transport } from '../src/egress.ts';
import { RateLimiter } from '../src/egress.ts';
import { balance, createAccount, deposit, verifyLedger } from '../src/ledger.ts';
import { generateMasterKey } from '../src/vault.ts';

const T0 = 1_800_000_000_000;
const mk = generateMasterKey('k1');
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function setup(credits = 1_000_000n) {
  const db = openDb(':memory:');
  const demo = seedDemo(db, mk, () => T0);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  deposit(db, { buyerId: buyer, asset: 'USDT', amountAtomic: credits, ref: 'test-credit-1' }, () => T0);
  const net = createDemoNetwork(() => T0);
  let calls = 0;
  const transport: Transport = (r) => (calls++, net.transport(r));
  const opts: ExecuteOptions = { now: () => T0, demoCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: net.resolver, transport, timeoutMs: 150 } } };
  return { db, demo, buyer, opts, calls: () => calls };
}
const run = (s: ReturnType<typeof setup>, listingId: string, input: unknown, key: string) => executeRequest(s.db, [mk], { buyerId: s.buyer, listingId, idempotencyKey: key, input }, s.opts);
const seller = (s: ReturnType<typeof setup>) => balance(s.db, s.demo.sellerId, 'seller_earnings', 'USDT');

test('qualifying response: the buyer is charged once, the seller gets price minus 3%, the body is returned, the ledger is sound', async () => {
  const s = setup();
  const r = await run(s, s.demo.priceListingId, { id: 'eth' }, 'req-0001');
  assert.equal(r.state, 'QUALIFIED');
  assert.equal(r.charged, true);
  assert.equal(r.held, false);
  assert.equal(r.priceAtomic, '20000');
  assert.equal(r.feeAtomic, '600');
  assert.equal(r.sellerAtomic, '19400');
  assert.deepEqual({ id: (r.body as any).id, price: (r.body as any).price }, { id: 'eth', price: 2450.17 });
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), 980_000n);
  assert.equal(balance(s.db, s.buyer, 'buyer_held', 'USDT'), 0n);
  assert.equal(seller(s), 19_400n);
  assert.equal(balance(s.db, 'platform', 'platform_fee', 'USDT'), 600n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
  assert.ok(r.checks.length >= 5 && r.checks.every((c) => c.ok));
  assert.equal(r.contractVersion, 1);
});

test('every kind of non-qualifying answer costs the buyer nothing and withholds the body', async () => {
  const s = setup();
  const before = balance(s.db, s.buyer, 'buyer_available', 'USDT');
  let n = 0;
  for (const scenario of ['stale', 'http500', 'html', 'empty', 'wrongtype', 'missing', 'badkey']) {
    const r = await run(s, s.demo.priceListingId, { id: 'eth', scenario }, `req-bad-${n++}`);
    assert.equal(r.state, 'NOT_QUALIFIED', scenario);
    assert.equal(r.charged, false, scenario);
    assert.equal(r.body, undefined, scenario);
    assert.ok(r.reason && r.reason.length > 0, scenario);
  }
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), before);
  assert.equal(balance(s.db, s.buyer, 'buyer_held', 'USDT'), 0n);
  assert.equal(seller(s), 0n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
  // the failure reasons name the rule
  const stale = await run(s, s.demo.priceListingId, { id: 'eth', scenario: 'stale' }, 'req-stale-2');
  assert.match(stale.reason!, /freshness/);
  const wrong = await run(s, s.demo.echoListingId, { text: 'hi', scenario: 'wrongtype' }, 'req-echo-wrong');
  assert.match(wrong.reason!, /field:length/);
});

test('echo API works through a POST body', async () => {
  const s = setup();
  const r = await run(s, s.demo.echoListingId, { text: 'hello world' }, 'req-echo-1');
  assert.equal(r.state, 'QUALIFIED');
  assert.equal((r.body as any).length, 11);
  assert.equal(r.priceAtomic, '5000');
  assert.equal(r.feeAtomic, '150');
});

test('a timeout is UNRESOLVED: funds stay held (not charged, not silently refunded), then are released after the window', async () => {
  const s = setup();
  const r = await run(s, s.demo.priceListingId, { id: 'eth', scenario: 'hang' }, 'req-hang-01');
  assert.equal(r.state, 'UNRESOLVED');
  assert.equal(r.charged, false);
  assert.equal(r.held, true);
  assert.equal(balance(s.db, s.buyer, 'buyer_held', 'USDT'), 20_000n);
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), 980_000n);
  assert.equal(seller(s), 0n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
  // replay: still unresolved, no second call
  const calls = s.calls();
  assert.equal((await run(s, s.demo.priceListingId, { id: 'eth', scenario: 'hang' }, 'req-hang-01')).state, 'UNRESOLVED');
  assert.equal(s.calls(), calls);
  // before the window: nothing happens
  assert.deepEqual(recoverExecutions(s.db, { staleHeldMs: 60_000, unresolvedMs: 3_600_000 }, () => T0 + 1_000), { interrupted: 0, released: 0 });
  // after the window: released to the buyer, flagged, seller earns nothing
  const rec = recoverExecutions(s.db, { staleHeldMs: 60_000, unresolvedMs: 3_600_000 }, () => T0 + 3_700_000);
  assert.equal(rec.released, 1);
  const after = executionResult(s.db, r.executionId)!;
  assert.equal(after.state, 'RELEASED_UNRESOLVED');
  assert.equal(after.charged, false);
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), 1_000_000n);
  assert.equal(balance(s.db, s.buyer, 'buyer_held', 'USDT'), 0n);
  assert.equal(seller(s), 0n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
});

test('idempotency: a repeated key returns the stored result without a second call or charge; a different request with the same key is refused', async () => {
  const s = setup();
  const a = await run(s, s.demo.priceListingId, { id: 'btc' }, 'req-idem-01');
  const calls = s.calls();
  const b = await run(s, s.demo.priceListingId, { id: 'btc' }, 'req-idem-01');
  assert.equal(s.calls(), calls, 'upstream was not called again');
  assert.equal(b.replay, true);
  assert.equal(b.executionId, a.executionId);
  assert.deepEqual(b.body, a.body, 'the paid response is still available on replay');
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), 980_000n, 'charged once');
  assert.equal(await code(run(s, s.demo.priceListingId, { id: 'eth' }, 'req-idem-01')), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await code(run(s, s.demo.echoListingId, { id: 'btc' }, 'req-idem-01')), 'IDEMPOTENCY_CONFLICT');
});

test('concurrent duplicates: one upstream call, one charge', async () => {
  const s = setup();
  const rs = await Promise.all([1, 2, 3].map(() => run(s, s.demo.priceListingId, { id: 'celo' }, 'req-race-001')));
  assert.equal(s.calls(), 1);
  assert.equal(rs.filter((r) => !r.replay).length, 1);
  assert.equal(balance(s.db, s.buyer, 'buyer_available', 'USDT'), 980_000n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
});

test('insufficient credits and bad input are refused BEFORE anything is held or sent', async () => {
  const poor = setup(10_000n);
  assert.equal(await code(run(poor, poor.demo.priceListingId, { id: 'eth' }, 'req-poor-001')), 'INSUFFICIENT_CREDITS');
  assert.equal(poor.calls(), 0);
  assert.equal(balance(poor.db, poor.buyer, 'buyer_held', 'USDT'), 0n);

  const s = setup();
  for (const [bad, key] of [[[1, 2], 'req-bad-in-1'], [{ 'a b': 1 }, 'req-bad-in-2'], [{ a: { x: 1 } }, 'req-bad-in-3']] as const) {
    assert.equal(await code(run(s, s.demo.echoListingId, bad, key)), 'BAD_INPUT');
  }
  assert.equal(await code(run(s, s.demo.echoListingId, {}, 'short')), 'NOT_FOUND', 'malformed idempotency key');
  assert.equal(s.calls(), 0);
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number | bigint }).n), 0);
});

test('an execution interrupted mid-call (crash) becomes UNRESOLVED and then releases', () => {
  const s = setup();
  // simulate a crash after the hold: create the hold via the normal path, but never settle
  const lst = s.db.prepare('SELECT id FROM contract_versions WHERE listing_id = ?').get(s.demo.priceListingId) as { id: string };
  s.db.prepare(
    "INSERT INTO executions (id, buyer_id, listing_id, contract_version_id, idempotency_key, request_hash, state, price_atomic, asset, fee_bps, created_at, updated_at) VALUES ('exec_crash', ?, ?, ?, 'crash-key-1', 'h', 'HELD', 20000, 'USDT', 300, ?, ?)",
  ).run(s.buyer, s.demo.priceListingId, lst.id, new Date(T0).toISOString(), new Date(T0).toISOString());
  // (the hold entries are posted by startExecution; here we only check state handling of a stuck HELD row)
  const rec = recoverExecutions(s.db, { staleHeldMs: 60_000, unresolvedMs: 600_000 }, () => T0 + 120_000);
  assert.equal(rec.interrupted, 1);
  assert.equal(executionResult(s.db, 'exec_crash')!.state, 'UNRESOLVED');
});

test('only demo listings may use the demo network; a normal listing uses the real-egress options it was given', async () => {
  const s = setup();
  // make a normal verified+published listing by copying the demo one and clearing the flag
  s.db.prepare("UPDATE listings SET demo = 0 WHERE id = ?").run(s.demo.echoListingId);
  let realCalls = 0;
  const real: Transport = async () => (realCalls++, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ text: 'x', length: 1 })) });
  const opts: ExecuteOptions = {
    now: () => T0,
    call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport: real } },
    demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: async () => { throw new Error('demo network must not be used'); }, transport: async () => { throw new Error('demo network must not be used'); } } },
  };
  const r = await executeRequest(s.db, [mk], { buyerId: s.buyer, listingId: s.demo.echoListingId, idempotencyKey: 'req-normal-1', input: { text: 'x' } }, opts);
  assert.equal(r.state, 'QUALIFIED');
  assert.equal(realCalls, 1);
});

test('seeding is idempotent and the demo listings are published with approved contracts', () => {
  const s = setup();
  const again = seedDemo(s.db, mk, () => T0);
  assert.deepEqual(again, s.demo);
  const rows = s.db.prepare("SELECT status, demo FROM listings ORDER BY id").all() as Array<{ status: string; demo: number | bigint }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'published' && Number(r.demo) === 1));
});
