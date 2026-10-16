// Phases 1-3: outcome-based billing, settlement accounting and the agent API, over HTTP + the real ledger.
// LOCAL INTEGRATION: in-process demo network, test credits, fake escrow where noted. No chain, no real funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { evaluate, parseContractBody } from '../src/contracts.ts';
import { createDemoNetwork, createSandboxNetwork, seedDemo, PRICE_CONTRACT } from '../src/dev/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import { recoverExecutions } from '../src/execute.ts';
import { balance, verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { buyerStatement, platformStatement, sellerStatement } from '../src/billing.ts';

const T0 = Date.now();
const mk = generateMasterKey('k1');

async function start() {
  const db = openDb(':memory:');
  const demo = seedDemo(db, mk);
  const sb = createSandboxNetwork(db);
  const dn = createDemoNetwork();
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, sandbox: true,
    execute: {
      call: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
      demoCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: dn.resolver, transport: dn.transport, timeoutMs: 150 } },
    },
    testCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
    domain: { txt: sb.txt, fetchOptions: { resolver: sb.resolver, transport: sb.transport } },
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'bl-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string, body?: unknown, pageToken = true) => {
    const r = await fetch(`${base}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', ...(pageToken ? { 'x-payrail-token': token } : {}) } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, demo, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;
const newBuyer = async (h: H, credits = '1') => {
  const b = await h.call('POST', '/buyer');
  await h.call('POST', '/credits', b.body.token, { amount: credits });
  return { token: b.body.token as string, id: b.body.accountId as string };
};
const run = (h: H, token: string, listingId: string, key: string, input: unknown = { id: 'eth' }) => h.call('POST', '/execute', token, { listingId, idempotencyKey: key, input });

// =================================================================== PHASE 1

test('quote before purchase: buyer pays, platform fee and seller earnings are exact and match what is actually settled', async () => {
  const h = await start();
  try {
    const q = await h.call('GET', `/quote/${h.demo.priceListingId}`);
    assert.equal(q.status, 200);
    const quote = q.body.quote;
    assert.deepEqual([quote.buyerPays.atomic, quote.platformFee.atomic, quote.sellerReceives.atomic], ['20000', '600', '19400']);
    assert.equal(quote.platformFee.percent, 3);
    assert.equal(quote.available, true);
    assert.ok(quote.chargedOnlyIf.some((c: string) => /Freshness.*60 seconds/.test(c)));
    assert.ok(quote.chargedOnlyIf.some((c: string) => /non-empty JSON object/.test(c)));
    assert.match(quote.validationNote, /does not and cannot verify that the data is true/);
    assert.ok(quote.notCharged.length >= 3);

    const b = await newBuyer(h);
    const r = await run(h, b.token, h.demo.priceListingId, 'quote-run-001');
    assert.equal(r.body.result.priceAtomic, quote.buyerPays.atomic);
    assert.equal(r.body.result.feeAtomic, quote.platformFee.atomic);
    assert.equal(r.body.result.sellerAtomic, quote.sellerReceives.atomic);
    // unavailable listings have no public quote
    h.db.prepare("UPDATE listings SET status = 'unpublished' WHERE id = ?").run(h.demo.priceListingId);
    assert.equal((await h.call('GET', `/quote/${h.demo.priceListingId}`)).status, 404);
  } finally {
    await h.close();
  }
});

test('every disqualifying condition is detected, explained and not charged (including an empty body and a timeout)', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h, '2');
    const cases: Array<[string, RegExp]> = [
      ['stale', /freshness/], ['http500', /status/], ['html', /content-type/], ['empty', /non-empty-body|json/],
      ['wrongtype', /field:price/], ['missing', /field:price/], ['badkey', /status/],
    ];
    let n = 0;
    for (const [scenario, why] of cases) {
      const r = await run(h, b.token, h.demo.priceListingId, `cond-${n++}-${scenario}`, { id: 'eth', scenario });
      assert.equal(r.body.result.state, 'NOT_QUALIFIED', scenario);
      assert.equal(r.body.result.charged, false, scenario);
      assert.match(r.body.result.reason, why, scenario);
      assert.equal(r.body.result.body, undefined, 'a non-qualifying body is not returned');
    }
    const hang = await run(h, b.token, h.demo.priceListingId, 'cond-hang', { id: 'eth', scenario: 'hang' });
    assert.equal(hang.body.result.state, 'UNRESOLVED');
    assert.equal(hang.body.result.charged, false);
    const empty = await h.call('GET', `/receipt/${(await run(h, b.token, h.demo.priceListingId, 'cond-empty-2', { id: 'eth', scenario: 'empty' })).body.result.executionId}`, b.token);
    assert.ok(empty.body.receipt.validation.checks.some((c: any) => c.name === 'non-empty-body' && c.ok === false));
    assert.equal(balance(h.db, b.id, 'buyer_available', 'TESTUSDT'), 2_000_000n - 20_000n, 'only the unresolved hold reduces the balance');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('validator unit: empty body, wrong type, stale timestamp and slow response each fail on their own', () => {
  const c = parseContractBody(PRICE_CONTRACT);
  const ok = { status: 200, contentType: 'application/json', json: { price: 1, id: 'eth', asOf: new Date(T0).toISOString() }, elapsedMs: 10, bodyBytes: 60 };
  assert.equal(evaluate(c, ok, T0).qualified, true);
  assert.equal(evaluate(c, { ...ok, bodyBytes: 0, json: undefined }, T0).checks.find((x) => x.name === 'non-empty-body')!.ok, false);
  assert.equal(evaluate(c, { ...ok, json: { ...(ok.json as object), price: '1' } }, T0).qualified, false);
  assert.equal(evaluate(c, { ...ok, json: { ...(ok.json as object), asOf: new Date(T0 - 120_000).toISOString() } }, T0).qualified, false);
  assert.equal(evaluate(c, { ...ok, elapsedMs: 5_000 }, T0).qualified, false);
});

test('duplicates, retries and interruptions never charge twice and never guess an unknown outcome', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h, '1');
    // same key, sequential and concurrent
    const first = await run(h, b.token, h.demo.priceListingId, 'dup-key-0001');
    const again = await run(h, b.token, h.demo.priceListingId, 'dup-key-0001');
    assert.equal(again.body.result.replay, true);
    assert.equal(again.body.result.executionId, first.body.result.executionId);
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => run(h, b.token, h.demo.priceListingId, 'dup-key-0002')));
    assert.equal(new Set(burst.map((x) => x.body.result.executionId)).size, 1);
    assert.equal(burst.filter((x) => x.body.result.replay === false).length, 1);
    // a different key is a different purchase
    assert.equal((await run(h, b.token, h.demo.priceListingId, 'dup-key-0003')).body.result.charged, true);
    assert.equal(balance(h.db, b.id, 'buyer_available', 'TESTUSDT'), 1_000_000n - 3n * 20_000n);

    // a changed request under an old key is refused, not silently re-run
    assert.equal((await run(h, b.token, h.demo.priceListingId, 'dup-key-0001', { id: 'btc' })).body.code, 'IDEMPOTENCY_CONFLICT');

    // interrupted: the process died after the hold; recovery marks it unresolved (never charged, never silently refunded)
    const lst = h.db.prepare('SELECT id FROM contract_versions WHERE listing_id = ?').get(h.demo.priceListingId) as { id: string };
    const { startExecution } = await import('../src/ledger.ts');
    const { execution } = startExecution(h.db, { buyerId: b.id, listingId: h.demo.priceListingId, contractVersionId: lst.id, idempotencyKey: 'interrupted-0001', requestHash: 'x' }, () => T0 - 10 * 60_000);
    assert.equal(balance(h.db, b.id, 'buyer_held', 'TESTUSDT'), 20_000n);
    const rec = recoverExecutions(h.db, { staleHeldMs: 60_000, unresolvedMs: 3_600_000 }, () => T0);
    assert.equal(rec.interrupted, 1);
    let rcp = (await h.call('GET', `/receipt/${execution.id}`, b.token)).body.receipt;
    assert.equal(rcp.outcome, 'UNRESOLVED');
    assert.equal(rcp.charged.atomic, '0');
    assert.equal(rcp.held.atomic, '20000');
    // retrying under the same key does not call the seller again and reports the unresolved state
    const retry = await run(h, b.token, h.demo.priceListingId, 'interrupted-0001', { id: 'eth' }); // request hash differs from 'x'
    assert.equal(retry.status, 409);
    // after the window the hold goes back to the buyer, flagged
    recoverExecutions(h.db, { staleHeldMs: 60_000, unresolvedMs: 3_600_000 }, () => T0 + 2 * 3_600_000);
    rcp = (await h.call('GET', `/receipt/${execution.id}`, b.token)).body.receipt;
    assert.equal(rcp.outcome, 'RELEASED_UNRESOLVED');
    assert.equal(rcp.returned.atomic, '20000');
    assert.equal(balance(h.db, b.id, 'buyer_held', 'TESTUSDT'), 0n);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

// =================================================================== PHASE 2

test('accounting: gross = platform fees + seller earnings; buyer, seller and platform statements agree with the ledger', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h, '2');
    for (let i = 0; i < 3; i++) await run(h, b.token, h.demo.priceListingId, `acct-ok-${i}`);
    await run(h, b.token, h.demo.priceListingId, 'acct-stale-1', { id: 'eth', scenario: 'stale' });
    await run(h, b.token, h.demo.echoListingId, 'acct-echo-1', { text: 'hello' });
    await run(h, b.token, h.demo.priceListingId, 'acct-hang-01', { id: 'eth', scenario: 'hang' });

    const seller = sellerStatement(h.db, h.demo.sellerId);
    const bucket = seller.buckets.find((x) => x.settlement === 'ledger' && x.asset === 'TESTUSDT')!;
    assert.equal(bucket.requests, 6);
    assert.equal(bucket.qualified, 4);
    assert.equal(bucket.notCharged, 1);
    assert.equal(bucket.unresolvedOpen, 1);
    assert.equal(BigInt(bucket.gross.atomic), 3n * 20_000n + 5_000n);
    assert.equal(BigInt(bucket.platformFees.atomic) + BigInt(bucket.sellerEarnings.atomic), BigInt(bucket.gross.atomic));
    assert.equal(bucket.platformFees.atomic, String(3n * 600n + 150n));
    assert.equal(bucket.heldOpen.atomic, '20000');
    assert.equal(bucket.refunded.atomic, '20000');
    // equals the ledger balances
    assert.equal(seller.ledgerBalances[0]!.available.atomic, bucket.sellerEarnings.atomic);
    assert.equal(balance(h.db, h.demo.sellerId, 'seller_earnings', 'TESTUSDT').toString(), bucket.sellerEarnings.atomic);
    assert.equal(balance(h.db, 'platform', 'platform_fee', 'TESTUSDT').toString(), bucket.platformFees.atomic);
    assert.equal(seller.recentSales.length, 4);

    const buyer = buyerStatement(h.db, b.id).balances.find((x) => x.asset === 'TESTUSDT')!;
    assert.equal(BigInt(buyer.deposited.atomic), 2_000_000n);
    // money in = money still available + held + charged
    assert.equal(BigInt(buyer.available.atomic) + BigInt(buyer.held.atomic) + BigInt(buyer.charged.atomic), BigInt(buyer.deposited.atomic));
    assert.equal(buyer.charged.atomic, bucket.gross.atomic);

    const plat = platformStatement(h.db);
    assert.equal(plat.feesCollected.find((f) => f.asset === 'TESTUSDT')!.atomic, bucket.platformFees.atomic);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });

    // the same numbers over HTTP
    const sHttp = await h.call('GET', '/me/statement', b.token);
    assert.equal(sHttp.body.statement.balances[0].charged.atomic, buyer.charged.atomic);
  } finally {
    await h.close();
  }
});

test('payout visibility: requested, approved and completed payouts appear in the seller statement and stay balanced', async () => {
  const db = openDb(':memory:');
  const { createAccount, deposit, startExecution, settleExecution } = await import('../src/ledger.ts');
  const { approvePayout, markSent, requestPayout, verifyPayout } = await import('../src/payouts.ts');
  const { TRANSFER_TOPIC } = await import('../src/funding.ts');
  const seller = createAccount(db, { kind: 'seller', displayName: 'S' }, () => T0);
  db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run('0x00000000000000000000000000000000000000e1', seller);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  deposit(db, { buyerId: buyer, asset: 'USDT', amountAtomic: 5_000_000n, ref: 'seed' }, () => T0);
  db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, fee_bps) VALUES ('l1', ?, 'x', 'published', 4000000, 'USDT', 't', 300)").run(seller);
  db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES ('c1', 'l1', 1, '{}', 'h', 'approved', 't')").run();
  const { execution } = startExecution(db, { buyerId: buyer, listingId: 'l1', contractVersionId: 'c1', idempotencyKey: 'k-1', requestHash: 'h' }, () => T0);
  settleExecution(db, execution.id, 'QUALIFIED', 'ok', () => T0);
  const policy = { payableAssets: ['USDT'], minAtomic: 1n, maxAtomic: 10_000_000n };
  const p1 = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 1_000_000n }, policy, () => T0);
  const p2 = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 2_000_000n }, policy, () => T0);
  approvePayout(db, p2.id, 'op', () => T0);
  markSent(db, p2.id, `0x${'ab'.repeat(32)}`, 'op', () => T0);
  const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
  const src = '0x00000000000000000000000000000000000dead2';
  await verifyPayout(db, {
    reader: { blockNumber: async () => 100n, receipt: async () => ({ status: 'success' as const, blockNumber: 90n, logs: [{ address: '0xtok', topics: [TRANSFER_TOPIC, pad(src), pad(p2.destination)], data: `0x${(2_000_000n).toString(16).padStart(64, '0')}`, logIndex: 0 }] }) },
    token: '0xtok', sourceAddress: src, minConfirmations: 5,
  }, p2.id, () => T0);

  const st = sellerStatement(db, seller);
  const b = st.buckets[0]!;
  assert.deepEqual([b.gross.atomic, b.platformFees.atomic, b.sellerEarnings.atomic], ['4000000', '120000', '3880000']);
  const t = st.payoutTotals.find((x) => x.asset === 'USDT')!;
  assert.deepEqual([t.pending.atomic, t.completed.atomic], ['1000000', '2000000']);
  assert.equal(st.ledgerBalances[0]!.available.atomic, String(3_880_000n - 3_000_000n));
  assert.equal(st.ledgerBalances[0]!.pendingPayout.atomic, '1000000');
  assert.deepEqual(st.payouts.map((p) => p.state).sort(), ['confirmed', 'requested']);
  assert.ok(p1.id);
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
});

// =================================================================== PHASE 3

test('agent API: machine-readable catalog, inspect-before-buy, structured result and receipt', async () => {
  const h = await start();
  try {
    const owner = await newBuyer(h, '1');
    const created = await h.call('POST', '/agents', owner.token, { name: 'doc-bot', perRequestCap: '0.03', dailyCap: '0.05' });
    const key = created.body.key as string;
    assert.match(key, /^pra_/);

    const spec = await h.call('GET', '/agent/spec');
    assert.equal(spec.status, 200);
    assert.ok(spec.body.spec.endpoints.length >= 5);

    const me = await h.call('GET', '/agent/me', key);
    assert.deepEqual([me.body.limits.perRequest, me.body.limits.daily, me.body.usage.remainingDaily], ['0.03', '0.05', '0.05']);
    assert.equal(me.body.credits[0].available, '1');

    const cat = await h.call('GET', '/agent/catalog', key);
    assert.equal(cat.body.count, 2);
    const price = cat.body.items.find((i: any) => /token price/i.test(i.name));
    assert.equal(price.price.display, '0.02');
    assert.equal(price.platformFee.display, '0.0006');
    assert.equal(price.sellerReceives.display, '0.0194');
    assert.ok(price.responseRequirements.length >= 5);
    assert.deepEqual(price.freshness, { path: 'asOf', maxAgeSeconds: 60 });
    assert.equal(price.available, true);
    assert.equal(price.forThisAgent.canExecute, true);
    assert.equal(price.origin, 'payrail-demo');

    const insp = await h.call('GET', `/agent/listing/${price.id}`, key);
    assert.equal(insp.body.listing.input.via, 'query string');

    const ex = await h.call('POST', '/agent/execute', key, { listingId: price.id, idempotencyKey: 'agent-doc-0001', input: { id: 'eth' } }, false);
    assert.equal(ex.status, 201, ex.text);
    assert.equal(ex.body.outcome, 'QUALIFIED');
    assert.equal(ex.body.charged, true);
    assert.equal(ex.body.result.body.id, 'eth');
    const rc = ex.body.receipt;
    assert.deepEqual([rc.outcome, rc.charged.atomic, rc.platformFee.atomic, rc.sellerEarned.atomic, rc.settlement], ['QUALIFIED', '20000', '600', '19400', 'ledger']);
    assert.deepEqual(rc.ledger.map((t: any) => t.kind), ['hold', 'capture']);
    assert.equal(rc.idempotencyKey, 'agent-doc-0001', 'the internal agent prefix is not exposed');
    assert.equal(rc.validation.kind, 'structural');
    assert.ok(rc.validation.responseSha256);

    // retry with the same key: no second charge, same receipt
    const retry = await h.call('POST', '/agent/execute', key, { listingId: price.id, idempotencyKey: 'agent-doc-0001', input: { id: 'eth' } }, false);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.result.replay, true);
    assert.equal((await h.call('GET', '/agent/me', key)).body.credits[0].available, '0.98');
  } finally {
    await h.close();
  }
});

test('agent errors are explicit and actionable; failed validation and unresolved outcomes are structured results', async () => {
  const h = await start();
  try {
    const owner = await newBuyer(h, '0.025');
    const key = (await h.call('POST', '/agents', owner.token, { name: 'err-bot', perRequestCap: '0.02', dailyCap: '1', allowedListings: [h.demo.priceListingId] })).body.key as string;
    const exec = (listingId: string, k: string, input: unknown = { id: 'eth' }) => h.call('POST', '/agent/execute', key, { listingId, idempotencyKey: k, input }, false);

    assert.equal((await h.call('POST', '/agent/execute', 'pra_' + 'q'.repeat(43), { listingId: 'x' }, false)).body.code, 'KEY_INVALID');
    assert.equal((await h.call('GET', '/agent/catalog')).status, 401);
    const bad = await exec(h.demo.priceListingId, 'x', {});
    assert.equal(bad.body.code, 'BAD_INPUT');
    assert.equal((await exec(h.demo.priceListingId, 'agent-err-0001', { 'bad key': 1 })).body.code, 'BAD_INPUT');
    assert.equal((await exec('lst_nope', 'agent-err-0002')).body.code, 'NOT_FOUND');
    const notAllowed = await exec(h.demo.echoListingId, 'agent-err-0003', { text: 'x' });
    assert.equal(notAllowed.status, 403);
    assert.equal(notAllowed.body.code, 'LISTING_NOT_ALLOWED');
    assert.ok(notAllowed.body.hint);

    // failed validation: structured, not charged
    const stale = await exec(h.demo.priceListingId, 'agent-err-0004', { id: 'eth', scenario: 'stale' });
    assert.equal(stale.status, 201);
    assert.equal(stale.body.outcome, 'NOT_QUALIFIED');
    assert.equal(stale.body.charged, false);
    assert.match(stale.body.advice, /new idempotencyKey/);
    assert.match(stale.body.result.reason, /freshness/);

    // unresolved: held, not charged, advice says do not use a new key
    const hang = await exec(h.demo.priceListingId, 'agent-err-0005', { id: 'eth', scenario: 'hang' });
    assert.equal(hang.body.outcome, 'UNRESOLVED');
    assert.equal(hang.body.charged, false);
    assert.match(hang.body.advice, /Do not retry with a new key/);
    const rid = hang.body.result.executionId;
    assert.equal((await h.call('GET', `/agent/receipt/${rid}`, key)).body.receipt.outcome, 'UNRESOLVED');

    // insufficient credits: 0.025 - 0.02 held = 0.005 < 0.02
    const poor = await exec(h.demo.priceListingId, 'agent-err-0006');
    assert.equal(poor.status, 402);
    assert.equal(poor.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(poor.body.retryable, false);

    // unavailable listing
    h.db.prepare("UPDATE listings SET status = 'unpublished' WHERE id = ?").run(h.demo.priceListingId);
    const gone = await exec(h.demo.priceListingId, 'agent-err-0007');
    assert.equal(gone.body.code, 'LISTING_NOT_PUBLISHED');
    assert.equal((await h.call('GET', `/agent/listing/${h.demo.priceListingId}`, key)).status, 404);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('agents cannot reach another buyer\'s balance, receipts or history, and keys are never echoed', async () => {
  const h = await start();
  try {
    const alice = await newBuyer(h, '1');
    const bob = await newBuyer(h, '1');
    const keyA = (await h.call('POST', '/agents', alice.token, { name: 'alice-bot', perRequestCap: '0.05', dailyCap: '1' })).body.key as string;
    const keyB = (await h.call('POST', '/agents', bob.token, { name: 'bob-bot', perRequestCap: '0.05', dailyCap: '1' })).body.key as string;

    const a = await h.call('POST', '/agent/execute', keyA, { listingId: h.demo.priceListingId, idempotencyKey: 'iso-run-0001', input: { id: 'eth' } }, false);
    const bobsOwn = await run(h, bob.token, h.demo.priceListingId, 'bob-run-0001');
    assert.equal(a.status, 201);

    // bob's agent cannot read alice-agent's receipt, nor bob's own non-agent receipt, nor alice's
    assert.equal((await h.call('GET', `/agent/receipt/${a.body.result.executionId}`, keyB)).status, 404);
    assert.equal((await h.call('GET', `/agent/receipt/${bobsOwn.body.result.executionId}`, keyB)).status, 404);
    // an agent key is not a buyer or seller session
    for (const p of ['/me', '/executions', '/me/statement', '/seller/listings', '/seller/statement']) assert.equal((await h.call('GET', p, keyA)).status, 401, p);
    // listings in an agent's catalog carry no seller credentials or private fields
    const cat = await h.call('GET', '/agent/catalog', keyA);
    assert.ok(!/endpointUrl|endpoint_url|credential|walletAddress|wallet_address|challenge|apiKey|api-key/i.test(JSON.stringify(cat.body)));
    // its own history only
    const ex = await h.call('GET', '/agent/executions', keyB);
    assert.equal(ex.body.executions.length, 0);
    assert.equal((await h.call('GET', '/agent/executions', keyA)).body.executions.length, 1);
    // the key is only ever shown at creation: not in listings, errors, receipts or the database
    const listed = await h.call('GET', '/agents', alice.token);
    for (const k of [keyA, keyB]) {
      assert.ok(!listed.text.includes(k));
      assert.ok(!a.text.includes(k));
    }
    const badCall = await h.call('POST', '/agent/execute', keyA, { listingId: 'nope', idempotencyKey: 'iso-run-0002' }, false);
    assert.ok(!badCall.text.includes(keyA));
    const rows = h.db.prepare('SELECT key_hash FROM agents').all() as Array<{ key_hash: string }>;
    assert.ok(rows.every((r) => r.key_hash !== keyA && !keyA.includes(r.key_hash)));
    assert.equal(rows.length, 2);
  } finally {
    await h.close();
  }
});

// =================================================================== regression: vault key changed under a stored credential

test('an unreadable stored credential releases the hold (request never sent); re-seeding under the new key repairs the demo listing', async () => {
  const { executeRequest } = await import('../src/execute.ts');
  const { createAccount, deposit } = await import('../src/ledger.ts');
  const db = openDb(':memory:');
  const oldKey = generateMasterKey('ephemeral');
  const newKey = generateMasterKey('file1');
  const demo = seedDemo(db, oldKey, () => T0);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  deposit(db, { buyerId: buyer, asset: 'TESTUSDT', amountAtomic: 1_000_000n, ref: 'seed-k' }, () => T0);
  const dn = createDemoNetwork(() => T0);
  const opts = { now: () => T0, demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: dn.resolver, transport: dn.transport, timeoutMs: 150 } } };

  // the server restarts with a different vault key
  const broken = await executeRequest(db, [newKey], { buyerId: buyer, listingId: demo.priceListingId, idempotencyKey: 'vault-key-001', input: { id: 'eth' } }, opts);
  assert.equal(broken.state, 'NOT_QUALIFIED', 'nothing was sent, so it is released, not left unresolved');
  assert.match(broken.reason!, /CREDENTIAL_UNREADABLE/);
  assert.equal(balance(db, buyer, 'buyer_held', 'TESTUSDT'), 0n);
  assert.equal(balance(db, buyer, 'buyer_available', 'TESTUSDT'), 1_000_000n);

  seedDemo(db, newKey, () => T0); // start-up re-seeding repairs the platform-owned demo credential
  const ok = await executeRequest(db, [newKey], { buyerId: buyer, listingId: demo.priceListingId, idempotencyKey: 'vault-key-002', input: { id: 'eth' } }, opts);
  assert.equal(ok.state, 'QUALIFIED');
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
});
