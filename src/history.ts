// Payment history and the duplicate-payment guard.
//
// Two files protect against paying twice:
//   receipts/<id>.json            written AFTER a payment completes
//   receipts/pending/<id>.json    written BEFORE a payment is sent and removed only after the receipt
//                                 is safely on disk. If the process dies in between, the pending file
//                                 remains and blocks every further payment until a human resolves it.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class DuplicateGuardError extends Error {
  code: 'PENDING_PAYMENT' | 'PRIOR_RECEIPT';
  constructor(code: 'PENDING_PAYMENT' | 'PRIOR_RECEIPT', message: string) {
    super(message);
    this.name = 'DuplicateGuardError';
    this.code = code;
  }
}

export interface PendingEntry {
  id: string;
  createdAt: string;
  state: 'in_flight';
  planId: string;
  serviceId: string;
  url: string;
  payer: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  /** The order this payment belongs to, when it was made through the order flow. */
  orderId?: string;
  note: string;
}

function pendingDir(dir: string): string {
  return join(dir, 'pending');
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.json')) // not isFile(): OneDrive reparse points report as symlinks
    .map((e) => e.name);
}

export function listPending(dir: string): string[] {
  return jsonFiles(pendingDir(dir));
}

export function writePending(dir: string, entry: PendingEntry): void {
  mkdirSync(pendingDir(dir), { recursive: true });
  // 'wx': fail if it already exists, so two writers can never silently share one id.
  writeFileSync(join(pendingDir(dir), `${entry.id}.json`), JSON.stringify(entry, null, 2), { flag: 'wx' });
}

export function clearPending(dir: string, id: string): void {
  const f = join(pendingDir(dir), `${id}.json`);
  if (existsSync(f)) unlinkSync(f);
}

/**
 * Throws unless it is safe to start a new payment.
 *
 * A pending journal ALWAYS blocks (an unresolved payment may be in flight), whatever the other options say.
 *
 * Receipts: without `scope` any prior receipt blocks (the original, strict rehearsal behaviour). WITH a scope
 * only a receipt for the SAME plan or the SAME order blocks, so a legitimate new order is allowed while a
 * repeat of one already paid is refused. A REJECTED receipt (proven not settled) never blocks a deliberate
 * retry of its own order; UNCERTAIN and CONFIRMED always do.
 */
export function assertNoPriorPayment(
  dir: string,
  opts: { again: boolean; scope?: { planId?: string; orderId?: string } },
): void {
  const pending = listPending(dir);
  if (pending.length > 0) {
    throw new DuplicateGuardError(
      'PENDING_PAYMENT',
      `a payment may be in flight or unresolved (${pending[0]}). Inspect the wallet and chain, then delete ` +
        `receipts/pending/${pending[0]} yourself if it is resolved. --again does NOT override this.`,
    );
  }
  if (opts.scope !== undefined) {
    if (opts.again) return;
    const { planId, orderId } = opts.scope;
    for (const r of readHistory(dir).receipts) {
      if (r.status === 'REJECTED') continue;
      const samePlan = planId !== undefined && r.planId === planId;
      const sameOrder = orderId !== undefined && r.orderId === orderId;
      if (samePlan || sameOrder) {
        throw new DuplicateGuardError(
          'PRIOR_RECEIPT',
          `this ${sameOrder ? 'order' : 'plan'} was already paid (${r.file}, ${r.status ?? 'legacy receipt'}); a new order needs a new plan.`,
        );
      }
    }
    return;
  }
  const receipts = jsonFiles(dir);
  if (receipts.length > 0 && !opts.again) {
    throw new DuplicateGuardError(
      'PRIOR_RECEIPT',
      `a receipt already exists (${receipts[0]}). Pass --again only if you intend another payment.`,
    );
  }
}

export interface StoredReceipt {
  file: string;
  id: string;
  createdAt: string;
  /** undefined for legacy receipts written before schemaVersion existed. */
  schemaVersion: number | undefined;
  status: string | undefined;
  asset: string | undefined;
  amountAtomic: bigint | undefined;
  settled: boolean | undefined;
  planId: string | undefined;
  /** Set for payments made through the order flow (schema additive; absent on older receipts). */
  orderId: string | undefined;
  /** Outcome of a later chain re-verification (receipts/resolutions); the receipt itself is never edited. */
  resolution: 'SETTLED' | 'NOT_SETTLED' | undefined;
}

export interface HistoryRead {
  receipts: StoredReceipt[];
  invalid: Array<{ file: string; reason: string }>;
}

/** Reads every receipt, tolerating legacy files and reporting (not throwing on) malformed ones. */
export function readHistory(dir: string): HistoryRead {
  const out: HistoryRead = { receipts: [], invalid: [] };
  const resolutions = readResolutionFiles(dir);
  for (const file of jsonFiles(dir)) {
    try {
      const j: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (typeof j !== 'object' || j === null) throw new Error('not an object');
      const r = j as Record<string, unknown>;
      const payment = (r.payment ?? {}) as Record<string, unknown>;
      const outcome = (r.outcome ?? {}) as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.createdAt !== 'string') throw new Error('missing id/createdAt');
      const amount = payment.amountAtomic;
      out.receipts.push({
        file,
        id: r.id,
        createdAt: r.createdAt,
        schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : undefined,
        // A receipt later PROVEN not settled (a resolution record) is effectively REJECTED: nothing was charged.
        status: resolutions.get(r.id) === 'NOT_SETTLED' ? 'REJECTED' : typeof r.status === 'string' ? r.status : undefined,
        asset: typeof payment.asset === 'string' ? payment.asset : undefined,
        amountAtomic: typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : undefined,
        settled: typeof outcome.settled === 'boolean' ? outcome.settled : undefined,
        planId: typeof r.planId === 'string' ? r.planId : undefined,
        orderId: typeof r.orderId === 'string' ? r.orderId : undefined,
        resolution: resolutions.get(r.id),
      });
    } catch (e) {
      out.invalid.push({ file, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Total spent (atomic units of USD-stable 6-decimal assets) since `sinceMs`.
 * CONSERVATIVE: uncertain payments count as spent. Legacy receipts count when settled.
 */
export function spentSince(history: HistoryRead, sinceMs: number): bigint {
  let total = 0n;
  for (const r of history.receipts) {
    if (Date.parse(r.createdAt) < sinceMs) continue;
    if (r.amountAtomic === undefined) continue;
    const counts = r.status === undefined ? r.settled === true : r.status !== 'REJECTED';
    if (counts) total += r.amountAtomic;
  }
  return total;
}

// ------------------------------------------------------------------ payment resolutions

/**
 * receipts/resolutions/<receiptId>.json: written by paymentresolve.ts after an UNCERTAIN payment was
 * re-verified from the chain. Receipts are never edited; a resolution is a separate, additive record.
 * Unreadable files are ignored here (they can only make a payment LESS resolved, i.e. stay blocking).
 */
export function readResolutionFiles(dir: string): Map<string, 'SETTLED' | 'NOT_SETTLED'> {
  const out = new Map<string, 'SETTLED' | 'NOT_SETTLED'>();
  const d = join(dir, 'resolutions');
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    // !isDirectory(), not isFile(): OneDrive reparse points report as symlinks
    if (e.isDirectory() || !e.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(d, e.name), 'utf8')) as Record<string, unknown>;
      if (typeof j.receiptId === 'string' && (j.outcome === 'SETTLED' || j.outcome === 'NOT_SETTLED')) out.set(j.receiptId, j.outcome);
    } catch {
      /* ignore */
    }
  }
  return out;
}
