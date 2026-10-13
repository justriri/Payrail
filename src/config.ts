// Payrail configuration: reads environment variables and refuses unsafe values.
// Nothing here ever logs a private key.
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_RPC_FALLBACKS } from './chainread.ts';

/** Official hackathon attribution tag (ERC-8021). Supplied by the user. Do not edit or derive another. */
export const OFFICIAL_ATTRIBUTION_TAG = 'celo_b2fff2ac9413';

export const CELO_MAINNET_CHAIN_ID = 42220;

export interface VerifiedToken {
  symbol: string;
  address: Address;
  decimals: number;
  /** Where this address was verified. Addresses are never invented. */
  source: string;
}

// Stored lowercase and normalised with getAddress(), so a checksum typo cannot slip in.
export const VERIFIED_TOKENS = {
  cNGN: {
    symbol: 'cNGN',
    address: getAddress('0xf6829d7393dae24509eb1e52ee8e572e2e271a4f'),
    decimals: 6,
    source: 'Textile FX address book (docs.textilecredit.com/protocol/address-book)',
  },
  USDT: {
    symbol: 'USDT',
    address: getAddress('0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'),
    decimals: 6,
    source: 'Celo x402 docs, Textile address book, @celo/buy-core registry (all agree)',
  },
  USDC: {
    symbol: 'USDC',
    address: getAddress('0xceba9300f2b948710d2653dd7b07f33a8b32118c'),
    decimals: 6,
    source: 'Celo x402 docs, Textile address book, @celo/buy-core registry (all agree)',
  },
} as const satisfies Record<string, VerifiedToken>;

/** Textile LimitOrderReactor on Celo (verified source on Blockscout; Textile address book). */
export const TEXTILE_REACTOR: Address = getAddress('0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3');
/**
 * Textile PreferredFillerValidation: the only order-validation callback Payrail accepts on a Textile order.
 * Verified source on Blockscout (2026-10-13): stateless `view`, not a proxy; it can only REVERT. It gives a
 * bounded set of fillers exclusive access until a signed deadline. data = abi.encode(address[], uint256).
 */
export const TEXTILE_PREFERRED_FILLER: Address = getAddress('0x10b9eba3a175df418a35cb8329a527691ee258c5');
/** Canonical Permit2 (Textile address book). */
export const PERMIT2: Address = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');

export interface Config {
  attributionTag: string;
  chainId: number;
  rpcUrl: string | undefined;
  /** Extra public RPC endpoints used when the primary cannot answer (see src/chainread.ts). https only. */
  rpcFallbackUrls: string[];
  /** Public wallet address, if known (derived from the key when a key is supplied). */
  walletAddress: Address | undefined;
  /** Secret. Never print, log or persist. */
  privateKey: Hex | undefined;
  sellAmountCngn: string;
  tokens: typeof VERIFIED_TOKENS;
}

export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration: ${problems.length} problem(s)`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  // 1) Attribution tag: required and must match the official tag exactly.
  const tag = env.PAYRAIL_ATTRIBUTION_TAG;
  if (tag === undefined || tag === '') {
    problems.push('PAYRAIL_ATTRIBUTION_TAG is missing. The official hackathon tag is required.');
  } else if (tag !== OFFICIAL_ATTRIBUTION_TAG) {
    problems.push('PAYRAIL_ATTRIBUTION_TAG does not match the official hackathon tag (exact match required).');
  }

  // 2) Network: Celo mainnet only.
  const chainId = Number(env.PAYRAIL_CHAIN_ID ?? CELO_MAINNET_CHAIN_ID);
  if (chainId !== CELO_MAINNET_CHAIN_ID) {
    problems.push(`PAYRAIL_CHAIN_ID must be ${CELO_MAINNET_CHAIN_ID} (Celo mainnet).`);
  }

  // 3) Token overrides must equal the verified addresses (defaults are the verified ones).
  const overrides: Array<[string, string, Address]> = [
    ['PAYRAIL_CNGN_ADDRESS', 'cNGN', VERIFIED_TOKENS.cNGN.address],
    ['PAYRAIL_USDT_ADDRESS', 'USDT', VERIFIED_TOKENS.USDT.address],
    ['PAYRAIL_USDC_ADDRESS', 'USDC', VERIFIED_TOKENS.USDC.address],
  ];
  for (const [name, symbol, verified] of overrides) {
    const v = env[name];
    if (v !== undefined && v !== '' && !(isAddress(v) && sameAddress(v, verified))) {
      problems.push(`${name} does not match the verified ${symbol} address on Celo mainnet.`);
    }
  }

  // 4) RPC: https only.
  const rpcUrl = env.PAYRAIL_RPC_URL || undefined;
  if (rpcUrl !== undefined && !rpcUrl.startsWith('https://')) {
    problems.push('PAYRAIL_RPC_URL must start with https://');
  }

  // 4b) Fallback RPCs for chain READS. Unset = the built-in list; set to an empty value to disable.
  const rawFallbacks = env.PAYRAIL_RPC_FALLBACK_URLS;
  let rpcFallbackUrls: string[] = [...DEFAULT_RPC_FALLBACKS];
  if (rawFallbacks !== undefined) {
    rpcFallbackUrls = rawFallbacks.split(',').map((s) => s.trim()).filter(Boolean);
    for (const u of rpcFallbackUrls) {
      if (!u.startsWith('https://')) problems.push('PAYRAIL_RPC_FALLBACK_URLS entries must start with https://');
    }
  }

  // 5) Sell amount (human units of cNGN, max 6 decimals).
  const sellAmountCngn = env.PAYRAIL_SELL_AMOUNT_CNGN ?? '1500';
  if (!/^\d+(\.\d{1,6})?$/.test(sellAmountCngn) || Number(sellAmountCngn) <= 0) {
    problems.push('PAYRAIL_SELL_AMOUNT_CNGN must be a positive number with at most 6 decimals.');
  }

  // 6) Wallet: private key (secret) and/or public address.
  let privateKey: Hex | undefined;
  const rawKey = env.PAYRAIL_PRIVATE_KEY;
  if (rawKey !== undefined && rawKey !== '') {
    if (/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
      privateKey = rawKey as Hex;
    } else {
      problems.push('PAYRAIL_PRIVATE_KEY is not a 0x-prefixed 32-byte hex string (value not shown).');
    }
  }
  let walletAddress: Address | undefined;
  const rawAddr = env.PAYRAIL_WALLET_ADDRESS;
  if (rawAddr !== undefined && rawAddr !== '') {
    if (isAddress(rawAddr)) walletAddress = getAddress(rawAddr);
    else problems.push('PAYRAIL_WALLET_ADDRESS is not a valid address.');
  }
  if (privateKey !== undefined) {
    const derived = privateKeyToAccount(privateKey).address;
    if (walletAddress !== undefined && !sameAddress(walletAddress, derived)) {
      problems.push('PAYRAIL_WALLET_ADDRESS does not match the address derived from PAYRAIL_PRIVATE_KEY.');
    }
    walletAddress = derived;
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    attributionTag: OFFICIAL_ATTRIBUTION_TAG,
    chainId,
    rpcUrl,
    rpcFallbackUrls,
    walletAddress,
    privateKey,
    sellAmountCngn,
    tokens: VERIFIED_TOKENS,
  };
}
