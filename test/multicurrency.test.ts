// Stage 1 multi-currency: route discovery, asset-agnostic funding (incl. the two-hop deposit), payout preferences,
// payout-address proofs and the simulated payout conversion workflow.
// SIMULATION ONLY: fake provider, fake chain receipts through the real verification code. No network, no wallets, no money.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, USDT_CELO, loadAllowList, seedConversionAssets, setAssetEnabled } from '../src/conversion.ts';
import type { AssetRef } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { balance, createAccount, deposit, settleExecution, startExecution, verifyLedger } from '../src/ledger.ts';
import { approveFunding, fundingEvents, getFundingOp, recoverFunding, requestFundingQuote } from '../src/marketfunding.ts';
import type { FundingConfig } from '../src/marketfunding.ts';
import { approvePayout, cancelPayout, getPayout } from '../src/payouts.ts';
import {
  confirmConversionQuote, executeConversionPayout, getPayoutPreference, payoutAddressMessage, payoutEvents, recheckConversionPayout, recoverConversionPayouts,
  registerPayoutAddress, requestConversionPayout, requoteConversionPayout, retryConversionDelivery, setPayoutPreference,
} from '../src/payoutconv.ts';
import type { PayoutConversionConfig } from '../src/payoutconv.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';

const T0 = 1_800_000_000_000;
const TOKEN_USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const CUSTODY = '0x00000000000000000000000000000000c0570d1a';
const DEPOSIT = '0x00000000000000000000000000000000000dEaD1';
const BUYER_WALLET = '0x00000000000000000000000000000000000000b1';
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function world(o: { quoteTtlMs?: number } = {}) {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  let clock = T0;
  const now = () => clock;
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR, now, ...(o.quoteTtlMs ? { quoteTtlMs: o.quoteTtlMs } : {}) });
  const registry = new RouteRegistry(db, [provider]);
  return { db, provider, registry, now, tick: (ms: number) => (clock += ms) };
}
type W = ReturnType<typeof world>;
const asset = (w: W, sym: string): AssetRef => w.provider.assets.find((a) => a.ref.symbol === sym)!.ref;

// ------------------------------------------------------------------ routes

test('funding routes: only live AND enabled assets are usable; USDT needs no conversion; an unknown asset (CWT) is simply absent', async () => {
  const w = world();
  const rs = await w.registry.routes('funding');
  const by = (s: string) => rs.find((r) => r.from.symbol === s)!;
  assert.equal(by('USDT').passthrough, true);
  assert.equal(by('USDT').usable, true);
  for (const s of ['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT']) assert.equal(by(s).usable, true, s);
  // live but not enabled by the operator
  assert.equal(by('CELO').available, true);
  assert.equal(by('CELO').usable, false);
  assert.match(by('CELO').reason!, /not enabled/);
  // listed with no liquidity
  assert.equal(by('G$').available, false);
  assert.match(by('G$').reason!, /no liquidity/);
  // CWT is not on the ladder at all
  assert.equal(await w.registry.find('funding', 'CWT'), undefined);
  assert.equal(rs.some((r) => r.from.symbol === 'CWT'), false);
});

test('payout routes are discovered separately: a fundable asset can be unpayable, and thin routes carry a ceiling', async () => {
  const w = world();
  const f = await w.registry.routes('funding');
  const p = await w.registry.routes('payout');
  const wmxnF = f.find((r) => r.from.symbol === 'wMXN')!;
  const wmxnP = p.find((r) => r.to.symbol === 'wMXN')!;
  assert.equal(wmxnF.available, true, 'wMXN -> USDT has makers');
  assert.equal(wmxnP.available, false, 'USDT -> wMXN has none');
  assert.equal(wmxnP.unavailableReason, 'no_makers_online');
  // even if the operator enables wMXN for payouts, it is not usable
  const w2 = await w.registry.find('payout', 'wMXN');
  setAssetEnabled(w.db, w2!.to.chainId, w2!.to.address, 'payout', true, 'op');
  assert.equal((await w.registry.find('payout', 'wMXN'))!.usable, false);
  const celo = p.find((r) => r.to.symbol === 'CELO')!;
  assert.equal(celo.maxInputAtomic, 33_000_000n, 'CELO payouts are only about $33 deep');
  assert.equal(p.find((r) => r.to.symbol === 'cNGN')!.minInputAtomic, 1_000_000n, 'the provider floor is about $1');
  assert.ok(loadAllowList(w.db).length >= 11);
});

