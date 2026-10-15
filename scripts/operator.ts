// Read-only operator report against a marketplace database. Changes nothing.
//   node scripts/operator.ts queue  [--db data/marketplace.db] [--failed]
//   node scripts/operator.ts inspect funding|payout <id> [--db ...]
//   node scripts/operator.ts reconcile [--db ...]
// Recovery actions (recheck, attach evidence, close without credit) live in src/operator.ts and re-verify from the chain;
// they are exercised by test/operator.test.ts and need a configured provider, so they are not exposed here.
import { openDb } from '../src/db.ts';
import { inspectItem, reconcile, reviewQueue } from '../src/operator.ts';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = openDb(flag('--db') ?? 'data/marketplace.db');
const [cmd, a, b] = args;
const show = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

if (cmd === 'queue') {
  const q = reviewQueue(db, { includeFailed: args.includes('--failed') });
  if (q.length === 0) console.log('Nothing needs attention.');
  for (const i of q) console.log(`[${i.category}] ${i.kind} ${i.id} ${i.simulated ? '(SIMULATED) ' : ''}${i.asset} expected ${i.expectedAtomic} :: ${i.reason}\n    actions: ${i.safeActions.join(', ') || 'none'}`);
} else if (cmd === 'inspect' && (a === 'funding' || a === 'payout') && b) {
  show(inspectItem(db, a, b));
} else if (cmd === 'reconcile') {
  const r = reconcile(db);
  show(r);
  process.exitCode = r.ok ? 0 : 2;
} else {
  console.log('usage: queue | inspect funding|payout <id> | reconcile   [--db path]');
  process.exitCode = 1;
}
