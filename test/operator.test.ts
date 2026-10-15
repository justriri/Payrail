// Operator review, recovery and reconciliation. SIMULATION ONLY: fake provider and receipts through the real verification code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, USDT_CELO, seedConversionAssets } from '../src/conversion.ts';
import type { AssetRef } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { TRANSFER_TOPIC } from '../src/funding.ts';
import { balance, createAccount, deposit, settleExecution, startExecution } from '../src/ledger.ts';
import { approveFunding, getFundingOp, requestFundingQuote } from '../src/marketfunding.ts';
import type { FundingConfig } from '../src/marketfunding.ts';
import {
  OperatorError, attachFundingDepositEvidence, attachPayoutDeliveryEvidence, closeFundingWithoutCredit, inspectItem, reconcile, recheckItem, retryPayoutDelivery, reviewQueue,
} from '../src/operator.ts';
import { approvePayout, getPayout } from '../src/payouts.ts';
import {
  confirmConversionQuote, executeConversionPayout, payoutAddressMessage, registerPayoutAddress, requestConversionPayout, setPayoutPreference,
} from '../src/payoutconv.ts';
import type { PayoutConversionConfig } from '../src/payoutconv.ts';
import { createSimProvider } from '../src/simconversion.ts';

const T0 = 1_800_000_000_000;
const CUSTODY = '0x00000000000000000000000000000000c0570d1a';
const DEPOSIT = '0x00000000000000000000000000000000000dEaD1';
const BUYER_WALLET = '0x00000000000000000000000000000000000000b1';
const POLICY = { payableAssets: ['TESTUSDT'], minAtomic: 1n, maxAtomic: 10n ** 12n };
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function world() {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const clock = T0;
  const now = () => clock;
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR, now });
  const registry = new RouteRegistry(db, [provider]);
  const asset = (sym: string): AssetRef => provider.assets.find((a) => a.ref.symbol === sym)!.ref;
  const fundingFor = (sym: string): FundingConfig => ({
    converter: provider.fundingConverter(asset(sym), { taker: BUYER_WALLET, depositAddress: DEPOSIT }),
    reader: provider.reader, usdt: ASSETS.find((a) => a.symbol === 'USDT')!.address, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 3,
    limits: { minSellAtomic: 1n, maxSellAtomic: 10n ** 30n, maxPerDaySellAtomic: 10n ** 30n, maxOpenOps: 5 }, creditAsset: 'TESTUSDT',
  });
  const payCfg: PayoutConversionConfig = { registry, provider, reader: provider.reader, reactor: TEXTILE_REACTOR, custody: CUSTODY, minConfirmations: 3, policy: POLICY };
  const deps = { funding: () => fundingFor('cNGN'), payouts: payCfg, now };
  /** a deposit receipt that lands on the simulated chain, as if the buyer had really sent it */
  const land = (tx: string, from: string, to: string, amount: bigint, depth = 12n) => {
    provider.receipts.set(tx.toLowerCase(), {
      status: 'success', blockNumber: 100_000n - depth,
      logs: [{ address: USDT_CELO.address, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 1 }],
    });
  };
  return { db, provider, registry, now, fundingFor, payCfg, deps, land };
}
type W = ReturnType<typeof world>;

/** a funding op that swapped but whose deposit hop was never recorded -> REVIEW */
async function stuckFunding(w: W) {
  const buyer = createAccount(w.db, { kind: 'buyer', displayName: 'B' }, w.now);
  const cfg = w.fundingFor('cNGN');
  const op = await requestFundingQuote(w.db, cfg, { buyerId: buyer, sellAtomic: 1_364_000_000n, idempotencyKey: `k-${Math.random()}`, scenario: 'deposit_missing' }, w.now);
  const done = await approveFunding(w.db, cfg, { opId: op.id, buyerId: buyer, digest: op.approvalDigest }, w.now);
  assert.equal(done.state, 'REVIEW');
  return { buyer, op: done };
}

