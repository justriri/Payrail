// Credits, holds and settlement: the money logic of the marketplace.
//
// THE MODEL (double entry; every transaction's entries sum to zero per asset)
//   deposit  external_funding -X   -> buyer_available +X        (credits enter; in milestone 1 these are TEST credits)
//   hold     buyer_available  -P   -> buyer_held      +P        (before the upstream call; P = listed price)
//   capture  buyer_held       -P   -> seller_earnings +(P-F), platform_fee +F      (ONLY for a qualifying response)
//   release  buyer_held       -P   -> buyer_available +P        (non-qualifying response, or an expired unknown outcome)
//
// THE RULES
//   * A buyer is charged only by `capture`, and only when the response met the approved contract.
//   * Unknown outcomes are never charged: the hold stays UNRESOLVED (funds reserved, not spent) until it is
//     proven (resolve) or the documented window passes (expire -> released to the buyer, flagged).
//   * One logical request = one (buyer, idempotency key). The same key + same request returns the stored result and
//     never holds twice; the same key with a different request is refused.
//   * The fee rate is snapshotted at hold time, so later listing edits cannot change an in-flight purchase.
//   * Fee = round-half-up(P * bps / 10_000); the seller receives P - fee. fee + seller == P exactly.
//   * Entries are immutable (database triggers). `verifyLedger` re-derives every invariant from the entries.
import { randomUUID } from 'node:crypto';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';

