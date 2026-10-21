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
  /** true when the migration rebuilds tables that other tables reference: runs with foreign keys off, then re-checks them */
  rebuild?: boolean;
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

/** Version 5: payouts, on-chain deposits, funding wallets, agent keys. Rebuilds the ledger tables to allow the new kinds. */
const V5 = `
CREATE TABLE ledger_accounts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('buyer_available','buyer_held','seller_earnings','platform_fee','external_funding','payout_pending')),
  asset TEXT NOT NULL,
  UNIQUE (owner_id, kind, asset)
) STRICT;
INSERT INTO ledger_accounts_new (id, owner_id, kind, asset) SELECT id, owner_id, kind, asset FROM ledger_accounts;
DROP TABLE ledger_accounts;
ALTER TABLE ledger_accounts_new RENAME TO ledger_accounts;

DROP TRIGGER IF EXISTS ledger_tx_no_update;
DROP TRIGGER IF EXISTS ledger_tx_no_delete;
CREATE TABLE ledger_transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','hold','capture','release','payout_request','payout_confirm','payout_cancel')),
  execution_id TEXT REFERENCES executions(id),
  ref TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, execution_id),
  UNIQUE (kind, ref)
) STRICT;
INSERT INTO ledger_transactions_new (id, kind, execution_id, ref, memo, created_at) SELECT id, kind, execution_id, ref, memo, created_at FROM ledger_transactions;
DROP TABLE ledger_transactions;
ALTER TABLE ledger_transactions_new RENAME TO ledger_transactions;
CREATE TRIGGER ledger_tx_no_update BEFORE UPDATE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;
CREATE TRIGGER ledger_tx_no_delete BEFORE DELETE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;

CREATE TABLE funding_wallets (
  address TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  signature TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;
CREATE TABLE chain_deposits (
  ref TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  amount_atomic INTEGER NOT NULL CHECK (amount_atomic > 0),
  asset TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  credited_at TEXT NOT NULL
) STRICT;
CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL,
  amount_atomic INTEGER NOT NULL CHECK (amount_atomic > 0),
  destination TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','approved','sent','confirmed','cancelled','failed')),
  tx_hash TEXT,
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  settled_at TEXT,
  note TEXT
) STRICT;
CREATE INDEX payouts_seller ON payouts (seller_id, state);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  per_request_cap INTEGER NOT NULL CHECK (per_request_cap > 0),
  daily_cap INTEGER NOT NULL CHECK (daily_cap > 0),
  allowed_listings TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
ALTER TABLE executions ADD COLUMN agent_id TEXT;
`;

/** Version 6: how an execution is settled: the off-chain ledger (default) or the on-chain escrow contract. */
const V6 = `
ALTER TABLE executions ADD COLUMN settlement TEXT NOT NULL DEFAULT 'ledger' CHECK (settlement IN ('ledger','escrow'));
`;

/** Version 7: marketplace funding through the Textile conversion (cNGN -> USDT). Immutable event log + one-claim-per-tx table. */
const V7 = `
CREATE TABLE funding_ops (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('simulated','live')),
  state TEXT NOT NULL CHECK (state IN ('QUOTED','EXPIRED','CONVERTING','VERIFYING','CREDITED','FAILED','UNRESOLVED','REVIEW','CANCELLED')),
  sell_symbol TEXT NOT NULL,
  sell_atomic INTEGER NOT NULL CHECK (sell_atomic > 0),
  buy_symbol TEXT NOT NULL,
  expected_atomic INTEGER NOT NULL,
  min_atomic INTEGER NOT NULL,
  fee_atomic INTEGER NOT NULL,
  rate TEXT NOT NULL,
  provider TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  quote_expires_at TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  approved_at TEXT,
  credit_asset TEXT NOT NULL,
  received_atomic INTEGER,
  credited_atomic INTEGER,
  credit_ref TEXT,
  swap_tx TEXT,
  approve_txs TEXT,
  failure_code TEXT,
  failure_message TEXT,
  scenario TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (buyer_id, idempotency_key)
) STRICT;
CREATE INDEX funding_ops_buyer ON funding_ops (buyer_id, created_at);
CREATE TABLE funding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL REFERENCES funding_ops(id),
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL,
  detail_json TEXT
) STRICT;
CREATE TRIGGER funding_events_no_update BEFORE UPDATE ON funding_events BEGIN SELECT RAISE(ABORT, 'funding events are append-only'); END;
CREATE TRIGGER funding_events_no_delete BEFORE DELETE ON funding_events BEGIN SELECT RAISE(ABORT, 'funding events are append-only'); END;
CREATE TABLE funding_tx_claims (
  tx_hash TEXT PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES funding_ops(id),
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  claimed_at TEXT NOT NULL
) STRICT;
`;

