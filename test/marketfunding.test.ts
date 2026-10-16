// Marketplace funding through the (SIMULATED) Textile conversion: quote -> approval -> verification -> credit.
// SIMULATION ONLY: fake quotes, fake chain receipts through the real verification code. No network, no wallet, no money.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/dev/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import { executeRequest } from '../src/execute.ts';
import { executeAsAgent, createAgent } from '../src/agents.ts';
import { executeEscrowRequest } from '../src/escrow.ts';
import type { EscrowClient, OnChainHold } from '../src/escrow.ts';
import { balance, createAccount, verifyLedger } from '../src/ledger.ts';
import { FundingOpError, approveFunding, fundingEvents, getFundingOp, recoverFunding, requestFundingQuote, verifyAndCredit, listFundingOps, fundingView } from '../src/marketfunding.ts';
import type { FundingConfig, FundingLimits } from '../src/marketfunding.ts';
import { createSimFunding } from '../src/dev/simfunding.ts';
import type { SimFunding } from '../src/dev/simfunding.ts';
import { buyerStatement } from '../src/billing.ts';
import { generateMasterKey } from '../src/vault.ts';

const T0 = 1_800_000_000_000;
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const mk = generateMasterKey('k1');
const LIMITS: FundingLimits = { minSellAtomic: 100_000_000n, maxSellAtomic: 7_000_000_000n, maxPerDaySellAtomic: 14_000_000_000n, maxOpenOps: 2 };
const CNGN = (n: number) => BigInt(n) * 1_000_000n;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function setup(o: { limits?: Partial<FundingLimits>; minConfirmations?: number; quoteTtlMs?: number; cngn?: bigint } = {}) {
  const db = openDb(':memory:');
  let clock = T0;
  const now = () => clock;
  const sim = createSimFunding({ usdt: USDT, reactor: TEXTILE_REACTOR, now, ...(o.quoteTtlMs ? { quoteTtlMs: o.quoteTtlMs } : {}), ...(o.cngn !== undefined ? { cngnBalanceAtomic: o.cngn } : {}) });
  const cfg: FundingConfig = { converter: sim.converter, reader: sim.reader, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: o.minConfirmations ?? 3, limits: { ...LIMITS, ...(o.limits ?? {}) }, creditAsset: 'TESTUSDT' };
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, now);
  return { db, sim, cfg, buyer, now, tick: (ms: number) => (clock += ms) };
}
type S = ReturnType<typeof setup>;
const quote = (s: S, amount = CNGN(1364), key = `k-${Math.random()}`, scenario?: string, buyer = s.buyer) =>
  requestFundingQuote(s.db, s.cfg, { buyerId: buyer, sellAtomic: amount, idempotencyKey: key, ...(scenario ? { scenario } : {}) }, s.now);
const approve = (s: S, opId: string, digest: string, buyer = s.buyer) => approveFunding(s.db, s.cfg, { opId, buyerId: buyer, digest }, s.now);
const avail = (s: S, asset = 'TESTUSDT', buyer = s.buyer) => balance(s.db, buyer, 'buyer_available', asset);

// ------------------------------------------------------------------ quote, limits, expiry, approval

test('a quote converts nothing; amount limits, daily limit and open-operation limit are enforced; the quote key is idempotent', async () => {
  const s = setup();
  const op = await quote(s, CNGN(1364), 'quote-key-1');
  assert.equal(op.state, 'QUOTED');
  assert.equal(s.sim.executions, 0, 'asking for a quote never executes a conversion');
  assert.equal(avail(s), 0n);
  const v = fundingView(op, s.now());
  assert.equal(v.simulated, true);
  assert.equal(v.creditAsset, 'TESTUSDT');
  assert.equal(v.spendable, false);
  assert.equal(op.mode, 'simulated');
  assert.ok(op.minAtomic < op.expectedAtomic);
  assert.equal(op.feeAtomic, (CNGN(1364) * 30n) / 10_000n);
  // same key: same operation; a different amount under the same key is refused
  assert.equal((await quote(s, CNGN(1364), 'quote-key-1')).id, op.id);
  assert.equal(await code(quote(s, CNGN(2000), 'quote-key-1')), 'IDEMPOTENCY_CONFLICT');

  assert.equal(await code(quote(s, 0n)), 'BAD_AMOUNT');
  assert.equal(await code(quote(s, CNGN(99))), 'BELOW_MINIMUM');
  assert.equal(await code(quote(s, CNGN(7001))), 'ABOVE_MAXIMUM');
  assert.equal(await code(quote(s, CNGN(1364), 'q-unavail', 'quote_unavailable')), 'QUOTE_UNAVAILABLE');

  // daily limit counts approved/finished operations
  const s2 = setup({ limits: { maxPerDaySellAtomic: CNGN(2000) } });
  const a = await quote(s2, CNGN(1500));
  await approve(s2, a.id, a.approvalDigest);
  assert.equal(await code(quote(s2, CNGN(1000))), 'DAILY_LIMIT');
  // too many open (unresolved) operations
  const s3 = setup();
  for (let i = 0; i < 2; i++) {
    const o = await quote(s3, CNGN(500), `u-${i}`, 'uncertain');
    await approve(s3, o.id, o.approvalDigest);
  }
  assert.equal(await code(quote(s3, CNGN(500))), 'TOO_MANY_OPEN');
});