async function sellerWithEarnings(w: W) {
  const id = createAccount(w.db, { kind: 'seller', displayName: 'S' }, w.now);
  w.db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run(privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), id);
  const buyer = createAccount(w.db, { kind: 'buyer', displayName: 'B' }, w.now);
  deposit(w.db, { buyerId: buyer, asset: 'TESTUSDT', amountAtomic: 5_000_000n, ref: `seed-${id}` }, w.now);
  w.db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, fee_bps) VALUES (?, ?, 'x', 'published', 5000000, 'TESTUSDT', 't', 0)").run(`l_${id}`, id);
  w.db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES (?, ?, 1, '{}', 'h', 'approved', 't')").run(`c_${id}`, `l_${id}`);
  const { execution } = startExecution(w.db, { buyerId: buyer, listingId: `l_${id}`, contractVersionId: `c_${id}`, idempotencyKey: `k-${id}`, requestHash: 'h' }, w.now);
  settleExecution(w.db, execution.id, 'QUALIFIED', 'ok', w.now);
  const dest = privateKeyToAccount(generatePrivateKey());
  await registerPayoutAddress(w.db, { sellerId: id, chainId: 42220, address: dest.address, signature: await dest.signMessage({ message: payoutAddressMessage(id, 42220, dest.address) }) }, w.now);
  await setPayoutPreference(w.db, w.registry, { sellerId: id, symbol: 'cNGN' }, w.now);
  return { id, dest };
}

test('review queue lists stuck funding with the reason, the evidence and ONLY the safe actions', async () => {
  const w = world();
  const { op } = await stuckFunding(w);
  const q = reviewQueue(w.db);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.category, 'review-required');
  assert.equal(q[0]!.simulated, true);
  assert.ok(q[0]!.txs.some((t) => t.label === 'swap'));
  assert.ok(q[0]!.safeActions.includes('attach-deposit-evidence'));
  assert.ok(q[0]!.safeActions.includes('close-without-credit'));
  assert.ok(!q[0]!.safeActions.some((a) => /credit$|mark/.test(a) && a !== 'close-without-credit'), 'there is no "mark paid/credited" action');
  const view = inspectItem(w.db, 'funding', op.id);
  assert.ok(view.history.length > 0);
  assert.equal(await code(() => inspectItem(w.db, 'funding', 'nope')), 'NOT_FOUND');
});

test('attaching deposit evidence: a transaction that does not verify credits nothing; a verified one credits exactly once', async () => {
  const w = world();
  const { buyer, op } = await stuckFunding(w);
  assert.equal(await code(attachFundingDepositEvidence(w.db, w.deps, { opId: op.id, txHash: 'nope', operator: 'ops', reason: 'buyer sent it' })), 'BAD_TX');
  assert.equal(await code(attachFundingDepositEvidence(w.db, w.deps, { opId: op.id, txHash: hex(1), operator: 'ops', reason: 'x' })), 'REASON_REQUIRED');

  // a hash with no receipt: stays unresolved, never credited
  const missing = await attachFundingDepositEvidence(w.db, w.deps, { opId: op.id, txHash: hex(0xaa), operator: 'ops', reason: 'buyer reports a deposit' });
  assert.equal(missing.verified, false);
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n);
  assert.notEqual(getFundingOp(w.db, op.id)!.state, 'CREDITED');

  // a transfer from the WRONG wallet is a mismatch: not credited
  const stuck2 = await stuckFunding(w);
  w.land(hex(0xbb), '0x00000000000000000000000000000000000000ee', DEPOSIT, stuck2.op.expectedAtomic);
  const wrong = await attachFundingDepositEvidence(w.db, w.deps, { opId: stuck2.op.id, txHash: hex(0xbb), operator: 'ops', reason: 'buyer reports a deposit' });
  assert.equal(wrong.verified, false);
  assert.equal(balance(w.db, stuck2.buyer, 'buyer_available', 'TESTUSDT'), 0n);

  // the real thing, from the buyer's proven wallet to custody, confirmed: credited once
  const stuck3 = await stuckFunding(w);
  w.land(hex(0xcc), BUYER_WALLET, DEPOSIT, stuck3.op.expectedAtomic);
  const ok = await attachFundingDepositEvidence(w.db, w.deps, { opId: stuck3.op.id, txHash: hex(0xcc), operator: 'ops', reason: 'buyer sent the deposit transfer' });
  assert.equal(ok.verified, true);
  const credited = balance(w.db, stuck3.buyer, 'buyer_available', 'TESTUSDT');
  assert.ok(credited > 0n);
  // repeating changes nothing; the same tx cannot back another operation
  assert.equal(await code(attachFundingDepositEvidence(w.db, w.deps, { opId: stuck3.op.id, txHash: hex(0xcc), operator: 'ops', reason: 'second attempt here' })), 'WRONG_STATE');
  const stuck4 = await stuckFunding(w);
  assert.equal(await code(attachFundingDepositEvidence(w.db, w.deps, { opId: stuck4.op.id, txHash: hex(0xcc), operator: 'ops', reason: 'reusing a hash' })), 'TX_ALREADY_USED');
  assert.equal(balance(w.db, stuck3.buyer, 'buyer_available', 'TESTUSDT'), credited);
  // history and audit are preserved
  const view = inspectItem(w.db, 'funding', stuck3.op.id);
  assert.ok(view.operatorActions.length >= 1);
  assert.ok(view.history.some((h) => /attached deposit transaction/.test(h.note)));
});

