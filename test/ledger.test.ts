// Ledger and execution accounting. In-memory SQLite (and one on-disk, multi-connection test). No network, no funds.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIGRATIONS, audit, inTransaction, migrate, openDb, query, queryOne } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { LedgerError, balance, createAccount, deposit, expireUnresolved, feeFor, getExecution, settleExecution, startExecution, verifyLedger } from '../src/ledger.ts';
import { tempDir } from './support.ts';

const T0 = 1_800_000_000_000;
const ASSET = 'USDT';

function world(opts: { price?: bigint; feeBps?: number; asset?: string; status?: string; db?: Db } = {}) {
  const db = opts.db ?? openDb(':memory:');
  const seller = createAccount(db, { kind: 'seller', displayName: 'Acme APIs' }, () => T0);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'Ada' }, () => T0);
  const listingId = `lst_${seller}`;
  db.prepare('INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, fee_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    listingId, seller, 'Token price', opts.status ?? 'published', opts.price ?? 10_000n, opts.asset ?? ASSET, opts.feeBps ?? 300, new Date(T0).toISOString(),
  );
  const contractId = `cv_${seller}`;
  db.prepare('INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, approved_at, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(
    contractId, listingId, '{"rules":[]}', 'h1', 'approved', new Date(T0).toISOString(), new Date(T0).toISOString(),
  );
  return { db, seller, buyer, listingId, contractId };
}
const start = (w: ReturnType<typeof world>, key = 'k1', hash = 'req1') =>
  startExecution(w.db, { buyerId: w.buyer, listingId: w.listingId, contractVersionId: w.contractId, idempotencyKey: key, requestHash: hash }, () => T0);
const fund = (w: ReturnType<typeof world>, amount: bigint, ref = 'dep-1') => deposit(w.db, { buyerId: w.buyer, asset: ASSET, amountAtomic: amount, ref }, () => T0);
const bal = (w: ReturnType<typeof world>, who: string, kind: any, asset = ASSET) => balance(w.db, who, kind, asset);

// ------------------------------------------------------------------ schema
test('schema: migrations apply once, are idempotent, and foreign keys are enforced', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db, MIGRATIONS), [], 'a second run applies nothing');
  assert.equal(Number(queryOne<{ n: bigint }>(db, 'SELECT COUNT(*) AS n FROM schema_migrations')!.n), 1);
  assert.throws(
    () => db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at) VALUES ('l','no-such-seller','n','draft',1,'USDT','t')").run(),
    /FOREIGN KEY/i,
  );
});

test('immutability: ledger entries, ledger transactions and the audit log cannot be updated or deleted', () => {
  const w = world();
  fund(w, 50_000n);
  audit(w.db, 'test', 'x', 'y');
  for (const sql of [
    'UPDATE ledger_entries SET amount = 1',
    'DELETE FROM ledger_entries',
    "UPDATE ledger_transactions SET memo = 'edited'",
    'DELETE FROM ledger_transactions',
    "UPDATE audit_log SET actor = 'someone else'",
    'DELETE FROM audit_log',
  ]) {
    assert.throws(() => w.db.exec(sql), /immutable|append-only/, sql);
  }
});

// ------------------------------------------------------------------ the happy path and the fee
test('deposit, hold, capture: buyer pays once, seller gets price minus 3%, platform gets the fee', () => {
  const w = world({ price: 10_000n });
  fund(w, 50_000n);
  const { execution, replay } = start(w);
  assert.equal(replay, false);
  assert.equal(execution.state, 'HELD');
  assert.equal(bal(w, w.buyer, 'buyer_available'), 40_000n);
  assert.equal(bal(w, w.buyer, 'buyer_held'), 10_000n);

  const done = settleExecution(w.db, execution.id, 'QUALIFIED', 'all rules passed', () => T0 + 1);
  assert.equal(done.state, 'QUALIFIED');
  assert.equal(done.feeAtomic, 300n);
  assert.equal(done.sellerAtomic, 9_700n);
  assert.equal(bal(w, w.buyer, 'buyer_held'), 0n);
  assert.equal(bal(w, w.buyer, 'buyer_available'), 40_000n, 'exactly one price was charged');
  assert.equal(bal(w, w.seller, 'seller_earnings'), 9_700n);
  assert.equal(bal(w, 'platform', 'platform_fee'), 300n);
  assert.deepEqual(verifyLedger(w.db), { ok: true, problems: [] });
});