test('only approval of the exact quote converts: digest required, expiry honoured, other buyers refused, repeats and races are safe', async () => {
  const s = setup({ quoteTtlMs: 30_000 });
  const op = await quote(s);
  assert.equal(await code(approve(s, op.id, 'deadbeef')), 'DIGEST_MISMATCH');
  const stranger = createAccount(s.db, { kind: 'buyer', displayName: 'X' }, s.now);
  assert.equal(await code(approve(s, op.id, op.approvalDigest, stranger)), 'NOT_OWNER');
  assert.equal(s.sim.executions, 0);

  // expiry: no execution, state EXPIRED, nothing credited
  s.tick(31_000);
  assert.equal(await code(approve(s, op.id, op.approvalDigest)), 'QUOTE_EXPIRED');
  assert.equal(getFundingOp(s.db, op.id)!.state, 'EXPIRED');
  assert.equal(s.sim.executions, 0);
  assert.equal(avail(s), 0n);

  // concurrent approvals of a fresh quote: exactly one conversion
  const fresh = await quote(s);
  const rs = await Promise.all([1, 2, 3, 4].map(() => approve(s, fresh.id, fresh.approvalDigest)));
  assert.equal(s.sim.executions, 1);
  assert.ok(rs.every((r) => r.id === fresh.id));
  assert.equal(getFundingOp(s.db, fresh.id)!.state, 'CREDITED');
  // approving again changes nothing
  await approve(s, fresh.id, fresh.approvalDigest);
  assert.equal(s.sim.executions, 1);
});

// ------------------------------------------------------------------ success + ledger

test('a verified conversion is credited exactly once, to the right buyer, in the TEST asset, with a ledger reference and event trail', async () => {
  const s = setup();
  const op = await quote(s);
  const done = await approve(s, op.id, op.approvalDigest);
  assert.equal(done.state, 'CREDITED');
  assert.equal(done.creditedAtomic, done.receivedAtomic);
  assert.ok(done.receivedAtomic! >= op.minAtomic);
  assert.equal(avail(s), done.receivedAtomic);
  assert.equal(avail(s, 'USDT'), 0n, 'simulated funding can never become real USDT');
  assert.equal(done.creditRef, `fund:${op.id}`);
  assert.ok(done.swapTx && done.approveTxs.length === 1);
  assert.deepEqual(fundingEvents(s.db, op.id).map((e) => e.state), ['QUOTED', 'CONVERTING', 'VERIFYING', 'CREDITED']);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
  // the events table is append-only
  assert.throws(() => s.db.prepare("UPDATE funding_events SET note = 'x'").run(), /append-only/);
  assert.throws(() => s.db.prepare('DELETE FROM funding_events').run(), /append-only/);
  // verifying again and recovering again never credit twice
  await verifyAndCredit(s.db, s.cfg, op.id, s.now);
  await recoverFunding(s.db, s.cfg, s.now);
  assert.equal(avail(s), done.receivedAtomic);
  const st = buyerStatement(s.db, s.buyer).balances.find((b) => b.asset === 'TESTUSDT')!;
  assert.equal(st.deposited.atomic, done.receivedAtomic!.toString());
});

// ------------------------------------------------------------------ nothing bad becomes spendable