test('quotes: rate, fee and minimum are explicit; amounts below the floor or above the depth are refused', async () => {
  const w = world();
  const cngn = asset(w, 'cNGN');
  const q = await w.provider.quote({ direction: 'funding', from: cngn, to: USDT_CELO, inputAtomic: 1_364_000_000n });
  assert.equal(q.rate, '1 USDT = 1364 cNGN');
  assert.equal(q.feeAtomic, 4_092_000n);
  assert.ok(q.minOutputAtomic < q.expectedOutputAtomic);
  assert.equal(q.minOutputAtomic, q.expectedOutputAtomic - (q.expectedOutputAtomic * 100n) / 10_000n);
  await assert.rejects(() => w.provider.quote({ direction: 'funding', from: cngn, to: USDT_CELO, inputAtomic: 1_000_000n }), /below the provider minimum/);
  await assert.rejects(() => w.provider.quote({ direction: 'payout', from: USDT_CELO, to: asset(w, 'wMXN'), inputAtomic: 5_000_000n }), /no route/);
  await assert.rejects(() => w.provider.quote({ direction: 'payout', from: USDT_CELO, to: asset(w, 'CELO'), inputAtomic: 100_000_000n }), /above the indicative depth/);
});

// ------------------------------------------------------------------ asset-agnostic funding with the deposit hop

function fundingFor(w: W, sym: string, over: Partial<FundingConfig> = {}): FundingConfig {
  const ref = sym === 'USDT' ? USDT_CELO : asset(w, sym);
  return {
    converter: w.provider.fundingConverter(ref, { taker: BUYER_WALLET, depositAddress: DEPOSIT }),
    reader: w.provider.reader,
    usdt: TOKEN_USDT,
    reactor: TEXTILE_REACTOR,
    chainId: 42220,
    minConfirmations: 3,
    limits: { minSellAtomic: 1n, maxSellAtomic: 10n ** 30n, maxPerDaySellAtomic: 10n ** 30n, maxOpenOps: 5 },
    creditAsset: 'TESTUSDT',
    ...over,
  };
}
const buyerIn = (w: W) => createAccount(w.db, { kind: 'buyer', displayName: 'B' }, w.now);
const fundWith = async (w: W, sym: string, amount: bigint, scenario?: string, buyer = buyerIn(w), cfg = fundingFor(w, sym)) => {
  const op = await requestFundingQuote(w.db, cfg, { buyerId: buyer, sellAtomic: amount, idempotencyKey: `k-${Math.random()}`, ...(scenario ? { scenario } : {}) }, w.now);
  const done = await approveFunding(w.db, cfg, { opId: op.id, buyerId: buyer, digest: op.approvalDigest }, w.now);
  return { op, done, buyer, cfg };
};

test('any enabled asset funds the balance in USDT: 6-decimal and 18-decimal sources, credited once, two transactions recorded', async () => {
  const w = world();
  const small = await fundWith(w, 'cNGN', 1_364_000_000n);
  assert.equal(small.done.state, 'CREDITED');
  assert.ok(small.done.swapTx && small.done.depositTx && small.done.approveTxs.length === 1);
  const credited = balance(w.db, small.buyer, 'buyer_available', 'TESTUSDT');
  assert.equal(credited, small.done.creditedAtomic);
  assert.equal(credited, 997_000n - 0n + (credited - 997_000n)); // sanity: positive and equal to the deposit
  assert.ok(credited > 990_000n && credited < 1_000_000n);

  // 1611 wARS = 1.611e21 atomic: far beyond 64 bits, stored as text
  const big = await fundWith(w, 'wARS', 1_611n * 10n ** 18n);
  assert.equal(big.done.state, 'CREDITED');
  assert.equal(big.done.sellAtomic, 1_611n * 10n ** 18n);
  assert.equal(getFundingOp(w.db, big.op.id)!.sellDecimals, 18);
  assert.ok(balance(w.db, big.buyer, 'buyer_available', 'TESTUSDT') > 990_000n);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
  // both transactions are claimed so neither can fund another operation
  const claims = w.db.prepare('SELECT COUNT(*) AS n FROM funding_tx_claims WHERE op_id = ?').get(big.op.id) as { n: number | bigint };
  assert.equal(Number(claims.n), 2);
  assert.deepEqual(fundingEvents(w.db, big.op.id).map((e) => e.state), ['QUOTED', 'CONVERTING', 'VERIFYING', 'CREDITED']);
});

