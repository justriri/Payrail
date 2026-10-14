// Mento V3 (FPMM) as a conversion venue on Celo mainnet. Used for USDm <-> USDT.
//
// PROVENANCE (nothing here is guessed):
//   * addresses: @mento-protocol/mento-sdk@3.4.0 (core/constants/addresses.js, chain 42220), then confirmed
//     on-chain on 2026-10-13: the Router has verified source on Blockscout (name "Router"); the USDm/USDT
//     pool 0x0FEBa760...228D reports token0 = USDT and token1 = USDm and holds ~$37k / ~$24.6k.
//   * ABI: the SDK's router ABI. The Mento docs show the same call shape:
//       swapExactTokensForTokens(amountIn, amountOutMin, routes, to, deadline)
//       getAmountsOut(amountIn, routes)        routes[i] = { from, to, factory }
//   * TRUST: the pool and factory are verified but UPGRADEABLE proxies (governance-controlled). That is an
//     assumption to state, not hide. The Router itself is not a proxy.
//
// An AMM swap has no quote that expires; its protection is `amountOutMin` inside the transaction, so the
// swap reverts on-chain if the price has moved beyond the authorized floor.
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import type { Asset } from './assets.ts';
import type { RouteFailureCode, RouteProvider, RouteRequest, RouteResult } from './routes.ts';

export const MENTO_PROVIDER = 'mento-router-v3';
export const MENTO_ROUTER: Address = getAddress('0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6');
export const MENTO_FACTORY: Address = getAddress('0xa849b475fe5a4b5c9c3280152c7a1945b907613b');

export const mentoRouterAbi = parseAbi([
  'struct Route { address from; address to; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] memory routes) view returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline) returns (uint256[] memory amounts)',
]);

/** The minimum a read-only client must provide (a viem PublicClient satisfies it). */
export interface ReadClient {
  readContract(args: { address: Address; abi: typeof mentoRouterAbi; functionName: 'getAmountsOut'; args: readonly [bigint, readonly { from: Address; to: Address; factory: Address }[]] }): Promise<readonly bigint[]>;
}

export interface SwapExpectation {
  amountIn: bigint;
  /** The calldata's amountOutMin must be at least this. */
  minOut: bigint;
  sell: Address;
  buy: Address;
  recipient: Address;
  nowSec: number;
  /** Longest deadline accepted, in seconds from now. */
  maxDeadlineSec: number;
}

/** A conversion venue that is an on-chain AMM (no firm quote; slippage guard lives in the calldata). */
export interface AmmVenue {
  readonly name: string;
  readonly router: Address;
  readonly factory: Address;
  /** Read-only quote: how much `buy` for exactly `amountIn` of `sell`. */
  quote(sell: Address, buy: Address, amountIn: bigint): Promise<bigint>;
  encodeSwap(a: { amountIn: bigint; amountOutMin: bigint; sell: Address; buy: Address; to: Address; deadline: bigint }): Hex;
  /** Independently decode the calldata and return every way it differs from `expect` (empty = OK). */
  validateSwap(data: Hex, expect: SwapExpectation): string[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

export function createMentoVenue(client: ReadClient): AmmVenue {
  return {
    name: MENTO_PROVIDER,
    router: MENTO_ROUTER,
    factory: MENTO_FACTORY,
    async quote(sell, buy, amountIn) {
      const out = await client.readContract({
        address: MENTO_ROUTER,
        abi: mentoRouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, [{ from: sell, to: buy, factory: MENTO_FACTORY }]],
      });
      const last = out[out.length - 1];
      if (last === undefined) throw new Error('router returned no amounts');
      return last;
    },
    encodeSwap(a) {
      return encodeFunctionData({
        abi: mentoRouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [a.amountIn, a.amountOutMin, [{ from: a.sell, to: a.buy, factory: MENTO_FACTORY }], a.to, a.deadline],
      });
    },
    validateSwap(data, expect) {
      const problems: string[] = [];
      try {
        const d = decodeFunctionData({ abi: mentoRouterAbi, data });
        if (d.functionName !== 'swapExactTokensForTokens') return [`calldata calls ${d.functionName}, not swapExactTokensForTokens`];
        const [amountIn, amountOutMin, routes, to, deadline] = d.args;
        if (amountIn !== expect.amountIn) problems.push(`amountIn ${amountIn} is not the authorized ${expect.amountIn}`);
        if (amountOutMin < expect.minOut) problems.push(`amountOutMin ${amountOutMin} is below the authorized floor ${expect.minOut}`);
        if (routes.length !== 1) problems.push(`expected a single-hop route, got ${routes.length} hops`);
        const r = routes[0];
        if (r) {
          if (!eq(r.from, expect.sell)) problems.push(`route starts at ${r.from}, not the sell token`);
          if (!eq(r.to, expect.buy)) problems.push(`route ends at ${r.to}, not the buy token`);
          if (!eq(r.factory, MENTO_FACTORY) && !eq(r.factory, ZERO)) problems.push(`route uses an unrecognised factory ${r.factory}`);
        }
        if (!eq(to, expect.recipient)) problems.push(`output goes to ${to}, not the wallet`);
        if (deadline < BigInt(expect.nowSec)) problems.push('deadline has already passed');
        if (deadline > BigInt(expect.nowSec + expect.maxDeadlineSec)) problems.push('deadline is further out than allowed');
      } catch {
        problems.push('swap calldata could not be decoded with the verified Router ABI');
      }
      return problems;
    },
  };
}

// ------------------------------------------------------------------ route provider (for planning)

function classify(e: unknown): { code: RouteFailureCode; message: string } {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/PoolDoesNotExist|PoolFactoryDoesNotExist|InvalidPath|InvalidRoute/i.test(text)) {
    return { code: 'CORRIDOR_UNAVAILABLE', message: 'no Mento pool for this pair' };
  }
  // The Router reverts with NO reason (empty signature) when it has no route for a pair, e.g. cNGN (observed live
  // 2026-10-14). That is "no corridor", not a provider outage: report it as such so users are not told to retry.
  if (/reverted with the following signature:\s*($|\n)/i.test(text) || /returned no data|execution reverted\s*$/i.test(text)) {
    return { code: 'CORRIDOR_UNAVAILABLE', message: 'the Mento router has no route for this pair' };
  }
  if (/FXMarketClosed/i.test(text)) return { code: 'NO_LIQUIDITY', message: 'the Mento FX market is closed' };
  if (/InsufficientLiquidity|ReservesEmpty|InsufficientAmount/i.test(text)) return { code: 'NO_LIQUIDITY', message: 'the pool cannot fill this amount' };
  return { code: 'PROVIDER_ERROR', message: text.split('\n')[0]!.slice(0, 160) };
}

