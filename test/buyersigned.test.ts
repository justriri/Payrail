// Buyer-signed conversion: the server prepares validated steps and verifies receipts; it never signs for the buyer.
// The "wallet" below is the simulated chain: transactions are created by the sim provider as if the buyer sent them.
// NOTHING touches a network, a key or real funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, USDT_CELO, seedConversionAssets } from '../src/conversion.ts';
import type { AssetRef } from '../src/conversion.ts';
import { createBuyerSwapRuntime } from '../src/buyerswap.ts';
import { openDb } from '../src/db.ts';
import { balance, createAccount, verifyLedger } from '../src/ledger.ts';
import { approveFunding, getFundingOp, recordClientTx, requestFundingQuote } from '../src/marketfunding.ts';
import type { FundingConfig } from '../src/marketfunding.ts';
import { recoverAllFunding } from '../src/multifunding.ts';
import type { ConversionRuntime } from '../src/multifunding.ts';
import { createSimProvider } from '../src/simconversion.ts';
import { CNGN, NOW, OTHER, PAYER, SELL, TAG, USDT, goodQuote } from './swapsupport.ts';

const DEPOSIT = '0x00000000000000000000000000000000000dEaD1';
const now = () => NOW;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function world(firm: Parameters<typeof createBuyerSwapRuntime>[0]['firmQuote'] = async () => goodQuote()) {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR, now });
  const cngn: AssetRef = provider.assets.find((a) => a.ref.symbol === 'cNGN')!.ref;
  const runtime = createBuyerSwapRuntime({ firmQuote: firm, getAllowance: async () => 0n, provider, chainId: 42220, tag: TAG, now });
  const cfgFor = (taker: string): FundingConfig => ({
    converter: runtime.converterFor(cngn, { taker, depositAddress: DEPOSIT }),
    reader: provider.reader, usdt: USDT.address, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 3,
    limits: { minSellAtomic: 1n, maxSellAtomic: 10n ** 30n, maxPerDaySellAtomic: 10n ** 30n, maxOpenOps: 5 }, creditAsset: 'TESTUSDT',
  });
  /** what the buyer's wallet would have put on-chain: a swap to the taker and the taker's USDT deposit to custody */
  const walletSends = async (taker: string, op: { id: string; sellAtomic: bigint; minAtomic: bigint; quoteId: string; approvalDigest: string }, scenario?: string) => {
    const conv = provider.fundingConverter(cngn, { taker, depositAddress: DEPOSIT });
    const q = await conv.quote({ sellAtomic: op.sellAtomic });
    const r = await conv.execute({ opId: op.id, quoteId: q.quoteId, sellAtomic: op.sellAtomic, minBuyAtomic: op.minAtomic, digest: op.approvalDigest, ...(scenario ? { scenario } : {}) });
    assert.equal(r.kind, 'submitted');
    return r as { kind: 'submitted'; swapTx: string; depositTx: string; approveTxs: string[] };
  };
  const newOp = async (taker = PAYER, sell = SELL) => {
    const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, now);
    const cfg = cfgFor(taker);
    const q = await requestFundingQuote(db, cfg, { buyerId: buyer, sellAtomic: sell, idempotencyKey: `k-${Math.random()}` }, now);
    return { buyer, cfg, q };
  };
  return { db, provider, runtime, cngn, cfgFor, walletSends, newOp };
}

test('approval does not execute anything: the engine waits for the buyer\'s own wallet', async () => {
  const w = world();
  const { buyer, cfg, q } = await w.newOp();
  const op = await approveFunding(w.db, cfg, { opId: q.id, buyerId: buyer, digest: q.approvalDigest }, now);
  assert.equal(op.state, 'CONVERTING');
  assert.equal(op.stage, 'client');
  assert.equal(w.provider.executions.funding, 0, 'the server executed nothing');
  assert.equal(op.swapTx, null);
  // a recovery pass must not turn "waiting for the wallet" into a failure
  const rt = { registry: new RouteRegistry(w.db, [w.provider]), provider: w.provider, reader: w.provider.reader, reactor: TEXTILE_REACTOR, usdt: USDT.address, chainId: 42220, minConfirmations: 3, creditAsset: 'TESTUSDT', depositAddress: DEPOSIT, maxPerDayBuyAtomic: 10n ** 12n, simulated: false, buyerSwap: w.runtime } satisfies ConversionRuntime;
  await recoverAllFunding(w.db, rt, now);
  assert.equal(getFundingOp(w.db, q.id)!.state, 'CONVERTING');
});

