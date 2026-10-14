// Phase 2: on-chain deposit crediting, seller payouts, agent keys, and the ledger migration.
// ALL chain access here is a FAKE reader. These tests prove the accounting and verification logic, not live behaviour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MIGRATIONS, migrate, openDb, query } from '../src/db.ts';
import { AgentError, authenticateAgent, createAgent, executeAsAgent, listAgents, revokeAgent } from '../src/agents.ts';
import { createDemoNetwork, seedDemo } from '../src/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import type { ExecuteOptions } from '../src/execute.ts';
import { TRANSFER_TOPIC, confirmDeposit, fundingMessage, registerFundingWallet } from '../src/funding.ts';
import type { ChainLog, ChainReader, ChainReceipt, FundingConfig } from '../src/funding.ts';
import { balance, createAccount, deposit, startExecution, verifyLedger } from '../src/ledger.ts';
import { approvePayout, cancelPayout, getPayout, markSent, requestPayout, verifyPayout } from '../src/payouts.ts';
import type { PayoutPolicy } from '../src/payouts.ts';
import { generateMasterKey } from '../src/vault.ts';

const T0 = 1_800_000_000_000;
const mk = generateMasterKey('k1');
const TOKEN = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
const DEPOSIT_ADDR = '0x00000000000000000000000000000000000dEaD1';
const PLATFORM_WALLET = '0x00000000000000000000000000000000000dEaD2';
const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function transferLog(o: { token?: string; from: string; to: string; amount: bigint; logIndex?: number }): ChainLog {
  return { address: o.token ?? TOKEN, topics: [TRANSFER_TOPIC, pad(o.from), pad(o.to)], data: word(o.amount), logIndex: o.logIndex ?? 0 };
}
function fakeChain() {
  const receipts = new Map<string, ChainReceipt>();
  let head = 1_000n;
  const reader: ChainReader = {
    blockNumber: async () => head,
    receipt: async (h) => receipts.get(h.toLowerCase()) ?? null,
  };
  return {
    reader,
    add: (hash: string, r: ChainReceipt) => receipts.set(hash.toLowerCase(), r),
    setHead: (n: bigint) => (head = n),
  };
}
const cfgFor = (reader: ChainReader, over: Partial<FundingConfig> = {}): FundingConfig => ({
  chainId: 42220, token: TOKEN, asset: 'USDT', depositAddress: DEPOSIT_ADDR, minConfirmations: 10, maxDepositAtomic: 50_000_000n, reader, ...over,
});

async function buyerWithWallet(db: ReturnType<typeof openDb>) {
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  const w = privateKeyToAccount(generatePrivateKey());
  await registerFundingWallet(db, buyer, w.address, await w.signMessage({ message: fundingMessage(buyer, w.address) }), () => T0);
  return { buyer, w };
}

// ------------------------------------------------------------------ migration of a populated database