export class LedgerError extends Error {
  code:
    | 'INSUFFICIENT_CREDITS'
    | 'IDEMPOTENCY_CONFLICT'
    | 'LISTING_NOT_PUBLISHED'
    | 'CONTRACT_NOT_APPROVED'
    | 'INVALID_TRANSITION'
    | 'NOT_FOUND'
    | 'BAD_AMOUNT'
    | 'DEPOSIT_CONFLICT';
  constructor(code: LedgerError['code'], message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export type ExecutionState = 'HELD' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'UNRESOLVED' | 'RELEASED_UNRESOLVED';

export interface Execution {
  id: string;
  buyerId: string;
  listingId: string;
  contractVersionId: string;
  idempotencyKey: string;
  requestHash: string;
  state: ExecutionState;
  priceAtomic: bigint;
  asset: string;
  feeBps: number;
  feeAtomic: bigint | null;
  sellerAtomic: bigint | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

type Kind = 'buyer_available' | 'buyer_held' | 'seller_earnings' | 'platform_fee' | 'external_funding';
export type Clock = () => number;
const iso = (now: Clock) => new Date(now()).toISOString();

export function feeFor(priceAtomic: bigint, feeBps: number): { fee: bigint; seller: bigint } {
  if (priceAtomic <= 0n) throw new LedgerError('BAD_AMOUNT', 'amount must be positive');
  const fee = (priceAtomic * BigInt(feeBps) + 5_000n) / 10_000n;
  return { fee, seller: priceAtomic - fee };
}

// ------------------------------------------------------------------ accounts

export function createAccount(db: Db, a: { id?: string; kind: 'buyer' | 'seller' | 'agent'; displayName: string }, now: Clock = Date.now): string {
  const id = a.id ?? `${a.kind}_${randomUUID()}`;
  db.prepare('INSERT INTO accounts (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, a.kind, a.displayName.slice(0, 120), iso(now));
  return id;
}

/** The ledger account for (owner, kind, asset), created on first use. Call inside a transaction when writing. */
function ledgerAccount(db: Db, owner: string, kind: Kind, asset: string): bigint {
  db.prepare('INSERT OR IGNORE INTO ledger_accounts (owner_id, kind, asset) VALUES (?, ?, ?)').run(owner, kind, asset);
  const r = queryOne<{ id: bigint }>(db, 'SELECT id FROM ledger_accounts WHERE owner_id = ? AND kind = ? AND asset = ?', owner, kind, asset);
  return r!.id;
}

export function balance(db: Db, owner: string, kind: Kind, asset: string): bigint {
  const r = queryOne<{ s: bigint | null }>(
    db,
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.owner_id = ? AND a.kind = ? AND a.asset = ?`,
    owner,
    kind,
    asset,
  );
  return BigInt(r?.s ?? 0n);
}

function post(db: Db, kind: 'deposit' | 'hold' | 'capture' | 'release', executionId: string | null, ref: string | null, memo: string, lines: Array<{ owner: string; kind: Kind; asset: string; amount: bigint }>, now: Clock): void {
  const sums = new Map<string, bigint>();
  for (const l of lines) sums.set(l.asset, (sums.get(l.asset) ?? 0n) + l.amount);
  for (const [asset, s] of sums) if (s !== 0n) throw new Error(`unbalanced ledger transaction for ${asset}: ${s}`);
  const r = db
    .prepare('INSERT INTO ledger_transactions (kind, execution_id, ref, memo, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, executionId, ref, memo, iso(now));
  const txId = r.lastInsertRowid;
  for (const l of lines) {
    if (l.amount === 0n) continue;
    db.prepare('INSERT INTO ledger_entries (tx_id, account_id, amount, asset) VALUES (?, ?, ?, ?)').run(txId, ledgerAccount(db, l.owner, l.kind, l.asset), l.amount, l.asset);
  }
}

// ------------------------------------------------------------------ deposits (credits in)

/**
 * Credit a buyer. `ref` makes it idempotent (for example a deposit transaction hash). Milestone 1 uses test credits:
 * the source is the platform's `external_funding` account, which is the ONLY account allowed to be negative.
 */
export function deposit(db: Db, a: { buyerId: string; asset: string; amountAtomic: bigint; ref: string; memo?: string }, now: Clock = Date.now): { created: boolean } {
  if (a.amountAtomic <= 0n) throw new LedgerError('BAD_AMOUNT', 'a deposit must be positive');
  return inTransaction(db, () => {
    const existing = queryOne<{ id: bigint }>(db, "SELECT id FROM ledger_transactions WHERE kind = 'deposit' AND ref = ?", a.ref);
    if (existing) {
      const amt = queryOne<{ amount: bigint }>(
        db,
        `SELECT e.amount FROM ledger_entries e JOIN ledger_accounts l ON l.id = e.account_id
         WHERE e.tx_id = ? AND l.kind = 'buyer_available' AND l.owner_id = ? AND e.asset = ?`,
        existing.id,
        a.buyerId,
        a.asset,
      );
      if (!amt || BigInt(amt.amount) !== a.amountAtomic) throw new LedgerError('DEPOSIT_CONFLICT', `deposit reference ${a.ref} was already used for a different deposit`);
      return { created: false };
    }
    post(db, 'deposit', null, a.ref, a.memo ?? 'deposit', [
      { owner: 'platform', kind: 'external_funding', asset: a.asset, amount: -a.amountAtomic },
      { owner: a.buyerId, kind: 'buyer_available', asset: a.asset, amount: a.amountAtomic },
    ], now);
    audit(db, a.buyerId, 'deposit', a.ref, { asset: a.asset, amount: a.amountAtomic.toString() }, new Date(now()));
    return { created: true };
  });
}

// ------------------------------------------------------------------ executions

function rowToExecution(r: Record<string, any>): Execution {
  return {
    id: String(r.id),
    buyerId: String(r.buyer_id),
    listingId: String(r.listing_id),
    contractVersionId: String(r.contract_version_id),
    idempotencyKey: String(r.idempotency_key),
    requestHash: String(r.request_hash),
    state: String(r.state) as ExecutionState,
    priceAtomic: BigInt(r.price_atomic),
    asset: String(r.asset),
    feeBps: Number(r.fee_bps),
    feeAtomic: r.fee_atomic === null ? null : BigInt(r.fee_atomic),
    sellerAtomic: r.seller_atomic === null ? null : BigInt(r.seller_atomic),
    reason: r.reason === null ? null : String(r.reason),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function getExecution(db: Db, id: string): Execution | undefined {
  const r = queryOne(db, 'SELECT * FROM executions WHERE id = ?', id);
  return r ? rowToExecution(r) : undefined;
}

/**
 * Reserve the price for one logical request. Atomic: either the execution and its hold both exist, or neither does.
 * Returns the existing execution (replay: true) when the same buyer repeats the same idempotency key and request.
 */
export function startExecution(
  db: Db,
  a: { buyerId: string; listingId: string; contractVersionId: string; idempotencyKey: string; requestHash: string },
  now: Clock = Date.now,
): { execution: Execution; replay: boolean } {
  return inTransaction(db, () => {
    const prior = queryOne(db, 'SELECT * FROM executions WHERE buyer_id = ? AND idempotency_key = ?', a.buyerId, a.idempotencyKey);
    if (prior) {
      if (String(prior.request_hash) !== a.requestHash) {
        throw new LedgerError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request');
      }
      return { execution: rowToExecution(prior), replay: true };
    }
    const listing = queryOne(db, 'SELECT * FROM listings WHERE id = ?', a.listingId);
    if (!listing) throw new LedgerError('NOT_FOUND', `no listing ${a.listingId}`);
    if (String(listing.status) !== 'published') throw new LedgerError('LISTING_NOT_PUBLISHED', 'the listing is not published');
    const cv = queryOne(db, 'SELECT * FROM contract_versions WHERE id = ? AND listing_id = ?', a.contractVersionId, a.listingId);
    if (!cv || String(cv.status) !== 'approved') throw new LedgerError('CONTRACT_NOT_APPROVED', 'the response contract is not an approved version of this listing');

    const price = BigInt(listing.price_atomic as bigint);
    const asset = String(listing.asset);
    const available = balance(db, a.buyerId, 'buyer_available', asset);
    if (available < price) {
      throw new LedgerError('INSUFFICIENT_CREDITS', `needs ${price} ${asset} atomic units; ${available} available`);
    }
    const id = `exec_${randomUUID()}`;
    const at = iso(now);
    db.prepare(
      `INSERT INTO executions (id, buyer_id, listing_id, contract_version_id, idempotency_key, request_hash, state, price_atomic, asset, fee_bps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'HELD', ?, ?, ?, ?, ?)`,
    ).run(id, a.buyerId, a.listingId, a.contractVersionId, a.idempotencyKey, a.requestHash, price, asset, Number(listing.fee_bps), at, at);
    post(db, 'hold', id, null, 'reserve price for one response', [
      { owner: a.buyerId, kind: 'buyer_available', asset, amount: -price },
      { owner: a.buyerId, kind: 'buyer_held', asset, amount: price },
    ], now);
    audit(db, a.buyerId, 'hold', id, { listing: a.listingId, price: price.toString(), asset }, new Date(now()));
    return { execution: getExecution(db, id)!, replay: false };
  });
}

export type Outcome = 'QUALIFIED' | 'NOT_QUALIFIED' | 'UNRESOLVED';

/**
 * Apply the result of validating a response. Idempotent: repeating the same outcome returns the stored execution;
 * a conflicting outcome for a terminal execution is refused.
 */
export function settleExecution(db: Db, executionId: string, outcome: Outcome, reason: string, now: Clock = Date.now, evidence?: unknown): Execution {
  return inTransaction(db, () => {
    const cur = getExecution(db, executionId);
    if (!cur) throw new LedgerError('NOT_FOUND', `no execution ${executionId}`);
    const same = (cur.state as string) === outcome;
    if (same) return cur; // replay
    const terminal = cur.state === 'QUALIFIED' || cur.state === 'NOT_QUALIFIED' || cur.state === 'RELEASED_UNRESOLVED';
    if (terminal) throw new LedgerError('INVALID_TRANSITION', `execution is ${cur.state}; it cannot become ${outcome}`);
    // here: HELD or UNRESOLVED
    if (cur.state === 'UNRESOLVED' && outcome === 'UNRESOLVED') return cur;
    const at = iso(now);
    const evidenceJson = evidence === undefined ? null : JSON.stringify(evidence);

    if (outcome === 'UNRESOLVED') {
      db.prepare('UPDATE executions SET state = ?, reason = ?, evidence_json = ?, updated_at = ? WHERE id = ?').run('UNRESOLVED', reason.slice(0, 300), evidenceJson, at, executionId);
      audit(db, 'system', 'unresolved', executionId, { reason }, new Date(now()));
      return getExecution(db, executionId)!;
    }

    const listing = queryOne(db, 'SELECT seller_id FROM listings WHERE id = ?', cur.listingId)!;
    if (outcome === 'QUALIFIED') {
      const { fee, seller } = feeFor(cur.priceAtomic, cur.feeBps);
      post(db, 'capture', executionId, null, 'qualifying response', [
        { owner: cur.buyerId, kind: 'buyer_held', asset: cur.asset, amount: -cur.priceAtomic },
        { owner: String(listing.seller_id), kind: 'seller_earnings', asset: cur.asset, amount: seller },
        { owner: 'platform', kind: 'platform_fee', asset: cur.asset, amount: fee },
      ], now);
      db.prepare('UPDATE executions SET state = ?, fee_atomic = ?, seller_atomic = ?, reason = ?, evidence_json = ?, updated_at = ? WHERE id = ?').run(
        'QUALIFIED', fee, seller, reason.slice(0, 300), evidenceJson, at, executionId,
      );
      audit(db, 'system', 'capture', executionId, { fee: fee.toString(), seller: seller.toString() }, new Date(now()));
    } else {
      post(db, 'release', executionId, null, 'non-qualifying response', [
        { owner: cur.buyerId, kind: 'buyer_held', asset: cur.asset, amount: -cur.priceAtomic },
        { owner: cur.buyerId, kind: 'buyer_available', asset: cur.asset, amount: cur.priceAtomic },
      ], now);
      db.prepare('UPDATE executions SET state = ?, reason = ?, evidence_json = ?, updated_at = ? WHERE id = ?').run('NOT_QUALIFIED', reason.slice(0, 300), evidenceJson, at, executionId);
      audit(db, 'system', 'release', executionId, { reason }, new Date(now()));
    }
    return getExecution(db, executionId)!;
  });
}

/**
 * Policy for outcomes that stay unknown: after `olderThanMs` the hold is RELEASED to the buyer and the execution is
 * marked RELEASED_UNRESOLVED. The seller earns nothing from it. Documented trade-off: buyer-favourable by default.
 */
export function expireUnresolved(db: Db, olderThanMs: number, now: Clock = Date.now): Execution[] {
  const cutoff = new Date(now() - olderThanMs).toISOString();
  const ids = query<{ id: string }>(db, "SELECT id FROM executions WHERE state = 'UNRESOLVED' AND updated_at <= ?", cutoff).map((r) => String(r.id));
  const out: Execution[] = [];
  for (const id of ids) {
    out.push(
      inTransaction(db, () => {
        const cur = getExecution(db, id)!;
        if (cur.state !== 'UNRESOLVED') return cur;
        post(db, 'release', id, null, 'unresolved outcome expired; released to the buyer', [
          { owner: cur.buyerId, kind: 'buyer_held', asset: cur.asset, amount: -cur.priceAtomic },
          { owner: cur.buyerId, kind: 'buyer_available', asset: cur.asset, amount: cur.priceAtomic },
        ], now);
        db.prepare('UPDATE executions SET state = ?, reason = ?, updated_at = ? WHERE id = ?').run(
          'RELEASED_UNRESOLVED', 'the outcome could not be established within the window; released to the buyer', iso(now), id,
        );
        audit(db, 'system', 'expire_unresolved', id, undefined, new Date(now()));
        return getExecution(db, id)!;
      }),
    );
  }
  return out;
}

// ------------------------------------------------------------------ verification

/** Re-derive every accounting invariant from the immutable entries. Returns the list of violations (empty = sound). */
export function verifyLedger(db: Db): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  for (const r of query<{ tx_id: bigint; asset: string; s: bigint }>(db, 'SELECT tx_id, asset, SUM(amount) AS s FROM ledger_entries GROUP BY tx_id, asset HAVING SUM(amount) <> 0')) {
    problems.push(`transaction ${r.tx_id} is unbalanced for ${r.asset} (${r.s})`);
  }
  for (const r of query<{ asset: string; s: bigint }>(db, 'SELECT asset, SUM(amount) AS s FROM ledger_entries GROUP BY asset HAVING SUM(amount) <> 0')) {
    problems.push(`the ledger does not net to zero for ${r.asset} (${r.s})`);
  }
  for (const r of query<{ owner_id: string; kind: string; asset: string; s: bigint }>(
    db,
    `SELECT a.owner_id, a.kind, a.asset, SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     GROUP BY a.id HAVING (a.kind <> 'external_funding' AND SUM(e.amount) < 0) OR (a.kind = 'external_funding' AND SUM(e.amount) > 0)`,
  )) {
    problems.push(`account ${r.owner_id}/${r.kind}/${r.asset} has an impossible balance (${r.s})`);
  }
  // held funds must equal the open executions' prices, per buyer and asset
  const held = new Map<string, bigint>();
  for (const r of query<{ owner_id: string; asset: string; s: bigint }>(
    db,
    `SELECT a.owner_id, a.asset, SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'buyer_held' GROUP BY a.id`,
  )) held.set(`${r.owner_id}|${r.asset}`, BigInt(r.s));
  const open = new Map<string, bigint>();
  for (const r of query<{ buyer_id: string; asset: string; s: bigint }>(
    db,
    `SELECT buyer_id, asset, SUM(price_atomic) AS s FROM executions WHERE state IN ('HELD','UNRESOLVED') GROUP BY buyer_id, asset`,
  )) open.set(`${r.buyer_id}|${r.asset}`, BigInt(r.s));
  for (const k of new Set([...held.keys(), ...open.keys()])) {
    if ((held.get(k) ?? 0n) !== (open.get(k) ?? 0n)) problems.push(`held balance for ${k} is ${held.get(k) ?? 0n} but open executions total ${open.get(k) ?? 0n}`);
  }
  // each execution has exactly the ledger transactions its state requires
  for (const e of query<{ id: string; state: string; price_atomic: bigint; fee_atomic: bigint | null; seller_atomic: bigint | null }>(db, 'SELECT id, state, price_atomic, fee_atomic, seller_atomic FROM executions')) {
    const kinds = query<{ kind: string }>(db, 'SELECT kind FROM ledger_transactions WHERE execution_id = ? ORDER BY id', e.id).map((r) => String(r.kind));
    const want: Record<string, string[]> = {
      HELD: ['hold'],
      UNRESOLVED: ['hold'],
      QUALIFIED: ['hold', 'capture'],
      NOT_QUALIFIED: ['hold', 'release'],
      RELEASED_UNRESOLVED: ['hold', 'release'],
    };
    if (JSON.stringify(kinds) !== JSON.stringify(want[String(e.state)])) problems.push(`execution ${e.id} is ${e.state} but has ledger transactions [${kinds.join(',')}]`);
    if (String(e.state) === 'QUALIFIED' && (e.fee_atomic === null || e.seller_atomic === null || BigInt(e.fee_atomic) + BigInt(e.seller_atomic) !== BigInt(e.price_atomic))) {
      problems.push(`execution ${e.id}: fee + seller does not equal the price`);
    }
  }
  return { ok: problems.length === 0, problems };
}
