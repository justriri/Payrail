// Marketplace funding through the Textile cNGN -> USDT conversion.
//
//   quote -> buyer approves the exact quote -> conversion -> INDEPENDENT on-chain verification -> ledger credit
//
// Rules this module enforces (see test/marketfunding.test.ts):
//  * Nothing is converted because an amount was typed or a page opened: execution needs the approval digest of the exact quote.
//  * Nothing is credited because a converter said "success" or a transaction was submitted. The credit is derived from a
//    chain receipt this module reads itself: a successful swap that emitted the Textile reactor's Fill, and USDT Transfer
//    logs to the intended recipient, at the right token contract, with enough confirmations.
//  * The credit is exactly once: ledger deposit reference `fund:<opId>` is UNIQUE, and a swap tx hash can be claimed by one
//    operation only.
//  * Pending, failed, unresolved and under-minimum results are never spendable.
//  * Simulated conversions credit the TEST asset and are labelled; they can never become real USDT.
import { createHash, randomUUID } from 'node:crypto';
import { toEventSelector } from 'viem';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { TRANSFER_TOPIC } from './funding.ts';
import type { ChainReader, ChainReceipt } from './funding.ts';
import { LedgerError, deposit } from './ledger.ts';

export class FundingOpError extends Error {
  code:
    | 'BAD_AMOUNT' | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'DAILY_LIMIT' | 'TOO_MANY_OPEN' | 'QUOTE_UNAVAILABLE' | 'NOT_FOUND' | 'NOT_OWNER'
    | 'WRONG_STATE' | 'QUOTE_EXPIRED' | 'DIGEST_MISMATCH' | 'SIGNING_UNAVAILABLE' | 'IDEMPOTENCY_CONFLICT' | 'NOT_ALLOWED' | 'BAD_INPUT' | 'TX_ALREADY_USED' | 'ALREADY_RECORDED';
  constructor(code: FundingOpError['code'], message: string) {
    super(message);
    this.name = 'FundingOpError';
    this.code = code;
  }
}

export type FundingState = 'QUOTED' | 'EXPIRED' | 'CONVERTING' | 'VERIFYING' | 'CREDITED' | 'FAILED' | 'UNRESOLVED' | 'REVIEW' | 'CANCELLED';

export interface FundingLimits {
  /** in atomic units of the SELL asset (cNGN, 6 decimals) */
  minSellAtomic: bigint;
  maxSellAtomic: bigint;
  maxPerDaySellAtomic: bigint;
  maxOpenOps: number;
}

export interface ConverterQuote {
  quoteId: string;
  provider: string;
  /** buy units per 1 sell unit, as text */
  rate: string;
  /** the venue fee, already inside the sell amount */
  feeAtomic: bigint;
  expectedBuyAtomic: bigint;
  /** the least the conversion may deliver; anything below is not credited */
  minBuyAtomic: bigint;
  expiresAtMs: number;
  notes: string[];
}

export type ExecuteResult =
  | { kind: 'submitted'; swapTx: string | null; approveTxs: string[]; /** the buyer's own USDT transfer to custody (two-hop funding) */ depositTx?: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'uncertain'; swapTx?: string; approveTxs: string[]; message: string };

export interface FundingConverter {
  mode: 'simulated' | 'live';
  sellSymbol: string;
  buySymbol: 'USDT';
  /** decimals of the sell asset (default 6); amounts above 64 bits are stored as text */
  sellDecimals?: number;
  sellChainId?: number;
  sellAddress?: string;
  /**
   * Already USDT: there is nothing to convert. The only step is the deposit to custody, which is still verified on-chain.
   */
  passthrough?: boolean;
  /**
   * The wallet that fills the order and therefore RECEIVES the converted USDT (Textile pays msg.sender; there is no
   * recipient parameter). For buyer funding this is the buyer's own wallet.
   */
  recipient: string;
  /**
   * The BUYER's own wallet signs and sends every transaction (approve, swap, deposit). This server never signs for the
   * buyer: `execute` is not called, and the engine waits for the buyer to report transaction hashes, which it then verifies
   * from the chain exactly like any other conversion.
   */
  clientSigned?: boolean;
  /** When set, the USDT must then be transferred from `recipient` to this custody address, and only that transfer is credited. */
  depositAddress?: string;
  quote(req: { sellAtomic: bigint; scenario?: string }): Promise<ConverterQuote>;
  execute(req: { opId: string; quoteId: string; sellAtomic: bigint; minBuyAtomic: bigint; digest: string; scenario?: string | null }): Promise<ExecuteResult>;
}

export interface FundingConfig {
  converter: FundingConverter;
  reader: ChainReader;
  /** the USDT token contract the credit must come from */
  usdt: string;
  /** the Textile reactor that must have emitted the Fill */
  reactor: string;
  chainId: number;
  minConfirmations: number;
  limits: FundingLimits;
  /** ledger asset credited: the TEST asset for simulated conversions, USDT only in real-funds mode */
  creditAsset: string;
  /** optional cap across ALL source assets, in USDT atomic (expected output summed over the rolling 24 hours) */
  maxPerDayBuyAtomic?: bigint;
  /**
   * Who may fund. REQUIRED for a live converter: the signing wallet belongs to the operator, and anonymous marketplace
   * buyers hold no keys, so unrestricted live funding would let any buyer turn the operator's cNGN into credits.
   */
  allowedBuyerIds?: readonly string[];
}

