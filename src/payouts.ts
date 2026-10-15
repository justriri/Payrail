// Seller payouts: earnings -> the seller's own verified wallet. NOTHING here broadcasts a transaction.
//
//   requested   seller asked; earnings are moved to "payout pending" (cannot be spent twice)
//   approved    the operator approved it (CLI only; not reachable over HTTP)
//   sent        the signed transfer's hash was recorded BEFORE it was broadcast
//   confirmed   the chain shows a successful token Transfer of exactly this amount to exactly this address
//   cancelled   returned to earnings (only possible before anything was sent)
//   failed      the transfer reverted on-chain: nothing left, returned to earnings
//
// A payout that is `sent` but not found/confirmed is NEVER returned automatically: the funds may have left.
import { randomUUID } from 'node:crypto';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { TRANSFER_TOPIC } from './funding.ts';
import type { ChainReader } from './funding.ts';
import { balance, post } from './ledger.ts';

export class PayoutError extends Error {
  code: 'NOT_FOUND' | 'NO_WALLET' | 'TEST_ASSET' | 'BAD_AMOUNT' | 'INSUFFICIENT_EARNINGS' | 'WRONG_STATE' | 'OVER_LIMIT' | 'BAD_HASH';
  constructor(code: PayoutError['code'], message: string) {
    super(message);
    this.name = 'PayoutError';
    this.code = code;
  }
}

export type PayoutState = 'requested' | 'approved' | 'sent' | 'confirmed' | 'cancelled' | 'failed';
export interface Payout {
  id: string;
  sellerId: string;
  asset: string;
  amountAtomic: bigint;
  destination: string;
  state: PayoutState;
  txHash: string | null;
  requestedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  sentAt: string | null;
  settledAt: string | null;
  note: string | null;
  /** 'usdt' (no conversion) | 'convert-simulated' | 'convert-live' */
  mode: string;
  /** conversion sub-state while `state` is requested/approved/sent: quoted | confirmed | converting | converted | converted_undelivered | delivering | review */
  stage: string | null;
  target: { symbol: string; chainId: number; address: string; decimals: number; deliveryAddress: string } | null;
  quoteId: string | null;
  quoteExpiresAt: string | null;
  approvalDigest: string | null;
  expectedTarget: bigint | null;
  minTarget: bigint | null;
  receivedTarget: bigint | null;
  rate: string | null;
  feeTarget: bigint | null;
  conversionTx: string | null;
  deliveryTx: string | null;
  preferenceVersion: number | null;
  sellerConfirmedAt: string | null;
  failure: string | null;
}
const toPayout = (r: Record<string, unknown>): Payout => ({
  id: String(r.id),
  sellerId: String(r.seller_id),
  asset: String(r.asset),
  amountAtomic: BigInt(r.amount_atomic as bigint),
  destination: String(r.destination),
  state: r.state as PayoutState,
  txHash: r.tx_hash === null ? null : String(r.tx_hash),
  requestedAt: String(r.requested_at),
  approvedAt: r.approved_at === null ? null : String(r.approved_at),
  approvedBy: r.approved_by === null ? null : String(r.approved_by),
  sentAt: r.sent_at === null ? null : String(r.sent_at),
  settledAt: r.settled_at === null ? null : String(r.settled_at),
  note: r.note === null ? null : String(r.note),
  mode: String(r.mode ?? 'usdt'),
  stage: r.stage === null || r.stage === undefined ? null : String(r.stage),
  target:
    r.target_symbol === null || r.target_symbol === undefined
      ? null
      : { symbol: String(r.target_symbol), chainId: Number(r.target_chain_id), address: String(r.target_address), decimals: Number(r.target_decimals), deliveryAddress: String(r.delivery_address) },
  quoteId: r.quote_id === null || r.quote_id === undefined ? null : String(r.quote_id),
  quoteExpiresAt: r.quote_expires_at === null || r.quote_expires_at === undefined ? null : String(r.quote_expires_at),
  approvalDigest: r.approval_digest === null || r.approval_digest === undefined ? null : String(r.approval_digest),
  expectedTarget: r.expected_target === null || r.expected_target === undefined ? null : BigInt(String(r.expected_target)),
  minTarget: r.min_target === null || r.min_target === undefined ? null : BigInt(String(r.min_target)),
  receivedTarget: r.received_target === null || r.received_target === undefined ? null : BigInt(String(r.received_target)),
  rate: r.rate === null || r.rate === undefined ? null : String(r.rate),
  feeTarget: r.fee_target === null || r.fee_target === undefined ? null : BigInt(String(r.fee_target)),
  conversionTx: r.conversion_tx === null || r.conversion_tx === undefined ? null : String(r.conversion_tx),
  deliveryTx: r.delivery_tx === null || r.delivery_tx === undefined ? null : String(r.delivery_tx),
  preferenceVersion: r.preference_version === null || r.preference_version === undefined ? null : Number(r.preference_version),
  sellerConfirmedAt: r.seller_confirmed_at === null || r.seller_confirmed_at === undefined ? null : String(r.seller_confirmed_at),
  failure: r.failure === null || r.failure === undefined ? null : String(r.failure),
});
const iso = (now: () => number) => new Date(now()).toISOString();

