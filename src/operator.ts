// Operator review, recovery and reconciliation.
//
// What an operator can do here is deliberately small:
//   - LIST and INSPECT everything that needs attention (funding operations and payouts), with the reason.
//   - RE-CHECK: re-run the SAME independent chain verification the engines use. Nothing is "marked paid".
//   - ATTACH EVIDENCE: supply a transaction hash; it is then verified from the chain like any other. If verification
//     does not succeed the item stays unresolved/review-required.
//   - CLOSE a funding operation WITHOUT crediting, with a written reason and a transaction/reference as evidence.
// There is no function that credits a buyer or completes a payout because an operator said so.
// Every action writes the audit log and the item's own append-only event history.
import type { Db } from './db.ts';
import { audit, query, queryOne } from './db.ts';
import { balance, verifyLedger } from './ledger.ts';
import { getFundingOp, fundingEvents, verifyAndCredit } from './marketfunding.ts';
import type { FundingConfig, FundingOp } from './marketfunding.ts';
import { getPayout, pendingPayouts } from './payouts.ts';
import type { Payout } from './payouts.ts';
import { payoutEvents, recheckConversionPayout, retryConversionDelivery } from './payoutconv.ts';
import type { PayoutConversionConfig } from './payoutconv.ts';

export class OperatorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TX = /^0x[0-9a-fA-F]{64}$/;
const iso = (ms: number) => new Date(ms).toISOString();

/** how the item should be read: nothing is called "failed" unless money provably did not move */
export type Category = 'review-required' | 'unresolved' | 'pending' | 'failed';

export interface ReviewItem {
  kind: 'funding' | 'payout';
  id: string;
  category: Category;
  who: { buyerId?: string; sellerId?: string };
  simulated: boolean;
  state: string;
  stage: string | null;
  asset: string;
  expectedAtomic: string;
  receivedAtomic: string | null;
  txs: Array<{ label: string; hash: string }>;
  reason: string;
  /** the only things an operator may do with this item right now */
  safeActions: string[];
  updatedAt: string;
}

function fundingItem(op: FundingOp): ReviewItem | null {
  let category: Category;
  const actions: string[] = [];
  switch (op.state) {
    case 'REVIEW': category = 'review-required'; break;
    case 'UNRESOLVED': category = 'unresolved'; break;
    case 'FAILED': category = 'failed'; break;
    case 'CONVERTING': case 'VERIFYING': category = 'pending'; break;
    default: return null;
  }
  if (op.swapTx || op.depositTx) actions.push('recheck');
  if (category !== 'failed' && !op.depositTx) actions.push('attach-deposit-evidence');
  if (category === 'review-required' || category === 'unresolved') actions.push('close-without-credit');
  const txs: ReviewItem['txs'] = [];
  if (op.swapTx) txs.push({ label: 'swap', hash: op.swapTx });
  if (op.depositTx) txs.push({ label: 'deposit', hash: op.depositTx });
  for (const t of op.approveTxs) txs.push({ label: 'approve', hash: t });
  return {
    kind: 'funding', id: op.id, category, who: { buyerId: op.buyerId }, simulated: op.mode === 'simulated', state: op.state, stage: op.stage,
    asset: `${op.sellSymbol} -> ${op.buySymbol}`, expectedAtomic: op.expectedAtomic.toString(), receivedAtomic: op.receivedAtomic?.toString() ?? null,
    txs, reason: op.failureMessage ?? op.failureCode ?? `${op.state} (${op.stage ?? 'no stage'})`, safeActions: actions, updatedAt: op.updatedAt,
  };
}

function payoutItem(p: Payout): ReviewItem | null {
  const isConv = p.mode !== 'usdt';
  let category: Category;
  const actions: string[] = [];
  if (p.state === 'failed') category = 'failed';
  else if (p.stage === 'review') category = 'review-required';
  else if (p.stage === 'converted_undelivered') category = 'unresolved';
  else if (p.state === 'sent' || ['converting', 'converted', 'delivering'].includes(p.stage ?? '')) category = 'pending';
  else return null;
  if (isConv && (p.conversionTx || p.deliveryTx)) actions.push('recheck');
  if (isConv && p.stage === 'converted_undelivered') actions.push('retry-delivery');
  if (isConv && (p.stage === 'review' || p.stage === 'converted_undelivered')) actions.push('attach-delivery-evidence');
  const txs: ReviewItem['txs'] = [];
  if (p.conversionTx) txs.push({ label: 'conversion', hash: p.conversionTx });
  if (p.deliveryTx) txs.push({ label: 'delivery', hash: p.deliveryTx });
  if (p.txHash && p.txHash !== p.deliveryTx) txs.push({ label: 'payout', hash: p.txHash });
  return {
    kind: 'payout', id: p.id, category, who: { sellerId: p.sellerId }, simulated: p.mode.includes('simulated'), state: p.state, stage: p.stage,
    asset: p.target ? `${p.asset} -> ${p.target.symbol}` : p.asset, expectedAtomic: (p.expectedTarget ?? p.amountAtomic).toString(),
    receivedAtomic: p.receivedTarget?.toString() ?? null, txs, reason: p.failure ?? p.note ?? `${p.state}/${p.stage ?? '-'}`,
    safeActions: actions, updatedAt: p.settledAt ?? p.sentAt ?? p.approvedAt ?? p.requestedAt,
  };
}