const FILL_TOPIC = toEventSelector('Fill(bytes32,address,address,uint256)').toLowerCase();
const lower = (s: string) => s.toLowerCase();
const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (n: number) => new Date(n).toISOString();

// ------------------------------------------------------------------ verification (pure)

export type Verdict =
  | { kind: 'pending'; confirmations: number }
  | { kind: 'reverted' }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'below_minimum'; receivedAtomic: bigint }
  | { kind: 'confirmed'; receivedAtomic: bigint };

/**
 * Judge one conversion transaction from its receipt alone. Never trusts what any API or caller said.
 * Confirmed requires: success status; enough confirmations; the verified Textile reactor emitted Fill with this wallet as
 * the filler; and USDT (the exact token contract) Transfer logs TO the recipient.
 */
export function verifyConversion(
  receipt: ChainReceipt,
  head: bigint,
  e: { usdt: string; reactor: string; recipient: string; minBuyAtomic: bigint; minConfirmations: number },
): Verdict {
  if (receipt.status !== 'success') return { kind: 'reverted' };
  const confirmations = Number(head - receipt.blockNumber) + 1;
  if (confirmations < e.minConfirmations) return { kind: 'pending', confirmations };
  const fill = receipt.logs.some((l) => lower(l.address) === lower(e.reactor) && l.topics.length >= 4 && lower(l.topics[0]!) === FILL_TOPIC && topicAddr(l.topics[2]!) === lower(e.recipient));
  if (!fill) return { kind: 'mismatch', reason: 'the transaction did not emit a Fill from the Textile reactor for this wallet' };
  let received = 0n;
  for (const l of receipt.logs) {
    if (lower(l.address) !== lower(e.usdt) || l.topics.length !== 3 || lower(l.topics[0]!) !== TRANSFER_TOPIC) continue;
    if (topicAddr(l.topics[2]!) !== lower(e.recipient)) continue;
    if (/^0x[0-9a-fA-F]{64}$/.test(l.data)) received += BigInt(l.data);
  }
  if (received <= 0n) return { kind: 'mismatch', reason: 'no USDT from the expected token contract was delivered to the intended recipient' };
  if (received < e.minBuyAtomic) return { kind: 'below_minimum', receivedAtomic: received };
  return { kind: 'confirmed', receivedAtomic: received };
}

// ------------------------------------------------------------------ records

export interface FundingOp {
  id: string;
  buyerId: string;
  mode: 'simulated' | 'live';
  state: FundingState;
  sellSymbol: string;
  sellAtomic: bigint;
  buySymbol: string;
  expectedAtomic: bigint;
  minAtomic: bigint;
  feeAtomic: bigint;
  rate: string;
  provider: string;
  quoteId: string;
  quoteExpiresAt: string;
  approvalDigest: string;
  approvedAt: string | null;
  creditAsset: string;
  receivedAtomic: bigint | null;
  creditedAtomic: bigint | null;
  creditRef: string | null;
  swapTx: string | null;
  approveTxs: string[];
  failureCode: string | null;
  failureMessage: string | null;
  scenario: string | null;
  createdAt: string;
  updatedAt: string;
  sellDecimals: number;
  sellChainId: number | null;
  sellAddress: string | null;
  taker: string | null;
  depositTx: string | null;
  depositAddress: string | null;
  /** 'swap' | 'deposit' while VERIFYING in a two-hop funding */
  stage: string | null;
}
const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as bigint));
const toOp = (r: Record<string, unknown>): FundingOp => ({
  id: String(r.id), buyerId: String(r.buyer_id), mode: r.mode as FundingOp['mode'], state: r.state as FundingState,
  sellSymbol: String(r.sell_symbol), sellAtomic: BigInt(String(r.sell_atomic)), buySymbol: String(r.buy_symbol),
  expectedAtomic: BigInt(r.expected_atomic as bigint), minAtomic: BigInt(r.min_atomic as bigint), feeAtomic: BigInt(String(r.fee_atomic)),
  rate: String(r.rate), provider: String(r.provider), quoteId: String(r.quote_id), quoteExpiresAt: String(r.quote_expires_at),
  approvalDigest: String(r.approval_digest), approvedAt: r.approved_at === null ? null : String(r.approved_at), creditAsset: String(r.credit_asset),
  receivedAtomic: big(r.received_atomic), creditedAtomic: big(r.credited_atomic), creditRef: r.credit_ref === null ? null : String(r.credit_ref),
  swapTx: r.swap_tx === null ? null : String(r.swap_tx), approveTxs: r.approve_txs === null ? [] : (JSON.parse(String(r.approve_txs)) as string[]),
  failureCode: r.failure_code === null ? null : String(r.failure_code), failureMessage: r.failure_message === null ? null : String(r.failure_message),
  scenario: r.scenario === null ? null : String(r.scenario), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  sellDecimals: Number(r.sell_decimals ?? 6), sellChainId: r.sell_chain_id === null || r.sell_chain_id === undefined ? null : Number(r.sell_chain_id),
  sellAddress: r.sell_address === null || r.sell_address === undefined ? null : String(r.sell_address),
  taker: r.taker === null || r.taker === undefined ? null : String(r.taker),
  depositTx: r.deposit_tx === null || r.deposit_tx === undefined ? null : String(r.deposit_tx),
  depositAddress: r.deposit_address === null || r.deposit_address === undefined ? null : String(r.deposit_address),
  stage: r.stage === null || r.stage === undefined ? null : String(r.stage),
});