test('failed, reverted, mismatched, short and uncertain conversions are never spendable and are distinguishable from deposits', async () => {
  const cases: Array<[string, string, string]> = [
    ['reverted', 'FAILED', 'REVERTED'],
    ['refused', 'FAILED', 'QUOTE_REFUSED'],
    ['wrong_token', 'REVIEW', 'VERIFICATION_MISMATCH'],
    ['wrong_recipient', 'REVIEW', 'VERIFICATION_MISMATCH'],
    ['no_fill', 'REVIEW', 'VERIFICATION_MISMATCH'],
    ['short', 'REVIEW', 'BELOW_MINIMUM'],
    ['uncertain', 'UNRESOLVED', 'UNCERTAIN'],
  ];
  for (const [scenario, state, failure] of cases) {
    const s = setup();
    const op = await quote(s, CNGN(1364), `k-${scenario}`, scenario);
    const r = await approve(s, op.id, op.approvalDigest);
    assert.equal(r.state, state, scenario);
    assert.equal(r.failureCode, failure, scenario);
    assert.equal(avail(s), 0n, `${scenario}: nothing spendable`);
    assert.equal(r.creditedAtomic, null, scenario);
    assert.equal(fundingView(r).spendable, false);
    assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE kind = 'deposit'").get()!.n, 0, scenario);
  }
});

test('delayed confirmation: stays VERIFYING and unspendable, then credits once when confirmed', async () => {
  const s = setup({ minConfirmations: 3 });
  const op = await quote(s, CNGN(1364), 'slow-1', 'slow');
  const r = await approve(s, op.id, op.approvalDigest);
  assert.equal(r.state, 'VERIFYING');
  assert.equal(avail(s), 0n);
  assert.match(fundingEvents(s.db, op.id).at(-1)!.note, /waiting for confirmations/);
  // still not enough
  assert.equal((await verifyAndCredit(s.db, s.cfg, op.id, s.now)).state, 'VERIFYING');
  s.sim.advance(5);
  const done = await verifyAndCredit(s.db, s.cfg, op.id, s.now);
  assert.equal(done.state, 'CREDITED');
  assert.equal(avail(s), done.receivedAtomic);
  s.sim.advance(5);
  await verifyAndCredit(s.db, s.cfg, op.id, s.now);
  assert.equal(avail(s), done.receivedAtomic, 'late re-checks do not credit again');
});

test('an unresolved transaction that lands later is credited exactly once by recovery', async () => {
  const s = setup();
  const op = await quote(s, CNGN(1364), 'late-1', 'uncertain');
  const r = await approve(s, op.id, op.approvalDigest);
  assert.equal(r.state, 'UNRESOLVED');
  assert.deepEqual(await recoverFunding(s.db, s.cfg, s.now), [], 'not visible yet: stays unresolved, never failed');
  assert.equal(getFundingOp(s.db, op.id)!.state, 'UNRESOLVED');
  s.sim.landLate(r.swapTx!);
  s.sim.advance(10);
  const rec = await recoverFunding(s.db, s.cfg, s.now);
  assert.deepEqual(rec.map((x) => x.to), ['CREDITED']);
  const bal = avail(s);
  assert.ok(bal > 0n);
  await recoverFunding(s.db, s.cfg, s.now);
  assert.equal(avail(s), bal);
});

// ------------------------------------------------------------------ crash recovery and duplicates

