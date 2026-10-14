// Outcome-based execution: hold -> call the seller's API -> validate against the pinned contract -> capture or release.
// The buyer is charged ONLY for a response that satisfies the contract. If the outcome cannot be established
// (timeout, connection lost after sending) the hold stays UNRESOLVED and is never silently charged.
import { createHash } from 'node:crypto';
import { audit, query } from './db.ts';
import type { Db } from './db.ts';
import { currentContract, evaluate, getContract } from './contracts.ts';
import type { Check } from './contracts.ts';
import { GatewayError, callUpstream, cleanInput } from './gateway.ts';
import type { CallOptions } from './gateway.ts';
import { LedgerError, expireUnresolved, getExecution, settleExecution, startExecution } from './ledger.ts';
import type { Execution, ExecutionState } from './ledger.ts';
import { getListing } from './seller.ts';
import type { MasterKey } from './vault.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

export interface ExecutionResult {
  executionId: string;
  state: ExecutionState;
  /** true only when the buyer's credits were captured */
  charged: boolean;
  /** true when funds are still reserved while the outcome is unknown */
  held: boolean;
  priceAtomic: string;
  asset: string;
  feeAtomic: string | null;
  sellerAtomic: string | null;
  reason: string | null;
  replay: boolean;
  contractVersion: number;
  checks: Check[];
  upstream: { status: number; elapsedMs: number } | null;
  /** present ONLY for a qualifying response */
  body: unknown;
}

/** What the upstream call is allowed to use. Demo listings (and only they) may be served by an injected demo network. */
export interface ExecuteOptions {
  now?: () => number;
  call?: Omit<CallOptions, 'purpose'>;
  /** Used only when the listing is flagged demo. A normal listing can never reach it. */
  demoCall?: Omit<CallOptions, 'purpose'>;
}

interface Stored {
  checks: Check[];
  upstream: { status: number; elapsedMs: number } | null;
  bodyText?: string;
  bodySha256?: string;
  failure?: { code: string; message: string };
}

function view(db: Db, e: Execution, replay: boolean): ExecutionResult {
  const row = query(db, 'SELECT evidence_json FROM executions WHERE id = ?', e.id)[0];
  const ev: Stored | undefined = row && row.evidence_json ? (JSON.parse(String(row.evidence_json)) as Stored) : undefined;
  const cv = getContract(db, e.contractVersionId);
  let body: unknown;
  if (e.state === 'QUALIFIED' && ev?.bodyText !== undefined) {
    try {
      body = JSON.parse(ev.bodyText);
    } catch {
      body = undefined;
    }
  }
  return {
    executionId: e.id,
    state: e.state,
    charged: e.state === 'QUALIFIED',
    held: e.state === 'HELD' || e.state === 'UNRESOLVED',
    priceAtomic: e.priceAtomic.toString(),
    asset: e.asset,
    feeAtomic: e.feeAtomic === null ? null : e.feeAtomic.toString(),
    sellerAtomic: e.sellerAtomic === null ? null : e.sellerAtomic.toString(),
    reason: e.reason,
    replay,
    contractVersion: cv?.version ?? 0,
    checks: ev?.checks ?? [],
    upstream: ev?.upstream ?? null,
    body,
  };
}

/**
 * Run one paid request. `idempotencyKey` makes retries safe: repeating it returns the stored result and never calls
 * the seller or holds funds a second time.
 */