export function getFundingOp(db: Db, id: string): FundingOp | undefined {
  const r = queryOne(db, 'SELECT * FROM funding_ops WHERE id = ?', id);
  return r ? toOp(r) : undefined;
}
export function listFundingOps(db: Db, buyerId: string, limit = 30): FundingOp[] {
  return query(db, 'SELECT * FROM funding_ops WHERE buyer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', buyerId, limit).map(toOp);
}
export function fundingEvents(db: Db, opId: string): Array<{ at: string; state: string; note: string }> {
  return query(db, 'SELECT at, state, note FROM funding_events WHERE op_id = ? ORDER BY id', opId).map((r) => ({ at: String(r.at), state: String(r.state), note: String(r.note) }));
}

function event(db: Db, opId: string, state: string, note: string, detail: unknown, now: number): void {
  db.prepare('INSERT INTO funding_events (op_id, at, state, note, detail_json) VALUES (?, ?, ?, ?, ?)').run(opId, iso(now), state, note.slice(0, 300), detail === undefined ? null : JSON.stringify(detail));
}
function setState(db: Db, id: string, state: FundingState, note: string, now: number, patch: Record<string, string | bigint | null> = {}, detail?: unknown): void {
  const cols = Object.keys(patch);
  db.prepare(`UPDATE funding_ops SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(state, iso(now), ...cols.map((c) => patch[c]!), id);
  event(db, id, state, note, detail, now);
}

/** The text the buyer's approval is bound to. It covers everything that matters about the quote. */
export function approvalDigest(op: { id: string; buyerId: string; sellAtomic: bigint; minAtomic: bigint; expectedAtomic: bigint; quoteId: string; quoteExpiresAt: string; mode: string; creditAsset: string }): string {
  return sha(JSON.stringify([op.id, op.buyerId, op.sellAtomic.toString(), op.minAtomic.toString(), op.expectedAtomic.toString(), op.quoteId, op.quoteExpiresAt, op.mode, op.creditAsset]));
}

// ------------------------------------------------------------------ 1. quote

export async function requestFundingQuote(
  db: Db,
  cfg: FundingConfig,
  a: { buyerId: string; sellAtomic: bigint; idempotencyKey: string; scenario?: string },
  now: () => number = Date.now,
): Promise<FundingOp> {
  const prior = queryOne(db, 'SELECT * FROM funding_ops WHERE buyer_id = ? AND idempotency_key = ?', a.buyerId, a.idempotencyKey);
  if (prior) {
    if (BigInt(String(prior.sell_atomic)) !== a.sellAtomic) throw new FundingOpError('IDEMPOTENCY_CONFLICT', 'this request key was already used for a different amount');
    return toOp(prior);
  }
  // a live converter that spends the OPERATOR wallet is restricted; a buyer-signed one spends only the buyer's own funds
  if (cfg.converter.mode === 'live' && !cfg.converter.clientSigned && !(cfg.allowedBuyerIds && cfg.allowedBuyerIds.includes(a.buyerId))) {
    throw new FundingOpError('NOT_ALLOWED', 'live funding converts the operator wallet funds and is restricted to the designated buyer account');
  }
  const L = cfg.limits;
  if (a.sellAtomic <= 0n) throw new FundingOpError('BAD_AMOUNT', 'the amount must be positive');
  if (a.sellAtomic < L.minSellAtomic) throw new FundingOpError('BELOW_MINIMUM', `the minimum funding amount is ${L.minSellAtomic} (atomic cNGN)`);
  if (a.sellAtomic > L.maxSellAtomic) throw new FundingOpError('ABOVE_MAXIMUM', `the maximum for one funding operation is ${L.maxSellAtomic} (atomic cNGN)`);
  const recent = query(
    db,
    "SELECT sell_symbol, sell_atomic, expected_atomic FROM funding_ops WHERE buyer_id = ? AND state IN ('CONVERTING','VERIFYING','CREDITED','UNRESOLVED','REVIEW') AND created_at >= ?",
    a.buyerId,
    iso(now() - 86_400_000),
  );
  // sums are done in JS: 18-decimal amounts do not fit SQLite integers
  let daySell = 0n;
  let dayBuy = 0n;
  for (const r of recent) {
    if (String(r.sell_symbol) === cfg.converter.sellSymbol) daySell += BigInt(String(r.sell_atomic));
    dayBuy += BigInt(r.expected_atomic as bigint);
  }
  if (daySell + a.sellAtomic > L.maxPerDaySellAtomic) throw new FundingOpError('DAILY_LIMIT', 'this would exceed the rolling 24-hour funding limit');
  // in-flight operations only: REVIEW is parked for an operator and still counts toward the daily limit, but must not lock a buyer out
  const open = queryOne<{ n: bigint }>(db, "SELECT COUNT(*) AS n FROM funding_ops WHERE buyer_id = ? AND state IN ('CONVERTING','VERIFYING','UNRESOLVED')", a.buyerId);
  if (Number(open?.n ?? 0n) >= L.maxOpenOps) throw new FundingOpError('TOO_MANY_OPEN', 'finish or resolve your open funding operations first');

  let q: ConverterQuote;
  try {
    q = await cfg.converter.quote({ sellAtomic: a.sellAtomic, ...(a.scenario ? { scenario: a.scenario } : {}) });
  } catch (e) {
    throw new FundingOpError('QUOTE_UNAVAILABLE', `no conversion quote is available right now: ${(e as Error).message.slice(0, 160)}`);
  }
  if (cfg.maxPerDayBuyAtomic !== undefined && dayBuy + q.expectedBuyAtomic > cfg.maxPerDayBuyAtomic) {
    throw new FundingOpError('DAILY_LIMIT', 'this would exceed the rolling 24-hour funding limit across all assets');
  }
  const id = `fund_${randomUUID()}`;
  const base = { id, buyerId: a.buyerId, sellAtomic: a.sellAtomic, minAtomic: q.minBuyAtomic, expectedAtomic: q.expectedBuyAtomic, quoteId: q.quoteId, quoteExpiresAt: iso(q.expiresAtMs), mode: cfg.converter.mode, creditAsset: cfg.creditAsset };
  const digest = approvalDigest(base);
  const at = iso(now());
  db.prepare(
    `INSERT INTO funding_ops (id, buyer_id, idempotency_key, mode, state, sell_symbol, sell_atomic, buy_symbol, expected_atomic, min_atomic, fee_atomic, rate, provider, quote_id, quote_expires_at, approval_digest, credit_asset, scenario, created_at, updated_at, sell_decimals, sell_chain_id, sell_address, taker, deposit_address)
     VALUES (?, ?, ?, ?, 'QUOTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.buyerId, a.idempotencyKey, cfg.converter.mode, cfg.converter.sellSymbol, a.sellAtomic.toString(), cfg.converter.buySymbol, q.expectedBuyAtomic, q.minBuyAtomic, q.feeAtomic.toString(), q.rate, q.provider, q.quoteId, iso(q.expiresAtMs), digest, cfg.creditAsset, a.scenario ?? null, at, at,
    cfg.converter.sellDecimals ?? 6, cfg.converter.sellChainId ?? null, cfg.converter.sellAddress ?? null, cfg.converter.recipient, cfg.converter.depositAddress ?? null);
  event(db, id, 'QUOTED', 'quote obtained; nothing has been converted', { rate: q.rate, expected: q.expectedBuyAtomic.toString(), min: q.minBuyAtomic.toString() }, now());
  return getFundingOp(db, id)!;
}

// ------------------------------------------------------------------ 2. approve + execute + verify + credit

/** Only an explicit approval of THIS quote (its digest) starts a conversion. Repeats are safe: the state moves once. */
export async function approveFunding(
  db: Db,
  cfg: FundingConfig,
  a: { opId: string; buyerId: string; digest: string },
  now: () => number = Date.now,
): Promise<FundingOp> {
  const op0 = getFundingOp(db, a.opId);
  if (!op0) throw new FundingOpError('NOT_FOUND', 'no such funding operation');
  if (op0.buyerId !== a.buyerId) throw new FundingOpError('NOT_OWNER', 'not your funding operation');
  if (op0.state !== 'QUOTED') return op0; // idempotent: already approved / finished / expired
  if (a.digest !== op0.approvalDigest) throw new FundingOpError('DIGEST_MISMATCH', 'the approval does not match this quote');
  if (Date.parse(op0.quoteExpiresAt) <= now()) {
    setState(db, op0.id, 'EXPIRED', 'the quote expired before approval; nothing was converted', now());
    throw new FundingOpError('QUOTE_EXPIRED', 'the quote expired; request a new one');
  }
  // compare-and-set so two concurrent approvals cannot both execute
  const claimed = db.prepare("UPDATE funding_ops SET state = 'CONVERTING', approved_at = ?, updated_at = ? WHERE id = ? AND state = 'QUOTED'").run(iso(now()), iso(now()), op0.id);
  if (Number(claimed.changes) !== 1) return getFundingOp(db, op0.id)!;
  event(db, op0.id, 'CONVERTING', 'buyer approved the exact quote; conversion started', { digest: a.digest }, now());
  audit(db, a.buyerId, 'funding.approved', op0.id, { sell: op0.sellAtomic.toString() }, new Date(now()));

  if (cfg.converter.clientSigned) {
    setState(db, op0.id, 'CONVERTING', 'waiting for YOUR wallet to sign and send the conversion; nothing has been sent by Payrail', now(), { stage: 'client' });
    return getFundingOp(db, op0.id)!;
  }
  let r: ExecuteResult;
  try {
    r = await cfg.converter.execute({ opId: op0.id, quoteId: op0.quoteId, sellAtomic: op0.sellAtomic, minBuyAtomic: op0.minAtomic, digest: op0.approvalDigest, scenario: op0.scenario });
  } catch (e) {
    const msg = e instanceof FundingOpError ? e.message : (e as Error).message.slice(0, 200);
    if (e instanceof FundingOpError && e.code === 'SIGNING_UNAVAILABLE') {
      setState(db, op0.id, 'FAILED', 'signing is unavailable; nothing was converted', now(), { failure_code: 'SIGNING_UNAVAILABLE', failure_message: msg });
      throw e;
    }
    // the converter threw after we said "go": it may or may not have sent anything
    setState(db, op0.id, 'UNRESOLVED', 'the conversion call failed unexpectedly; the outcome is unknown', now(), { failure_code: 'CONVERTER_ERROR', failure_message: msg });
    return getFundingOp(db, op0.id)!;
  }
  if (r.kind === 'failed') {
    setState(db, op0.id, 'FAILED', `the conversion did not happen: ${r.message}`, now(), { failure_code: r.code, failure_message: r.message.slice(0, 300) });
    return getFundingOp(db, op0.id)!;
  }
  const patch: Record<string, string | null> = { approve_txs: JSON.stringify(r.approveTxs), swap_tx: r.swapTx ?? null };
  if (r.kind === 'submitted' && r.depositTx) patch.deposit_tx = r.depositTx;
  if (r.kind === 'uncertain') {
    setState(db, op0.id, 'UNRESOLVED', `outcome unknown: ${r.message}`, now(), { ...patch, failure_code: 'UNCERTAIN', failure_message: r.message.slice(0, 300) });
    return getFundingOp(db, op0.id)!;
  }
  setState(db, op0.id, 'VERIFYING', 'transaction submitted; verifying on-chain before crediting', now(), { ...patch, stage: cfg.converter.passthrough ? 'deposit' : 'swap' }, { swapTx: r.swapTx, depositTx: r.depositTx ?? null });
  return verifyAndCredit(db, cfg, op0.id, now);
}

/**
 * The buyer's wallet reports a transaction it sent. The hash is only a CLAIM: it is recorded once, may not be used by any
 * other operation, and is then verified from the chain by the same code as every other conversion.
 */
export async function recordClientTx(
  db: Db,
  cfg: FundingConfig,
  a: { opId: string; buyerId: string; kind: 'approve' | 'swap' | 'deposit'; txHash: string },
  now: () => number = Date.now,
): Promise<FundingOp> {
  const op = getFundingOp(db, a.opId);
  if (!op) throw new FundingOpError('NOT_FOUND', 'no such funding operation');
  if (op.buyerId !== a.buyerId) throw new FundingOpError('NOT_OWNER', 'not your funding operation');
  if (!cfg.converter.clientSigned) throw new FundingOpError('WRONG_STATE', 'this conversion is not signed by the buyer');
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.txHash)) throw new FundingOpError('BAD_INPUT', 'a transaction hash (0x + 64 hex characters) is required');
  // idempotent: re-reporting a transaction that is already settled changes nothing
  if (op.state === 'CREDITED' && [op.swapTx, op.depositTx, ...op.approveTxs].some((t) => t && lower(t) === a.txHash.toLowerCase())) return op;
  if (!['CONVERTING', 'VERIFYING'].includes(op.state) || (op.state === 'CONVERTING' && op.stage !== 'client' && !op.swapTx)) {
    throw new FundingOpError('WRONG_STATE', `a ${op.state} operation cannot take a transaction`);
  }
  const tx = a.txHash.toLowerCase();
  const used = db.prepare(
    "SELECT id FROM funding_ops WHERE id <> ? AND (lower(swap_tx) = ? OR lower(deposit_tx) = ? OR lower(approve_txs) LIKE ?) LIMIT 1",
  ).get(op.id, tx, tx, `%${tx}%`) ?? db.prepare('SELECT op_id AS id FROM funding_tx_claims WHERE lower(tx_hash) = ? AND op_id <> ?').get(tx, op.id);
  if (used) throw new FundingOpError('TX_ALREADY_USED', 'that transaction is already attached to another operation');
  if (a.kind === 'approve') {
    if (op.approveTxs.map(lower).includes(tx)) return op;
    db.prepare('UPDATE funding_ops SET approve_txs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...op.approveTxs, tx]), iso(now()), op.id);
    event(db, op.id, op.state, 'your wallet reported an approval transaction (informational; it is not what gets credited)', { tx }, now());
    return getFundingOp(db, op.id)!;
  }
  if (a.kind === 'swap') {
    if (op.swapTx) {
      if (lower(op.swapTx) === tx) return verifyAndCredit(db, cfg, op.id, now);
      throw new FundingOpError('ALREADY_RECORDED', 'a different swap transaction is already recorded for this operation');
    }
    setState(db, op.id, 'VERIFYING', 'your wallet reported the conversion transaction; verifying on-chain before anything is credited', now(), { swap_tx: tx, stage: 'swap' }, { tx });
  } else {
    if (!op.swapTx && !cfg.converter.passthrough) throw new FundingOpError('WRONG_STATE', 'the conversion transaction must be reported first');
    if (op.depositTx) {
      if (lower(op.depositTx) === tx) return verifyAndCredit(db, cfg, op.id, now);
      throw new FundingOpError('ALREADY_RECORDED', 'a different deposit transaction is already recorded for this operation');
    }
    setState(db, op.id, 'VERIFYING', 'your wallet reported the deposit transaction; verifying on-chain before crediting', now(), { deposit_tx: tx, stage: 'deposit' }, { tx });
  }
  audit(db, a.buyerId, 'funding.client_tx', op.id, { kind: a.kind, tx }, new Date(now()));
  return verifyAndCredit(db, cfg, op.id, now);
}