test('migration v5 preserves a populated database, keeps the immutability triggers, and the ledger stays sound', () => {
  const db = openDb(':memory:', MIGRATIONS.filter((m) => m.version <= 4));
  const demo = seedDemo(db, mk, () => T0);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  deposit(db, { buyerId: buyer, asset: 'TESTUSDT', amountAtomic: 1_000_000n, ref: 'old-1' }, () => T0);
  const hold = startExecution(db, { buyerId: buyer, listingId: demo.priceListingId, contractVersionId: (db.prepare('SELECT id FROM contract_versions WHERE listing_id = ?').get(demo.priceListingId) as { id: string }).id, idempotencyKey: 'old-exec-1', requestHash: 'h' }, () => T0);
  const before = { avail: balance(db, buyer, 'buyer_available', 'TESTUSDT'), held: balance(db, buyer, 'buyer_held', 'TESTUSDT') };

  assert.deepEqual(migrate(db, MIGRATIONS), [5]);
  assert.equal(balance(db, buyer, 'buyer_available', 'TESTUSDT'), before.avail);
  assert.equal(balance(db, buyer, 'buyer_held', 'TESTUSDT'), before.held);
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
  assert.equal(query(db, 'SELECT id FROM executions WHERE id = ?', hold.execution.id).length, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'foreign keys are back on');
  assert.throws(() => db.prepare("UPDATE ledger_transactions SET memo = 'x'").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM ledger_entries').run(), /immutable/);
  // the new kinds are accepted now
  db.prepare("INSERT INTO ledger_transactions (kind, ref, created_at) VALUES ('payout_request', 'p1', 't')").run();
});

// ------------------------------------------------------------------ deposits

test('deposit: a verified transfer from the registered wallet to the deposit address is credited exactly once', async () => {
  const db = openDb(':memory:');
  const { buyer, w } = await buyerWithWallet(db);
  const chain = fakeChain();
  chain.add(H(1), { status: 'success', blockNumber: 900n, logs: [transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 2_500_000n, logIndex: 3 })] });
  const cfg = cfgFor(chain.reader);
  const r = await confirmDeposit(db, cfg, buyer, H(1), () => T0);
  assert.equal(r.credited.length, 1);
  assert.equal(r.credited[0]!.amountAtomic, 2_500_000n);
  assert.equal(r.credited[0]!.created, true);
  assert.equal(balance(db, buyer, 'buyer_available', 'USDT'), 2_500_000n);
  const again = await confirmDeposit(db, cfg, buyer, H(1), () => T0);
  assert.equal(again.credited[0]!.created, false);
  assert.equal(balance(db, buyer, 'buyer_available', 'USDT'), 2_500_000n, 'never credited twice');
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
  assert.equal(balance(db, buyer, 'buyer_available', 'TESTUSDT'), 0n, 'real funds are a different asset from test credits');
});

test('deposit: everything that does not match is refused and credits nothing', async () => {
  const db = openDb(':memory:');
  const { buyer, w } = await buyerWithWallet(db);
  const stranger = privateKeyToAccount(generatePrivateKey());
  const chain = fakeChain();
  const cfg = cfgFor(chain.reader);
  const ok = { status: 'success' as const, blockNumber: 900n };
  chain.add(H(10), { ...ok, logs: [transferLog({ from: stranger.address, to: DEPOSIT_ADDR, amount: 1_000_000n })] });
  chain.add(H(11), { ...ok, logs: [transferLog({ from: w.address, to: '0x000000000000000000000000000000000000beef', amount: 1_000_000n })] });
  chain.add(H(12), { ...ok, logs: [transferLog({ token: '0x0000000000000000000000000000000000001234', from: w.address, to: DEPOSIT_ADDR, amount: 1_000_000n })] });
  chain.add(H(13), { status: 'reverted', blockNumber: 900n, logs: [transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 1_000_000n })] });
  chain.add(H(14), { status: 'success', blockNumber: 995n, logs: [transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 1_000_000n })] });
  chain.add(H(15), { ...ok, logs: [transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 51_000_000n })] });
  chain.add(H(16), { ...ok, logs: [{ address: TOKEN, topics: [pad(w.address)], data: word(1n), logIndex: 0 }] });
  const expect: Array<[string, string]> = [
    [H(10), 'NO_MATCHING_TRANSFER'], // from a wallet this buyer never registered
    [H(11), 'NO_MATCHING_TRANSFER'], // to a different address
    [H(12), 'NO_MATCHING_TRANSFER'], // a different token
    [H(13), 'TX_REVERTED'],
    [H(14), 'NOT_ENOUGH_CONFIRMATIONS'],
    [H(15), 'OVER_LIMIT'],
    [H(16), 'NO_MATCHING_TRANSFER'], // not a Transfer event
    [H(99), 'TX_NOT_FOUND'],
    ['0x1234', 'BAD_INPUT'],
  ];
  for (const [hash, want] of expect) assert.equal(await code(confirmDeposit(db, cfg, buyer, hash, () => T0)), want, hash);
  assert.equal(balance(db, buyer, 'buyer_available', 'USDT'), 0n);
  const noWallet = createAccount(db, { kind: 'buyer', displayName: 'N' }, () => T0);
  assert.equal(await code(confirmDeposit(db, cfg, noWallet, H(10), () => T0)), 'NO_FUNDING_WALLET');
  // a failing read is reported, not treated as "no deposit"
  const broken: ChainReader = { blockNumber: async () => { throw new Error('rpc down'); }, receipt: async () => null };
  assert.equal(await code(confirmDeposit(db, cfgFor(broken), buyer, H(10), () => T0)), 'READ_FAILED');
});

