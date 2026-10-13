// Buy gateway (usebuy.ai) integration: catalog lookup, unpaid price quote, and the payment policy.
// Facts verified live on 2026-10-12: x402 v1, scheme "exact", network "celo", tokens USDC/USDT/USAT,
// quote = unpaid request that answers 402. Payment itself is done by @celo/buy-core's payingFetch.
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { x402 } from '@celo/buy-core';
import type { PaymentRequirements } from '@celo/buy-core';

export const GATEWAY = 'https://gateway.usebuy.ai';
export const CATALOG_URL = `${GATEWAY}/v1/catalog`;

/** The single capability this step is allowed to buy. */
export const CAPABILITY_ID = 'x.posts.search';
export const CAPABILITY_URL = `${GATEWAY}/v1/social/x/posts/search`;

/** payTo address published in the live catalog and 402 challenge on 2026-10-12. Pinned: a change stops the run. */
export const EXPECTED_PAY_TO: Address = getAddress('0x20faaca5f980e29639a0fcc6dca6988e18ed333b');

/** Hard spending cap per call, atomic units of a 6-decimal stablecoin ($0.01). */
export const MAX_ATOMIC = 10_000n;

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface CatalogFacts {
  payTo: Address;
  chainId: number;
  network: string;
  x402Version: number;
  tokens: Array<{ symbol: string; asset: Address; decimals: number }>;
  priceAtomic: bigint;
  priceUsd: string;
  available: boolean;
}

export async function fetchCatalogFacts(): Promise<CatalogFacts> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
  const j: unknown = await res.json();
  if (!isRecord(j) || !isRecord(j.payment) || !Array.isArray(j.capabilities)) {
    throw new Error('catalog has an unexpected shape');
  }
  const p = j.payment;
  const tokens = Array.isArray(p.tokens)
    ? p.tokens.filter(isRecord).map((t) => ({
        symbol: String(t.symbol),
        asset: getAddress(String(t.asset)),
        decimals: Number(t.decimals),
      }))
    : [];
  const cap = j.capabilities.filter(isRecord).find((c) => c.id === CAPABILITY_ID);
  if (!cap) throw new Error(`capability ${CAPABILITY_ID} not found in the catalog`);
  if (cap.url !== CAPABILITY_URL) throw new Error(`capability URL changed: ${String(cap.url)}`);
  const price = isRecord(cap.price) ? cap.price : undefined;
  if (!price || typeof price.atomic !== 'string' || !/^\d+$/.test(price.atomic)) {
    throw new Error('capability price is missing or malformed');
  }
  return {
    payTo: getAddress(String(p.payTo)),
    chainId: Number(p.chainId),
    network: String(p.network),
    x402Version: Number(p.x402Version),
    tokens,
    priceAtomic: BigInt(price.atomic),
    priceUsd: String(price.usd),
    available: cap.available === true,
  };
}

export interface UnpaidQuote {
  /** The offer Payrail would pay with (the preferred token). */
  chosen: PaymentRequirements;
  /** Every offer in the 402, for display. */
  offers: PaymentRequirements[];
  x402Version: number;
}

/** Ask the service for its price without paying. Signs nothing; the 402 challenge is the price authority. */
export async function quoteUnpaid(body: string, preferredToken: string): Promise<UnpaidQuote> {
  const res = await fetch(CAPABILITY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status !== 402) {
    throw new Error(`expected HTTP 402 from the unpaid request, got ${res.status}`);
  }
  const envelope = x402.parseEnvelope(text);
  if (!envelope) throw new Error('402 body is not a valid x402 v1 envelope');
  const chosen = x402.selectRequirements(envelope, 'celo', preferredToken);
  if (!chosen) throw new Error(`the service does not offer ${preferredToken} on celo`);
  return { chosen, offers: envelope.accepts, x402Version: envelope.x402Version };
}

/** What a live 402 challenge must match before anything is signed. */
export interface ChallengeExpectation {
  resource: string;
  asset: Address;
  payTo: Address;
  /** The challenge may not ask for more than this (the authorized/planned amount or a hard cap). */
  maxAtomic: bigint;
}

/** Generic challenge check: returns problems (empty = allowed). Used by the executor for every payment. */
export function checkChallenge(req: PaymentRequirements, expected: ChallengeExpectation): string[] {
  const problems: string[] = [];
  if (req.scheme !== 'exact') problems.push(`scheme ${req.scheme} is not "exact"`);
  if (req.network !== 'celo') problems.push(`network ${req.network} is not celo`);
  if (req.resource !== expected.resource) problems.push(`resource ${req.resource} is not the authorized endpoint`);
  if (getAddress(req.asset) !== expected.asset) problems.push(`asset ${req.asset} is not the authorized token`);
  if (getAddress(req.payTo) !== expected.payTo) problems.push(`payTo ${req.payTo} is not the authorized recipient`);
  if (!/^\d+$/.test(req.maxAmountRequired)) problems.push('amount is not an atomic-unit integer');
  else if (BigInt(req.maxAmountRequired) > expected.maxAtomic) {
    problems.push(`amount ${req.maxAmountRequired} exceeds the authorized maximum ${expected.maxAtomic}`);
  }
  return problems;
}

/** Original single-service policy (unchanged behavior): endpoint, pinned payTo, token, scheme, hard cap. */
export function checkPolicy(
  req: PaymentRequirements,
  facts: { expectedAsset: Address; catalogPayTo: Address },
): string[] {
  const problems = checkChallenge(req, {
    resource: CAPABILITY_URL,
    asset: facts.expectedAsset,
    payTo: EXPECTED_PAY_TO,
    maxAtomic: MAX_ATOMIC,
  });
  if (getAddress(req.payTo) !== facts.catalogPayTo) problems.push('payTo differs from the catalog payTo');
  return problems;
}