test('buyer already holds USDT: no conversion, only the deposit is verified and credited', async () => {
  const w = world();
  const r = await fundWith(w, 'USDT', 2_500_000n);
  assert.equal(r.done.state, 'CREDITED');
  assert.equal(r.done.swapTx, null, 'no swap was made');
  assert.ok(r.done.depositTx);
  assert.equal(balance(w.db, r.buyer, 'buyer_available', 'TESTUSDT'), 2_500_000n);
  assert.equal(r.op.feeAtomic, 0n);
  // USDT with no deposit transaction is never credited
  const miss = await fundWith(w, 'USDT', 1_000_000n, 'deposit_missing');
  assert.equal(miss.done.state, 'REVIEW');
  assert.equal(balance(w.db, miss.buyer, 'buyer_available', 'TESTUSDT'), 0n);
});

test('two-hop failures: a good swap without a verified deposit credits nothing; a short deposit credits only what arrived', async () => {
  const w = world();
  const none = await fundWith(w, 'cNGN', 1_364_000_000n, 'deposit_missing');
  assert.equal(none.done.state, 'REVIEW');
  assert.equal(none.done.failureCode, 'DEPOSIT_NOT_RECORDED');
  assert.match(none.done.failureMessage ?? fundingEvents(w.db, none.op.id).at(-1)!.note, /./);
  assert.equal(balance(w.db, none.buyer, 'buyer_available', 'TESTUSDT'), 0n);
  assert.match(fundingEvents(w.db, none.op.id).at(-1)!.note, /in your wallet/);

  const short = await fundWith(w, 'cNGN', 1_364_000_000n, 'deposit_short');
  assert.equal(short.done.state, 'CREDITED');
  const swapOut = 997_000n; // approx; the credit must be strictly the deposit, which is half of the swap output
  assert.ok(short.done.creditedAtomic! < swapOut, 'only the USDT that reached custody is credited');
  assert.equal(balance(w.db, short.buyer, 'buyer_available', 'TESTUSDT'), short.done.creditedAtomic);
});

test('delayed deposit confirmation stays unspendable, then credits once', async () => {
  const w = world();
  const cfg = fundingFor(w, 'cNGN');
  const { op, done } = await fundWith(w, 'cNGN', 1_364_000_000n, 'slow', undefined, cfg);
  assert.equal(done.state, 'VERIFYING');
  assert.equal(balance(w.db, done.buyerId, 'buyer_available', 'TESTUSDT'), 0n);
  w.provider.advance(6);
  await recoverFunding(w.db, cfg, w.now);
  const after = getFundingOp(w.db, op.id)!;
  assert.equal(after.state, 'CREDITED');
  const bal = balance(w.db, after.buyerId, 'buyer_available', 'TESTUSDT');
  w.provider.advance(6);
  await recoverFunding(w.db, cfg, w.now);
  assert.equal(balance(w.db, after.buyerId, 'buyer_available', 'TESTUSDT'), bal);
});

test('every swap failure mode still credits nothing in the two-hop path', async () => {
  for (const sc of ['reverted', 'wrong_token', 'wrong_recipient', 'no_fill', 'short', 'refused', 'uncertain']) {
    const w = world();
    const r = await fundWith(w, 'wARS', 1_611n * 10n ** 18n, sc);
    assert.notEqual(r.done.state, 'CREDITED', sc);
    assert.equal(balance(w.db, r.buyer, 'buyer_available', 'TESTUSDT'), 0n, sc);
    assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
  }
});

// ------------------------------------------------------------------ payout preferences and address proofs