/**
 * Version 8 (Stage 1 multi-currency): funding and payouts become asset-agnostic.
 * funding_ops is REBUILT so amounts that exceed 64 bits (18-decimal assets) are stored as text and the two-hop
 * (swap -> deposit) funding path has somewhere to record its second transaction.
 */
const V8 = `
CREATE TABLE funding_ops_new (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('simulated','live')),
  state TEXT NOT NULL CHECK (state IN ('QUOTED','EXPIRED','CONVERTING','VERIFYING','CREDITED','FAILED','UNRESOLVED','REVIEW','CANCELLED')),
  sell_symbol TEXT NOT NULL,
  sell_atomic TEXT NOT NULL,
  buy_symbol TEXT NOT NULL,
  expected_atomic INTEGER NOT NULL,
  min_atomic INTEGER NOT NULL,
  fee_atomic TEXT NOT NULL,
  rate TEXT NOT NULL,
  provider TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  quote_expires_at TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  approved_at TEXT,
  credit_asset TEXT NOT NULL,
  received_atomic INTEGER,
  credited_atomic INTEGER,
  credit_ref TEXT,
  swap_tx TEXT,
  approve_txs TEXT,
  failure_code TEXT,
  failure_message TEXT,
  scenario TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sell_decimals INTEGER NOT NULL DEFAULT 6,
  sell_chain_id INTEGER,
  sell_address TEXT,
  taker TEXT,
  deposit_tx TEXT,
  deposit_address TEXT,
  stage TEXT,
  UNIQUE (buyer_id, idempotency_key)
) STRICT;
INSERT INTO funding_ops_new (id, buyer_id, idempotency_key, mode, state, sell_symbol, sell_atomic, buy_symbol, expected_atomic, min_atomic, fee_atomic, rate, provider, quote_id, quote_expires_at, approval_digest, approved_at, credit_asset, received_atomic, credited_atomic, credit_ref, swap_tx, approve_txs, failure_code, failure_message, scenario, created_at, updated_at)
  SELECT id, buyer_id, idempotency_key, mode, state, sell_symbol, CAST(sell_atomic AS TEXT), buy_symbol, expected_atomic, min_atomic, CAST(fee_atomic AS TEXT), rate, provider, quote_id, quote_expires_at, approval_digest, approved_at, credit_asset, received_atomic, credited_atomic, credit_ref, swap_tx, approve_txs, failure_code, failure_message, scenario, created_at, updated_at FROM funding_ops;
DROP TABLE funding_ops;
ALTER TABLE funding_ops_new RENAME TO funding_ops;
CREATE INDEX funding_ops_buyer ON funding_ops (buyer_id, created_at);

CREATE TABLE conversion_assets (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  funding_enabled INTEGER NOT NULL DEFAULT 0,
  payout_enabled INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (chain_id, address)
) STRICT;

CREATE TABLE payout_addresses (
  seller_id TEXT NOT NULL REFERENCES accounts(id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (seller_id, chain_id, address),
  UNIQUE (chain_id, address)
) STRICT;

CREATE TABLE payout_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT,
  asset_chain_id INTEGER NOT NULL,
  asset_address TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  asset_decimals INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (seller_id, listing_id, version)
) STRICT;

ALTER TABLE payouts ADD COLUMN mode TEXT NOT NULL DEFAULT 'usdt';
ALTER TABLE payouts ADD COLUMN stage TEXT;
ALTER TABLE payouts ADD COLUMN target_symbol TEXT;
ALTER TABLE payouts ADD COLUMN target_chain_id INTEGER;
ALTER TABLE payouts ADD COLUMN target_address TEXT;
ALTER TABLE payouts ADD COLUMN target_decimals INTEGER;
ALTER TABLE payouts ADD COLUMN delivery_address TEXT;
ALTER TABLE payouts ADD COLUMN quote_id TEXT;
ALTER TABLE payouts ADD COLUMN quote_expires_at TEXT;
ALTER TABLE payouts ADD COLUMN approval_digest TEXT;
ALTER TABLE payouts ADD COLUMN expected_target TEXT;
ALTER TABLE payouts ADD COLUMN min_target TEXT;
ALTER TABLE payouts ADD COLUMN received_target TEXT;
ALTER TABLE payouts ADD COLUMN rate TEXT;
ALTER TABLE payouts ADD COLUMN fee_target TEXT;
ALTER TABLE payouts ADD COLUMN conversion_tx TEXT;
ALTER TABLE payouts ADD COLUMN delivery_tx TEXT;
ALTER TABLE payouts ADD COLUMN preference_version INTEGER;
ALTER TABLE payouts ADD COLUMN seller_confirmed_at TEXT;
ALTER TABLE payouts ADD COLUMN failure TEXT;
CREATE TABLE payout_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id TEXT NOT NULL REFERENCES payouts(id),
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  note TEXT NOT NULL
) STRICT;
CREATE TRIGGER payout_events_no_update BEFORE UPDATE ON payout_events BEGIN SELECT RAISE(ABORT, 'payout events are append-only'); END;
CREATE TRIGGER payout_events_no_delete BEFORE DELETE ON payout_events BEGIN SELECT RAISE(ABORT, 'payout events are append-only'); END;
`;