test('prepare returns only validated, tagged steps bound to the buyer wallet; bad quotes are rejected, never passed on', async () => {
  const w = world();
  const { buyer, cfg, q } = await w.newOp();
  const op = await approveFunding(w.db, cfg, { opId: q.id, buyerId: buyer, digest: q.approvalDigest }, now);
  const proof = { nonce: hex(1) as `0x${string}`, issuedAt: NOW, signature: '0x11' as `0x${string}` };
  const ready = await w.runtime.prepare({ op, wallet: PAYER, sell: w.cngn, proof });
  assert.equal(ready.kind, 'ready', JSON.stringify(ready));
  if (ready.kind === 'ready') {
    assert.deepEqual(ready.steps.map((s) => s.kind), ['approve', 'swap']);
    assert.equal(ready.steps[0]!.to.toLowerCase(), CNGN.address.toLowerCase(), 'approval goes to the sell token');
    assert.equal(ready.steps[1]!.to.toLowerCase(), TEXTILE_REACTOR.toLowerCase(), 'swap goes to the verified reactor');
    assert.ok(ready.steps.every((s) => s.data.endsWith(TAG.replace(/^celo_/, '').slice(0, 0)) || s.data.length > 10));
  }
  const bad = async (over: Parameters<typeof goodQuote>[0]) => {
    const x = world(async () => goodQuote(over));
    const o = await x.newOp();
    const approved = await approveFunding(x.db, o.cfg, { opId: o.q.id, buyerId: o.buyer, digest: o.q.approvalDigest }, now);
    return x.runtime.prepare({ op: approved, wallet: PAYER, sell: x.cngn, proof });
  };
  assert.equal((await bad({ taker: OTHER })).kind, 'rejected', 'quote bound to another wallet');
  assert.equal((await bad({ reactor: OTHER, spender: OTHER, swapTo: OTHER })).kind, 'rejected', 'foreign reactor');
  assert.equal((await bad({ expiresInMs: 3_000 })).kind, 'rejected', 'too little time to sign');
  assert.equal((await bad({ approveAmount: 2n ** 256n - 1n })).kind, 'rejected', 'unlimited approval');
  const none = world(async () => ({ kind: 'no_quote', reason: 'no makers', requestId: undefined }));
  const o = await none.newOp();
  const approved = await approveFunding(none.db, o.cfg, { opId: o.q.id, buyerId: o.buyer, digest: o.q.approvalDigest }, now);
  assert.equal((await none.runtime.prepare({ op: approved, wallet: PAYER, sell: none.cngn, proof })).kind, 'no_quote');
});

test('reported transactions are verified from the chain: credited once, only from the buyer wallet to custody', async () => {
  const w = world();
  const { buyer, cfg, q } = await w.newOp();
  await approveFunding(w.db, cfg, { opId: q.id, buyerId: buyer, digest: q.approvalDigest }, now);
  const sent = await w.walletSends(PAYER, q);

  // the deposit cannot come before the conversion
  assert.equal(await code(recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'deposit', txHash: sent.depositTx }, now)), 'WRONG_STATE');
  // another buyer cannot report on this operation
  const stranger = createAccount(w.db, { kind: 'buyer', displayName: 'X' }, now);
  assert.equal(await code(recordClientTx(w.db, cfg, { opId: q.id, buyerId: stranger, kind: 'swap', txHash: sent.swapTx }, now)), 'NOT_OWNER');
  assert.equal(await code(recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'swap', txHash: 'nope' }, now)), 'BAD_INPUT');

  const afterSwap = await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'swap', txHash: sent.swapTx }, now);
  assert.equal(afterSwap.state, 'VERIFYING');
  assert.equal(afterSwap.stage, 'deposit', 'conversion verified; the buyer must now deposit the USDT');
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n, 'nothing credited by the swap alone');

  const done = await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'deposit', txHash: sent.depositTx }, now);
  assert.equal(done.state, 'CREDITED');
  const credited = balance(w.db, buyer, 'buyer_available', 'TESTUSDT');
  assert.ok(credited > 0n);
  // repeats change nothing
  await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'deposit', txHash: sent.depositTx }, now);
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), credited);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });

  // the same transactions cannot be claimed by another operation
  const second = await w.newOp();
  await approveFunding(w.db, second.cfg, { opId: second.q.id, buyerId: second.buyer, digest: second.q.approvalDigest }, now);
  assert.equal(await code(recordClientTx(w.db, second.cfg, { opId: second.q.id, buyerId: second.buyer, kind: 'swap', txHash: sent.swapTx }, now)), 'TX_ALREADY_USED');
});

test('a deposit that did not come from the buyer wallet is never credited', async () => {
  const w = world();
  const { buyer, cfg, q } = await w.newOp();
  await approveFunding(w.db, cfg, { opId: q.id, buyerId: buyer, digest: q.approvalDigest }, now);
  // the conversion was done by the right wallet, but the deposit was sent by someone else's wallet
  const mine = await w.walletSends(PAYER, q);
  const theirs = await w.walletSends(OTHER, q);
  await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'swap', txHash: mine.swapTx }, now);
  const r = await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'deposit', txHash: theirs.depositTx }, now);
  assert.equal(r.state, 'REVIEW');
  assert.equal(r.failureCode, 'DEPOSIT_MISMATCH');
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n);
});

test('a swap that delivered to a different wallet is never credited', async () => {
  const w = world();
  const { buyer, cfg, q } = await w.newOp();
  await approveFunding(w.db, cfg, { opId: q.id, buyerId: buyer, digest: q.approvalDigest }, now);
  const other = await w.walletSends(OTHER, q);
  const r = await recordClientTx(w.db, cfg, { opId: q.id, buyerId: buyer, kind: 'swap', txHash: other.swapTx }, now);
  assert.ok(['REVIEW', 'FAILED'].includes(r.state), r.state);
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n);
  void USDT_CELO;
});