/** Everything that is not simply finished. Failed items are included so the operator can see what did not happen. */
export function reviewQueue(db: Db, o: { includeFailed?: boolean } = {}): ReviewItem[] {
  const out: ReviewItem[] = [];
  const ops = query<{ id: string }>(db, "SELECT id FROM funding_ops WHERE state IN ('REVIEW','UNRESOLVED','CONVERTING','VERIFYING'" + (o.includeFailed ? ",'FAILED'" : '') + ') ORDER BY updated_at');
  for (const r of ops) {
    const op = getFundingOp(db, String(r.id));
    const it = op ? fundingItem(op) : null;
    if (it) out.push(it);
  }
  const ids = new Set<string>();
  for (const p of pendingPayouts(db, ['requested', 'approved', 'sent'])) {
    ids.add(p.id);
    const it = payoutItem(p);
    if (it) out.push(it);
  }
  if (o.includeFailed) {
    for (const r of query<{ id: string }>(db, "SELECT id FROM payouts WHERE state = 'failed' AND mode <> 'usdt'")) {
      const p = getPayout(db, r.id);
      const it = p && !ids.has(p.id) ? payoutItem(p) : null;
      if (it) out.push(it);
    }
  }
  const rank: Record<Category, number> = { 'review-required': 0, unresolved: 1, pending: 2, failed: 3 };
  return out.sort((a, b) => rank[a.category] - rank[b.category]);
}

export function inspectItem(db: Db, kind: 'funding' | 'payout', id: string) {
  if (kind === 'funding') {
    const op = getFundingOp(db, id);
    if (!op) throw new OperatorError('NOT_FOUND', 'no such funding operation');
    const claims = query<{ tx_hash: string; claimed_at: string }>(db, 'SELECT tx_hash, claimed_at FROM funding_tx_claims WHERE op_id = ?', id);
    return {
      item: fundingItem(op), quote: { rate: op.rate, provider: op.provider, expectedAtomic: op.expectedAtomic.toString(), minAtomic: op.minAtomic.toString(), feeAtomic: op.feeAtomic.toString(), expiresAt: op.quoteExpiresAt },
      taker: op.taker, depositAddress: op.depositAddress, creditRef: op.creditRef, failureCode: op.failureCode, claims, history: fundingEvents(db, id),
      operatorActions: query(db, "SELECT at, actor, action, details_json FROM audit_log WHERE subject = ? ORDER BY id", id),
    };
  }
  const p = getPayout(db, id);
  if (!p) throw new OperatorError('NOT_FOUND', 'no such payout');
  return {
    item: payoutItem(p), quote: { rate: p.rate, expectedTarget: p.expectedTarget?.toString() ?? null, minTarget: p.minTarget?.toString() ?? null, feeTarget: p.feeTarget?.toString() ?? null, expiresAt: p.quoteExpiresAt },
    destination: p.target?.deliveryAddress ?? p.destination, failure: p.failure, history: payoutEvents(db, id),
    operatorActions: query(db, "SELECT at, actor, action, details_json FROM audit_log WHERE subject = ? ORDER BY id", id),
  };
}

function need(operator: string, reason: string, min = 10) {
  if (!operator.trim()) throw new OperatorError('OPERATOR_REQUIRED', 'an operator name is required');
  if (reason.trim().length < min) throw new OperatorError('REASON_REQUIRED', `write a reason (at least ${min} characters)`);
}