export async function executeRequest(
  db: Db,
  keys: readonly MasterKey[],
  a: { buyerId: string; listingId: string; idempotencyKey: string; input: unknown },
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const now = opts.now ?? Date.now;
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(a.idempotencyKey)) throw new LedgerError('NOT_FOUND', 'idempotencyKey must be 8-100 characters (letters, digits, _ . : -)');
  const listing = getListing(db, a.listingId);
  if (!listing) throw new LedgerError('NOT_FOUND', `no listing ${a.listingId}`);
  // refuse malformed input BEFORE anything is reserved
  const input = cleanInput(a.input);
  const contract = currentContract(db, a.listingId);
  if (!contract) throw new LedgerError('CONTRACT_NOT_APPROVED', 'this listing has no approved response contract');

  const { execution, replay } = startExecution(
    db,
    { buyerId: a.buyerId, listingId: a.listingId, contractVersionId: contract.id, idempotencyKey: a.idempotencyKey, requestHash: sha256(canonical({ l: a.listingId, i: input })) },
    now,
  );
  // a replay never re-calls the seller: it reports what is already known (HELD means "in progress or interrupted")
  if (replay) return view(db, getExecution(db, execution.id)!, true);

  const pinned = getContract(db, execution.contractVersionId)!;
  const callOpts = listing.demo ? (opts.demoCall ?? opts.call) : opts.call;
  let settled: Execution;
  try {
    const r = await callUpstream(db, keys, a.listingId, input, { ...(callOpts ?? {}), now, purpose: 'gateway-execution' });
    const ev = evaluate(pinned.body, r, now());
    const stored: Stored = { checks: ev.checks, upstream: { status: r.status, elapsedMs: r.elapsedMs }, bodySha256: sha256(r.bodyText) };
    if (ev.qualified) stored.bodyText = r.bodyText;
    settled = settleExecution(
      db,
      execution.id,
      ev.qualified ? 'QUALIFIED' : 'NOT_QUALIFIED',
      ev.qualified ? 'response satisfied the contract' : ev.reasons.join('; '),
      now,
      stored,
    );
  } catch (e) {
    if (!(e instanceof GatewayError)) {
      // our own fault after the hold: the outcome is unknown, so the hold must not be released as "not qualified" nor captured
      settled = settleExecution(db, execution.id, 'UNRESOLVED', 'internal error while calling the API', now, { checks: [], upstream: null, failure: { code: 'INTERNAL', message: 'internal error' } } satisfies Stored);
      return view(db, settled, false);
    }
    // the request provably never left Payrail -> nothing happened upstream -> release
    const neverSent = ['EGRESS_BLOCKED', 'RATE_LIMITED', 'BAD_INPUT', 'LISTING_NOT_VERIFIED', 'NOT_FOUND'].includes(e.code);
    const stored: Stored = { checks: [], upstream: null, failure: { code: e.code, message: e.message.slice(0, 200) } };
    settled = settleExecution(
      db,
      execution.id,
      neverSent ? 'NOT_QUALIFIED' : 'UNRESOLVED',
      neverSent ? `the request was not sent (${e.code})` : `the API did not answer in time or the connection failed (${e.code}); outcome unknown`,
      now,
      stored,
    );
  }
  audit(db, a.buyerId, 'execution.finished', settled.id, { state: settled.state }, new Date(now()));
  return view(db, settled, false);
}

export function executionResult(db: Db, executionId: string): ExecutionResult | undefined {
  const e = getExecution(db, executionId);
  return e ? view(db, e, true) : undefined;
}

/**
 * Housekeeping, safe to run on a timer or at start-up:
 *  - an execution still HELD after `staleHeldMs` was interrupted mid-call (crash/restart): the outcome is unknown -> UNRESOLVED;
 *  - UNRESOLVED older than `unresolvedMs` is released to the buyer (RELEASED_UNRESOLVED), never charged.
 */
export function recoverExecutions(db: Db, p: { staleHeldMs: number; unresolvedMs: number }, now: () => number = Date.now): { interrupted: number; released: number } {
  const cutoff = new Date(now() - p.staleHeldMs).toISOString();
  const stuck = query<{ id: string }>(db, "SELECT id FROM executions WHERE state = 'HELD' AND updated_at <= ?", cutoff);
  for (const r of stuck) settleExecution(db, String(r.id), 'UNRESOLVED', 'interrupted before an outcome was recorded', now, { checks: [], upstream: null, failure: { code: 'INTERRUPTED', message: 'process stopped mid-call' } } satisfies Stored);
  const released = expireUnresolved(db, p.unresolvedMs, now);
  return { interrupted: stuck.length, released: released.length };
}