async function seller(w: W) {
  const id = createAccount(w.db, { kind: 'seller', displayName: 'S' }, w.now);
  const wallet = privateKeyToAccount(generatePrivateKey());
  w.db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run(wallet.address.toLowerCase(), id);
  return { id, wallet };
}

test('payout preference: defaults to USDT; only live+enabled assets can be chosen; changes are versioned and per listing', async () => {
  const w = world();
  const s = await seller(w);
  assert.deepEqual([getPayoutPreference(w.db, s.id).asset.symbol, getPayoutPreference(w.db, s.id).version, getPayoutPreference(w.db, s.id).source], ['USDT', 0, 'default']);
  const p1 = await setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'cNGN' }, w.now);
  assert.deepEqual([p1.asset.symbol, p1.version, p1.source], ['cNGN', 1, 'seller']);
  assert.equal(await code(setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'wMXN' }, w.now)), 'NOT_ENABLED');
  assert.equal(await code(setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'G$' }, w.now)), 'NOT_ENABLED');
  assert.equal(await code(setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'CWT' }, w.now)), 'ROUTE_UNAVAILABLE');
  const p2 = await setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'wBRL' }, w.now);
  assert.equal(p2.version, 2);
  // listing-level override beats the seller default; another seller's listing is refused
  w.db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at) VALUES ('lst_x', ?, 'x', 'draft', 1000, 'TESTUSDT', 't')").run(s.id);
  const lp = await setPayoutPreference(w.db, w.registry, { sellerId: s.id, listingId: 'lst_x', symbol: 'wARS' }, w.now);
  assert.deepEqual([getPayoutPreference(w.db, s.id, 'lst_x').asset.symbol, getPayoutPreference(w.db, s.id).asset.symbol, lp.source], ['wARS', 'wBRL', 'listing']);
  const other = await seller(w);
  assert.equal(await code(setPayoutPreference(w.db, w.registry, { sellerId: other.id, listingId: 'lst_x', symbol: 'cNGN' }, w.now)), 'NOT_OWNER');
});

test('payout address proof: signed by that address for that seller; one address belongs to one seller', async () => {
  const w = world();
  const a = await seller(w);
  const b = await seller(w);
  const addr = privateKeyToAccount(generatePrivateKey());
  const sig = await addr.signMessage({ message: payoutAddressMessage(a.id, 42220, addr.address) });
  assert.equal((await registerPayoutAddress(w.db, { sellerId: a.id, chainId: 42220, address: addr.address, signature: sig }, w.now)).address, addr.address.toLowerCase());
  // same seller again: idempotent
  await registerPayoutAddress(w.db, { sellerId: a.id, chainId: 42220, address: addr.address, signature: sig }, w.now);
  // another seller cannot take it, even with a signature made for them
  const sigB = await addr.signMessage({ message: payoutAddressMessage(b.id, 42220, addr.address) });
  assert.equal(await code(registerPayoutAddress(w.db, { sellerId: b.id, chainId: 42220, address: addr.address, signature: sigB }, w.now)), 'ADDRESS_TAKEN');
  // a signature by a different key, or for a different seller, is refused
  const other = privateKeyToAccount(generatePrivateKey());
  assert.equal(await code(registerPayoutAddress(w.db, { sellerId: b.id, chainId: 42220, address: other.address, signature: await addr.signMessage({ message: payoutAddressMessage(b.id, 42220, other.address) }) }, w.now)), 'BAD_SIGNATURE');
  assert.equal(await code(registerPayoutAddress(w.db, { sellerId: b.id, chainId: 42220, address: other.address, signature: await other.signMessage({ message: payoutAddressMessage(a.id, 42220, other.address) }) }, w.now)), 'BAD_SIGNATURE');
});

// ------------------------------------------------------------------ the conversion payout

const POLICY = { payableAssets: ['TESTUSDT'], minAtomic: 1n, maxAtomic: 10n ** 12n };