/** Re-run independent verification. Safe to repeat: crediting and payout completion are once-only in their engines. */
export async function recheckItem(db: Db, deps: { funding: (op: FundingOp) => FundingConfig; payouts: PayoutConversionConfig; now?: () => number }, a: { kind: 'funding' | 'payout'; id: string; operator: string }) {
  const now = deps.now ?? Date.now;
  need(a.operator, 'recheck request');
  audit(db, a.operator, 'operator.recheck', a.id, { kind: a.kind }, new Date(now()));
  if (a.kind === 'funding') {
    const op = getFundingOp(db, a.id);
    if (!op) throw new OperatorError('NOT_FOUND', 'no such funding operation');
    const after = await verifyAndCredit(db, deps.funding(op), a.id, now);
    return { state: after.state, stage: after.stage, credited: after.creditedAtomic?.toString() ?? null, failure: after.failureCode };
  }
  const s = await recheckConversionPayout(db, deps.payouts, a.id, now);
  return { outcome: s.outcome, state: s.payout.state, stage: s.payout.stage, detail: s.detail };
}

/** Re-attempt ONLY the delivery leg of a payout whose swap was verified. Never swaps again. */
export async function retryPayoutDelivery(db: Db, deps: { payouts: PayoutConversionConfig; now?: () => number }, a: { id: string; operator: string }) {
  const now = deps.now ?? Date.now;
  need(a.operator, 'retry delivery');
  const p = getPayout(db, a.id);
  if (!p) throw new OperatorError('NOT_FOUND', 'no such payout');
  if (p.stage !== 'converted_undelivered') throw new OperatorError('WRONG_STATE', 'only a verified swap that was not delivered can be retried');
  audit(db, a.operator, 'operator.retry_delivery', a.id, undefined, new Date(now()));
  const s = await retryConversionDelivery(db, deps.payouts, a.id, now);
  return { outcome: s.outcome, state: s.payout.state, stage: s.payout.stage, detail: s.detail };
}

/** a transaction hash may back exactly one funding operation or payout */
function txUsedElsewhere(db: Db, tx: string, exceptKind: 'funding' | 'payout', exceptId: string): string | null {
  const t = tx.toLowerCase();
  const f = queryOne<{ id: string }>(db, 'SELECT op_id AS id FROM funding_tx_claims WHERE lower(tx_hash) = ?', t);
  if (f && !(exceptKind === 'funding' && f.id === exceptId)) return `funding ${f.id}`;
  const f2 = queryOne<{ id: string }>(db, 'SELECT id FROM funding_ops WHERE (lower(swap_tx) = ? OR lower(deposit_tx) = ?) AND NOT (? = ? AND id = ?)', t, t, exceptKind, 'funding', exceptId);
  if (f2) return `funding ${f2.id}`;
  const p = queryOne<{ id: string }>(db, 'SELECT id FROM payouts WHERE (lower(conversion_tx) = ? OR lower(delivery_tx) = ? OR lower(tx_hash) = ?) AND NOT (? = ? AND id = ?)', t, t, t, exceptKind, 'payout', exceptId);
  if (p) return `payout ${p.id}`;
  return null;
}

/**
 * Operator supplies the deposit transaction a buyer says they made. It is recorded as a CLAIM and then verified from the
 * chain with the engine's own rules (token, sender = the buyer's proven wallet, recipient = custody, amount, confirmations).
 * If it does not verify, nothing is credited and the item stays where it was.
 */
export async function attachFundingDepositEvidence(db: Db, deps: { funding: (op: FundingOp) => FundingConfig; now?: () => number }, a: { opId: string; txHash: string; operator: string; reason: string }) {
  const now = deps.now ?? Date.now;
  need(a.operator, a.reason);
  if (!TX.test(a.txHash)) throw new OperatorError('BAD_TX', 'a transaction hash (0x + 64 hex characters) is required');
  const op = getFundingOp(db, a.opId);
  if (!op) throw new OperatorError('NOT_FOUND', 'no such funding operation');
  if (!['REVIEW', 'UNRESOLVED'].includes(op.state)) throw new OperatorError('WRONG_STATE', `a ${op.state} operation cannot take new evidence`);
  if (op.depositTx) throw new OperatorError('ALREADY_RECORDED', 'a deposit transaction is already recorded; use recheck');
  const used = txUsedElsewhere(db, a.txHash, 'funding', op.id);
  if (used) throw new OperatorError('TX_ALREADY_USED', `that transaction is already attached to ${used}`);
  const tx = a.txHash.toLowerCase();
  db.prepare("UPDATE funding_ops SET deposit_tx = ?, state = 'VERIFYING', stage = 'deposit', updated_at = ? WHERE id = ?").run(tx, iso(now()), op.id);
  db.prepare('INSERT INTO funding_events (op_id, at, state, note, detail_json) VALUES (?, ?, ?, ?, ?)').run(
    op.id, iso(now()), 'VERIFYING', `operator ${a.operator} attached deposit transaction ${tx} as evidence; it is verified from the chain, not trusted`, JSON.stringify({ reason: a.reason }),
  );
  audit(db, a.operator, 'operator.attach_deposit_evidence', op.id, { tx, reason: a.reason }, new Date(now()));
  const after = await verifyAndCredit(db, deps.funding(getFundingOp(db, op.id)!), op.id, now);
  return { state: after.state, credited: after.creditedAtomic?.toString() ?? null, verified: after.state === 'CREDITED', failure: after.failureCode };
}

