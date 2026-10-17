// READ-ONLY per-route verification of the Textile -> USDT routes Payrail offers for Buy purchases.
// For each enabled currency it checks, against Celo mainnet and Textile's public API:
//   - contract code, symbol and decimals match the registry
//   - approve(reactor, amount) simulates cleanly (eth_call, no signature, no transaction), untagged AND with the attribution suffix,
//     with identical results, plus an eth_estimateGas figure for the approval
//   - the current allowance of a fresh wallet is 0 (so no allowance reset step is needed)
//   - an indicative Textile preview at the smallest swap and at 3x: output, fee in bps (a firm quote above 100 bps would be REFUSED by Payrail), minimum guaranteed output
//   - Textile's OpenAPI still has the firm-quote endpoint Payrail calls
// It cannot request a firm quote (that needs a wallet signature and reserves maker inventory) or run a swap: those remain live tests.
//   node scripts/buy-routes-verify.ts
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import { withTag } from '../src/attribution.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { USDT_CELO } from '../src/conversion.ts';
import { preview, TEXTILE_API } from '../src/textile.ts';

const TAG = 'celo_b2fff2ac9413';
const SYMBOLS = ['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT', 'IDRX', 'wCOP', 'WETH', 'wMXN'];
const client = createPublicClient({ transport: http('https://forno.celo.org') });
const probe = '0x00000000000000000000000000000000000000c1' as const; // a throwaway address: nothing is signed or sent
let bad = 0;
const line = (...p: unknown[]) => console.log(p.join(' | '));

line(`Textile route verification at ${new Date().toISOString()} (read-only)`);
try {
  const spec = (await (await fetch(`${TEXTILE_API}/openapi.json`)).json()) as { paths?: Record<string, any> };
  const rp = spec.paths?.['/rfq/request']?.post;
  line('OpenAPI /rfq/request (firm quote)', rp ? 'present' : 'MISSING');
  if (!rp) bad++;
} catch (e) { line('OpenAPI', `could not be read: ${(e as Error).message.slice(0, 80)}`); bad++; }

for (const sym of SYMBOLS) {
  const a = assetBySymbol(sym)!;
  const out: string[] = [sym.padEnd(5)];
  try {
    const [code, dec, symbol, allowance] = await Promise.all([
      client.getCode({ address: a.address }),
      client.readContract({ address: a.address, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: a.address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: a.address, abi: erc20Abi, functionName: 'allowance', args: [probe, TEXTILE_REACTOR] }),
    ]);
    const okMeta = Boolean(code && code !== '0x') && dec === a.decimals && symbol === a.symbol;
    out.push(`contract ${okMeta ? 'OK' : 'MISMATCH'} (${symbol}, ${dec} dec)`, `fresh allowance ${allowance}`);
    if (!okMeta || allowance !== 0n) bad++;
    const amount = 10n ** BigInt(a.decimals);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEXTILE_REACTOR, amount] });
    const tagged = withTag(data, TAG);
    const [r1, r2, gas] = await Promise.all([
      client.call({ account: probe, to: a.address, data }),
      client.call({ account: probe, to: a.address, data: tagged }),
      client.estimateGas({ account: probe, to: a.address, data }),
    ]);
    const same = r1.data === r2.data;
    out.push(`approve simulates ${r1.data === `0x${'0'.repeat(63)}1` ? 'true' : String(r1.data)} (tagged ${same ? 'identical' : 'DIFFERENT'})`, `approve gas ~${gas}`);
    if (!same || r1.data !== `0x${'0'.repeat(63)}1`) bad++;
    // indicative preview at the smallest swap Textile allows, then 3x
    const lad = (await (await fetch(`${TEXTILE_API}/rfq/levels?chainId=42220`)).json()) as any;
    const pairs = (lad.data ?? lad).pairs as Array<{ sellToken: string; buyToken: string; levels?: Array<{ sellAmount: string }> }>;
    const pair = pairs.find((p) => p.sellToken.toLowerCase() === a.address.toLowerCase() && p.buyToken.toLowerCase() === USDT_CELO.address.toLowerCase());
    const min = pair?.levels?.[0]?.sellAmount ? BigInt(pair.levels[0].sellAmount) : undefined;
    if (!min) { out.push('NO LIVE LEVELS'); bad++; } else {
      for (const mult of [1n, 3n]) {
        const r = await preview({ chainId: 42220, sellToken: a.address, buyToken: USDT_CELO.address as `0x${string}`, sellAmount: min * mult });
        if (r.kind !== 'preview') { out.push(`preview x${mult}: ${r.reason ?? 'no quote'}`); bad++; continue; }
        const feeBps = Number((r.feeAmount * 1_000_000n) / r.takerPays) / 100; // the fee is in SELL-token units, as Payrail's firm-quote check assumes
        const flag = feeBps > 100 ? ' FEE ABOVE PAYRAIL LIMIT (100 bps)' : '';
        if (feeBps > 100) bad++;
        out.push(`x${mult}: sell ${formatUnits(r.sellAmount, a.decimals)} -> ${formatUnits(r.buyAmount, 6)} USDT, min ${formatUnits(r.buyAmount - r.buyAmount / 100n, 6)}, fee ${feeBps.toFixed(2)} bps${flag}`);
      }
    }
  } catch (e) { out.push(`ERROR ${(e as Error).message.slice(0, 120)}`); bad++; }
  line(...out);
}
line(bad === 0 ? 'ALL READ-ONLY CHECKS PASSED' : `${bad} CHECK(S) FAILED`, '(no firm quote, no signature, no transaction was made)');
process.exit(bad === 0 ? 0 : 1);