/** Read the chain for an operation that has a swap transaction and settle it. Safe to call repeatedly. */
export async function verifyAndCredit(db: Db, cfg: FundingConfig, opId: string, now: () => number = Date.now): Promise<FundingOp> {
  const op = getFundingOp(db, opId);
  if (!op) throw new FundingOpError('NOT_FOUND', 'no such funding operation');
  if (!['VERIFYING', 'CONVERTING', 'UNRESOLVED'].includes(op.state)) return op;
  const pass = cfg.converter.passthrough === true;
  // waiting for the buyer's own wallet: nothing exists to verify yet, and that is not a failure
  if (cfg.converter.clientSigned && !op.swapTx && !op.depositTx && op.state === 'CONVERTING' && op.stage === 'client') return op;
  if (!op.swapTx && !(pass && op.depositTx)) {
    if (op.state === 'CONVERTING') setState(db, op.id, 'UNRESOLVED', 'interrupted before a transaction was recorded; check the wallet before retrying', now(), { failure_code: 'NO_TX_RECORDED' });
    else if (pass && op.state === 'VERIFYING') setState(db, op.id, 'REVIEW', 'no deposit transaction was recorded; nothing was credited', now(), { failure_code: 'DEPOSIT_NOT_RECORDED', stage: 'deposit' });
    return getFundingOp(db, opId)!;
  }
  const hop = op.depositAddress !== null || cfg.converter.depositAddress !== undefined;
  const depositTo = op.depositAddress ?? cfg.converter.depositAddress ?? null;
  const read = async (hash: string): Promise<{ receipt: ChainReceipt | null; head: bigint } | { error: string }> => {
    try {
      const [receipt, head] = await Promise.all([cfg.reader.receipt(hash), cfg.reader.blockNumber()]);
      return { receipt, head };
    } catch (e) {
      return { error: (e as Error).message.slice(0, 120) };
    }
  };
  const unreadable = (msg: string) => {
    if (op.state !== 'UNRESOLVED') setState(db, op.id, 'UNRESOLVED', `could not read the chain: ${msg}; will re-check`, now(), { failure_code: 'READ_FAILED' });
    return getFundingOp(db, opId)!;
  };

  // ---- 1. the conversion (skipped when the buyer already holds USDT)
  let swapReceived: bigint | null = null;
  if (!pass) {
    const r = await read(op.swapTx!);
    if ('error' in r) return unreadable(r.error);
    if (!r.receipt) {
      // not found is NOT failure: the transaction may still land. It stays pending and unspendable.
      if (op.state === 'CONVERTING') setState(db, op.id, 'VERIFYING', 'transaction not found yet; waiting', now());
      return getFundingOp(db, opId)!;
    }
    const v = verifyConversion(r.receipt, r.head, { usdt: cfg.usdt, reactor: cfg.reactor, recipient: cfg.converter.recipient, minBuyAtomic: op.minAtomic, minConfirmations: cfg.minConfirmations });
    switch (v.kind) {
      case 'pending': {
        const note = `waiting for confirmations (${v.confirmations}/${cfg.minConfirmations})`;
        const last = fundingEvents(db, op.id).at(-1);
        if (op.state !== 'VERIFYING') setState(db, op.id, 'VERIFYING', note, now());
        else if (last?.note !== note) event(db, op.id, 'VERIFYING', note, undefined, now());
        return getFundingOp(db, opId)!;
      }
      case 'reverted':
        setState(db, op.id, 'FAILED', 'the conversion transaction reverted on-chain; nothing was converted or credited', now(), { failure_code: 'REVERTED' });
        return getFundingOp(db, opId)!;
      case 'mismatch':
        setState(db, op.id, 'REVIEW', `verification failed: ${v.reason}. Nothing was credited; an operator must review.`, now(), { failure_code: 'VERIFICATION_MISMATCH', failure_message: v.reason });
        return getFundingOp(db, opId)!;
      case 'below_minimum':
        setState(db, op.id, 'REVIEW', `received ${fmt(v.receivedAtomic)} ${op.buySymbol}, below the agreed minimum ${fmt(op.minAtomic)}. Nothing was credited; an operator must review.`, now(), { received_atomic: v.receivedAtomic, failure_code: 'BELOW_MINIMUM' });
        return getFundingOp(db, opId)!;
      case 'confirmed':
        swapReceived = v.receivedAtomic;
        break;
    }
  }

  // ---- 2. the deposit hop: only USDT that actually reached custody from the buyer's own wallet is credited
  if (!hop || !depositTo) {
    return creditOnce(db, cfg, op, swapReceived!, now);
  }
  if (!op.depositTx && cfg.converter.clientSigned && op.state !== 'REVIEW') {
    // the buyer's wallet still has to send the USDT it received to the marketplace address
    if (op.stage !== 'deposit' || op.state !== 'VERIFYING') {
      setState(db, op.id, 'VERIFYING', `conversion verified: ${fmt(swapReceived ?? 0n)} ${op.buySymbol} is in your wallet. Send it to the marketplace address from the same wallet to credit it.`, now(), { received_atomic: swapReceived, stage: 'deposit' });
    }
    return getFundingOp(db, opId)!;
  }
  if (!op.depositTx) {
    setState(db, op.id, 'REVIEW', swapReceived !== null
      ? `the conversion is verified (${fmt(swapReceived)} ${op.buySymbol} is in your wallet) but no deposit transaction was recorded. Nothing was credited. Deposit that USDT to the marketplace address to credit it.`
      : 'no deposit transaction was recorded; nothing was credited', now(), { received_atomic: swapReceived, failure_code: 'DEPOSIT_NOT_RECORDED', stage: 'deposit' });
    return getFundingOp(db, opId)!;
  }
  const d = await read(op.depositTx);
  if ('error' in d) return unreadable(d.error);
  if (!d.receipt) {
    if (op.stage !== 'deposit') setState(db, op.id, 'VERIFYING', 'conversion verified; waiting for the deposit transaction', now(), { stage: 'deposit' });
    return getFundingOp(db, opId)!;
  }
  const dv = verifyDeposit(d.receipt, d.head, { usdt: cfg.usdt, from: cfg.converter.recipient, to: depositTo, minConfirmations: cfg.minConfirmations });
  switch (dv.kind) {
    case 'pending':
      if (op.stage !== 'deposit') setState(db, op.id, 'VERIFYING', `conversion verified; deposit has ${dv.confirmations}/${cfg.minConfirmations} confirmations`, now(), { stage: 'deposit' });
      return getFundingOp(db, opId)!;
    case 'reverted':
      setState(db, op.id, 'REVIEW', 'the deposit transaction reverted; nothing was credited. The USDT stays in your wallet.', now(), { received_atomic: swapReceived, failure_code: 'DEPOSIT_REVERTED', stage: 'deposit' });
      return getFundingOp(db, opId)!;
    case 'mismatch':
      setState(db, op.id, 'REVIEW', `deposit verification failed: ${dv.reason}. Nothing was credited; an operator must review.`, now(), { received_atomic: swapReceived, failure_code: 'DEPOSIT_MISMATCH', failure_message: dv.reason, stage: 'deposit' });
      return getFundingOp(db, opId)!;
    case 'confirmed':
      return creditOnce(db, cfg, op, dv.receivedAtomic, now, swapReceived ?? undefined);
  }
}