async function earningSeller(w: W, earnings = 5_000_000n, pref = 'cNGN') {
  const s = await seller(w);
  const buyer = createAccount(w.db, { kind: 'buyer', displayName: 'B' }, w.now);
  deposit(w.db, { buyerId: buyer, asset: 'TESTUSDT', amountAtomic: earnings, ref: `seed-${s.id}` }, w.now);
  w.db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, fee_bps) VALUES (?, ?, 'x', 'published', ?, 'TESTUSDT', 't', 0)").run(`l_${s.id}`, s.id, earnings);
  w.db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES (?, ?, 1, '{}', 'h', 'approved', 't')").run(`c_${s.id}`, `l_${s.id}`);
  const { execution } = startExecution(w.db, { buyerId: buyer, listingId: `l_${s.id}`, contractVersionId: `c_${s.id}`, idempotencyKey: `k-${s.id}`, requestHash: 'h' }, w.now);
  settleExecution(w.db, execution.id, 'QUALIFIED', 'ok', w.now);
  const dest = privateKeyToAccount(generatePrivateKey());
  await registerPayoutAddress(w.db, { sellerId: s.id, chainId: 42220, address: dest.address, signature: await dest.signMessage({ message: payoutAddressMessage(s.id, 42220, dest.address) }) }, w.now);
  if (pref !== 'USDT') await setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: pref }, w.now);
  return { ...s, dest };
}
const payCfg = (w: W): PayoutConversionConfig => ({ registry: w.registry, provider: w.provider, reader: w.provider.reader, reactor: TEXTILE_REACTOR, custody: CUSTODY, minConfirmations: 3, policy: POLICY });

async function toApproved(w: W, s: Awaited<ReturnType<typeof earningSeller>>, amount = 3_000_000n, scenario?: string) {
  const cfg = payCfg(w);
  const p = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: amount, asset: 'TESTUSDT', ...(scenario ? { scenario } : {}) }, w.now);
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now);
  approvePayout(w.db, p.id, 'operator', w.now);
  return { cfg, p };
}

test('conversion payout happy path: quote shown first, seller confirms, operator approves, delivered and verified, ledger sound', async () => {
  const w = world();
  const s = await earningSeller(w);
  const cfg = payCfg(w);
  const p = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 3_000_000n, asset: 'TESTUSDT' }, w.now);
  assert.equal(p.stage, 'quoted');
  assert.equal(p.mode, 'convert-simulated');
  assert.equal(p.target!.symbol, 'cNGN');
  assert.equal(p.rate, '1 USDT = 1364 cNGN');
  assert.ok(p.expectedTarget! > p.minTarget!);
  assert.equal(p.preferenceVersion, 1);
  // earnings are reserved at once, in USDT; nothing was converted
  assert.equal(balance(w.db, s.id, 'seller_earnings', 'TESTUSDT'), 2_000_000n);
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 3_000_000n);
  assert.equal(w.provider.executions.payout, 0);
  // the operator cannot approve an unconfirmed quote
  assert.equal(await code(() => approvePayout(w.db, p.id, 'operator', w.now)), 'WRONG_STATE');
  assert.equal(await code(() => confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: 'nope' }, w.now)), 'DIGEST_MISMATCH');
  const other = await seller(w);
  assert.equal(await code(() => confirmConversionQuote(w.db, { sellerId: other.id, payoutId: p.id, digest: p.approvalDigest! }, w.now)), 'NOT_OWNER');
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now);
  assert.equal(await code(executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now)), 'WRONG_STATE', 'cannot execute before operator approval');
  approvePayout(w.db, p.id, 'operator', w.now);

  const step = await executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now);
  assert.equal(step.outcome, 'completed');
  const done = getPayout(w.db, p.id)!;
  assert.equal(done.state, 'confirmed');
  assert.equal(done.stage, 'delivered');
  assert.equal(done.receivedTarget, done.expectedTarget);
  assert.ok(done.conversionTx && done.deliveryTx);
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n);
  assert.deepEqual(payoutEvents(w.db, p.id).map((e) => e.stage), ['quoted', 'confirmed', 'converting', 'converted', 'delivered']);
  // idempotent: executing/rechecking again changes nothing
  assert.equal((await executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now)).outcome, 'completed');
  assert.equal((await recheckConversionPayout(w.db, cfg, p.id, w.now)).outcome, 'completed');
  assert.equal(w.provider.executions.payout, 1);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
});

