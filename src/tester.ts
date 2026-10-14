// Seller API tester: calls the seller's own verified endpoint through the gateway, reports what happened (never
// credentials or request headers), and can suggest a contract from what it observed. Runs spend no buyer credits.
import { randomUUID } from 'node:crypto';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { evaluate, inferContract, getContract } from './contracts.ts';
import type { Check, ContractBody } from './contracts.ts';
import { GatewayError, callUpstream } from './gateway.ts';
import type { CallOptions } from './gateway.ts';
import type { MasterKey } from './vault.ts';

export class TesterError extends Error {
  code: 'NOT_FOUND' | 'NOT_OWNER';
  constructor(code: TesterError['code'], message: string) {
    super(message);
    this.name = 'TesterError';
    this.code = code;
  }
}

export interface TestReport {
  id: string;
  listingId: string;
  at: string;
  outcome: 'RESPONDED' | 'FAILED';
  failure?: { code: string; message: string };
  httpStatus?: number;
  contentType?: string;
  elapsedMs?: number;
  /** first 2 KB of the (redacted) body */
  bodyPreview?: string;
  /** field paths and JSON types seen in the response, no values */
  shape?: Record<string, string>;
  contract?: { contractId: string; version: number; qualified: boolean; checks: Check[] };
}

function shapeOf(v: unknown, prefix = '', depth = 0, out: Record<string, string> = {}): Record<string, string> {
  if (depth > 3 || Object.keys(out).length > 80) return out;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (x && typeof x === 'object' && !Array.isArray(x)) shapeOf(x, p, depth + 1, out);
      else out[p] = Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x;
    }
  }
  return out;
}

export async function runTest(
  db: Db,
  keys: readonly MasterKey[],
  sellerId: string,
  listingId: string,
  input: unknown,
  opts: { contractId?: string; call?: Omit<CallOptions, 'purpose'> } = {},
): Promise<TestReport> {
  const l = queryOne(db, 'SELECT seller_id FROM listings WHERE id = ?', listingId);
  if (!l) throw new TesterError('NOT_FOUND', `no listing ${listingId}`);
  if (String(l.seller_id) !== sellerId) throw new TesterError('NOT_OWNER', 'this listing belongs to another seller');
  const now = opts.call?.now ?? Date.now;
  const report: TestReport = { id: `test_${randomUUID()}`, listingId, at: new Date(now()).toISOString(), outcome: 'FAILED' };
  try {
    const r = await callUpstream(db, keys, listingId, input, { ...(opts.call ?? {}), purpose: 'seller-test' });
    report.outcome = 'RESPONDED';
    report.httpStatus = r.status;
    if (r.contentType) report.contentType = r.contentType;
    report.elapsedMs = r.elapsedMs;
    report.bodyPreview = r.bodyText.slice(0, 2048);
    if (r.json !== undefined) report.shape = shapeOf(r.json);
    if (opts.contractId) {
      const c = getContract(db, opts.contractId);
      if (c && c.listingId === listingId) {
        const ev = evaluate(c.body, r, now());
        report.contract = { contractId: c.id, version: c.version, qualified: ev.qualified, checks: ev.checks };
      }
    }
  } catch (e) {
    if (e instanceof GatewayError) report.failure = { code: e.code, message: e.message };
    else report.failure = { code: 'ERROR', message: (e as Error).message };
  }
  db.prepare('INSERT INTO test_runs (id, listing_id, created_at, input_json, outcome, http_status, elapsed_ms, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    report.id, listingId, report.at, JSON.stringify(input ?? {}), report.outcome, report.httpStatus ?? null, report.elapsedMs ?? null, JSON.stringify(report),
  );
  audit(db, sellerId, 'listing.tested', listingId, { testId: report.id, outcome: report.outcome, status: report.httpStatus ?? null }, new Date(now()));
  return report;
}

/** Suggest a contract from stored successful test runs that returned a 2xx JSON body. Needs the original shape, so re-runs are by sample. */
export function suggestContract(samples: Array<{ json: unknown; elapsedMs: number }>): ContractBody {
  return inferContract(samples);
}

export function recentTests(db: Db, listingId: string, limit = 20): TestReport[] {
  return query(db, 'SELECT report_json FROM test_runs WHERE listing_id = ? ORDER BY created_at DESC LIMIT ?', listingId, limit).map((r) => JSON.parse(String(r.report_json)) as TestReport);
}