export interface PayoutPolicy {
  /** assets that are real money and may be paid out; test credits are never in this list */
  payableAssets: readonly string[];
  minAtomic: bigint;
  maxAtomic: bigint;
}

export function getPayout(db: Db, id: string): Payout | undefined {
  const r = queryOne(db, 'SELECT * FROM payouts WHERE id = ?', id);
  return r ? toPayout(r) : undefined;
}
export function payoutsOf(db: Db, sellerId: string): Payout[] {
  return query(db, 'SELECT * FROM payouts WHERE seller_id = ? ORDER BY requested_at DESC', sellerId).map(toPayout);
}
export function pendingPayouts(db: Db, states: PayoutState[] = ['requested', 'approved', 'sent']): Payout[] {
  return query(db, `SELECT * FROM payouts WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY requested_at`, ...states).map(toPayout);
}

/** The seller asks for `amount` of their earnings to be sent to the wallet they signed in with. */
export function requestPayout(db: Db, sellerId: string, a: { asset: string; amountAtomic: bigint }, policy: PayoutPolicy, now: () => number = Date.now): Payout {
  if (!policy.payableAssets.includes(a.asset)) throw new PayoutError('TEST_ASSET', `${a.asset} is not a payable asset (test credits cannot be paid out)`);
  if (a.amountAtomic < policy.minAtomic) throw new PayoutError('BAD_AMOUNT', `the minimum payout is ${policy.minAtomic}`);
  if (a.amountAtomic > policy.maxAtomic) throw new PayoutError('OVER_LIMIT', `a single payout is capped at ${policy.maxAtomic} while the system is new`);
  return inTransaction(db, () => {
    const acct = queryOne(db, "SELECT wallet_address FROM accounts WHERE id = ? AND kind = 'seller'", sellerId);
    if (!acct) throw new PayoutError('NOT_FOUND', 'unknown seller');
    if (acct.wallet_address === null) throw new PayoutError('NO_WALLET', 'sign in with a wallet first: payouts go only to your verified wallet');
    if (balance(db, sellerId, 'seller_earnings', a.asset) < a.amountAtomic) throw new PayoutError('INSUFFICIENT_EARNINGS', 'amount is more than your available earnings');
    const id = `pay_${randomUUID()}`;
    db.prepare(
      "INSERT INTO payouts (id, seller_id, asset, amount_atomic, destination, state, requested_at) VALUES (?, ?, ?, ?, ?, 'requested', ?)",
    ).run(id, sellerId, a.asset, a.amountAtomic, String(acct.wallet_address), iso(now));
    post(db, 'payout_request', null, id, 'payout requested', [
      { owner: sellerId, kind: 'seller_earnings', asset: a.asset, amount: -a.amountAtomic },
      { owner: sellerId, kind: 'payout_pending', asset: a.asset, amount: a.amountAtomic },
    ], now);
    audit(db, sellerId, 'payout.requested', id, { asset: a.asset, amount: a.amountAtomic.toString() }, new Date(now()));
    return getPayout(db, id)!;
  });
}