test('deposit: a transaction with several transfers credits each qualifying one once; a wallet cannot belong to two buyers; bad signatures fail', async () => {
  const db = openDb(':memory:');
  const { buyer, w } = await buyerWithWallet(db);
  const chain = fakeChain();
  chain.add(H(20), {
    status: 'success',
    blockNumber: 900n,
    logs: [
      transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 1_000_000n, logIndex: 0 }),
      transferLog({ from: w.address, to: DEPOSIT_ADDR, amount: 2_000_000n, logIndex: 1 }),
      transferLog({ from: w.address, to: '0x000000000000000000000000000000000000beef', amount: 9_000_000n, logIndex: 2 }),
    ],
  });
  const r = await confirmDeposit(db, cfgFor(chain.reader), buyer, H(20), () => T0);
  assert.deepEqual(r.credited.map((c) => c.amountAtomic), [1_000_000n, 2_000_000n]);
  assert.equal(balance(db, buyer, 'buyer_available', 'USDT'), 3_000_000n);

  const other = createAccount(db, { kind: 'buyer', displayName: 'O' }, () => T0);
  assert.equal(await code(registerFundingWallet(db, other, w.address, await w.signMessage({ message: fundingMessage(other, w.address) }), () => T0)), 'WALLET_TAKEN');
  const x = privateKeyToAccount(generatePrivateKey());
  assert.equal(await code(registerFundingWallet(db, other, x.address, await w.signMessage({ message: fundingMessage(other, x.address) }), () => T0)), 'BAD_SIGNATURE');
  assert.equal(await code(registerFundingWallet(db, other, 'nope', 'sig', () => T0)), 'BAD_INPUT');
  // a signature made for another buyer cannot be reused
  assert.equal(await code(registerFundingWallet(db, other, x.address, await x.signMessage({ message: fundingMessage(buyer, x.address) }), () => T0)), 'BAD_SIGNATURE');
});

// ------------------------------------------------------------------ payouts

async function fundedSeller(db: ReturnType<typeof openDb>, earnings = 5_000_000n) {
  const seller = createAccount(db, { kind: 'seller', displayName: 'S' }, () => T0);
  const w = privateKeyToAccount(generatePrivateKey());
  db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run(w.address.toLowerCase(), seller);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  deposit(db, { buyerId: buyer, asset: 'USDT', amountAtomic: earnings, ref: `seed-${seller}` }, () => T0);
  // move the money to the seller through a real execution so the ledger path is the production one
  db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, fee_bps) VALUES (?, ?, 'x', 'published', ?, 'USDT', 't', 0)").run(`l_${seller}`, seller, earnings);
  db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES (?, ?, 1, '{}', 'h', 'approved', 't')").run(`c_${seller}`, `l_${seller}`);
  const { execution } = startExecution(db, { buyerId: buyer, listingId: `l_${seller}`, contractVersionId: `c_${seller}`, idempotencyKey: `k-${seller}`, requestHash: 'h' }, () => T0);
  const { settleExecution } = await import('../src/ledger.ts');
  settleExecution(db, execution.id, 'QUALIFIED', 'ok', () => T0);
  return { seller, w };
}
const policy: PayoutPolicy = { payableAssets: ['USDT'], minAtomic: 1_000_000n, maxAtomic: 100_000_000n };

