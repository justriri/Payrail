// READ-ONLY route matrix. Reads Textile's public ladder and indicative previews (no keys, no firm quote, nothing signed)
// and writes docs/ROUTE-MATRIX.md, labelling each route with how we know it.
//   node scripts/route-matrix.ts            prints the matrix and writes the doc
//   node scripts/route-matrix.ts --no-write prints only
import { writeFileSync } from 'node:fs';
import { formatUnits } from 'viem';
import { CELO_CHAIN_ID, USDT_CELO } from '../src/conversion.ts';
import type { AssetRef, Direction } from '../src/conversion.ts';
import { evidenceFor, DOCUMENTED_ON_CELO } from '../src/routeevidence.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';

const provider = createTextileRouteProvider();
const write = !process.argv.includes('--no-write');
const rows: string[][] = [];

async function one(direction: Direction): Promise<string> {
  const { asOf, routes } = await provider.discover(direction);
  for (const r of routes) {
    const a: AssetRef = direction === 'funding' ? r.from : r.to;
    const ev = evidenceFor(direction, a.symbol, { providerSimulated: false, liveAsOf: r.asOf, liveAvailable: r.available });
    // one indicative preview at about the lower bound x3 (read-only; reserves nothing)
    let preview = 'n/a';
    if (r.available) {
      try {
        const input = r.minInputAtomic * 3n > r.maxInputAtomic ? r.minInputAtomic : r.minInputAtomic * 3n;
        const q = await provider.quote({ direction, from: r.from, to: r.to, inputAtomic: input });
        preview = `${formatUnits(input, r.from.decimals)} ${r.from.symbol} -> ${formatUnits(q.expectedOutputAtomic, r.to.decimals)} ${r.to.symbol} (fee ${formatUnits(q.feeAtomic, direction === 'funding' ? r.from.decimals : r.to.decimals)})`;
      } catch (e) {
        preview = `no quote: ${(e as Error).message.slice(0, 40)}`;
      }
    }
    rows.push([
      direction,
      `${r.from.symbol} -> ${r.to.symbol}`,
      a.address,
      String(a.decimals),
      r.available ? 'makers quoting' : `unavailable (${r.unavailableReason})`,
      r.available ? `${formatUnits(r.minInputAtomic, r.from.decimals)} .. ${formatUnits(r.maxInputAtomic, r.from.decimals)} ${r.from.symbol}` : '-',
      preview,
      DOCUMENTED_ON_CELO.has(a.symbol) ? 'yes' : 'no',
      ev.level + (ev.txs ? ` (${ev.txs.map((t) => t.slice(0, 10)).join(',')})` : ''),
    ]);
  }
  return asOf;
}

const asOfF = await one('funding');
const asOfP = await one('payout');
const header = ['direction', 'route', 'asset contract (Celo 42220)', 'dec', 'status when read', 'ladder min .. max', 'indicative preview', 'in address book', 'evidence'];
const md = [
  '# Textile route matrix (Celo mainnet, chain 42220)',
  '',
  `Generated ${new Date().toISOString()} by \`scripts/route-matrix.ts\`. **Read-only**: public ladder (as of ${asOfF}) and indicative previews. No firm quote was requested, nothing was signed, nothing was executed.`,
  '',
  'Evidence levels: **live-executed** = our own code executed it on mainnet (tx shown); **live-quoted** = the provider ladder showed makers when read (indicative, not current liquidity, not executed); **documented** = listed in the address book; **simulated** = only our simulation offers it.',
  '',
  `A route in one direction says nothing about the other. USDT address: ${USDT_CELO.address}. Chain: ${CELO_CHAIN_ID}.`,
  '',
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
  '',
  'The ladder also lists tokens that are not in the Payrail asset registry (for example CELO, WETH, wCOP, wMXN, G$ when present); they are deliberately not offered here because this server cannot name or size them.',
  '',
  'Not executable from this server today: live funding and live payouts are not wired (they need buyer-wallet signing and a bounded custody signer). CWT does not appear on any ladder and is not offered.',
  '',
].join('\n');
console.log(md);
if (write) {
  writeFileSync('docs/ROUTE-MATRIX.md', md, 'utf8');
  console.log('\nWrote docs/ROUTE-MATRIX.md');
}
void asOfP;
process.exit(0);