function transition(db: Db, id: string, from: PayoutState[], fn: (p: Payout) => void): Payout {
  return inTransaction(db, () => {
    const p = getPayout(db, id);
    if (!p) throw new PayoutError('NOT_FOUND', `no payout ${id}`);
    if (!from.includes(p.state)) throw new PayoutError('WRONG_STATE', `payout is ${p.state}`);
    fn(p);
    return getPayout(db, id)!;
  });
}

export function approvePayout(db: Db, id: string, operator: string, now: () => number = Date.now): Payout {
  const cur = getPayout(db, id);
  if (cur?.state === 'approved') return cur;
  if (cur && cur.mode !== 'usdt' && cur.stage !== 'confirmed') {
    throw new PayoutError('WRONG_STATE', 'the seller has not confirmed the conversion quote (or it expired); it cannot be approved yet');
  }
  return transition(db, id, ['requested'], () => {
    db.prepare("UPDATE payouts SET state = 'approved', approved_at = ?, approved_by = ? WHERE id = ?").run(iso(now), operator.slice(0, 80), id);
    audit(db, operator, 'payout.approved', id, undefined, new Date(now()));
  });
}

/** Record the hash of the signed transfer BEFORE broadcasting it. */
export function markSent(db: Db, id: string, txHash: string, operator: string, now: () => number = Date.now): Payout {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new PayoutError('BAD_HASH', 'invalid transaction hash');
  const cur = getPayout(db, id);
  if (cur?.state === 'sent' && cur.txHash === txHash.toLowerCase()) return cur;
  return transition(db, id, ['approved'], () => {
    db.prepare("UPDATE payouts SET state = 'sent', tx_hash = ?, sent_at = ? WHERE id = ?").run(txHash.toLowerCase(), iso(now), id);
    audit(db, operator, 'payout.sent', id, { txHash: txHash.toLowerCase() }, new Date(now()));
  });
}

function giveBack(db: Db, p: Payout, kind: 'cancelled' | 'failed', note: string, actor: string, now: () => number): void {
  post(db, 'payout_cancel', null, p.id, note, [
    { owner: p.sellerId, kind: 'payout_pending', asset: p.asset, amount: -p.amountAtomic },
    { owner: p.sellerId, kind: 'seller_earnings', asset: p.asset, amount: p.amountAtomic },
  ], now);
  db.prepare('UPDATE payouts SET state = ?, settled_at = ?, note = ? WHERE id = ?').run(kind, iso(now), note.slice(0, 200), p.id);
  audit(db, actor, `payout.${kind}`, p.id, { note }, new Date(now()));
}

/** Cancel before anything was sent. The seller may cancel their own request; the operator may cancel any. */
export function cancelPayout(db: Db, id: string, actor: string, now: () => number = Date.now): Payout {
  const cur = getPayout(db, id);
  if (cur?.state === 'cancelled') return cur;
  return transition(db, id, ['requested', 'approved'], (p) => giveBack(db, p, 'cancelled', 'cancelled before sending', actor, now));
}

/** A conversion payout whose swap provably did not happen: restore the USDT earnings (state sent -> failed). */
export function failSentPayout(db: Db, id: string, note: string, now: () => number = Date.now): Payout {
  return transition(db, id, ['sent', 'approved'], (p) => giveBack(db, p, 'failed', note, 'system', now));
}