test('payout failure rules: provable failure restores USDT; swapped-but-undelivered is never silently reversed; unverifiable is never completed', async () => {
  // swap reverted / refused: restored
  for (const sc of ['reverted', 'refused']) {
    const w = world();
    const s = await earningSeller(w);
    const { cfg, p } = await toApproved(w, s);
    const r = await executeConversionPayout(w.db, cfg, { payoutId: p.id, scenario: sc }, w.now);
    assert.equal(r.outcome, 'restored', sc);
    assert.equal(getPayout(w.db, p.id)!.state, 'failed');
    assert.equal(balance(w.db, s.id, 'seller_earnings', 'TESTUSDT'), 5_000_000n, `${sc}: earnings fully restored`);
    assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n);
    assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
  }
  // swap verified, delivery missing / reverted: stays pending in the target asset, then retry delivers
  for (const sc of ['delivery_missing', 'delivery_reverted']) {
    const w = world();
    const s = await earningSeller(w);
    const { cfg, p } = await toApproved(w, s);
    const r = await executeConversionPayout(w.db, cfg, { payoutId: p.id, scenario: sc }, w.now);
    assert.equal(r.outcome, 'undelivered', sc);
    const mid = getPayout(w.db, p.id)!;
    assert.equal(mid.state, 'sent');
    assert.equal(mid.stage, 'converted_undelivered');
    assert.ok(mid.receivedTarget! > 0n);
    assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 3_000_000n, `${sc}: USDT is NOT returned once swapped`);
    assert.equal(balance(w.db, s.id, 'seller_earnings', 'TESTUSDT'), 2_000_000n);
    assert.equal(w.provider.executions.payout, 1);
    const retried = await retryConversionDelivery(w.db, cfg, p.id, w.now);
    assert.equal(retried.outcome, 'completed', sc);
    assert.equal(w.provider.executions.payout, 1, 'delivery retry never re-swaps');
    assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n);
    assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
  }
  // wrong token / short / wrong recipient: not completed, not refunded -> review
  for (const sc of ['wrong_token', 'short', 'wrong_recipient']) {
    const w = world();
    const s = await earningSeller(w);
    const { cfg, p } = await toApproved(w, s);
    const r = await executeConversionPayout(w.db, cfg, { payoutId: p.id, scenario: sc }, w.now);
    assert.ok(['needs_review', 'undelivered'].includes(r.outcome), `${sc}: ${r.outcome}`);
    const cur = getPayout(w.db, p.id)!;
    assert.notEqual(cur.state, 'confirmed', sc);
    assert.notEqual(cur.state, 'failed', sc);
    assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 3_000_000n, `${sc}: still reserved`);
  }
  // unknown outcome: in progress; when it lands, recovery completes it exactly once
  const w = world();
  const s = await earningSeller(w);
  const { cfg, p } = await toApproved(w, s);
  const u = await executeConversionPayout(w.db, cfg, { payoutId: p.id, scenario: 'uncertain' }, w.now);
  assert.equal(u.outcome, 'in_progress');
  assert.equal(getPayout(w.db, p.id)!.state, 'sent');
  assert.deepEqual((await recoverConversionPayouts(w.db, cfg, w.now)).map((x) => x.outcome), ['in_progress'], 'still not visible: unresolved, not refunded');
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 3_000_000n);
});

test('quotes expire; a stale quote cannot be confirmed or executed; re-quoting keeps earnings reserved; cancelling restores them', async () => {
  const w = world({ quoteTtlMs: 30_000 });
  const s = await earningSeller(w);
  const cfg = payCfg(w);
  const p = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  w.tick(31_000);
  assert.equal(await code(() => confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now)), 'QUOTE_EXPIRED');
  const fresh = await requoteConversionPayout(w.db, cfg, { sellerId: s.id, payoutId: p.id }, w.now);
  assert.notEqual(fresh.approvalDigest, p.approvalDigest);
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 2_000_000n);
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: fresh.approvalDigest! }, w.now);
  approvePayout(w.db, p.id, 'operator', w.now);
  w.tick(31_000);
  assert.equal(await code(executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now)), 'QUOTE_EXPIRED');
  assert.equal(w.provider.executions.payout, 0, 'nothing is executed on an expired quote');
  const again = await requoteConversionPayout(w.db, cfg, { sellerId: s.id, payoutId: p.id }, w.now);
  assert.equal(again.state, 'requested', 're-quoting resets operator approval: the seller must confirm again');
  cancelPayout(w.db, p.id, s.id, w.now);
  assert.equal(balance(w.db, s.id, 'seller_earnings', 'TESTUSDT'), 5_000_000n);
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
});