/** Same for a payout whose delivery could not be proven. Verified against the seller's verified address. */
export async function attachPayoutDeliveryEvidence(db: Db, deps: { payouts: PayoutConversionConfig; now?: () => number }, a: { payoutId: string; txHash: string; operator: string; reason: string }) {
  const now = deps.now ?? Date.now;
  need(a.operator, a.reason);
  if (!TX.test(a.txHash)) throw new OperatorError('BAD_TX', 'a transaction hash (0x + 64 hex characters) is required');
  const p = getPayout(db, a.payoutId);
  if (!p) throw new OperatorError('NOT_FOUND', 'no such payout');
  if (p.mode === 'usdt' || !['review', 'converted_undelivered'].includes(p.stage ?? '')) throw new OperatorError('WRONG_STATE', 'only a conversion payout in review or undelivered can take delivery evidence');
  const used = txUsedElsewhere(db, a.txHash, 'payout', p.id);
  if (used) throw new OperatorError('TX_ALREADY_USED', `that transaction is already attached to ${used}`);
  const tx = a.txHash.toLowerCase();
  db.prepare("UPDATE payouts SET delivery_tx = ?, stage = 'delivering' WHERE id = ?").run(tx, p.id);
  db.prepare('INSERT INTO payout_events (payout_id, at, stage, note) VALUES (?, ?, ?, ?)').run(
    p.id, iso(now()), 'delivering', `operator ${a.operator} attached delivery transaction ${tx} as evidence (${a.reason.slice(0, 120)}); it is verified from the chain`,
  );
  audit(db, a.operator, 'operator.attach_delivery_evidence', p.id, { tx, reason: a.reason }, new Date(now()));
  const s = await recheckConversionPayout(db, deps.payouts, p.id, now);
  return { outcome: s.outcome, state: s.payout.state, stage: s.payout.stage, detail: s.detail, verified: s.outcome === 'completed' };
}

/**
 * Give up on a funding operation WITHOUT crediting anything. Requires a reason and an evidence reference (a transaction
 * hash or a ticket id). History is preserved; the buyer's balance is untouched.
 */
export function closeFundingWithoutCredit(db: Db, a: { opId: string; operator: string; reason: string; evidence: string }, now: () => number = Date.now) {
  need(a.operator, a.reason);
  if (a.evidence.trim().length < 6) throw new OperatorError('EVIDENCE_REQUIRED', 'give the evidence reference (transaction hash or ticket)');
  const op = getFundingOp(db, a.opId);
  if (!op) throw new OperatorError('NOT_FOUND', 'no such funding operation');
  if (!['REVIEW', 'UNRESOLVED'].includes(op.state)) throw new OperatorError('WRONG_STATE', `a ${op.state} operation cannot be closed this way`);
  db.prepare("UPDATE funding_ops SET state = 'FAILED', failure_code = 'OPERATOR_CLOSED', failure_message = ?, updated_at = ? WHERE id = ?").run(`closed by ${a.operator}: ${a.reason.slice(0, 160)}`, iso(now()), op.id);
  db.prepare('INSERT INTO funding_events (op_id, at, state, note, detail_json) VALUES (?, ?, ?, ?, ?)').run(
    op.id, iso(now()), 'FAILED', `closed without credit by ${a.operator}`, JSON.stringify({ reason: a.reason, evidence: a.evidence, previousState: op.state }),
  );
  audit(db, a.operator, 'operator.close_without_credit', op.id, { reason: a.reason, evidence: a.evidence, previousState: op.state }, new Date(now()));
  return getFundingOp(db, op.id)!;
}