/**
 * SIMULATION ONLY. The simulated chain lives in memory, so after a restart an unfinished simulated operation can never be
 * confirmed. It is parked for review (never credited) so it does not block the buyer forever.
 */
export function parkSimulatedAfterRestart(db: Db, opId: string, now: () => number = Date.now): FundingOp {
  const op = getFundingOp(db, opId);
  if (!op) throw new FundingOpError('NOT_FOUND', 'no such funding operation');
  if (op.mode !== 'simulated' || !['CONVERTING', 'VERIFYING', 'UNRESOLVED'].includes(op.state)) return op;
  setState(db, op.id, 'REVIEW', 'the simulated chain was reset by a server restart, so this simulated operation can no longer be confirmed. Nothing was credited.', now(), { failure_code: 'SIMULATION_RESET' });
  return getFundingOp(db, op.id)!;
}

/** Judge the buyer's USDT transfer to custody from its receipt: exact token, from the buyer's wallet, to the custody address. */
export function verifyDeposit(
  receipt: ChainReceipt,
  head: bigint,
  e: { usdt: string; from: string; to: string; minConfirmations: number },
): { kind: 'pending'; confirmations: number } | { kind: 'reverted' } | { kind: 'mismatch'; reason: string } | { kind: 'confirmed'; receivedAtomic: bigint } {
  if (receipt.status !== 'success') return { kind: 'reverted' };
  const confirmations = Number(head - receipt.blockNumber) + 1;
  if (confirmations < e.minConfirmations) return { kind: 'pending', confirmations };
  let total = 0n;
  for (const l of receipt.logs) {
    if (lower(l.address) !== lower(e.usdt) || l.topics.length !== 3 || lower(l.topics[0]!) !== TRANSFER_TOPIC) continue;
    if (topicAddr(l.topics[1]!) !== lower(e.from) || topicAddr(l.topics[2]!) !== lower(e.to)) continue;
    if (/^0x[0-9a-fA-F]{64}$/.test(l.data)) total += BigInt(l.data);
  }
  if (total <= 0n) return { kind: 'mismatch', reason: 'no USDT transfer from your wallet to the marketplace address was found in that transaction' };
  return { kind: 'confirmed', receivedAtomic: total };
}