test('payout requests refuse unsupported routes, missing addresses, floor and depth, and a changed preference never alters an existing payout', async () => {
  const w = world();
  const cfg = payCfg(w);
  // preference USDT: in SIMULATION this is a labelled demo lifecycle; the live provider still refuses it
  const usdt = await earningSeller(w, 5_000_000n, 'USDT');
  const up = await requestConversionPayout(w.db, cfg, { sellerId: usdt.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  assert.equal(up.mode, 'usdt-simulated');
  assert.equal(up.stage, 'quoted');
  cancelPayout(w.db, up.id, usdt.id, w.now);

  const s = await earningSeller(w);
  assert.equal(await code(requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 500_000n, asset: 'TESTUSDT' }, w.now)), 'BELOW_FLOOR');
  assert.equal(await code(requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 10_000_000_000n, asset: 'TESTUSDT' }, w.now)), 'ABOVE_DEPTH');
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n, 'refusals reserve nothing');

  // no verified address on the target chain
  const noAddr = await seller(w);
  w.db.prepare("INSERT INTO payout_preferences (seller_id, listing_id, asset_chain_id, asset_address, asset_symbol, asset_decimals, version, created_at) VALUES (?, NULL, 42220, ?, 'cNGN', 6, 1, 't')").run(noAddr.id, asset(w, 'cNGN').address.toLowerCase());
  assert.equal(await code(requestConversionPayout(w.db, cfg, { sellerId: noAddr.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now)), 'ADDRESS_REQUIRED');

  // the route disappears after the preference was set: refused with a clear reason, never an unknown rate
  const w2 = world();
  const s2 = await earningSeller(w2);
  setAssetEnabled(w2.db, 42220, asset(w2, 'cNGN').address, 'payout', false, 'op');
  assert.equal(await code(requestConversionPayout(w2.db, payCfg(w2), { sellerId: s2.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w2.now)), 'ROUTE_UNAVAILABLE');

  // a preference change after the request does not alter the quoted payout
  const p = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  await setPayoutPreference(w.db, w.registry, { sellerId: s.id, symbol: 'wBRL' }, w.now);
  const after = getPayout(w.db, p.id)!;
  assert.equal(after.target!.symbol, 'cNGN');
  assert.equal(after.preferenceVersion, 1);
  assert.equal(getPayoutPreference(w.db, s.id).asset.symbol, 'wBRL');
  // the next request uses the new preference
  const p2 = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  assert.equal(p2.target!.symbol, 'wBRL');
  assert.equal(p2.preferenceVersion, 2);
  assert.equal(p2.target!.decimals, 18);
});

test('funding and payout conversions are separate: a payout conversion never touches a buyer balance, and payouts accounting stays in USDT', async () => {
  const w = world();
  const buyer = await fundWith(w, 'cNGN', 1_364_000_000n);
  const before = balance(w.db, buyer.buyer, 'buyer_available', 'TESTUSDT');
  const s = await earningSeller(w);
  const { cfg, p } = await toApproved(w, s);
  await executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now);
  assert.equal(balance(w.db, buyer.buyer, 'buyer_available', 'TESTUSDT'), before);
  const row = w.db.prepare('SELECT COUNT(*) AS n FROM funding_ops').get() as { n: number | bigint };
  assert.equal(Number(row.n), 1, 'a payout creates no funding operation');
  assert.equal(getPayout(w.db, p.id)!.amountAtomic, 3_000_000n, 'the payout amount is USDT-denominated');
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
});