test('payout: request -> approve -> sent -> confirmed on-chain; every step keeps the ledger balanced', async () => {
  const db = openDb(':memory:');
  const { seller, w } = await fundedSeller(db);
  assert.equal(balance(db, seller, 'seller_earnings', 'USDT'), 5_000_000n);
  const p = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 3_000_000n }, policy, () => T0);
  assert.equal(p.state, 'requested');
  assert.equal(p.destination, w.address.toLowerCase(), 'payouts go only to the verified wallet');
  assert.equal(balance(db, seller, 'seller_earnings', 'USDT'), 2_000_000n);
  assert.equal(balance(db, seller, 'payout_pending', 'USDT'), 3_000_000n);
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });

  const chain = fakeChain();
  const vcfg = { reader: chain.reader, token: TOKEN, sourceAddress: PLATFORM_WALLET, minConfirmations: 5 };
  assert.equal(await code(verifyPayout(db, vcfg, p.id)), 'WRONG_STATE', 'cannot verify before it is sent');
  assert.equal(await code(() => markSent(db, p.id, H(30), 'op')), 'WRONG_STATE', 'cannot send before approval');
  assert.equal(approvePayout(db, p.id, 'operator', () => T0).state, 'approved');
  assert.equal(approvePayout(db, p.id, 'operator').state, 'approved', 'idempotent');
  assert.equal(await code(() => cancelPayout(db, p.id, 'seller')), 'no error', 'still cancellable before sending');
  // (cancelled above: start a fresh one for the send path)
  const p2 = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 3_000_000n }, policy, () => T0);
  approvePayout(db, p2.id, 'operator', () => T0);
  const sent = markSent(db, p2.id, H(31), 'operator', () => T0);
  assert.equal(sent.state, 'sent');
  assert.equal(await code(() => cancelPayout(db, p2.id, 'seller')), 'WRONG_STATE', 'cannot cancel once sent');
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });

  // not on chain yet -> stays sent, funds stay pending
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'not_found');
  assert.equal(getPayout(db, p2.id)!.state, 'sent');
  assert.equal(balance(db, seller, 'payout_pending', 'USDT'), 3_000_000n);
  // wrong amount / wrong destination / wrong source do not confirm
  const rcpt = (log: ChainLog): ChainReceipt => ({ status: 'success', blockNumber: 990n, logs: [log] });
  chain.add(H(31), rcpt(transferLog({ from: PLATFORM_WALLET, to: w.address, amount: 2_999_999n })));
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'mismatch');
  chain.add(H(31), rcpt(transferLog({ from: PLATFORM_WALLET, to: '0x000000000000000000000000000000000000beef', amount: 3_000_000n })));
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'mismatch');
  chain.add(H(31), rcpt(transferLog({ from: '0x000000000000000000000000000000000000beef', to: w.address, amount: 3_000_000n })));
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'mismatch');
  // too few confirmations
  chain.add(H(31), { status: 'success', blockNumber: 999n, logs: [transferLog({ from: PLATFORM_WALLET, to: w.address, amount: 3_000_000n })] });
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'pending');
  // the real thing
  chain.add(H(31), rcpt(transferLog({ from: PLATFORM_WALLET, to: w.address, amount: 3_000_000n })));
  const done = await verifyPayout(db, vcfg, p2.id, () => T0);
  assert.equal(done.observed, 'confirmed');
  assert.equal(done.payout.state, 'confirmed');
  assert.equal(balance(db, seller, 'payout_pending', 'USDT'), 0n);
  assert.equal(balance(db, seller, 'seller_earnings', 'USDT'), 2_000_000n);
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
  assert.equal((await verifyPayout(db, vcfg, p2.id, () => T0)).observed, 'confirmed', 'idempotent');
});