test('a non-qualifying response consumes no credit and creates no seller earnings', () => {
  const w = world();
  fund(w, 20_000n);
  const { execution } = start(w);
  const r = settleExecution(w.db, execution.id, 'NOT_QUALIFIED', 'timestamp older than 60 seconds', () => T0 + 1);
  assert.equal(r.state, 'NOT_QUALIFIED');
  assert.equal(bal(w, w.buyer, 'buyer_available'), 20_000n, 'credit fully returned');
  assert.equal(bal(w, w.buyer, 'buyer_held'), 0n);
  assert.equal(bal(w, w.seller, 'seller_earnings'), 0n);
  assert.equal(bal(w, 'platform', 'platform_fee'), 0n);
  assert.equal(verifyLedger(w.db).ok, true);
});

test('fee arithmetic: round-half-up, fee + seller == price, never negative, for awkward amounts', () => {
  for (const [price, bps, fee] of [[10_000n, 300, 300n], [1n, 300, 0n], [17n, 300, 1n], [16n, 300, 0n], [1_000_001n, 300, 30_000n], [5n, 10_000, 5n], [999n, 0, 0n]] as const) {
    const f = feeFor(price, bps);
    assert.equal(f.fee, fee, `${price}@${bps}`);
    assert.equal(f.fee + f.seller, price);
    assert.ok(f.seller >= 0n);
  }
  assert.throws(() => feeFor(0n, 300), /positive/);
});

test('the fee rate is snapshotted at hold time: editing the listing later does not change an in-flight purchase', () => {
  const w = world({ price: 10_000n, feeBps: 300 });
  fund(w, 10_000n);
  const { execution } = start(w);
  w.db.prepare('UPDATE listings SET fee_bps = 1000 WHERE id = ?').run(w.listingId);
  const done = settleExecution(w.db, execution.id, 'QUALIFIED', 'ok', () => T0);
  assert.equal(done.feeAtomic, 300n, 'still 3%, not the new 10%');
});

// ------------------------------------------------------------------ refusals leave nothing behind
test('insufficient credits: refused with no execution and no ledger rows created', () => {
  const w = world({ price: 10_000n });
  fund(w, 9_999n);
  const before = Number(queryOne<{ n: bigint }>(w.db, 'SELECT COUNT(*) AS n FROM ledger_entries')!.n);
  assert.throws(() => start(w), (e: unknown) => e instanceof LedgerError && e.code === 'INSUFFICIENT_CREDITS');
  assert.equal(Number(queryOne<{ n: bigint }>(w.db, 'SELECT COUNT(*) AS n FROM executions')!.n), 0);
  assert.equal(Number(queryOne<{ n: bigint }>(w.db, 'SELECT COUNT(*) AS n FROM ledger_entries')!.n), before);
});

test('listing must be published and the contract must be an approved version of that listing', () => {
  const draft = world({ status: 'draft' });
  fund(draft, 20_000n);
  assert.throws(() => start(draft), (e: unknown) => e instanceof LedgerError && e.code === 'LISTING_NOT_PUBLISHED');

  const w = world();
  fund(w, 20_000n);
  w.db.prepare("UPDATE contract_versions SET status = 'proposed'").run();
  assert.throws(() => start(w), (e: unknown) => e instanceof LedgerError && e.code === 'CONTRACT_NOT_APPROVED');
  const other = world();
  assert.throws(
    () => startExecution(w.db, { buyerId: w.buyer, listingId: w.listingId, contractVersionId: other.contractId, idempotencyKey: 'z', requestHash: 'z' }, () => T0),
    (e: unknown) => e instanceof LedgerError && e.code === 'CONTRACT_NOT_APPROVED',
  );
});

// ------------------------------------------------------------------ idempotency
test('idempotency: the same key and request returns the same execution and holds only once', () => {
  const w = world({ price: 10_000n });
  fund(w, 30_000n);
  const a = start(w, 'abc', 'hash-1');
  const b = start(w, 'abc', 'hash-1');
  assert.equal(b.replay, true);
  assert.equal(b.execution.id, a.execution.id);
  assert.equal(bal(w, w.buyer, 'buyer_held'), 10_000n, 'one hold, not two');
  assert.throws(() => start(w, 'abc', 'DIFFERENT'), (e: unknown) => e instanceof LedgerError && e.code === 'IDEMPOTENCY_CONFLICT');
  // a different key is a different logical request
  const c = start(w, 'def', 'hash-1');
  assert.notEqual(c.execution.id, a.execution.id);
  assert.equal(bal(w, w.buyer, 'buyer_held'), 20_000n);
});

test('idempotency: keys are scoped per buyer', () => {
  const w = world();
  fund(w, 20_000n);
  const other = createAccount(w.db, { kind: 'buyer', displayName: 'Bo' }, () => T0);
  deposit(w.db, { buyerId: other, asset: ASSET, amountAtomic: 20_000n, ref: 'dep-other' }, () => T0);
  const a = start(w, 'same-key', 'r');
  const b = startExecution(w.db, { buyerId: other, listingId: w.listingId, contractVersionId: w.contractId, idempotencyKey: 'same-key', requestHash: 'r' }, () => T0);
  assert.notEqual(a.execution.id, b.execution.id);
  assert.equal(b.replay, false);
});

