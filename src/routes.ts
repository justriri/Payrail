// Currency-conversion route discovery.
//
// A route is only reported when the provider's LIVE ladder and a preview support it right now.
// Nothing here is hardcoded as "available". Every route is an INDICATIVE PREVIEW: it is not a firm
// quote, reserves nothing, and cannot be executed until a firm quote is obtained (separate step).
import type { Address } from 'viem';
import type { Asset } from './assets.ts';
import { getPairLevel, preview } from './textile.ts';
import type { PairLevel, PreviewResult } from './textile.ts';

export type RouteFailureCode =
  | 'CORRIDOR_UNAVAILABLE' // pair not listed or no liquidity on the live ladder
  | 'NO_LIQUIDITY' // listed, but the provider declined to price it
  | 'BELOW_MINIMUM' // wallet holds less than the corridor minimum
  | 'EXCEEDS_BALANCE' // the amount needed is more than the wallet holds
  | 'INSUFFICIENT_DEPTH' // not enough depth to deliver the amount
  | 'PROVIDER_ERROR';

export interface RouteRequest {
  chainId: number;
  sell: Asset;
  buy: Asset;
  /** The conversion must deliver at least this much of `buy` (atomic units). */
  minBuyAmount: bigint;
  /** Never plan to sell more than the wallet holds. */
  maxSellAmount: bigint;
}

export type RouteResult =
  | {
      kind: 'route';
      provider: string;
      quoteState: 'preview';
      sell: Asset;
      buy: Asset;
      sellAmount: bigint;
      buyAmount: bigint;
      feeAmount: bigint;
      takerPays: bigint;
      minSellAmount: bigint;
      availableSellAmount: bigint | undefined;
      fetchedAt: number;
      /** Contract the sell token must be approved to. Defaults to the Textile reactor when absent. */
      spender?: Address;
      /** Anything the provider could not state precisely (e.g. fees embedded in the rate). */
      note?: string;
    }
  | {
      kind: 'none';
      provider: string;
      code: RouteFailureCode;
      message: string;
      sell: Asset;
      buy: Asset;
      minSellAmount?: bigint;
      neededSellAmount?: bigint;
    };

export interface RouteProvider {
  readonly name: string;
  /** Find a route that delivers at least `minBuyAmount` (used when paying a service). */
  findRoute(req: RouteRequest): Promise<RouteResult>;
  /** Price converting EXACTLY `sellAmount` (used for standalone conversions / top-ups). Indicative only. */
  quoteExactInput?(req: { chainId: number; sell: Asset; buy: Asset; sellAmount: bigint }): Promise<RouteResult>;
}

export interface TextileClient {
  getPairLevel(chainId: number, sell: `0x${string}`, buy: `0x${string}`): Promise<PairLevel | undefined>;
  preview(args: { chainId: number; sellToken: `0x${string}`; buyToken: `0x${string}`; sellAmount: bigint }): Promise<PreviewResult>;
}