test('crash recovery: interrupted before/after the credit never loses a record and never duplicates one', async () => {
  // (a) the process died after the swap was submitted but before verification
  const a = setup();
  const opA = await quote(a, CNGN(1364), 'crash-a');
  const exec = await a.cfg.converter.execute({ opId: opA.id, quoteId: opA.quoteId, sellAtomic: opA.sellAtomic, minBuyAtomic: opA.minAtomic, digest: opA.approvalDigest });
  assert.equal(exec.kind, 'submitted');
  a.db.prepare("UPDATE funding_ops SET state = 'CONVERTING', approved_at = ?, swap_tx = ? WHERE id = ?").run(new Date(T0).toISOString(), (exec as { swapTx: string }).swapTx, opA.id);
  const rec = await recoverFunding(a.db, a.cfg, a.now);
  assert.deepEqual(rec.map((x) => x.to), ['CREDITED']);
  const credited = avail(a);
  assert.ok(credited > 0n);
  await recoverFunding(a.db, a.cfg, a.now);
  assert.equal(avail(a), credited);

  // (b) died after the ledger credit was written but before the operation was marked CREDITED
  const b = setup();
  const opB = await quote(b, CNGN(1364), 'crash-b');
  const execB = (await b.cfg.converter.execute({ opId: opB.id, quoteId: opB.quoteId, sellAtomic: opB.sellAtomic, minBuyAtomic: opB.minAtomic, digest: opB.approvalDigest })) as { swapTx: string };
  b.db.prepare("UPDATE funding_ops SET state = 'VERIFYING', swap_tx = ? WHERE id = ?").run(execB.swapTx, opB.id);
  const { deposit } = await import('../src/ledger.ts');
  const expectedReceived = (CNGN(1364) - (CNGN(1364) * 30n) / 10_000n) / 1364n;
  deposit(b.db, { buyerId: b.buyer, asset: 'TESTUSDT', amountAtomic: expectedReceived, ref: `fund:${opB.id}` }, b.now);
  const before = avail(b);
  const done = await verifyAndCredit(b.db, b.cfg, opB.id, b.now);
  assert.equal(done.state, 'CREDITED');
  assert.equal(avail(b), before, 'the pre-existing ledger credit was recognised, not repeated');

  // (c) died before any transaction was recorded: unresolved, never silently failed or credited
  const c = setup();
  const opC = await quote(c, CNGN(1364), 'crash-c');
  c.db.prepare("UPDATE funding_ops SET state = 'CONVERTING' WHERE id = ?").run(opC.id);
  await recoverFunding(c.db, c.cfg, c.now);
  assert.equal(getFundingOp(c.db, opC.id)!.state, 'UNRESOLVED');
  assert.equal(avail(c), 0n);
});

test('one transaction can fund one operation for one buyer; a claimed transaction cannot be re-used', async () => {
  const s = setup();
  const first = await quote(s, CNGN(1364), 'dup-1');
  const done = await approve(s, first.id, first.approvalDigest);
  assert.equal(done.state, 'CREDITED');
  // another operation (even another buyer) pointing at the same transaction is refused
  const other = createAccount(s.db, { kind: 'buyer', displayName: 'O' }, s.now);
  for (const buyer of [s.buyer, other]) {
    const second = await quote(s, CNGN(1364), `dup-${buyer}`, undefined, buyer);
    s.db.prepare("UPDATE funding_ops SET state = 'VERIFYING', swap_tx = ? WHERE id = ?").run(done.swapTx, second.id);
    const r = await verifyAndCredit(s.db, s.cfg, second.id, s.now);
    assert.equal(r.state, 'REVIEW');
    assert.equal(r.failureCode, 'TX_ALREADY_CLAIMED');
    assert.equal(avail(s, 'TESTUSDT', buyer), buyer === s.buyer ? done.receivedAtomic : 0n);
  }
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
});

test('insufficient cNGN balance is reported at quote time and nothing is created in the ledger', async () => {
  const s = setup({ cngn: CNGN(500) });
  assert.equal(await code(quote(s, CNGN(1364))), 'QUOTE_UNAVAILABLE');
  assert.equal(listFundingOps(s.db, s.buyer).length, 0);
  const ok = await quote(s, CNGN(400));
  assert.equal((await approve(s, ok.id, ok.approvalDigest)).state, 'CREDITED');
});

// ------------------------------------------------------------------ integration: spending the funded balance