test('deposits are idempotent by reference; reusing a reference for a different amount is refused', () => {
  const w = world();
  assert.deepEqual(fund(w, 5_000n, 'tx-abc'), { created: true });
  assert.deepEqual(fund(w, 5_000n, 'tx-abc'), { created: false });
  assert.equal(bal(w, w.buyer, 'buyer_available'), 5_000n);
  assert.throws(() => fund(w, 6_000n, 'tx-abc'), (e: unknown) => e instanceof LedgerError && e.code === 'DEPOSIT_CONFLICT');
  assert.throws(() => deposit(w.db, { buyerId: w.buyer, asset: ASSET, amountAtomic: 0n, ref: 'zero' }), /positive/);
});

// ------------------------------------------------------------------ state machine
test('settlement is idempotent and a terminal outcome can never be reversed (no double charge, no double refund)', () => {
  const w = world();
  fund(w, 30_000n);
  const { execution } = start(w);
  const a = settleExecution(w.db, execution.id, 'QUALIFIED', 'ok', () => T0);
  const b = settleExecution(w.db, execution.id, 'QUALIFIED', 'ok again', () => T0 + 5);
  assert.equal(b.state, 'QUALIFIED');
  assert.equal(b.updatedAt, a.updatedAt, 'the replay changed nothing');
  assert.equal(bal(w, w.seller, 'seller_earnings'), 9_700n, 'captured exactly once');
  assert.throws(() => settleExecution(w.db, execution.id, 'NOT_QUALIFIED', 'x', () => T0), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_TRANSITION');
  assert.throws(() => settleExecution(w.db, 'exec_missing', 'QUALIFIED', 'x', () => T0), (e: unknown) => e instanceof LedgerError && e.code === 'NOT_FOUND');
  assert.equal(verifyLedger(w.db).ok, true);
});

test('unknown outcome: the hold stays reserved (not spent), can be proven either way, never auto-charged', () => {
  const w = world({ price: 10_000n });
  fund(w, 10_000n);
  const { execution } = start(w);
  const u = settleExecution(w.db, execution.id, 'UNRESOLVED', 'timeout after the request was sent', () => T0 + 1);
  assert.equal(u.state, 'UNRESOLVED');
  assert.equal(bal(w, w.buyer, 'buyer_held'), 10_000n);
  assert.equal(bal(w, w.buyer, 'buyer_available'), 0n, 'cannot be spent elsewhere meanwhile');
  assert.equal(bal(w, w.seller, 'seller_earnings'), 0n, 'the seller earns nothing from an unknown outcome');
  assert.equal(settleExecution(w.db, execution.id, 'UNRESOLVED', 'again', () => T0 + 2).state, 'UNRESOLVED', 'replay');

  // proven NOT qualifying -> released; (a second execution proven qualifying -> captured)
  const released = settleExecution(w.db, execution.id, 'NOT_QUALIFIED', 'upstream confirmed it failed', () => T0 + 3);
  assert.equal(released.state, 'NOT_QUALIFIED');
  assert.equal(bal(w, w.buyer, 'buyer_available'), 10_000n);

  const w2 = world({ price: 10_000n });
  fund(w2, 10_000n);
  const e2 = start(w2).execution;
  settleExecution(w2.db, e2.id, 'UNRESOLVED', 'unknown', () => T0);
  const cap = settleExecution(w2.db, e2.id, 'QUALIFIED', 'upstream receipt proves delivery', () => T0 + 1);
  assert.equal(cap.state, 'QUALIFIED');
  assert.equal(bal(w2, w2.seller, 'seller_earnings'), 9_700n);
  assert.equal(verifyLedger(w.db).ok && verifyLedger(w2.db).ok, true);
});

test('expiry: an outcome unresolved past the window is RELEASED to the buyer and flagged; fresh ones are untouched', () => {
  const w = world({ price: 10_000n });
  fund(w, 20_000n);
  const a = start(w, 'a', 'ra').execution;
  const b = start(w, 'b', 'rb').execution;
  settleExecution(w.db, a.id, 'UNRESOLVED', 'unknown', () => T0);
  settleExecution(w.db, b.id, 'UNRESOLVED', 'unknown', () => T0 + 50 * 60_000);
  const expired = expireUnresolved(w.db, 30 * 60_000, () => T0 + 60 * 60_000); // 60 min after T0
  assert.deepEqual(expired.map((e) => e.id), [a.id]);
  assert.equal(getExecution(w.db, a.id)!.state, 'RELEASED_UNRESOLVED');
  assert.equal(getExecution(w.db, b.id)!.state, 'UNRESOLVED');
  assert.equal(bal(w, w.buyer, 'buyer_available'), 10_000n);
  assert.equal(bal(w, w.buyer, 'buyer_held'), 10_000n);
  assert.equal(bal(w, w.seller, 'seller_earnings'), 0n);
  assert.deepEqual(expireUnresolved(w.db, 30 * 60_000, () => T0 + 60 * 60_000), [], 'idempotent');
  assert.throws(() => settleExecution(w.db, a.id, 'QUALIFIED', 'late', () => T0), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_TRANSITION');
  assert.equal(verifyLedger(w.db).ok, true);
});

// ------------------------------------------------------------------ assets and the verifier
test('assets never mix: a USDC listing cannot be paid from USDT credits', () => {
  const w = world({ price: 10_000n, asset: 'USDC' });
  fund(w, 50_000n); // USDT credits
  assert.throws(() => start(w), (e: unknown) => e instanceof LedgerError && e.code === 'INSUFFICIENT_CREDITS');
  deposit(w.db, { buyerId: w.buyer, asset: 'USDC', amountAtomic: 10_000n, ref: 'usdc-1' }, () => T0);
  assert.equal(start(w).execution.asset, 'USDC');
  assert.equal(bal(w, w.buyer, 'buyer_available', 'USDT'), 50_000n, 'USDT untouched');
  assert.equal(verifyLedger(w.db).ok, true);
});

test('verifyLedger catches tampering the triggers cannot see (an unbalanced insert, a missing capture)', () => {
  const w = world();
  fund(w, 20_000n);
  const { execution } = start(w);
  settleExecution(w.db, execution.id, 'QUALIFIED', 'ok', () => T0);
  assert.equal(verifyLedger(w.db).ok, true);

  // unbalanced extra entry added by hand
  const acct = queryOne<{ id: bigint }>(w.db, "SELECT id FROM ledger_accounts WHERE kind = 'seller_earnings'")!.id;
  const tx = queryOne<{ id: bigint }>(w.db, "SELECT id FROM ledger_transactions WHERE kind = 'capture'")!.id;
  w.db.prepare('INSERT INTO ledger_entries (tx_id, account_id, amount, asset) VALUES (?, ?, ?, ?)').run(tx, acct, 1n, ASSET);
  const v = verifyLedger(w.db);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /unbalanced/.test(p)));
  assert.ok(v.problems.some((p) => /net to zero/.test(p)));
});

