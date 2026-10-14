// Marketplace database (node:sqlite, built into Node 24: no dependency).
//
// RULES FOR EVERYTHING BUILT ON THIS FILE
//   * Amounts are INTEGER atomic units of a named asset (never floats). They are read back as BigInt.
//   * Ledger entries are append-only: SQLite triggers refuse UPDATE and DELETE.
//   * Every multi-row change happens inside `inTransaction` (BEGIN IMMEDIATE), so concurrent writers serialize
//     and a failure leaves nothing half-written.
//   * Foreign keys are ON. Schema changes are numbered migrations; applying them twice is a no-op.
//   * Nothing secret is stored here. Seller credentials live in the vault (a later module) as ciphertext only.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Version 1: accounts, listings, contract versions, double-entry ledger, executions, audit log. */
const V1 = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('buyer','seller','agent','platform')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO accounts (id, kind, display_name, created_at) VALUES ('platform', 'platform', 'Payrail', '1970-01-01T00:00:00.000Z');

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','verified','published','suspended','unpublished')),
  price_atomic INTEGER NOT NULL CHECK (price_atomic > 0),
  asset TEXT NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 300 CHECK (fee_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE contract_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  body_json TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','superseded')),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version)
) STRICT;

CREATE TABLE ledger_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('buyer_available','buyer_held','seller_earnings','platform_fee','external_funding')),
  asset TEXT NOT NULL,
  UNIQUE (owner_id, kind, asset)
) STRICT;

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  contract_version_id TEXT NOT NULL REFERENCES contract_versions(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('HELD','QUALIFIED','NOT_QUALIFIED','UNRESOLVED','RELEASED_UNRESOLVED')),
  price_atomic INTEGER NOT NULL CHECK (price_atomic > 0),
  asset TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_atomic INTEGER,
  seller_atomic INTEGER,
  reason TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (buyer_id, idempotency_key)
) STRICT;

CREATE TABLE ledger_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','hold','capture','release')),
  execution_id TEXT REFERENCES executions(id),
  ref TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, execution_id),
  UNIQUE (kind, ref)
) STRICT;

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id INTEGER NOT NULL REFERENCES ledger_transactions(id),
  account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  asset TEXT NOT NULL
) STRICT;
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);
CREATE INDEX ledger_entries_tx ON ledger_entries (tx_id);

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_tx_no_update BEFORE UPDATE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;
CREATE TRIGGER ledger_tx_no_delete BEFORE DELETE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  details_json TEXT
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

/** Version 2: seller credentials, stored ONLY as envelope-encrypted ciphertext (see vault.ts). */
const V2 = `
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  label TEXT NOT NULL,
  header_name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','rotated','revoked')),
  algorithm TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (listing_id, label, version)
) STRICT;
CREATE INDEX credentials_listing ON credentials (listing_id, status);
`;

/** Version 3: wallet sign-in, sessions, listing endpoint details, ownership challenges, seller test runs. */
const V3 = `
ALTER TABLE accounts ADD COLUMN wallet_address TEXT;
CREATE UNIQUE INDEX accounts_wallet ON accounts (wallet_address) WHERE wallet_address IS NOT NULL;
ALTER TABLE listings ADD COLUMN endpoint_url TEXT;
ALTER TABLE listings ADD COLUMN http_method TEXT NOT NULL DEFAULT 'GET';
ALTER TABLE listings ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN host TEXT;
ALTER TABLE listings ADD COLUMN verified_at TEXT;
CREATE TABLE login_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE TABLE ownership_challenges (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id),
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  wallet_signature TEXT,
  wallet_verified_at TEXT,
  domain_method TEXT CHECK (domain_method IN ('dns_txt','well_known')),
  domain_verified_at TEXT
) STRICT;
CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  created_at TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  elapsed_ms INTEGER,
  report_json TEXT NOT NULL
) STRICT;
CREATE TRIGGER contract_body_immutable BEFORE UPDATE OF body_json, body_hash, version, listing_id ON contract_versions BEGIN SELECT RAISE(ABORT, 'contract versions are immutable'); END;
CREATE TRIGGER contract_no_delete BEFORE DELETE ON contract_versions BEGIN SELECT RAISE(ABORT, 'contract versions cannot be deleted'); END;
`;

/** Version 4: platform-operated demo listings (served only by the in-process demo network, never the real internet). */
const V4 = `
ALTER TABLE listings ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'accounts, listings, contracts, ledger, executions, audit', sql: V1 },
  { version: 2, name: 'encrypted seller credentials', sql: V2 },
  { version: 3, name: 'sign-in, listing endpoints, ownership challenges, test runs', sql: V3 },
  { version: 4, name: 'demo listings flag', sql: V4 },
];

/** Open (creating the file and folder if needed) and bring the schema up to date. ':memory:' for tests. */
export function openDb(path: string = ':memory:', migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db, migrations);
  return db;
}

export function migrate(db: Db, migrations: readonly Migration[]): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;');
  const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    inTransaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    });
    applied.push(m.version);
  }
  return applied;
}

/** BEGIN IMMEDIATE ... COMMIT; ROLLBACK on any throw. Not re-entrant: callers must not nest it. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) throw new Error('inTransaction cannot be nested');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is the one that matters */
    }
    throw e;
  }
}

type Row = Record<string, string | bigint | null | Uint8Array>;

/** Run a SELECT returning rows whose integers are BigInt (amounts must never pass through a JS float). */
export function query<R extends Row = Row>(db: Db, sql: string, ...params: SQLInputValue[]): R[] {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  return st.all(...params) as R[];
}

export function queryOne<R extends Row = Row>(db: Db, sql: string, ...params: SQLInputValue[]): R | undefined {
  return query<R>(db, sql, ...params)[0];
}

export function audit(db: Db, actor: string, action: string, subject: string, details?: unknown, at: Date = new Date()): void {
  db.prepare('INSERT INTO audit_log (at, actor, action, subject, details_json) VALUES (?, ?, ?, ?, ?)').run(
    at.toISOString(),
    actor,
    action,
    subject,
    details === undefined ? null : JSON.stringify(details),
  );
}