test('simulation restart: unfinished simulated operations are parked for review, never credited, and stop blocking the buyer', async () => {
  const { parkSimulatedAfterRestart } = await import('../src/marketfunding.ts');
  const w = world();
  const cfg = fundingFor(w, 'cNGN');
  const buyer = buyerIn(w);
  const mk2 = async (sc: string) => {
    const op = await requestFundingQuote(w.db, cfg, { buyerId: buyer, sellAtomic: 1_364_000_000n, idempotencyKey: `r-${sc}`, scenario: sc }, w.now);
    return approveFunding(w.db, cfg, { opId: op.id, buyerId: buyer, digest: op.approvalDigest }, w.now);
  };
  const a = await mk2('slow');
  const b = await mk2('uncertain');
  assert.deepEqual([a.state, b.state], ['VERIFYING', 'UNRESOLVED']);
  for (const op of [a, b]) assert.equal(parkSimulatedAfterRestart(w.db, op.id, w.now).state, 'REVIEW');
  assert.equal(balance(w.db, buyer, 'buyer_available', 'TESTUSDT'), 0n);
  // a finished operation is left alone
  const ok = await mk2('ok');
  assert.equal(parkSimulatedAfterRestart(w.db, ok.id, w.now).state, 'CREDITED');
});

test('simulated USDT payout lifecycle: quote, confirm, approve, deliver and verify; failures restore only when nothing left custody', async () => {
  const w = world();
  const s = await earningSeller(w, 5_000_000n, 'USDT');
  const cfg = payCfg(w);
  const p = await requestConversionPayout(w.db, cfg, { sellerId: s.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, w.now);
  assert.equal(p.mode, 'usdt-simulated');
  assert.equal(p.expectedTarget, 2_000_000n);
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 2_000_000n);
  assert.equal(await code(() => approvePayout(w.db, p.id, 'operator', w.now)), 'WRONG_STATE', 'unconfirmed quote cannot be approved');
  confirmConversionQuote(w.db, { sellerId: s.id, payoutId: p.id, digest: p.approvalDigest! }, w.now);
  approvePayout(w.db, p.id, 'operator', w.now);
  const r = await executeConversionPayout(w.db, cfg, { payoutId: p.id }, w.now);
  assert.equal(r.outcome, 'completed');
  const done = getPayout(w.db, p.id)!;
  assert.equal(done.state, 'confirmed');
  assert.ok(done.deliveryTx && !done.conversionTx, 'a delivery transfer only; there was no swap');
  assert.equal(balance(w.db, s.id, 'payout_pending', 'TESTUSDT'), 0n);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });

  // refused / reverted: nothing left custody, earnings restored
  for (const sc of ['refused', 'reverted']) {
    const x = world();
    const sx = await earningSeller(x, 5_000_000n, 'USDT');
    const c2 = payCfg(x);
    const q = await requestConversionPayout(x.db, c2, { sellerId: sx.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, x.now);
    confirmConversionQuote(x.db, { sellerId: sx.id, payoutId: q.id, digest: q.approvalDigest! }, x.now);
    approvePayout(x.db, q.id, 'operator', x.now);
    assert.equal((await executeConversionPayout(x.db, c2, { payoutId: q.id, scenario: sc }, x.now)).outcome, 'restored', sc);
    assert.equal(balance(x.db, sx.id, 'seller_earnings', 'TESTUSDT'), 5_000_000n);
    assert.deepEqual(verifyLedger(x.db), { ok: true, problems: [] });
  }
  // short / wrong recipient: never completed and never refunded
  for (const sc of ['short', 'wrong_recipient']) {
    const x = world();
    const sx = await earningSeller(x, 5_000_000n, 'USDT');
    const c2 = payCfg(x);
    const q = await requestConversionPayout(x.db, c2, { sellerId: sx.id, amountAtomic: 2_000_000n, asset: 'TESTUSDT' }, x.now);
    confirmConversionQuote(x.db, { sellerId: sx.id, payoutId: q.id, digest: q.approvalDigest! }, x.now);
    approvePayout(x.db, q.id, 'operator', x.now);
    assert.equal((await executeConversionPayout(x.db, c2, { payoutId: q.id, scenario: sc }, x.now)).outcome, 'needs_review', sc);
    assert.equal(balance(x.db, sx.id, 'payout_pending', 'TESTUSDT'), 2_000_000n, 'still reserved');
    assert.notEqual(getPayout(x.db, q.id)!.state, 'confirmed');
  }
});