test('verifyLedger catches an execution whose state does not match its ledger transactions', () => {
  const w = world();
  fund(w, 20_000n);
  const { execution } = start(w);
  w.db.prepare("UPDATE executions SET state = 'QUALIFIED', fee_atomic = 300, seller_atomic = 9700 WHERE id = ?").run(execution.id);
  const v = verifyLedger(w.db);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /QUALIFIED but has ledger transactions \[hold\]/.test(p)));
  assert.ok(v.problems.some((p) => /held balance/.test(p)));
});

test('transactions are atomic: a failure inside one leaves no partial rows', () => {
  const w = world();
  assert.throws(() =>
    inTransaction(w.db, () => {
      w.db.prepare("INSERT INTO accounts (id, kind, display_name, created_at) VALUES ('half', 'buyer', 'x', 't')").run();
      throw new Error('boom');
    }),
  );
  assert.equal(queryOne(w.db, "SELECT id FROM accounts WHERE id = 'half'"), undefined);
  assert.throws(() => inTransaction(w.db, () => inTransaction(w.db, () => 1)), /nested/);
});

// ------------------------------------------------------------------ concurrency across connections (on disk)
test('two connections to the same database file cannot both spend the last credit', () => {
  const file = join(tempDir(), 'market.db');
  const a = world({ db: openDb(file), price: 10_000n });
  const b = openDb(file);
  deposit(a.db, { buyerId: a.buyer, asset: ASSET, amountAtomic: 10_000n, ref: 'only-once' }, () => T0);

  const r1 = startExecution(a.db, { buyerId: a.buyer, listingId: a.listingId, contractVersionId: a.contractId, idempotencyKey: 'one', requestHash: 'x' }, () => T0);
  assert.equal(r1.execution.state, 'HELD');
  assert.throws(
    () => startExecution(b, { buyerId: a.buyer, listingId: a.listingId, contractVersionId: a.contractId, idempotencyKey: 'two', requestHash: 'y' }, () => T0),
    (e: unknown) => e instanceof LedgerError && e.code === 'INSUFFICIENT_CREDITS',
  );
  // the second connection also sees the first's idempotent replay
  assert.equal(startExecution(b, { buyerId: a.buyer, listingId: a.listingId, contractVersionId: a.contractId, idempotencyKey: 'one', requestHash: 'x' }, () => T0).replay, true);
  assert.equal(verifyLedger(b).ok, true);
  assert.equal(query(b, 'SELECT id FROM executions').length, 1);
});