export interface Reconciliation {
  generatedAt: string;
  ledger: { ok: boolean; problems: string[] };
  funding: { credited: number; creditedWithoutLedgerDeposit: string[]; ledgerDepositsWithoutOp: string[]; byState: Record<string, number> };
  payouts: { byState: Record<string, number>; pendingReservedAtomic: string; ledgerPendingAtomic: string; mismatch: boolean };
  duplicateTxs: string[];
  /** repeats among simulated rows only (simulated hashes restart with the process); informational */
  simulatedDuplicateTxs: string[];
  openItems: { reviewRequired: number; unresolved: number; pending: number };
  ok: boolean;
}

/** A read-only cross-check of the three books: funding operations, payouts, and the ledger. */
export function reconcile(db: Db, now: () => number = Date.now, asset = 'TESTUSDT'): Reconciliation {
  const ledger = verifyLedger(db);
  const byState: Record<string, number> = {};
  for (const r of query<{ state: string; n: bigint }>(db, 'SELECT state, COUNT(*) AS n FROM funding_ops GROUP BY state')) byState[r.state] = Number(r.n);
  const credited = query<{ id: string; credit_ref: string | null }>(db, "SELECT id, credit_ref FROM funding_ops WHERE state = 'CREDITED'");
  const withoutDeposit: string[] = [];
  for (const c of credited) {
    const t = c.credit_ref ? queryOne(db, "SELECT 1 AS x FROM ledger_transactions WHERE kind = 'deposit' AND ref = ?", c.credit_ref) : null;
    if (!t) withoutDeposit.push(c.id);
  }
  const refs = new Set(credited.map((c) => c.credit_ref).filter((x): x is string => Boolean(x)));
  const orphan = query<{ ref: string }>(db, "SELECT ref FROM ledger_transactions WHERE kind = 'deposit' AND ref LIKE 'fund:%'").map((r) => r.ref).filter((r) => !refs.has(r));

  const pByState: Record<string, number> = {};
  for (const r of query<{ state: string; n: bigint }>(db, 'SELECT state, COUNT(*) AS n FROM payouts GROUP BY state')) pByState[r.state] = Number(r.n);
  let reserved = 0n;
  for (const p of pendingPayouts(db, ['requested', 'approved', 'sent'])) reserved += p.amountAtomic;
  const ledgerPending = query<{ s: bigint | null }>(db, "SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'payout_pending' AND a.asset = ?", asset)[0]?.s ?? 0n;
  void balance;

  // one tx, one purpose: no hash may appear in two places. Simulated hashes come from a counter that restarts with the
  // process, so repeats among SIMULATED rows are reported separately and do not fail the reconciliation.
  const seen = new Map<string, number>();
  const seenSim = new Map<string, number>();
  const bump = (m: Map<string, number>, h: string | null | undefined) => h && m.set(h.toLowerCase(), (m.get(h.toLowerCase()) ?? 0) + 1);
  for (const r of query<{ a: string | null; b: string | null; mode: string }>(db, 'SELECT swap_tx AS a, deposit_tx AS b, mode FROM funding_ops')) {
    const m = r.mode === 'simulated' ? seenSim : seen;
    bump(m, r.a); bump(m, r.b);
  }
  for (const r of query<{ a: string | null; b: string | null; mode: string }>(db, 'SELECT conversion_tx AS a, delivery_tx AS b, mode FROM payouts')) {
    const m = r.mode.includes('simulated') ? seenSim : seen;
    bump(m, r.a); bump(m, r.b);
  }
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
  const simulatedDuplicates = [...seenSim].filter(([, n]) => n > 1).map(([h]) => h);

  const q = reviewQueue(db);
  const open = {
    reviewRequired: q.filter((i) => i.category === 'review-required').length,
    unresolved: q.filter((i) => i.category === 'unresolved').length,
    pending: q.filter((i) => i.category === 'pending').length,
  };
  const mismatch = BigInt(ledgerPending) !== reserved;
  return {
    generatedAt: iso(now()), ledger,
    funding: { credited: credited.length, creditedWithoutLedgerDeposit: withoutDeposit, ledgerDepositsWithoutOp: orphan, byState },
    payouts: { byState: pByState, pendingReservedAtomic: reserved.toString(), ledgerPendingAtomic: BigInt(ledgerPending).toString(), mismatch },
    duplicateTxs: duplicates, simulatedDuplicateTxs: simulatedDuplicates, openItems: open,
    ok: ledger.ok && withoutDeposit.length === 0 && orphan.length === 0 && !mismatch && duplicates.length === 0,
  };
}
