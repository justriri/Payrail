// READ-ONLY audit of an existing marketplace database for LEGACY demo / test-credit / sandbox data.
//   node scripts/audit-legacy-data.ts data/marketplace-live.db
// It opens the file read-only (no migration, no write) and reports what is there, so you can decide about cleanup.
// Production already hides and refuses this data; nothing is deleted by this script or by the server.
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) {
  console.log('usage: node scripts/audit-legacy-data.ts <marketplace.db>');
  process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
const one = (sql: string, ...p: Array<string | number>): Record<string, unknown> => (db.prepare(sql).get(...p) as Record<string, unknown>) ?? {};
const all = (sql: string): Array<Record<string, unknown>> => db.prepare(sql).all() as Array<Record<string, unknown>>;
const has = (t: string) => Boolean(one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t).name);
const out: Record<string, unknown> = { file: path };

if (has('listings')) {
  out.demoListings = all("SELECT id, name, status FROM listings WHERE demo = 1");
  out.testCreditListings = all("SELECT id, name, status, asset FROM listings WHERE asset <> 'USDT' AND demo = 0");
  out.sandboxHostListings = all("SELECT id, name, host FROM listings WHERE host LIKE '%.sandbox.payrail.example'");
  out.realListings = all("SELECT id, name, status FROM listings WHERE demo = 0 AND asset = 'USDT' AND host NOT LIKE '%.sandbox.payrail.example'");
}
if (has('ledger_accounts')) {
  out.testCreditBalances = all("SELECT a.kind, a.asset, SUM(e.amount) AS total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.asset = 'TESTUSDT' GROUP BY a.kind, a.asset");
  out.realUsdtBalances = all("SELECT a.kind, a.asset, SUM(e.amount) AS total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.asset = 'USDT' GROUP BY a.kind, a.asset");
}
if (has('chain_deposits')) out.verifiedOnChainDeposits = one('SELECT COUNT(*) AS n, COALESCE(SUM(amount_atomic), 0) AS atomic FROM chain_deposits');
if (has('executions')) out.executionsByAsset = all('SELECT l.asset, e.state, COUNT(*) AS n FROM executions e JOIN listings l ON l.id = e.listing_id GROUP BY l.asset, e.state');
if (has('accounts')) out.sandboxAccounts = all("SELECT id, kind, display_name FROM accounts WHERE display_name LIKE 'Sandbox%' OR display_name LIKE 'Test buyer%' OR id = 'seller_demo'");
if (has('funding_ops')) out.simulatedFundingOps = one("SELECT COUNT(*) AS n FROM funding_ops WHERE mode = 'simulated'");
if (has('payouts')) out.simulatedPayouts = one("SELECT COUNT(*) AS n FROM payouts WHERE mode LIKE '%simulated%'");
console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log('\nNothing was changed. Production hides and refuses all of the above; deleting it is optional and needs your approval.');
