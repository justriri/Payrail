// READ-ONLY check of the Textile -> USDT routes Payrail offers for paying Buy APIs, against Textile's LIVE public API.
// It runs the production currency-listing code (src/buyconvert.ts) over the live ladder and indicative previews.
// No firm quote is requested (that needs a wallet signature and reserves maker inventory), nothing is signed or sent.
//   node scripts/buy-routes-check.ts [--max-usd 2]
import { formatUnits } from 'viem';
import { createBuyConvert } from '../src/buyconvert.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';
import { createOfficialCorridors } from '../src/textiledocs.ts';

const i = process.argv.indexOf('--max-usd');
const maxUsd = i > 0 ? Number(process.argv[i + 1]) : 2;
const db = openDb(':memory:');
seedConversionAssets(db);
const provider = createTextileRouteProvider();
const bc = createBuyConvert({
  db, registry: new RouteRegistry(db, [provider]), provider, buyerSwap: { converterFor: () => { throw new Error('unused'); }, prepare: async () => { throw new Error('unused'); } },
  reader: { blockNumber: async () => 0n, receipt: async () => null }, usdt: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 1,
  maxUsdtAtomic: BigInt(Math.round(maxUsd * 1e6)),
  officialCorridors: createOfficialCorridors(),
});
const list = await bc.currencies();
console.log(`Textile live check at ${new Date().toISOString()} (per-conversion limit ${maxUsd} USDT)`);
for (const c of list) {
  console.log([c.symbol.padEnd(5), c.address, `dec ${c.decimals}`, c.statusLabel.toUpperCase(), `min swap ${c.minSell ?? '-'} (${c.minUsdt ?? '-'} USDT)`, `max ${c.maxSell ?? '-'}`, `evidence ${c.evidence.level}`, c.reason ? `reason: ${c.reason}` : ''].join(' | '));
}
void formatUnits;