export function createMentoRouteProvider(opts: { client: ReadClient; now?: () => number }): RouteProvider {
  const venue = createMentoVenue(opts.client);
  const now = opts.now ?? Date.now;
  return {
    name: MENTO_PROVIDER,
    async quoteExactInput(req): Promise<RouteResult> {
      const none = (code: RouteFailureCode, message: string): RouteResult => ({ kind: 'none', provider: MENTO_PROVIDER, code, message, sell: req.sell, buy: req.buy });
      if (req.chainId !== 42220) return none('CORRIDOR_UNAVAILABLE', 'Mento is only wired for Celo mainnet');
      try {
        const out = await venue.quote(req.sell.address, req.buy.address, req.sellAmount);
        if (out === 0n) return none('NO_LIQUIDITY', 'the router quoted zero');
        return {
          kind: 'route',
          provider: MENTO_PROVIDER,
          quoteState: 'preview',
          sell: req.sell,
          buy: req.buy,
          sellAmount: req.sellAmount,
          buyAmount: out,
          feeAmount: 0n,
          takerPays: req.sellAmount,
          minSellAmount: 0n,
          availableSellAmount: undefined,
          fetchedAt: now(),
          spender: MENTO_ROUTER,
          note: 'Mento pool fees are embedded in the quoted rate and are not itemised here (fee units not independently verified).',
        };
      } catch (e) {
        const c = classify(e);
        return none(c.code, c.message);
      }
    },
    /**
     * Pay-a-service route: the smallest sell amount whose quoted output covers `minBuyAmount`. The router only
     * quotes an exact INPUT, so the amount is found by inverting the quote: take a reference quote, scale, then
     * re-quote the candidate and correct it (bounded). Everything returned is the router's own quote.
     */
    async findRoute(req: RouteRequest): Promise<RouteResult> {
      const none = (code: RouteFailureCode, message: string, extra: { neededSellAmount?: bigint } = {}): RouteResult => ({
        kind: 'none', provider: MENTO_PROVIDER, code, message, sell: req.sell, buy: req.buy, ...extra,
      });
      if (req.chainId !== 42220) return none('CORRIDOR_UNAVAILABLE', 'Mento is only wired for Celo mainnet');
      if (req.minBuyAmount <= 0n || req.maxSellAmount <= 0n) return none('EXCEEDS_BALANCE', 'nothing to sell or nothing to buy');
      try {
        const unit = 10n ** BigInt(req.sell.decimals);
        const ref = req.maxSellAmount < unit ? req.maxSellAmount : unit;
        const refOut = await venue.quote(req.sell.address, req.buy.address, ref);
        if (refOut === 0n) return none('NO_LIQUIDITY', 'the router quoted zero');
        // first estimate with a 1% cushion, then correct against the router's own answer
        let sell = (req.minBuyAmount * ref * 101n) / (refOut * 100n) + 1n;
        let out = 0n;
        for (let i = 0; i < 4; i++) {
          if (sell > req.maxSellAmount) return none('EXCEEDS_BALANCE', 'the wallet holds less than the conversion needs', { neededSellAmount: sell });
          out = await venue.quote(req.sell.address, req.buy.address, sell);
          if (out >= req.minBuyAmount) break;
          if (out === 0n) return none('NO_LIQUIDITY', 'the router quoted zero');
          sell = (sell * req.minBuyAmount) / out + 1n + sell / 200n;
        }
        if (out < req.minBuyAmount) return none('NO_LIQUIDITY', 'could not find an input that covers the price');
        return {
          kind: 'route',
          provider: MENTO_PROVIDER,
          quoteState: 'preview',
          sell: req.sell,
          buy: req.buy,
          sellAmount: sell,
          buyAmount: out,
          feeAmount: 0n,
          takerPays: sell,
          minSellAmount: 0n,
          availableSellAmount: undefined,
          fetchedAt: now(),
          spender: MENTO_ROUTER,
          note: 'Mento pool fees are embedded in the quoted rate and are not itemised here (fee units not independently verified).',
        };
      } catch (e) {
        const c = classify(e);
        return none(c.code, c.message);
      }
    },
  };
}