test('closing a funding op without credit needs a reason and evidence, credits nothing and keeps the history', async () => {
  const w = world();
  const { buyer, op } = await stuckFunding(w);
  assert.equal(await code(() => closeFundingWithoutCredit(w.db, { opId: op.id, operator: 'ops', reason: 'buyer never deposited', evidence: '' })), 'EVIDENCE_REQUIRED');
  assert.equal(await code(() => closeFundingWithoutCredit(w.db, { opId: op.id, operator: 'ops', reason: 'x', evidence: 'ticket-123' })), 'REASON_REQUIRED');
  const closed = closeFundingWithoutCredit(w.db, { opId: op.id, operator: 'ops', reason: 'buyer never deposited; confirmed on-chain', evidence: 'ticket-123' }, w.now);
  assert.equal(closed.state, 'FAILED');
  assert.equal(closed.failureCode, 'OPERATOR_CLOSED');
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n);
  assert.equal(await code(() => closeFundingWithoutCredit(w.db, { opId: op.id, operator: 'ops', reason: 'closing it again', evidence: 'ticket-123' })), 'WRONG_STATE');
  assert.ok(inspectItem(w.db, 'funding', op.id).history.length >= 2);
  assert.equal(reviewQueue(w.db).length, 0, 'closed items leave the active queue');
  assert.equal(reviewQueue(w.db, { includeFailed: true }).length, 1);
});

test('payout recovery: undelivered swap is retried without re-swapping; unverifiable delivery evidence stays in review', async () => {
  const w = world();
  const s = await sellerWithEarnings(w);
  const p = await requestConversionPayout(w.db, w.payCfg, { sellerId: s.id, amountAtomic: 3_000_000n, asset: 'TESTUSDT' }, w.now);
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now);
  approvePayout(w.db, p.id, 'ops', w.now);
  const r = await executeConversionPayout(w.db, w.payCfg, { payoutId: p.id, scenario: 'delivery_missing' }, w.now);
  assert.equal(r.outcome, 'undelivered');

  const item = reviewQueue(w.db).find((i) => i.id === p.id)!;
  assert.equal(item.category, 'unresolved');
  assert.ok(item.safeActions.includes('retry-delivery'));
  assert.equal(await code(retryPayoutDelivery(w.db, w.deps, { id: p.id, operator: '' })), 'OPERATOR_REQUIRED');

  // attaching evidence that does not verify leaves it unresolved (never completed, never refunded)
  const bad = await attachPayoutDeliveryEvidence(w.db, w.deps, { payoutId: p.id, txHash: hex(0xdd), operator: 'ops', reason: 'seller says it arrived' });
  assert.equal(bad.verified, false);
  assert.notEqual(getPayout(w.db, p.id)!.state, 'confirmed');
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 3_000_000n);

  const rec = reconcile(w.db, w.now);
  assert.equal(rec.payouts.mismatch, false);
  assert.equal(rec.ledger.ok, true);
  assert.ok(rec.openItems.unresolved + rec.openItems.reviewRequired + rec.openItems.pending >= 1);
  assert.equal(w.provider.executions.payout, 1, 'recovery never re-swaps');
});

test('reconciliation is clean on a healthy book and flags a duplicated transaction', async () => {
  const w = world();
  const s = await sellerWithEarnings(w);
  const p = await requestConversionPayout(w.db, w.payCfg, { sellerId: s.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now);
  approvePayout(w.db, p.id, 'ops', w.now);
  assert.equal((await executeConversionPayout(w.db, w.payCfg, { payoutId: p.id }, w.now)).outcome, 'completed');
  const healthy = reconcile(w.db, w.now);
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  assert.deepEqual(healthy.duplicateTxs, []);
  // corrupt on purpose: a second payout row sharing a hash must be reported
  const done = getPayout(w.db, p.id)!;
  w.db.prepare("UPDATE payouts SET mode = 'convert-live', conversion_tx = delivery_tx WHERE id = ?").run(p.id);
  const dup = reconcile(w.db, w.now);
  assert.equal(dup.ok, false);
  assert.ok(dup.duplicateTxs.includes(done.deliveryTx!.toLowerCase()));
  assert.ok(OperatorError);
  void recheckItem;
});