function creditOnce(db: Db, cfg: FundingConfig, op: FundingOp, received: bigint, now: () => number, swapReceived?: bigint): FundingOp {
  // the credited transaction (the deposit when there is a hop, else the swap) can fund one operation, for one buyer, ever
  const txs = [op.depositTx, op.swapTx].filter((x): x is string => Boolean(x)).map(lower);
  for (const tx of txs) {
    const claim = queryOne(db, 'SELECT op_id FROM funding_tx_claims WHERE tx_hash = ?', tx);
    if (claim && String(claim.op_id) !== op.id) {
      setState(db, op.id, 'REVIEW', 'this transaction was already used to fund a different operation; nothing was credited', now(), { failure_code: 'TX_ALREADY_CLAIMED' });
      return getFundingOp(db, op.id)!;
    }
  }
  for (const tx of txs) {
    if (!queryOne(db, 'SELECT 1 AS x FROM funding_tx_claims WHERE tx_hash = ?', tx)) {
      db.prepare('INSERT INTO funding_tx_claims (tx_hash, op_id, buyer_id, claimed_at) VALUES (?, ?, ?, ?)').run(tx, op.id, op.buyerId, iso(now()));
    }
  }
  void swapReceived;
  const ref = `fund:${op.id}`;
  try {
    // ledger deposit is idempotent per ref; a second call returns created:false and credits nothing
    deposit(db, { buyerId: op.buyerId, asset: cfg.creditAsset, amountAtomic: received, ref, memo: `marketplace funding ${op.mode === 'simulated' ? '(SIMULATED conversion) ' : ''}${op.id}` }, now);
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'DEPOSIT_CONFLICT') {
      setState(db, op.id, 'REVIEW', 'the ledger already holds a different amount for this funding reference; nothing more was credited', now(), { failure_code: 'DEPOSIT_CONFLICT' });
      return getFundingOp(db, op.id)!;
    }
    throw e;
  }
  setState(db, op.id, 'CREDITED', `verified ${fmt(received)} ${op.buySymbol} received; credited to the marketplace balance`, now(), { received_atomic: received, credited_atomic: received, credit_ref: ref });
  audit(db, op.buyerId, 'funding.credited', op.id, { asset: cfg.creditAsset, amount: received.toString(), mode: op.mode }, new Date(now()));
  return getFundingOp(db, op.id)!;
}