test('payout: a reverted transfer returns the funds; refusals (test asset, limits, balance, no wallet); cancel restores earnings', async () => {
  const db = openDb(':memory:');
  const { seller } = await fundedSeller(db, 4_000_000n);
  assert.equal(await code(() => requestPayout(db, seller, { asset: 'TESTUSDT', amountAtomic: 1_000_000n }, policy)), 'TEST_ASSET');
  assert.equal(await code(() => requestPayout(db, seller, { asset: 'USDT', amountAtomic: 10n }, policy)), 'BAD_AMOUNT');
  assert.equal(await code(() => requestPayout(db, seller, { asset: 'USDT', amountAtomic: 200_000_000n }, policy)), 'OVER_LIMIT');
  assert.equal(await code(() => requestPayout(db, seller, { asset: 'USDT', amountAtomic: 4_000_001n }, policy)), 'INSUFFICIENT_EARNINGS');
  const noWallet = createAccount(db, { kind: 'seller', displayName: 'NW' }, () => T0);
  assert.equal(await code(() => requestPayout(db, noWallet, { asset: 'USDT', amountAtomic: 1_000_000n }, policy)), 'NO_WALLET');

  // two requests cannot spend the same earnings
  requestPayout(db, seller, { asset: 'USDT', amountAtomic: 3_000_000n }, policy, () => T0);
  assert.equal(await code(() => requestPayout(db, seller, { asset: 'USDT', amountAtomic: 2_000_000n }, policy)), 'INSUFFICIENT_EARNINGS');

  const p = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 1_000_000n }, policy, () => T0);
  const c = cancelPayout(db, p.id, 'seller', () => T0);
  assert.equal(c.state, 'cancelled');
  assert.equal(cancelPayout(db, p.id, 'seller').state, 'cancelled', 'idempotent');
  assert.equal(balance(db, seller, 'seller_earnings', 'USDT'), 1_000_000n);

  const q = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 1_000_000n }, policy, () => T0);
  approvePayout(db, q.id, 'op', () => T0);
  markSent(db, q.id, H(40), 'op', () => T0);
  const chain = fakeChain();
  chain.add(H(40), { status: 'reverted', blockNumber: 900n, logs: [] });
  const r = await verifyPayout(db, { reader: chain.reader, token: TOKEN, sourceAddress: PLATFORM_WALLET, minConfirmations: 1 }, q.id, () => T0);
  assert.equal(r.observed, 'reverted');
  assert.equal(r.payout.state, 'failed');
  assert.equal(balance(db, seller, 'seller_earnings', 'USDT'), 1_000_000n);
  assert.equal(balance(db, seller, 'payout_pending', 'USDT'), 3_000_000n, 'the first, still-open 3.0 request');
  assert.deepEqual(verifyLedger(db), { ok: true, problems: [] });
  assert.equal(await code(() => markSent(db, q.id, 'not-a-hash', 'op')), 'BAD_HASH');
});

test('verifyLedger catches a payout whose state does not match its ledger entries', async () => {
  const db = openDb(':memory:');
  const { seller } = await fundedSeller(db);
  const p = requestPayout(db, seller, { asset: 'USDT', amountAtomic: 1_000_000n }, policy, () => T0);
  db.prepare("UPDATE payouts SET state = 'confirmed' WHERE id = ?").run(p.id); // tampering
  const v = verifyLedger(db);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('payout')));
});

// ------------------------------------------------------------------ agents

function agentSetup(credits = 1_000_000n) {
  const db = openDb(':memory:');
  const demo = seedDemo(db, mk, () => T0);
  const owner = createAccount(db, { kind: 'buyer', displayName: 'Owner' }, () => T0);
  deposit(db, { buyerId: owner, asset: 'TESTUSDT', amountAtomic: credits, ref: 'agent-seed' }, () => T0);
  const net = createDemoNetwork(() => T0);
  let calls = 0;
  const opts: ExecuteOptions = {
    now: () => T0,
    demoCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: net.resolver, transport: (r) => (calls++, net.transport(r)), timeoutMs: 150 } },
  };
  return { db, demo, owner, opts, calls: () => calls };
}

