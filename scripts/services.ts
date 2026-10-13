// Read-only: list and search the Buy service catalog. Pays nothing, signs nothing.
//   node scripts/services.ts [--query text] [--platform x] [--available] [--max-price-usd 0.01] [--limit 20] [--refresh]
import { formatUnits } from 'viem';
import { createCatalogClient, searchServices } from '../src/catalog.ts';
import { assessService, DEFAULT_POLICY, policyFromEnv } from '../src/policy.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

const policy = policyFromEnv(process.env, DEFAULT_POLICY);
let catalog;
try {
  catalog = await createCatalogClient().get({ forceRefresh: flag('refresh') });
} catch (e) {
  console.log(`[STOP] the service catalog is unavailable (${e instanceof Error ? e.message : String(e)}).`);
  process.exit(4);
}

console.log(`catalog: ${catalog.services.length} services, ${catalog.rejected.length} entries rejected as malformed${catalog.stale ? ' (STALE copy)' : ''}`);
console.log(`payment: x402 v${catalog.payment.x402Version} on ${catalog.payment.network} (chain ${catalog.payment.chainId}); tokens: ${catalog.payment.tokens.map((t) => t.symbol).join(', ')}`);
console.log('NOTE: catalog prices are INDICATIVE. The real price is the HTTP 402 challenge, read at plan time.\n');

const maxUsd = opt('max-price-usd');
const found = searchServices(catalog.services, {
  ...(opt('query') ? { query: opt('query')! } : {}),
  ...(opt('platform') ? { platform: opt('platform')! } : {}),
  availableOnly: flag('available'),
  ...(maxUsd ? { maxPriceAtomic: BigInt(Math.round(Number(maxUsd) * 1_000_000)) } : {}),
});
const limit = Number(opt('limit') ?? 20);
console.log(`${found.length} match(es); showing ${Math.min(limit, found.length)}:\n`);
for (const s of found.slice(0, limit)) {
  const a = assessService(s, policy);
  const price = s.price
    ? s.price.minAtomic === s.price.maxAtomic
      ? `~${formatUnits(s.price.minAtomic, 6)}`
      : `~${formatUnits(s.price.minAtomic, 6)}..${formatUnits(s.price.maxAtomic, 6)}`
    : 'n/a';
  const safety = !a.contactable ? 'BLOCKED' : a.autoPayable ? 'auto-pay' : 'needs approval';
  console.log(`${s.id.padEnd(58)} ${s.platform.padEnd(10)} ${price.padEnd(18)} ${s.available ? 'available  ' : 'unavailable'} ${safety}`);
}
if (catalog.rejected.length > 0) {
  console.log(`\nrejected entries (first 5): ${catalog.rejected.slice(0, 5).map((r) => `${r.id ?? '#' + r.index}: ${r.reason}`).join('; ')}`);
}