/**
 * Re-examine every operation that is not final. Run at start-up and on demand. Never fails an operation merely because a
 * transaction is not visible yet, and never credits twice.
 */
export async function recoverFunding(db: Db, cfg: FundingConfig, now: () => number = Date.now): Promise<Array<{ id: string; from: string; to: string }>> {
  const out: Array<{ id: string; from: string; to: string }> = [];
  // quotes that were never approved just expire
  for (const r of query(db, "SELECT id, quote_expires_at FROM funding_ops WHERE state = 'QUOTED'")) {
    if (Date.parse(String(r.quote_expires_at)) <= now()) {
      setState(db, String(r.id), 'EXPIRED', 'the quote expired; nothing was converted', now());
      out.push({ id: String(r.id), from: 'QUOTED', to: 'EXPIRED' });
    }
  }
  for (const r of query(db, "SELECT id, state FROM funding_ops WHERE state IN ('CONVERTING','VERIFYING','UNRESOLVED')")) {
    const after = await verifyAndCredit(db, cfg, String(r.id), now);
    if (after.state !== r.state) out.push({ id: after.id, from: String(r.state), to: after.state });
  }
  return out;
}

// ------------------------------------------------------------------ views

const fmt = (v: bigint, decimals = 6) => {
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, '0');
  const f = s.slice(-decimals).replace(/0+$/, '');
  return `${s.slice(0, -decimals)}${f ? `.${f}` : ''}`;
};
const STATE_TEXT: Record<FundingState, string> = {
  QUOTED: 'Quote ready: nothing has been converted',
  EXPIRED: 'Quote expired: nothing was converted',
  CONVERTING: 'Converting',
  VERIFYING: 'Verifying on-chain: not spendable yet',
  CREDITED: 'Credited to your balance',
  FAILED: 'Failed: nothing was credited',
  UNRESOLVED: 'Outcome unknown: not spendable, being re-checked',
  REVIEW: 'Needs review: nothing was credited',
  CANCELLED: 'Cancelled',
};
export function fundingView(op: FundingOp, now: number = Date.now()) {
  return {
    id: op.id,
    mode: op.mode,
    simulated: op.mode === 'simulated',
    state: op.state,
    statusText: STATE_TEXT[op.state],
    spendable: op.state === 'CREDITED',
    asset: { symbol: op.sellSymbol, chainId: op.sellChainId, address: op.sellAddress, decimals: op.sellDecimals },
    stage: op.stage,
    sell: { symbol: op.sellSymbol, atomic: op.sellAtomic.toString(), display: fmt(op.sellAtomic, op.sellDecimals) },
    estimatedReceive: { symbol: op.buySymbol, atomic: op.expectedAtomic.toString(), display: fmt(op.expectedAtomic) },
    minimumReceive: { atomic: op.minAtomic.toString(), display: fmt(op.minAtomic) },
    fee: { symbol: op.sellSymbol, atomic: op.feeAtomic.toString(), display: fmt(op.feeAtomic, op.sellDecimals) },
    rate: op.rate,
    provider: op.provider,
    creditAsset: op.creditAsset,
    willBeCredited: { asset: op.creditAsset, display: op.creditedAtomic !== null ? fmt(op.creditedAtomic) : `${fmt(op.minAtomic)} to ${fmt(op.expectedAtomic)} (the verified amount received)` },
    received: op.receivedAtomic === null ? null : fmt(op.receivedAtomic),
    receivedAtomic: op.receivedAtomic === null ? null : op.receivedAtomic.toString(),
    credited: op.creditedAtomic === null ? null : fmt(op.creditedAtomic),
    quoteExpiresAt: op.quoteExpiresAt,
    expiresInSeconds: op.state === 'QUOTED' ? Math.max(0, Math.round((Date.parse(op.quoteExpiresAt) - now) / 1000)) : null,
    approvalDigest: op.state === 'QUOTED' ? op.approvalDigest : null,
    txs: { approve: op.approveTxs, swap: op.swapTx, deposit: op.depositTx },
    depositAddress: op.depositAddress,
    taker: op.taker,
    creditRef: op.creditRef,
    failure: op.failureCode ? { code: op.failureCode, message: op.failureMessage } : null,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