test('a funded balance buys API responses through the existing billing, agents and ledger; escrow is untouched', async () => {
  const s = setup();
  const demo = seedDemo(s.db, mk, s.now);
  const op = await quote(s, CNGN(1364));
  const funded = await approve(s, op.id, op.approvalDigest);
  const fundedAmt = funded.creditedAtomic!;
  const dn = createDemoNetwork(s.now);
  const opts = { now: s.now, demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: dn.resolver, transport: dn.transport, timeoutMs: 150 } } };

  const r = await executeRequest(s.db, [mk], { buyerId: s.buyer, listingId: demo.priceListingId, idempotencyKey: 'fund-buy-0001', input: { id: 'eth' } }, opts);
  assert.equal(r.state, 'QUALIFIED');
  assert.equal(avail(s), fundedAmt - 20_000n, 'one purchase deducts exactly the price; no new conversion happens per request');
  assert.equal(s.sim.executions, 1);

  // an agent of this buyer spends from the same funded balance inside its caps
  const { key: _k, agent } = createAgent(s.db, s.buyer, { name: 'fund-bot', perRequestCapAtomic: 30_000n, dailyCapAtomic: 50_000n }, s.now);
  const ar = await executeAsAgent(s.db, [mk], agent, { listingId: demo.priceListingId, idempotencyKey: 'fund-agent-0001', input: { id: 'btc' } }, opts);
  assert.equal(ar.state, 'QUALIFIED');
  assert.equal(avail(s), fundedAmt - 40_000n);

  // escrow settlement uses the on-chain escrow balance and never touches the ledger balance
  s.db.prepare("INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES ('0x00000000000000000000000000000000000000b1', ?, 's', 't')").run(s.buyer);
  s.db.prepare("UPDATE accounts SET wallet_address = '0x00000000000000000000000000000000000000e1' WHERE id = ?").run(demo.sellerId);
  const holds = new Map<string, OnChainHold>();
  const esc: EscrowClient = {
    holdTimeoutSeconds: 86_400,
    available: async () => 1_000_000n,
    hold: async (id) => holds.get(id) ?? { state: 'None', buyer: '', seller: '', amount: 0n, createdAt: 0 },
    placeHold: async (id, b, sl, a) => (holds.set(id, { state: 'Held', buyer: b, seller: sl, amount: a, createdAt: 0 }), '0xh'),
    capture: async (id) => ((holds.get(id)!.state = 'Captured'), '0xc'),
    release: async (id) => ((holds.get(id)!.state = 'Released'), '0xr'),
    expire: async () => '0xe',
  };
  const before = avail(s);
  const er = await executeEscrowRequest(s.db, [mk], esc, { buyerId: s.buyer, listingId: demo.priceListingId, idempotencyKey: 'fund-escrow-01', input: { id: 'celo' }, asset: 'TESTUSDT' }, opts);
  assert.equal(er.state, 'QUALIFIED');
  assert.equal(avail(s), before, 'escrow-settled requests do not move the funded ledger balance');
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
  // statement reconciliation: deposited = available + held + charged
  const st = buyerStatement(s.db, s.buyer).balances.find((b) => b.asset === 'TESTUSDT')!;
  assert.equal(BigInt(st.deposited.atomic), BigInt(st.available.atomic) + BigInt(st.held.atomic) + BigInt(st.charged.atomic));
});

test('simulated funding and the capped test-credit grant are separate: funding does not consume the grant cap', async () => {
  const { grantTestCredits, TEST_CREDIT_CAP } = await import('../src/market.ts');
  const s = setup();
  const op = await quote(s, CNGN(6000));
  await approve(s, op.id, op.approvalDigest);
  const rt = { db: s.db, keys: [mk], activeKey: mk, now: s.now } as never;
  const g = grantTestCredits(rt, s.buyer, TEST_CREDIT_CAP);
  assert.equal(g.granted, TEST_CREDIT_CAP, 'the full grant is still available after a (larger) simulated funding');
});

test('a live converter is refused for any buyer that is not the designated funding account (no faucet from the operator wallet)', async () => {
  const s = setup();
  const live = { ...s.cfg, converter: { ...s.cfg.converter, mode: 'live' as const } };
  const other = createAccount(s.db, { kind: 'buyer', displayName: 'O' }, s.now);
  assert.equal(await code(requestFundingQuote(s.db, live, { buyerId: s.buyer, sellAtomic: CNGN(1364), idempotencyKey: 'live-none' }, s.now)), 'NOT_ALLOWED');
  const allowed = { ...live, allowedBuyerIds: [s.buyer] };
  assert.equal(await code(requestFundingQuote(s.db, allowed, { buyerId: other, sellAtomic: CNGN(1364), idempotencyKey: 'live-other' }, s.now)), 'NOT_ALLOWED');
  assert.equal((await requestFundingQuote(s.db, allowed, { buyerId: s.buyer, sellAtomic: CNGN(1364), idempotencyKey: 'live-ok-1' }, s.now)).mode, 'live');
  assert.equal(s.sim.executions, 0);
});
