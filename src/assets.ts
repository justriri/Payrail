// Known assets on Celo mainnet. Addresses come from verified sources only (see `source`).
// This registry says what a token IS; whether a swap route exists is decided live (routes.ts).
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { TOKENS, isTokenSignable } from '@celo/buy-core';

export interface Asset {
  symbol: string;
  address: Address;
  decimals: number;
  /** Pegged 1:1 to USD for policy purposes (so atomic amounts can be limited in dollars). */
  usdStable: boolean;
  /** Can sign an EIP-3009 x402 payment (so it can be used to pay a service directly). */
  x402Signable: boolean;
  /** Can pay Celo gas via fee abstraction (CIP-64). Local currencies cannot. */
  gasCapable: boolean;
  /**
   * Must a non-zero allowance be reset to 0 before it is changed? Textile's docs say USDT-style tokens need
   * it. Anything not positively known is 'unknown' and is treated as "reset required" (one extra, safe tx).
   */
  allowanceReset: 'required' | 'not_required' | 'unknown';
  source: string;
}

const assets: Asset[] = [];

// Tokens Buy's client knows (addresses, decimals, EIP-3009 domain and fee-currency data verified on-chain by Buy).
for (const t of Object.values(TOKENS.celo)) {
  assets.push({
    symbol: t.symbol,
    address: getAddress(t.address),
    decimals: t.decimals,
    usdStable: ['USDC', 'USDT', 'USAT', 'USDm'].includes(t.symbol),
    x402Signable: isTokenSignable(t),
    gasCapable: t.feeCurrency !== undefined,
    allowanceReset: t.symbol === 'USDT' ? 'required' : 'unknown',
    source: '@celo/buy-core registry (verified on-chain by Buy)',
  });
}

// Local-currency stablecoins Textile FX lists on Celo (Textile address book). Not x402-signable, not gas tokens.
const TEXTILE_SOURCE = 'Textile FX address book (docs.textilecredit.com/protocol/address-book)';
for (const [symbol, address, decimals] of [
  ['cNGN', '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f', 6],
  ['wARS', '0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d', 18],
  ['wBRL', '0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0', 18],
  ['IDRX', '0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22', 2],
] as const) {
  assets.push({
    symbol,
    address: getAddress(address),
    decimals,
    usdStable: false,
    x402Signable: false,
    gasCapable: false,
    allowanceReset: 'unknown',
    source: TEXTILE_SOURCE,
  });
}

export const ASSETS: readonly Asset[] = Object.freeze(assets);

export function assetByAddress(address: string): Asset | undefined {
  const a = address.toLowerCase();
  return ASSETS.find((x) => x.address.toLowerCase() === a);
}

export function assetBySymbol(symbol: string): Asset | undefined {
  return ASSETS.find((x) => x.symbol === symbol);
}

/** Dollar value of `atomic` units of a USD-stable asset, in micro-dollars (6 decimals); undefined if not USD-stable. */
export function microUsd(asset: Asset, atomic: bigint): bigint | undefined {
  if (!asset.usdStable) return undefined;
  if (asset.decimals === 6) return atomic;
  if (asset.decimals > 6) return atomic / 10n ** BigInt(asset.decimals - 6);
  return atomic * 10n ** BigInt(6 - asset.decimals);
}