/** Version 9: a wallet may hold one account PER ROLE (buyer and seller), so wallet sign-in does not collide across roles. */
const V9 = `
CREATE TABLE account_wallets (
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('buyer','seller')),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet, kind)
) STRICT;
`;

/**
 * Version 10: every credited on-chain deposit records WHICH network and token contract it was verified on, who it was
 * sent to, how many confirmations had been seen when it was verified, and that verification succeeded. Old rows keep NULLs
 * (they were verified before these fields existed); nothing is rewritten.
 */
const V10 = `
ALTER TABLE chain_deposits ADD COLUMN chain_id INTEGER;
ALTER TABLE chain_deposits ADD COLUMN token TEXT;
ALTER TABLE chain_deposits ADD COLUMN to_address TEXT;
ALTER TABLE chain_deposits ADD COLUMN confirmations INTEGER;
ALTER TABLE chain_deposits ADD COLUMN verification TEXT;
`;

/**
 * Version 11: a database remembers which ENVIRONMENT it belongs to ('production' or 'development'). The production server stamps
 * 'production' and refuses a database stamped 'development'; the development server refuses anything stamped 'production'. See envguard.ts.
 */
const V11 = `
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at TEXT NOT NULL
) STRICT;
`;

/**
 * Version 12: purchases of Buy AI APIs paid DIRECTLY by the buyer's own wallet (x402 / EIP-3009), with no deposit wallet and no ledger.
 * One row per purchase with everything needed to audit it: who paid whom, which token and network, the exact authorization that was
 * signed, what the gateway answered, the independent settlement evidence, and the platform fee (due, and whether it was collected).
 */
const V12 = `
CREATE TABLE buy_orders (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  wallet TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_url TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  network TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  scheme TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  valid_before INTEGER NOT NULL,
  typed_data_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUOTED','SUBMITTED','CONFIRMED','FAILED','REVIEW','UNRESOLVED','EXPIRED')),
  failure TEXT,
  tx_hash TEXT,
  settlement_json TEXT,
  http_status INTEGER,
  response_body TEXT,
  response_sha256 TEXT,
  response_content_type TEXT,
  fee_bps INTEGER NOT NULL,
  fee_atomic TEXT NOT NULL,
  fee_state TEXT NOT NULL CHECK (fee_state IN ('not_collected','collected')),
  fee_tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX buy_orders_buyer ON buy_orders (buyer_id, created_at);
CREATE TABLE buy_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES buy_orders(id),
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL
) STRICT;
CREATE TRIGGER buy_order_events_no_update BEFORE UPDATE ON buy_order_events BEGIN SELECT RAISE(ABORT, 'buy order events are append-only'); END;
CREATE TRIGGER buy_order_events_no_delete BEFORE DELETE ON buy_order_events BEGIN SELECT RAISE(ABORT, 'buy order events are append-only'); END;
`;


/**
 * Version 13: conversions of a buyer's own currency (cNGN, ...) into the USDT a Buy AI purchase needs, done by Textile with the buyer's
 * own wallet as taker. Output lands in the buyer's wallet; nothing is credited anywhere. A conversion is only CONFIRMED from the receipt.
 * A Buy order may reference the conversion that funded it.
 */
