// Read-only: which currency conversions are LIVE right now (Textile FX price ladder)?
//   node scripts/routes.ts [--from USDT] [--to cNGN]
// A ladder is indicative: it is not a firm quote and reserves nothing.
import { formatUnits } from 'viem';
import { ASSETS, assetByAddress } from '../src/assets.ts';
import { getLadder } from '../src/textile.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = opt('from');
const to = opt('to');

const { asOf, pairs } = await getLadder(42220);
console.log(`Textile FX ladder, chain 42220, as of ${asOf ?? 'unknown'}: ${pairs.length} pairs listed\n`);
console.log('route              status      min sell        receive at min     depth (max sell)       rate at min');
let shown = 0;
for (const p of pairs) {
  const s = assetByAddress(p.sellToken);
  const b = assetByAddress(p.buyToken);
  const label = `${s?.symbol ?? p.sellToken.slice(0, 8)} -> ${b?.symbol ?? p.buyToken.slice(0, 8)}`;
  if (from && s?.symbol !== from) continue;
  if (to && b?.symbol !== to) continue;
  if (!s || !b) {
    if (!from && !to) console.log(`${label.padEnd(18)} (unrecognised token, ignored)`);
    continue;
  }
  shown += 1;
  const first = p.levels[0];
  if (!first) {
    console.log(`${label.padEnd(18)} NO LIQUIDITY (listed but no price levels)`);
    continue;
  }
  const sell = Number(formatUnits(first.sellAmount, s.decimals));
  const buy = Number(formatUnits(first.buyAmount, b.decimals));
  console.log(
    `${label.padEnd(18)} live        ${formatUnits(p.minSellAmount, s.decimals).padEnd(15)} ${formatUnits(first.buyAmount, b.decimals).padEnd(18)} ${formatUnits(p.maxSellAmount, s.decimals).padEnd(22)} ${(buy / sell).toPrecision(6)} ${b.symbol}/${s.symbol}`,
  );
}
if (shown === 0) console.log('(no matching recognised routes)');
void ASSETS;
console.log('\nindicative only: no quote was requested and nothing was reserved.');