/** The destination payment was verified: only now is a conversion payout complete (USDT leaves pending). */
export function completeConvertedPayout(db: Db, id: string, received: bigint, now: () => number = Date.now): Payout {
  const cur = getPayout(db, id);
  if (cur?.state === 'confirmed') return cur;
  return transition(db, id, ['sent'], (x) => {
    post(db, 'payout_confirm', null, x.id, 'conversion payout delivered and verified', [
      { owner: x.sellerId, kind: 'payout_pending', asset: x.asset, amount: -x.amountAtomic },
      { owner: 'platform', kind: 'external_funding', asset: x.asset, amount: x.amountAtomic },
    ], now);
    db.prepare("UPDATE payouts SET state = 'confirmed', settled_at = ?, stage = 'delivered', received_target = ? WHERE id = ?").run(iso(now), received.toString(), x.id);
    audit(db, 'system', 'payout.confirmed', x.id, { receivedTarget: received.toString(), conversionTx: x.conversionTx, deliveryTx: x.deliveryTx }, new Date(now()));
  });
}

export interface PayoutVerifyConfig {
  reader: ChainReader;
  token: string;
  /** the wallet the transfer must come from */
  sourceAddress: string;
  minConfirmations: number;
}

/** Read the chain and settle a `sent` payout. Returns the payout and what was observed. */
export async function verifyPayout(db: Db, cfg: PayoutVerifyConfig, id: string, now: () => number = Date.now): Promise<{ payout: Payout; observed: 'confirmed' | 'reverted' | 'not_found' | 'pending' | 'mismatch' }> {
  const p = getPayout(db, id);
  if (!p) throw new PayoutError('NOT_FOUND', `no payout ${id}`);
  if (p.state === 'confirmed') return { payout: p, observed: 'confirmed' };
  if (p.state !== 'sent' || !p.txHash) throw new PayoutError('WRONG_STATE', `payout is ${p.state}`);
  const [receipt, head] = await Promise.all([cfg.reader.receipt(p.txHash), cfg.reader.blockNumber()]);
  if (!receipt) return { payout: p, observed: 'not_found' }; // never auto-return: the funds may have left
  if (receipt.status !== 'success') {
    const out = transition(db, id, ['sent'], (x) => giveBack(db, x, 'failed', 'transfer reverted on-chain; funds did not leave', 'system', now));
    return { payout: out, observed: 'reverted' };
  }
  if (Number(head - receipt.blockNumber) + 1 < cfg.minConfirmations) return { payout: p, observed: 'pending' };
  const lower = (s: string) => s.toLowerCase();
  const match = receipt.logs.some(
    (l) =>
      lower(l.address) === lower(cfg.token) &&
      l.topics.length === 3 &&
      lower(l.topics[0]!) === TRANSFER_TOPIC &&
      `0x${l.topics[1]!.slice(-40)}`.toLowerCase() === lower(cfg.sourceAddress) &&
      `0x${l.topics[2]!.slice(-40)}`.toLowerCase() === lower(p.destination) &&
      /^0x[0-9a-fA-F]{64}$/.test(l.data) &&
      BigInt(l.data) === p.amountAtomic,
  );
  if (!match) return { payout: p, observed: 'mismatch' };
  const out = transition(db, id, ['sent'], (x) => {
    post(db, 'payout_confirm', null, x.id, 'payout confirmed on-chain', [
      { owner: x.sellerId, kind: 'payout_pending', asset: x.asset, amount: -x.amountAtomic },
      { owner: 'platform', kind: 'external_funding', asset: x.asset, amount: x.amountAtomic },
    ], now);
    db.prepare("UPDATE payouts SET state = 'confirmed', settled_at = ? WHERE id = ?").run(iso(now), x.id);
    audit(db, 'system', 'payout.confirmed', x.id, { txHash: x.txHash }, new Date(now()));
  });
  return { payout: out, observed: 'confirmed' };
}