test('agent: spends only inside its caps and allow-list; the key is hashed; revocation is immediate', async () => {
  const s = agentSetup();
  const { agent, key } = createAgent(s.db, s.owner, { name: 'research-bot', perRequestCapAtomic: 20_000n, dailyCapAtomic: 50_000n, allowedListings: [s.demo.priceListingId] }, () => T0);
  assert.match(key, /^pra_/);
  assert.equal(JSON.stringify(query(s.db, 'SELECT * FROM agents'), (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(key), false, 'the key is not stored');
  assert.equal(authenticateAgent(s.db, key).id, agent.id);
  assert.equal(await code(() => authenticateAgent(s.db, 'pra_' + 'x'.repeat(43))), 'KEY_INVALID');
  assert.equal(await code(() => authenticateAgent(s.db, 'garbage')), 'KEY_INVALID');

  const run = (listingId: string, k: string, input: unknown = { id: 'eth' }) => executeAsAgent(s.db, [mk], agent, { listingId, idempotencyKey: k, input }, s.opts);
  const r1 = await run(s.demo.priceListingId, 'agent-req-01');
  assert.equal(r1.charged, true);
  assert.equal(await code(run(s.demo.echoListingId, 'agent-req-02', { text: 'x' })), 'LISTING_NOT_ALLOWED');
  const r2 = await run(s.demo.priceListingId, 'agent-req-03');
  assert.equal(r2.charged, true);
  // 0.02 + 0.02 = 0.04 committed of 0.05: a third 0.02 would exceed the daily cap
  assert.equal(await code(run(s.demo.priceListingId, 'agent-req-04')), 'DAILY_CAP');
  // a replay of an existing key is not new spend
  assert.equal((await run(s.demo.priceListingId, 'agent-req-01')).replay, true);
  assert.equal(s.calls(), 2);
  assert.equal(listAgents(s.db, s.owner, () => T0)[0]!.spentLast24hAtomic, 40_000n);

  // the cap window rolls: 25 hours later the agent can spend again
  const net2 = createDemoNetwork(() => T0 + 25 * 3_600_000);
  const later: ExecuteOptions = { now: () => T0 + 25 * 3_600_000, demoCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: net2.resolver, transport: net2.transport, timeoutMs: 150 } } };
  assert.equal((await executeAsAgent(s.db, [mk], agent, { listingId: s.demo.priceListingId, idempotencyKey: 'agent-req-05', input: { id: 'btc' } }, later)).charged, true);

  revokeAgent(s.db, s.owner, agent.id, () => T0);
  assert.equal(await code(() => authenticateAgent(s.db, key)), 'KEY_INVALID');
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] });
});

test('agent: per-request cap, balance, input validation and ownership are enforced; failed responses do not count against the cap', async () => {
  const s = agentSetup(30_000n);
  const tight = createAgent(s.db, s.owner, { name: 'tight-bot', perRequestCapAtomic: 10_000n, dailyCapAtomic: 100_000n }, () => T0);
  assert.equal(await code(executeAsAgent(s.db, [mk], tight.agent, { listingId: s.demo.priceListingId, idempotencyKey: 'agent-cap-001', input: {} }, s.opts)), 'PER_REQUEST_CAP');
  assert.equal(await code(executeAsAgent(s.db, [mk], tight.agent, { listingId: 'nope', idempotencyKey: 'agent-cap-002', input: {} }, s.opts)), 'NOT_FOUND');
  assert.equal(await code(executeAsAgent(s.db, [mk], tight.agent, { listingId: s.demo.echoListingId, idempotencyKey: 'x', input: {} }, s.opts)), 'BAD_INPUT');

  const bot = createAgent(s.db, s.owner, { name: 'wide-bot', perRequestCapAtomic: 20_000n, dailyCapAtomic: 40_000n }, () => T0);
  // a stale (non-qualifying) answer is released, so it frees the cap again
  const stale = await executeAsAgent(s.db, [mk], bot.agent, { listingId: s.demo.priceListingId, idempotencyKey: 'agent-stale-1', input: { id: 'eth', scenario: 'stale' } }, s.opts);
  assert.equal(stale.charged, false);
  assert.equal(listAgents(s.db, s.owner, () => T0).find((a) => a.id === bot.agent.id)!.spentLast24hAtomic, 0n);
  // the owner's balance still binds: only 0.03 exists
  assert.equal((await executeAsAgent(s.db, [mk], bot.agent, { listingId: s.demo.priceListingId, idempotencyKey: 'agent-ok-0001', input: { id: 'eth' } }, s.opts)).charged, true);
  assert.equal(await code(executeAsAgent(s.db, [mk], bot.agent, { listingId: s.demo.priceListingId, idempotencyKey: 'agent-ok-0002', input: { id: 'eth' } }, s.opts)), 'INSUFFICIENT_CREDITS');

  const stranger = createAccount(s.db, { kind: 'buyer', displayName: 'S' }, () => T0);
  assert.equal(await code(() => revokeAgent(s.db, stranger, bot.agent.id)), 'NOT_OWNER');
  assert.equal(await code(() => createAgent(s.db, s.owner, { name: 'bad', perRequestCapAtomic: 10n, dailyCapAtomic: 5n })), 'BAD_INPUT');
  assert.ok(AgentError);
});