export function createTextileRouteProvider(
  opts: { client?: TextileClient; now?: () => number } = {},
): RouteProvider {
  const client: TextileClient = opts.client ?? { getPairLevel, preview };
  const now = opts.now ?? Date.now;
  const name = 'textile-fx-v2';

  return {
    name,
    async quoteExactInput(req): Promise<RouteResult> {
      const none = (code: RouteFailureCode, message: string, extra: Partial<Extract<RouteResult, { kind: 'none' }>> = {}): RouteResult => ({
        kind: 'none',
        provider: name,
        code,
        message,
        sell: req.sell,
        buy: req.buy,
        ...extra,
      });
      try {
        const level = await client.getPairLevel(req.chainId, req.sell.address, req.buy.address);
        if (!level) return none('CORRIDOR_UNAVAILABLE', `${req.sell.symbol} -> ${req.buy.symbol} is not listed or has no liquidity right now`);
        if (req.sellAmount < level.minSellAmount) {
          return none('BELOW_MINIMUM', `${req.sellAmount} is below the corridor minimum ${level.minSellAmount}`, { minSellAmount: level.minSellAmount });
        }
        if (req.sellAmount > level.maxSellAmount) {
          return none('INSUFFICIENT_DEPTH', `${req.sellAmount} is above the listed depth ${level.maxSellAmount}`, { minSellAmount: level.minSellAmount });
        }
        const pv = await client.preview({ chainId: req.chainId, sellToken: req.sell.address, buyToken: req.buy.address, sellAmount: req.sellAmount });
        if (pv.kind === 'no_quote') return none('NO_LIQUIDITY', `provider declined to price it (${pv.reason ?? 'no reason given'})`);
        if (pv.buyAmount === 0n) return none('NO_LIQUIDITY', 'provider priced it at zero');
        return {
          kind: 'route',
          provider: name,
          quoteState: 'preview',
          sell: req.sell,
          buy: req.buy,
          sellAmount: pv.sellAmount,
          buyAmount: pv.buyAmount,
          feeAmount: pv.feeAmount,
          takerPays: pv.takerPays,
          minSellAmount: level.minSellAmount,
          availableSellAmount: pv.availableSellAmount,
          fetchedAt: now(),
        };
      } catch (e) {
        return none('PROVIDER_ERROR', `route lookup failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    },
    async findRoute(req: RouteRequest): Promise<RouteResult> {
      const none = (code: RouteFailureCode, message: string, extra: Partial<Extract<RouteResult, { kind: 'none' }>> = {}): RouteResult => ({
        kind: 'none',
        provider: name,
        code,
        message,
        sell: req.sell,
        buy: req.buy,
        ...extra,
      });
      try {
        const level = await client.getPairLevel(req.chainId, req.sell.address, req.buy.address);
        if (!level) return none('CORRIDOR_UNAVAILABLE', `${req.sell.symbol} -> ${req.buy.symbol} is not listed or has no liquidity right now`);
        if (level.minSellAmount > req.maxSellAmount) {
          return none('BELOW_MINIMUM', `corridor minimum is above the ${req.sell.symbol} balance`, { minSellAmount: level.minSellAmount });
        }

        const first = await client.preview({ chainId: req.chainId, sellToken: req.sell.address, buyToken: req.buy.address, sellAmount: level.minSellAmount });
        if (first.kind === 'no_quote') return none('NO_LIQUIDITY', `provider declined to price the pair (${first.reason ?? 'no reason given'})`);
        if (first.buyAmount === 0n) return none('NO_LIQUIDITY', 'provider priced the minimum size at zero');

        const finish = (pv: Extract<PreviewResult, { kind: 'preview' }>): RouteResult => ({
          kind: 'route',
          provider: name,
          quoteState: 'preview',
          sell: req.sell,
          buy: req.buy,
          sellAmount: pv.sellAmount,
          buyAmount: pv.buyAmount,
          feeAmount: pv.feeAmount,
          takerPays: pv.takerPays,
          minSellAmount: level.minSellAmount,
          availableSellAmount: pv.availableSellAmount,
          fetchedAt: now(),
        });

        if (first.buyAmount >= req.minBuyAmount) return finish(first);

        // Scale the sell amount from the observed rate, with a 2% margin, then confirm with a second preview.
        const needed = (level.minSellAmount * req.minBuyAmount * 102n + first.buyAmount * 100n - 1n) / (first.buyAmount * 100n);
        const sell = needed > level.maxSellAmount ? level.maxSellAmount : needed;
        if (needed > req.maxSellAmount) {
          return none('EXCEEDS_BALANCE', `needs about ${needed} atomic ${req.sell.symbol} but the wallet holds ${req.maxSellAmount}`, {
            minSellAmount: level.minSellAmount,
            neededSellAmount: needed,
          });
        }
        const second = await client.preview({ chainId: req.chainId, sellToken: req.sell.address, buyToken: req.buy.address, sellAmount: sell });
        if (second.kind === 'no_quote') return none('NO_LIQUIDITY', `provider declined the larger size (${second.reason ?? 'no reason given'})`);
        if (second.buyAmount < req.minBuyAmount) {
          return none('INSUFFICIENT_DEPTH', 'the pair cannot deliver the required amount at its listed depth', { minSellAmount: level.minSellAmount });
        }
        return finish(second);
      } catch (e) {
        return none('PROVIDER_ERROR', `route lookup failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    },
  };
}

/**
 * Several conversion venues behind one RouteProvider. The first venue that has a live route wins (order =
 * preference). If none does, the most informative failure is returned: a venue that LISTS the pair but lacks
 * liquidity beats "not listed", and a provider error beats both so that outages are never reported as "no route".
 */
export function createCompositeRouteProvider(providers: readonly RouteProvider[]): RouteProvider {
  const rank = (r: RouteResult): number => {
    if (r.kind === 'route') return 100;
    if (r.code === 'PROVIDER_ERROR') return 50;
    if (r.code === 'BELOW_MINIMUM' || r.code === 'EXCEEDS_BALANCE' || r.code === 'INSUFFICIENT_DEPTH') return 40;
    if (r.code === 'NO_LIQUIDITY') return 30;
    return 10; // CORRIDOR_UNAVAILABLE
  };
  async function pick(calls: Array<() => Promise<RouteResult>>): Promise<RouteResult | undefined> {
    let best: RouteResult | undefined;
    for (const call of calls) {
      const r = await call();
      if (r.kind === 'route') return r;
      if (best === undefined || rank(r) > rank(best)) best = r;
    }
    return best;
  }
  const unsupported = (req: { sell: Asset; buy: Asset }): RouteResult => ({
    kind: 'none',
    provider: 'composite',
    code: 'CORRIDOR_UNAVAILABLE',
    message: 'no conversion provider can price this request',
    sell: req.sell,
    buy: req.buy,
  });
  return {
    name: 'composite',
    async findRoute(req) {
      return (await pick(providers.map((p) => () => p.findRoute(req)))) ?? unsupported(req);
    },
    async quoteExactInput(req) {
      const calls = providers.filter((p) => p.quoteExactInput).map((p) => () => p.quoteExactInput!(req));
      return (await pick(calls)) ?? unsupported(req);
    },
  };
}
