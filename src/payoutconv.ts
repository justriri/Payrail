// Seller payout preferences, payout-address proofs, and the payout CONVERSION workflow (USDT -> preferred asset).
//
// Internal money never changes denomination: prices, balances, fees and earnings stay USDT. A conversion payout only
// changes what the seller RECEIVES, and only after they have seen and confirmed the quote.
//
//   requested(quoted) -> seller confirms digest -> operator approves -> converting -> converted -> delivered(confirmed)
//
// Failure rules (enforced by tests):
//   * swap provably did not happen  -> USDT earnings restored (payout_cancel)
//   * swap done, delivery missing   -> stage converted_undelivered: liability stays in the target asset, never silently reversed
//   * anything unverifiable         -> not complete, not refunded: re-checked
//
// STAGE 1: the provider is a simulation. There is no signing here. A live provider would need a bounded custody signer.
import { createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { CELO_CHAIN_ID, USDT_CELO } from './conversion.ts';
import type { AssetRef, ConversionProvider, ConversionQuote, RouteRegistry } from './conversion.ts';
import { verifyConversion, verifyDeposit } from './marketfunding.ts';
import type { ChainReader } from './funding.ts';
import { completeConvertedPayout, failSentPayout, getPayout, markSent, requestPayout } from './payouts.ts';
import type { Payout, PayoutPolicy } from './payouts.ts';
import type { SimProvider } from './simconversion.ts';

export class PayoutConvError extends Error {
  code:
    | 'BAD_INPUT' | 'NOT_FOUND' | 'NOT_OWNER' | 'ROUTE_UNAVAILABLE' | 'ADDRESS_REQUIRED' | 'BAD_SIGNATURE' | 'ADDRESS_TAKEN'
    | 'BELOW_FLOOR' | 'ABOVE_DEPTH' | 'QUOTE_EXPIRED' | 'DIGEST_MISMATCH' | 'WRONG_STATE' | 'NOT_ENABLED';
  constructor(code: PayoutConvError['code'], message: string) {
    super(message);
    this.name = 'PayoutConvError';
    this.code = code;
  }
}
const iso = (n: number) => new Date(n).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const lower = (s: string) => s.toLowerCase();

// ------------------------------------------------------------------ payout address proofs

export function payoutAddressMessage(sellerId: string, chainId: number, address: string): string {
  return `Payrail payout address\nSeller: ${sellerId}\nChain: ${chainId}\nAddress: ${lower(address)}\nI control this address and want payouts delivered to it.`;
}

export async function registerPayoutAddress(
  db: Db,
  a: { sellerId: string; chainId: number; address: string; signature: string },
  now: () => number = Date.now,
): Promise<{ address: string; chainId: number }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) throw new PayoutConvError('BAD_INPUT', 'address must be a 0x address');
  const addr = lower(a.address);
  let ok = false;
  try {
    ok = await verifyMessage({ address: a.address as `0x${string}`, message: payoutAddressMessage(a.sellerId, a.chainId, addr), signature: a.signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new PayoutConvError('BAD_SIGNATURE', 'the signature does not match this address and seller');
  return inTransaction(db, () => {
    const taken = queryOne(db, 'SELECT seller_id FROM payout_addresses WHERE chain_id = ? AND address = ?', a.chainId, addr);
    if (taken && String(taken.seller_id) !== a.sellerId) throw new PayoutConvError('ADDRESS_TAKEN', 'this address is already registered to another seller');
    if (!taken) {
      db.prepare('INSERT INTO payout_addresses (seller_id, chain_id, address, signature, verified_at) VALUES (?, ?, ?, ?, ?)').run(a.sellerId, a.chainId, addr, a.signature, iso(now()));
      audit(db, a.sellerId, 'payout_address.verified', addr, { chainId: a.chainId }, new Date(now()));
    }
    return { address: addr, chainId: a.chainId };
  });
}

export function payoutAddresses(db: Db, sellerId: string): Array<{ chainId: number; address: string; verifiedAt: string }> {
  return query(db, 'SELECT chain_id, address, verified_at FROM payout_addresses WHERE seller_id = ? ORDER BY verified_at', sellerId).map((r) => ({ chainId: Number(r.chain_id), address: String(r.address), verifiedAt: String(r.verified_at) }));
}

// ------------------------------------------------------------------ preferences (append-only versions)

export interface Preference {
  asset: AssetRef;
  version: number;
  listingId: string | null;
  /** where it came from: the listing, the seller default, or the built-in USDT default */
  source: 'listing' | 'seller' | 'default';
}

export function getPayoutPreference(db: Db, sellerId: string, listingId?: string | null): Preference {
  const pick = (lid: string | null) =>
    lid === null
      ? queryOne(db, 'SELECT * FROM payout_preferences WHERE seller_id = ? AND listing_id IS NULL ORDER BY version DESC LIMIT 1', sellerId)
      : queryOne(db, 'SELECT * FROM payout_preferences WHERE seller_id = ? AND listing_id = ? ORDER BY version DESC LIMIT 1', sellerId, lid);
  const toPref = (r: Record<string, unknown>, source: Preference['source']): Preference => ({
    asset: { chainId: Number(r.asset_chain_id), address: String(r.asset_address), symbol: String(r.asset_symbol), decimals: Number(r.asset_decimals) },
    version: Number(r.version),
    listingId: r.listing_id === null ? null : String(r.listing_id),
    source,
  });
  if (listingId) {
    const l = pick(listingId);
    if (l) return toPref(l, 'listing');
  }
  const s = pick(null);
  if (s) return toPref(s, 'seller');
  return { asset: USDT_CELO, version: 0, listingId: null, source: 'default' };
}

/** Save a preference. The route must be live and enabled NOW; the change applies to payouts requested after it. */
export async function setPayoutPreference(
  db: Db,
  registry: RouteRegistry,
  a: { sellerId: string; listingId?: string | null; symbol: string },
  now: () => number = Date.now,
): Promise<Preference> {
  const listingId = a.listingId ?? null;
  if (listingId) {
    const l = queryOne(db, 'SELECT seller_id FROM listings WHERE id = ?', listingId);
    if (!l) throw new PayoutConvError('NOT_FOUND', 'no such listing');
    if (String(l.seller_id) !== a.sellerId) throw new PayoutConvError('NOT_OWNER', 'not your listing');
  }
  const route = await registry.find('payout', a.symbol);
  if (!route) throw new PayoutConvError('ROUTE_UNAVAILABLE', `${a.symbol} is not a known payout asset`);
  if (!route.usable) throw new PayoutConvError(route.enabled ? 'ROUTE_UNAVAILABLE' : 'NOT_ENABLED', `${route.to.symbol} payouts are not available: ${route.reason ?? 'unavailable'}`);
  const asset = route.to;
  return inTransaction(db, () => {
    const cur = listingId === null
      ? queryOne<{ v: bigint | null }>(db, 'SELECT MAX(version) AS v FROM payout_preferences WHERE seller_id = ? AND listing_id IS NULL', a.sellerId)
      : queryOne<{ v: bigint | null }>(db, 'SELECT MAX(version) AS v FROM payout_preferences WHERE seller_id = ? AND listing_id = ?', a.sellerId, listingId);
    const version = Number(cur?.v ?? 0n) + 1;
    db.prepare('INSERT INTO payout_preferences (seller_id, listing_id, asset_chain_id, asset_address, asset_symbol, asset_decimals, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      a.sellerId, listingId, asset.chainId, lower(asset.address), asset.symbol, asset.decimals, version, iso(now()),
    );
    audit(db, a.sellerId, 'payout_preference.set', listingId ?? a.sellerId, { asset: asset.symbol, version }, new Date(now()));
    return getPayoutPreference(db, a.sellerId, listingId);
  });
}

// ------------------------------------------------------------------ the conversion payout

export interface PayoutConversionConfig {
  registry: RouteRegistry;
  provider: SimProvider | ConversionProvider;
  reader: ChainReader;
  reactor: string;
  /** the wallet that holds collected USDT and fills the swap */
  custody: string;
  minConfirmations: number;
  policy: PayoutPolicy;
  quoteTtlMs?: number;
}

const event = (db: Db, id: string, stage: string, note: string, now: number) =>
  db.prepare('INSERT INTO payout_events (payout_id, at, stage, note) VALUES (?, ?, ?, ?)').run(id, iso(now), stage, note.slice(0, 300));
export function payoutEvents(db: Db, id: string): Array<{ at: string; stage: string; note: string }> {
  return query(db, 'SELECT at, stage, note FROM payout_events WHERE payout_id = ? ORDER BY id', id).map((r) => ({ at: String(r.at), stage: String(r.stage), note: String(r.note) }));
}
const setStage = (db: Db, id: string, stage: string, note: string, now: number, extra: Record<string, string | null> = {}) => {
  const cols = Object.keys(extra);
  db.prepare(`UPDATE payouts SET stage = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(stage, ...cols.map((c) => extra[c]!), id);
  event(db, id, stage, note, now);
};
const digestOf = (id: string, sellerId: string, q: ConversionQuote, deliveryAddress: string, mode: string) =>
  sha(JSON.stringify([id, sellerId, q.id, q.from.symbol, q.to.symbol, q.to.address.toLowerCase(), q.inputAtomic.toString(), q.expectedOutputAtomic.toString(), q.minOutputAtomic.toString(), q.expiresAtMs, deliveryAddress.toLowerCase(), mode]));

/**
 * Reserve USDT earnings and attach a conversion quote. Nothing is sent. The seller sees expected amount, rate, fee and
 * minimum, and must confirm the digest before an operator can approve.
 */
export async function requestConversionPayout(
  db: Db,
  cfg: PayoutConversionConfig,
  a: { sellerId: string; amountAtomic: bigint; asset: string; listingId?: string | null; scenario?: string },
  now: () => number = Date.now,
): Promise<Payout> {
  const pref = getPayoutPreference(db, a.sellerId, a.listingId ?? null);
  if (pref.asset.symbol === 'USDT') {
    // plain USDT payout. Real ones go through the operator payout flow; only the SIMULATED lifecycle lives here.
    if (!cfg.provider.simulated) throw new PayoutConvError('BAD_INPUT', 'your payout preference is USDT: use a normal USDT payout (no conversion)');
    const dest = payoutAddresses(db, a.sellerId).find((x) => x.chainId === USDT_CELO.chainId);
    if (!dest) throw new PayoutConvError('ADDRESS_REQUIRED', `verify a payout address on chain ${USDT_CELO.chainId} first`);
    const sp = requestPayout(db, a.sellerId, { asset: a.asset, amountAtomic: a.amountAtomic }, cfg.policy, now);
    const qid = `usdtq_${sp.id}`;
    const exp = now() + (cfg.quoteTtlMs ?? 10 * 60_000);
    const q0: ConversionQuote = { id: qid, provider: 'none (USDT, no conversion)', direction: 'payout', from: USDT_CELO, to: USDT_CELO, inputAtomic: a.amountAtomic, expectedOutputAtomic: a.amountAtomic, minOutputAtomic: a.amountAtomic, feeAtomic: 0n, rate: '1 USDT = 1 USDT', expiresAtMs: exp, notes: [] };
    const dg = digestOf(sp.id, a.sellerId, q0, dest.address, 'usdt-simulated');
    db.prepare(
      `UPDATE payouts SET mode = 'usdt-simulated', stage = 'quoted', target_symbol = 'USDT', target_chain_id = ?, target_address = ?, target_decimals = 6, delivery_address = ?, quote_id = ?, quote_expires_at = ?,
         approval_digest = ?, expected_target = ?, min_target = ?, rate = '1 USDT = 1 USDT', fee_target = '0', preference_version = ? WHERE id = ?`,
    ).run(USDT_CELO.chainId, lower(USDT_CELO.address), dest.address, qid, iso(exp), dg, a.amountAtomic.toString(), a.amountAtomic.toString(), pref.version, sp.id);
    event(db, sp.id, 'quoted', `USDT payout ${a.amountAtomic} (atomic) to ${dest.address}; no conversion; nothing sent`, now());
    return getPayout(db, sp.id)!;
  }
  const route = await cfg.registry.find('payout', pref.asset.address);
  if (!route || !route.usable) throw new PayoutConvError('ROUTE_UNAVAILABLE', `${pref.asset.symbol} payouts are not available right now (${route?.reason ?? 'unknown'}); choose USDT or try later`);
  if (a.amountAtomic < route.minInputAtomic) throw new PayoutConvError('BELOW_FLOOR', `the provider minimum is ${route.minInputAtomic} (atomic USDT); let earnings accumulate`);
  if (a.amountAtomic > route.maxInputAtomic) throw new PayoutConvError('ABOVE_DEPTH', `the indicative depth for this route is ${route.maxInputAtomic} (atomic USDT)`);
  const addr = payoutAddresses(db, a.sellerId).find((x) => x.chainId === pref.asset.chainId);
  if (!addr) throw new PayoutConvError('ADDRESS_REQUIRED', `verify a payout address on chain ${pref.asset.chainId} first`);
  const provider = cfg.registry.provider(route.provider) ?? cfg.provider;
  let q: ConversionQuote;
  try {
    q = await provider.quote({ direction: 'payout', from: USDT_CELO, to: pref.asset, inputAtomic: a.amountAtomic, ...(a.scenario ? { scenario: a.scenario } : {}) });
  } catch (e) {
    throw new PayoutConvError('ROUTE_UNAVAILABLE', `no quote available: ${(e as Error).message.slice(0, 140)}`);
  }
  const mode = provider.simulated ? 'convert-simulated' : 'convert-live';
  // reserve earnings first (ledger payout_request); the quote metadata is attached to the same payout
  const p = requestPayout(db, a.sellerId, { asset: a.asset, amountAtomic: a.amountAtomic }, cfg.policy, now);
  const digest = digestOf(p.id, a.sellerId, q, addr.address, mode);
  db.prepare(
    `UPDATE payouts SET mode = ?, stage = 'quoted', target_symbol = ?, target_chain_id = ?, target_address = ?, target_decimals = ?, delivery_address = ?, quote_id = ?, quote_expires_at = ?,
       approval_digest = ?, expected_target = ?, min_target = ?, rate = ?, fee_target = ?, preference_version = ? WHERE id = ?`,
  ).run(mode, q.to.symbol, q.to.chainId, lower(q.to.address), q.to.decimals, addr.address, q.id, iso(q.expiresAtMs), digest, q.expectedOutputAtomic.toString(), q.minOutputAtomic.toString(), q.rate, q.feeAtomic.toString(), pref.version, p.id);
  event(db, p.id, 'quoted', `quote ${q.rate}; expected ${q.expectedOutputAtomic} ${q.to.symbol} (atomic), minimum ${q.minOutputAtomic}; nothing converted`, now());
  return getPayout(db, p.id)!;
}

/** The seller confirms exactly this quote. Still nothing is converted: the operator must then approve. */
export function confirmConversionQuote(db: Db, a: { sellerId: string; payoutId: string; digest: string }, now: () => number = Date.now): Payout {
  const p = getPayout(db, a.payoutId);
  if (!p) throw new PayoutConvError('NOT_FOUND', 'no such payout');
  if (p.sellerId !== a.sellerId) throw new PayoutConvError('NOT_OWNER', 'not your payout');
  if (p.stage === 'confirmed') return p;
  if (p.stage !== 'quoted' || p.state !== 'requested') throw new PayoutConvError('WRONG_STATE', `payout is ${p.state}/${p.stage ?? '-'}`);
  if (a.digest !== p.approvalDigest) throw new PayoutConvError('DIGEST_MISMATCH', 'the confirmation does not match this quote');
  if (Date.parse(p.quoteExpiresAt!) <= now()) throw new PayoutConvError('QUOTE_EXPIRED', 'the quote expired; request a new quote');
  db.prepare("UPDATE payouts SET stage = 'confirmed', seller_confirmed_at = ? WHERE id = ?").run(iso(now()), p.id);
  event(db, p.id, 'confirmed', 'seller confirmed the exact quote', now());
  return getPayout(db, p.id)!;
}

/** Replace an expired or unwanted quote on a payout that has not been converted. Earnings stay reserved. */
export async function requoteConversionPayout(db: Db, cfg: PayoutConversionConfig, a: { sellerId: string; payoutId: string; scenario?: string }, now: () => number = Date.now): Promise<Payout> {
  const p = getPayout(db, a.payoutId);
  if (!p) throw new PayoutConvError('NOT_FOUND', 'no such payout');
  if (p.sellerId !== a.sellerId) throw new PayoutConvError('NOT_OWNER', 'not your payout');
  if (p.mode === 'usdt' || !p.target) throw new PayoutConvError('WRONG_STATE', 'not a conversion payout');
  if (p.mode === 'usdt-simulated') {
    const exp = now() + (cfg.quoteTtlMs ?? 10 * 60_000);
    const q1: ConversionQuote = { id: `usdtq_${p.id}_${now()}`, provider: 'none (USDT, no conversion)', direction: 'payout', from: USDT_CELO, to: USDT_CELO, inputAtomic: p.amountAtomic, expectedOutputAtomic: p.amountAtomic, minOutputAtomic: p.amountAtomic, feeAtomic: 0n, rate: '1 USDT = 1 USDT', expiresAtMs: exp, notes: [] };
    const dg = digestOf(p.id, a.sellerId, q1, p.target.deliveryAddress, 'usdt-simulated');
    db.prepare("UPDATE payouts SET stage = 'quoted', state = 'requested', approved_at = NULL, approved_by = NULL, seller_confirmed_at = NULL, quote_id = ?, quote_expires_at = ?, approval_digest = ? WHERE id = ?").run(q1.id, iso(exp), dg, p.id);
    event(db, p.id, 'quoted', 'new USDT payout confirmation requested', now());
    return getPayout(db, p.id)!;
  }
  if (!['requested', 'approved'].includes(p.state) || ['converting', 'converted', 'converted_undelivered', 'delivering'].includes(p.stage ?? '')) throw new PayoutConvError('WRONG_STATE', 'the conversion has already started');
  const route = await cfg.registry.find('payout', p.target.address);
  if (!route || !route.usable) throw new PayoutConvError('ROUTE_UNAVAILABLE', 'the route is no longer available; cancel to restore your USDT earnings');
  const provider = cfg.registry.provider(route.provider) ?? cfg.provider;
  const target: AssetRef = { chainId: p.target.chainId, address: p.target.address, symbol: p.target.symbol, decimals: p.target.decimals };
  const q = await provider.quote({ direction: 'payout', from: USDT_CELO, to: target, inputAtomic: p.amountAtomic, ...(a.scenario ? { scenario: a.scenario } : {}) });
  const digest = digestOf(p.id, a.sellerId, q, p.target.deliveryAddress, p.mode);
  db.prepare(
    "UPDATE payouts SET stage = 'quoted', state = 'requested', approved_at = NULL, approved_by = NULL, seller_confirmed_at = NULL, quote_id = ?, quote_expires_at = ?, approval_digest = ?, expected_target = ?, min_target = ?, rate = ?, fee_target = ? WHERE id = ?",
  ).run(q.id, iso(q.expiresAtMs), digest, q.expectedOutputAtomic.toString(), q.minOutputAtomic.toString(), q.rate, q.feeAtomic.toString(), p.id);
  event(db, p.id, 'quoted', `new quote ${q.rate}; expected ${q.expectedOutputAtomic} ${q.to.symbol} (atomic)`, now());
  return getPayout(db, p.id)!;
}

type Step = { outcome: 'completed' | 'in_progress' | 'restored' | 'needs_review' | 'undelivered'; payout: Payout; detail: string };

/**
 * Execute an APPROVED, seller-confirmed conversion payout (SIMULATED: custody swap + delivery on a fake chain).
 * Every outcome is decided from receipts read through `cfg.reader`, never from what the executor says.
 */
export async function executeConversionPayout(db: Db, cfg: PayoutConversionConfig, a: { payoutId: string; scenario?: string }, now: () => number = Date.now): Promise<Step> {
  const p0 = getPayout(db, a.payoutId);
  if (!p0 || !p0.target) throw new PayoutConvError('NOT_FOUND', 'no such conversion payout');
  if (p0.state === 'confirmed') return { outcome: 'completed', payout: p0, detail: 'already complete' };
  if (p0.state !== 'approved' || p0.stage !== 'confirmed') throw new PayoutConvError('WRONG_STATE', `payout is ${p0.state}/${p0.stage ?? '-'}: it must be seller-confirmed and operator-approved`);
  if (Date.parse(p0.quoteExpiresAt!) <= now()) throw new PayoutConvError('QUOTE_EXPIRED', 'the quote expired; the seller must confirm a new one');
  const provider = cfg.registry.provider(cfg.provider.id) ?? cfg.provider;
  if (p0.mode === 'usdt-simulated') {
    const u = await (provider as SimProvider).executeUsdtPayout({ custody: cfg.custody, deliveryAddress: p0.target.deliveryAddress, amountAtomic: p0.amountAtomic, ...(a.scenario ? { scenario: a.scenario } : {}) });
    if (u.kind === 'failed' || (u.kind === 'submitted' && u.deliveryTx === null)) {
      // nothing left custody: restore the earnings
      const out = failSentPayout(db, p0.id, u.kind === 'failed' ? `the transfer did not happen: ${u.message}` : 'no transfer was made; nothing left custody', now);
      event(db, p0.id, 'failed', 'USDT transfer did not happen; earnings restored', now());
      return { outcome: 'restored', payout: out, detail: u.kind === 'failed' ? u.message : 'no transfer' };
    }
    markSent(db, p0.id, u.deliveryTx!, 'custody-bounded-signer', now);
    setStage(db, p0.id, 'delivering', 'USDT transfer submitted from custody; verifying', now(), { delivery_tx: lower(u.deliveryTx!) });
    return recheckConversionPayout(db, cfg, p0.id, now);
  }
  if (!('executePayout' in provider)) throw new PayoutConvError('WRONG_STATE', 'this provider cannot execute payouts here');
  const quote: ConversionQuote = {
    id: p0.quoteId!, provider: provider.id, direction: 'payout', from: USDT_CELO,
    to: { chainId: p0.target.chainId, address: p0.target.address, symbol: p0.target.symbol, decimals: p0.target.decimals },
    inputAtomic: p0.amountAtomic, expectedOutputAtomic: p0.expectedTarget!, minOutputAtomic: p0.minTarget!, feeAtomic: p0.feeTarget ?? 0n, rate: p0.rate ?? '', expiresAtMs: Date.parse(p0.quoteExpiresAt!), notes: [],
  };
  const r = await (provider as SimProvider).executePayout({ quote, custody: cfg.custody, deliveryAddress: p0.target.deliveryAddress, ...(a.scenario ? { scenario: a.scenario } : {}) });
  if (r.kind === 'failed') {
    const out = failSentPayout(db, p0.id, `the conversion did not happen: ${r.message}`, now);
    event(db, p0.id, 'failed', `conversion refused (${r.code}); USDT earnings restored`, now());
    return { outcome: 'restored', payout: out, detail: r.message };
  }
  // record the transaction BEFORE judging it, so a crash can never lose track of it
  markSent(db, p0.id, r.conversionTx, 'custody-bounded-signer', now);
  setStage(db, p0.id, 'converting', 'swap submitted from custody; verifying', now(), { conversion_tx: lower(r.conversionTx), ...('deliveryTx' in r && r.deliveryTx ? { delivery_tx: lower(r.deliveryTx) } : {}) });
  return recheckConversionPayout(db, cfg, p0.id, now);
}

/** Re-read the chain and move a conversion payout forward. Idempotent; safe at start-up and on demand. */
export async function recheckConversionPayout(db: Db, cfg: PayoutConversionConfig, payoutId: string, now: () => number = Date.now): Promise<Step> {
  const p = getPayout(db, payoutId);
  if (!p || !p.target) throw new PayoutConvError('NOT_FOUND', 'no such conversion payout');
  if (p.state === 'confirmed') return { outcome: 'completed', payout: p, detail: 'complete' };
  if (p.state === 'failed' || p.state === 'cancelled') return { outcome: 'restored', payout: p, detail: p.state };
  if (p.mode === 'usdt-simulated') {
    if (!p.deliveryTx) return { outcome: 'in_progress', payout: p, detail: 'no transfer recorded yet' };
    let r: { receipt: Awaited<ReturnType<ChainReader['receipt']>>; head: bigint } | null = null;
    try {
      r = { receipt: await cfg.reader.receipt(p.deliveryTx), head: await cfg.reader.blockNumber() };
    } catch {
      r = null;
    }
    if (!r) return { outcome: 'in_progress', payout: p, detail: 'chain unreadable; will re-check' };
    if (!r.receipt) return { outcome: 'in_progress', payout: p, detail: 'transfer not visible yet; unresolved, not refunded' };
    const dv = verifyDeposit(r.receipt, r.head, { usdt: USDT_CELO.address, from: cfg.custody, to: p.target!.deliveryAddress, minConfirmations: cfg.minConfirmations });
    if (dv.kind === 'pending') return { outcome: 'in_progress', payout: p, detail: `transfer has ${dv.confirmations}/${cfg.minConfirmations} confirmations` };
    if (dv.kind === 'reverted') {
      const out = failSentPayout(db, p.id, 'the USDT transfer reverted on-chain; funds never left custody', now);
      event(db, p.id, 'failed', 'transfer reverted; earnings restored', now());
      return { outcome: 'restored', payout: out, detail: 'transfer reverted' };
    }
    if (dv.kind === 'mismatch' || dv.receivedAtomic < p.amountAtomic) {
      const why = dv.kind === 'mismatch' ? dv.reason : `delivered ${dv.receivedAtomic}, less than ${p.amountAtomic}`;
      setStage(db, p.id, 'review', `delivery verification failed: ${why}. Not marked paid, not refunded; an operator must review.`, now(), { failure: why.slice(0, 200) });
      return { outcome: 'needs_review', payout: getPayout(db, p.id)!, detail: why };
    }
    const fin = completeConvertedPayout(db, p.id, dv.receivedAtomic, now);
    event(db, p.id, 'delivered', `USDT delivered and verified: ${dv.receivedAtomic} (atomic) to ${p.target!.deliveryAddress}`, now());
    return { outcome: 'completed', payout: fin, detail: 'delivered and verified' };
  }
  if (!p.conversionTx) return { outcome: 'in_progress', payout: p, detail: 'no conversion transaction recorded yet' };
  const read = async (h: string) => {
    try {
      const [receipt, head] = await Promise.all([cfg.reader.receipt(h), cfg.reader.blockNumber()]);
      return { receipt, head };
    } catch {
      return null;
    }
  };
  // ---- 1. the swap in custody
  const sw = await read(p.conversionTx);
  if (!sw) return { outcome: 'in_progress', payout: p, detail: 'chain unreadable; will re-check' };
  if (!sw.receipt) return { outcome: 'in_progress', payout: p, detail: 'swap not visible yet; unresolved, not refunded' };
  const v = verifyConversion(sw.receipt, sw.head, { usdt: p.target.address, reactor: cfg.reactor, recipient: cfg.custody, minBuyAtomic: p.minTarget!, minConfirmations: cfg.minConfirmations });
  if (v.kind === 'pending') return { outcome: 'in_progress', payout: getPayout(db, p.id)!, detail: `swap has ${v.confirmations}/${cfg.minConfirmations} confirmations` };
  if (v.kind === 'reverted') {
    const out = failSentPayout(db, p.id, 'the swap reverted on-chain; USDT never left custody', now);
    event(db, p.id, 'failed', 'swap reverted; USDT earnings restored', now());
    return { outcome: 'restored', payout: out, detail: 'swap reverted' };
  }
  if (v.kind === 'mismatch' || v.kind === 'below_minimum') {
    const why = v.kind === 'mismatch' ? v.reason : `received ${v.receivedAtomic}, below the agreed minimum ${p.minTarget}`;
    setStage(db, p.id, 'review', `swap verification failed: ${why}. Not marked paid, not refunded; an operator must review.`, now(), { failure: why.slice(0, 200) });
    return { outcome: 'needs_review', payout: getPayout(db, p.id)!, detail: why };
  }
  const received = v.receivedAtomic;
  if (p.stage === 'converting') setStage(db, p.id, 'converted', `swap verified: ${received} ${p.target.symbol} (atomic) received in custody`, now(), { received_target: received.toString() });

  // ---- 2. delivery to the seller's verified address
  const cur = getPayout(db, p.id)!;
  if (!cur.deliveryTx) {
    if (cur.stage !== 'converted_undelivered') setStage(db, p.id, 'converted_undelivered', 'swap done; delivery not recorded. The liability is now in the target asset and is NOT returned to USDT.', now());
    return { outcome: 'undelivered', payout: getPayout(db, p.id)!, detail: 'delivery missing' };
  }
  const dl = await read(cur.deliveryTx);
  if (!dl) return { outcome: 'in_progress', payout: cur, detail: 'chain unreadable; will re-check' };
  if (!dl.receipt) {
    if (cur.stage !== 'delivering') setStage(db, p.id, 'delivering', 'delivery submitted; waiting to be visible', now());
    return { outcome: 'in_progress', payout: getPayout(db, p.id)!, detail: 'delivery not visible yet' };
  }
  const dv = verifyDeposit(dl.receipt, dl.head, { usdt: p.target.address, from: cfg.custody, to: p.target.deliveryAddress, minConfirmations: cfg.minConfirmations });
  if (dv.kind === 'pending') return { outcome: 'in_progress', payout: cur, detail: `delivery has ${dv.confirmations}/${cfg.minConfirmations} confirmations` };
  if (dv.kind === 'reverted' || dv.kind === 'mismatch') {
    const why = dv.kind === 'reverted' ? 'the delivery transaction reverted' : dv.reason;
    setStage(db, p.id, 'converted_undelivered', `delivery failed: ${why}. The liability stays in ${p.target.symbol}; retry the delivery.`, now(), { failure: why.slice(0, 200), delivery_tx: null });
    return { outcome: 'undelivered', payout: getPayout(db, p.id)!, detail: why };
  }
  if (dv.receivedAtomic < received) {
    setStage(db, p.id, 'review', `delivered ${dv.receivedAtomic}, less than the verified ${received}. Not complete; an operator must review.`, now(), { failure: 'short delivery' });
    return { outcome: 'needs_review', payout: getPayout(db, p.id)!, detail: 'short delivery' };
  }
  const done = completeConvertedPayout(db, p.id, dv.receivedAtomic, now);
  event(db, p.id, 'delivered', `delivered and verified: ${dv.receivedAtomic} ${p.target.symbol} (atomic) to ${p.target.deliveryAddress}`, now());
  return { outcome: 'completed', payout: done, detail: 'delivered and verified' };
}

/** Retry ONLY the delivery leg of a payout whose swap was verified (simulated). Never re-swaps. */
export async function retryConversionDelivery(db: Db, cfg: PayoutConversionConfig, payoutId: string, now: () => number = Date.now): Promise<Step> {
  const p = getPayout(db, payoutId);
  if (!p || !p.target) throw new PayoutConvError('NOT_FOUND', 'no such conversion payout');
  if (p.stage !== 'converted_undelivered' || p.receivedTarget === null) throw new PayoutConvError('WRONG_STATE', 'only a verified-but-undelivered payout can retry delivery');
  const provider = cfg.provider as SimProvider;
  if (typeof provider.retryDelivery !== 'function') throw new PayoutConvError('WRONG_STATE', 'this provider cannot deliver here');
  const { deliveryTx } = provider.retryDelivery({
    token: { chainId: p.target.chainId, address: p.target.address, symbol: p.target.symbol, decimals: p.target.decimals },
    custody: cfg.custody, deliveryAddress: p.target.deliveryAddress, amountAtomic: p.receivedTarget,
  });
  db.prepare('UPDATE payouts SET delivery_tx = ? WHERE id = ?').run(lower(deliveryTx), p.id);
  event(db, p.id, 'delivering', 'delivery retried', now());
  return recheckConversionPayout(db, cfg, p.id, now);
}

/** Start-up / on-demand: move every conversion payout that is mid-flight. */
export async function recoverConversionPayouts(db: Db, cfg: PayoutConversionConfig, now: () => number = Date.now, o: { atStartup?: boolean } = {}): Promise<Array<{ id: string; outcome: string }>> {
  const out: Array<{ id: string; outcome: string }> = [];
  for (const r of query(db, "SELECT id FROM payouts WHERE mode <> 'usdt' AND state = 'sent' AND stage IN ('converting','converted','delivering','converted_undelivered')")) {
    const s = await recheckConversionPayout(db, cfg, String(r.id), now);
    out.push({ id: String(r.id), outcome: s.outcome });
    // SIMULATION ONLY: the fake chain does not survive a restart. Park what it can no longer confirm (never complete, never refund).
    if (o.atStartup && cfg.provider.simulated && s.outcome === 'in_progress' && (s.payout.mode === 'convert-simulated' || s.payout.mode === 'usdt-simulated')) {
      setStage(db, s.payout.id, 'review', 'the simulated chain was reset by a server restart; this simulated payout can no longer be confirmed. Not marked paid, not refunded.', now());
    }
  }
  return out;
}

export { CELO_CHAIN_ID };
