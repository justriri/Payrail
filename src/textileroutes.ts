// READ-ONLY Textile route discovery and indicative quotes (public, keyless endpoints):
//   GET  /v2/rfq/levels?chainId=...   the price ladder (which pairs have makers, and at what sizes)
//   POST /v2/rfq/preview              an indicative price
// This provider can NOT execute anything: it has no signer, requests no firm quote, and reserves no liquidity.
// Everything it reports is "live-quoted" evidence at a stated time, never a promise of liquidity later.
import { getLadder, preview } from './textile.ts';
import type { LadderPair, PreviewResult } from './textile.ts';
import { assetByAddress } from './assets.ts';
import { CELO_CHAIN_ID, USDT_CELO } from './conversion.ts';
import type { AssetRef, ConversionProvider, ConversionQuote, Direction, Route } from './conversion.ts';

export interface TextileRouteDeps {
  getLadder?: (chainId: number) => Promise<{ asOf: string | undefined; pairs: LadderPair[] }>;
  preview?: (a: { chainId: number; sellToken: `0x${string}`; buyToken: `0x${string}`; sellAmount: bigint }) => Promise<PreviewResult>;
  now?: () => number;
  chainId?: number;
}

export interface LiveRoute extends Route {
  asOf: string;
}

export function createTextileRouteProvider(deps: TextileRouteDeps = {}): ConversionProvider & { discover(direction: Direction): Promise<{ asOf: string; routes: LiveRoute[] }> } {
  const ladder = deps.getLadder ?? getLadder;
  const prev = deps.preview ?? preview;
  const now = deps.now ?? Date.now;
  const chainId = deps.chainId ?? CELO_CHAIN_ID;
  const usdt = USDT_CELO.address.toLowerCase();

  const ref = (addr: string): AssetRef | undefined => {
    const a = assetByAddress(addr as `0x${string}`);
    return a ? { chainId, address: a.address, symbol: a.symbol, decimals: a.decimals } : undefined;
  };

  async function discover(direction: Direction): Promise<{ asOf: string; routes: LiveRoute[] }> {
    const l = await ladder(chainId);
    const asOf = l.asOf ?? new Date(now()).toISOString();
    const routes: LiveRoute[] = [];
    for (const p of l.pairs) {
      // funding: X -> USDT ; payout: USDT -> X. The two directions are separate entries on the ladder.
      const sell = p.sellToken.toLowerCase();
      const buy = p.buyToken.toLowerCase();
      const wanted = direction === 'funding' ? buy === usdt && sell !== usdt : sell === usdt && buy !== usdt;
      if (!wanted) continue;
      const other = ref(direction === 'funding' ? sell : buy);
      if (!other) continue; // an address we cannot name or size is not offered
      const from = direction === 'funding' ? other : USDT_CELO;
      const to = direction === 'funding' ? USDT_CELO : other;
      const lv = p.levels;
      let available = lv.length > 0;
      let reason: 'no_levels' | 'no_makers_online' = 'no_levels';
      let minIn = available ? lv[0]!.sellAmount : 0n;
      let maxIn = available ? lv[lv.length - 1]!.sellAmount : 0n;
      if (!available && p.minSellAmount > 0n && direction === 'funding') {
        // An empty ladder entry is not proof that nothing can be bought: ask Textile for a price at the pair's own minimum. A usable
        // price means the route works (the ladder is only a summary); a refusal gives the real reason (for example no_makers_online).
        try {
          const probe = await prev({ chainId, sellToken: p.sellToken, buyToken: p.buyToken, sellAmount: p.minSellAmount });
          if (probe.kind === 'preview' && probe.buyAmount > 0n) {
            available = true;
            minIn = p.minSellAmount;
            maxIn = probe.availableSellAmount ?? p.minSellAmount;
          } else if (probe.kind === 'no_quote' && probe.reason === 'no_makers_online') reason = 'no_makers_online';
        } catch { /* the probe could not be made: stay unavailable with the ladder's own reason */ }
      }
      routes.push({
        provider: 'textile-rfq (live ladder, read-only)',
        direction,
        from,
        to,
        available,
        ...(available ? {} : { unavailableReason: reason }),
        minInputAtomic: available ? minIn : p.minSellAmount,
        maxInputAtomic: available ? maxIn : 0n,
        discoveredAt: now(),
        asOf,
      });
    }
    return { asOf, routes };
  }

  return {
    id: 'textile-rfq (live ladder, read-only)',
    simulated: false,
    discover,
    async discoverRoutes(direction) {
      return (await discover(direction)).routes;
    },
    async quote({ direction, from, to, inputAtomic }): Promise<ConversionQuote> {
      const r = await prev({ chainId, sellToken: from.address as `0x${string}`, buyToken: to.address as `0x${string}`, sellAmount: inputAtomic });
      if (r.kind !== 'preview') throw new Error(`no quote: ${r.reason ?? 'no_quote'}`);
      // sanity: an indicative quote must be internally consistent or it is refused rather than shown
      if (r.buyAmount <= 0n) throw new Error('the provider returned a zero output');
      if (r.feeAmount < 0n || r.feeAmount > r.sellAmount) throw new Error('the provider returned an implausible fee');
      if (r.takerPays > inputAtomic) throw new Error('the provider would debit more than the requested amount');
      const expected = r.buyAmount;
      const min = expected - (expected * 100n) / 10_000n; // 100 bps tolerance, matching the swap bounds
      return {
        id: `prev_${r.requestId ?? now()}`,
        provider: 'textile-rfq (live ladder, read-only)',
        direction,
        from,
        to,
        inputAtomic,
        expectedOutputAtomic: expected,
        minOutputAtomic: min,
        feeAtomic: r.feeAmount,
        rate: r.rateRay ?? 'n/a',
        expiresAtMs: now() + 60_000,
        notes: ['INDICATIVE preview: not a firm quote, reserves no liquidity, and cannot be executed by this server.'],
      };
    },
  };
}
