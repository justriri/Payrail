// Operator report: platform-wide gross, fees, seller earnings, refunds, open holds and payouts, plus the ledger check.
//   node scripts/ledger-report.ts --db data/marketplace.db
import { openDb } from '../src/db.ts';
import { verifyLedger } from '../src/ledger.ts';
import { platformStatement } from '../src/billing.ts';

const i = process.argv.indexOf('--db');
const db = openDb(i >= 0 ? process.argv[i + 1]! : 'data/marketplace.db');
const s = platformStatement(db);
console.log('Platform statement (atomic units, 6 decimals)');
for (const b of s.buckets) {
  console.log(`\n[${b.settlement}] ${b.asset}: ${b.requests} requests (${b.qualified} qualified, ${b.notCharged} not charged, ${b.unresolvedOpen} unresolved, ${b.releasedUnresolved} released)`);
  console.log(`  gross ${b.gross.display}  fees ${b.platformFees.display}  seller earnings ${b.sellerEarnings.display}  refunded ${b.refunded.display}  held ${b.heldOpen.display}`);
}
for (const f of s.feesCollected) console.log(`\nPlatform fees on the ledger: ${f.display} ${f.asset}`);
for (const p of s.openPayouts) console.log(`Open payouts: ${p.display} ${p.asset}`);
const v = verifyLedger(db);
console.log(v.ok ? '\nLedger check: sound.' : `\nLedger check FAILED:\n  ${v.problems.join('\n  ')}`);
process.exit(v.ok ? 0 : 1);
