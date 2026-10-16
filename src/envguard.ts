// Keeps the two environments apart at the DATABASE level.
//   production  = scripts/serve.ts, real USDT on Celo mainnet, databases anywhere EXCEPT data/dev/
//   development = scripts/dev-serve.ts, test credits and sandbox APIs, databases ONLY inside data/dev/
// Each side checks the path AND (read-only, before any write) what the file already is, then production stamps its database so it can
// never be opened by the development server. A refused database is never modified.
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class EnvironmentError extends Error {}
export type Environment = 'production' | 'development';

export const DEV_DB_ROOT = 'data/dev';
const PRODUCTION_NAME = /marketplace-live/i;

const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/** read-only look at an existing file: its stamp, whether it holds verified on-chain deposits, and test-credit data */
export function probeDatabase(path: string): { exists: boolean; environment: Environment | null; onChainDeposits: number; testCreditEntries: number } {
  if (!existsSync(path)) return { exists: false, environment: null, onChainDeposits: 0, testCreditEntries: 0 };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = (t: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const env = has('app_meta') ? (db.prepare("SELECT value FROM app_meta WHERE key = 'environment'").get() as { value?: string } | undefined)?.value : undefined;
    const deposits = has('chain_deposits') ? Number((db.prepare('SELECT COUNT(*) AS n FROM chain_deposits').get() as { n: number | bigint }).n) : 0;
    const test = has('ledger_accounts') ? Number((db.prepare("SELECT COUNT(*) AS n FROM ledger_accounts WHERE asset = 'TESTUSDT'").get() as { n: number | bigint }).n) : 0;
    return { exists: true, environment: env === 'production' || env === 'development' ? env : null, onChainDeposits: deposits, testCreditEntries: test };
  } finally {
    db.close();
  }
}

/** The development server may only use a database file inside data/dev/ (or memory), and never one that is, or looks like, production. */
export function assertDevelopmentDatabase(path: string, devRoot: string = DEV_DB_ROOT): void {
  if (path === ':memory:') return;
  const abs = resolve(path);
  if (!inside(abs, resolve(devRoot))) throw new EnvironmentError(`the development server only uses databases inside ${devRoot}/ (got ${path}). It never opens the production database.`);
  if (PRODUCTION_NAME.test(basename(abs))) throw new EnvironmentError(`${basename(abs)} looks like a production database; the development server refuses it.`);
  const p = probeDatabase(abs);
  if (p.environment === 'production') throw new EnvironmentError(`${path} is stamped as a PRODUCTION database; the development server refuses it.`);
  if (p.onChainDeposits > 0) throw new EnvironmentError(`${path} holds verified on-chain deposits (real money records); the development server refuses it.`);
}

/** The production server never opens a development database or anything inside data/dev/. */
export function assertProductionDatabase(path: string, devRoot: string = DEV_DB_ROOT): void {
  if (path === ':memory:') throw new EnvironmentError('a production database must be a persistent file, not :memory:.');
  const abs = resolve(path);
  if (inside(abs, resolve(devRoot))) throw new EnvironmentError(`${path} is in a development location; the production server refuses it.`);
  const p = probeDatabase(abs);
  if (p.environment === 'development') throw new EnvironmentError(`${path} is stamped as a DEVELOPMENT database; the production server refuses it.`);
  if (p.testCreditEntries > 0 && p.environment !== 'production') throw new EnvironmentError(`${path} contains test-credit ledger accounts and was never used by production; the production server refuses it. Use a fresh file.`);
}

/** record the environment in an OPEN database (first writer wins; a different existing stamp is an error) */
export function stampEnvironment(db: DatabaseSync, env: Environment): void {
  const cur = db.prepare("SELECT value FROM app_meta WHERE key = 'environment'").get() as { value?: string } | undefined;
  if (cur?.value && cur.value !== env) throw new EnvironmentError(`this database is stamped '${cur.value}', not '${env}'.`);
  if (!cur?.value) db.prepare("INSERT INTO app_meta (key, value, set_at) VALUES ('environment', ?, ?)").run(env, new Date().toISOString());
}