const V13 = `
CREATE TABLE buy_conversions (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  wallet TEXT NOT NULL,
  provider TEXT NOT NULL,
  sell_symbol TEXT NOT NULL,
  sell_address TEXT NOT NULL,
  sell_decimals INTEGER NOT NULL,
  sell_atomic TEXT NOT NULL,
  target_atomic TEXT NOT NULL,
  expected_atomic TEXT NOT NULL,
  min_atomic TEXT NOT NULL,
  fee_atomic TEXT NOT NULL,
  rate TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  quote_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUOTED','PREPARED','SUBMITTED','CONFIRMED','FAILED','REVIEW','EXPIRED')),
  failure TEXT,
  approve_txs TEXT NOT NULL DEFAULT '[]',
  swap_tx TEXT UNIQUE,
  received_atomic TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX buy_conversions_buyer ON buy_conversions (buyer_id, created_at);
CREATE TABLE buy_conversion_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversion_id TEXT NOT NULL REFERENCES buy_conversions(id),
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL
) STRICT;
CREATE TRIGGER buy_conversion_events_no_update BEFORE UPDATE ON buy_conversion_events BEGIN SELECT RAISE(ABORT, 'conversion events are append-only'); END;
CREATE TRIGGER buy_conversion_events_no_delete BEFORE DELETE ON buy_conversion_events BEGIN SELECT RAISE(ABORT, 'conversion events are append-only'); END;
ALTER TABLE buy_orders ADD COLUMN conversion_id TEXT;
`;

/**
 * Version 14: a listing may be priced in another currency (one Textile can convert). The ORIGINAL price and currency are kept; price_atomic stays the
 * USDT amount the marketplace bills, normalised from a Textile quote whose rate and time are recorded. NULL price_currency = priced in USDT directly.
 */
const V14 = `
ALTER TABLE listings ADD COLUMN price_currency TEXT;
ALTER TABLE listings ADD COLUMN price_decimals INTEGER;
ALTER TABLE listings ADD COLUMN price_amount_atomic TEXT;
ALTER TABLE listings ADD COLUMN price_rate TEXT;
ALTER TABLE listings ADD COLUMN price_quoted_at TEXT;
ALTER TABLE listings ADD COLUMN price_source TEXT;
`;

/**
 * Version 15: checkout of SELLER-LISTED APIs. One row per purchase attempt: the authoritative price frozen from the listing, the request input,
 * the conversion and deposit transactions that funded it, and the execution (ledger) that settled it. Events are append-only.
 */
const V15 = `
CREATE TABLE listing_checkouts (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES accounts(id),
  wallet TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  seller_id TEXT NOT NULL,
  price_atomic TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  listed_json TEXT,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUOTED','RUNNING','CHARGED','NOT_CHARGED','UNRESOLVED','EXPIRED')),
  conversion_id TEXT,
  deposit_txs TEXT NOT NULL DEFAULT '[]',
  execution_id TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX listing_checkouts_buyer ON listing_checkouts (buyer_id, created_at);
CREATE TABLE listing_checkout_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_id TEXT NOT NULL REFERENCES listing_checkouts(id),
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL
) STRICT;
CREATE TRIGGER listing_checkout_events_no_update BEFORE UPDATE ON listing_checkout_events BEGIN SELECT RAISE(ABORT, 'checkout events are append-only'); END;
CREATE TRIGGER listing_checkout_events_no_delete BEFORE DELETE ON listing_checkout_events BEGIN SELECT RAISE(ABORT, 'checkout events are append-only'); END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'accounts, listings, contracts, ledger, executions, audit', sql: V1 },
  { version: 2, name: 'encrypted seller credentials', sql: V2 },
  { version: 3, name: 'sign-in, listing endpoints, ownership challenges, test runs', sql: V3 },
  { version: 4, name: 'demo listings flag', sql: V4 },
  { version: 5, name: 'payouts, chain deposits, funding wallets, agents', sql: V5, rebuild: true },
  { version: 6, name: 'execution settlement mode', sql: V6 },
  { version: 7, name: 'marketplace funding operations', sql: V7 },
  { version: 8, name: 'multi-currency funding and payout conversion (stage 1)', sql: V8, rebuild: true },
  { version: 9, name: 'per-role wallet accounts (buyer wallet sign-in)', sql: V9 },
  { version: 10, name: 'deposit records carry network, token, recipient, confirmations and verification', sql: V10 },
  { version: 11, name: 'database environment marker (production / development)', sql: V11 },
  { version: 12, name: 'direct Buy AI purchases paid by the buyer wallet (orders and events)', sql: V12 },
  { version: 13, name: 'buyer-wallet currency conversions that fund Buy AI purchases', sql: V13 },
  { version: 14, name: 'listing prices in other currencies (original price kept, USDT price normalised from a Textile quote)', sql: V14 },
  { version: 15, name: 'checkout of seller-listed APIs (authoritative price, funding transactions, execution link)', sql: V15 },
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
    if (m.rebuild) db.exec('PRAGMA foreign_keys = OFF;');
    try {
      inTransaction(db, () => {
        db.exec(m.sql);
        if (m.rebuild) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) throw new Error(`migration ${m.version} left ${broken.length} broken foreign key(s)`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      });
    } finally {
      if (m.rebuild) db.exec('PRAGMA foreign_keys = ON;');
    }
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
