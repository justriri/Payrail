// Payment-requirement discovery: ask a service what it ACTUALLY wants, without paying.
//
// An unpaid request returns HTTP 402 whose body (x402 v1) or header (v2) states the real price,
// accepted assets, recipient and network. That challenge is the only price authority; catalog prices
// are indicative. Results are never cached: a price must be read fresh for every plan.
//
// Safety: the request body is sent to the service, so the endpoint is checked against policy FIRST,
// and redirects are never followed.
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import { x402 } from '@celo/buy-core';
import { assetByAddress } from './assets.ts';
import { sanitizeText } from './catalog.ts';
import type { Service } from './catalog.ts';
import { assessService } from './policy.ts';
import type { SpendingPolicy } from './policy.ts';

export interface PaymentOffer {
  asset: Address;
  symbol: string | undefined;
  /** Asset is in Payrail's registry. */
  known: boolean;
  /** Asset can sign an x402 (EIP-3009) payment. */
  signable: boolean;
  decimals: number | undefined;
  amountAtomic: bigint;
  payTo: Address;
  network: string;
  scheme: string;
  maxTimeoutSeconds: number;
  resource: string;
  /** The challenge's resource equals the service URL we asked. */
  resourceMatches: boolean;
  /** EIP-712 domain name/version the token needs for an EIP-3009 authorization (from the challenge's `extra`). */
  domain?: { name: string; version: string } | undefined;
}

export type DiscoveryResult =
  | {
      kind: 'payment_required';
      x402Version: number;
      offers: PaymentOffer[];
      discarded: string[];
      fetchedAt: number;
    }
  | { kind: 'no_payment_required'; httpStatus: number }
  | { kind: 'blocked'; reasons: string[] }
  | { kind: 'invalid_body'; issues: string[] }
  | {
      kind: 'error';
      code: 'TIMEOUT' | 'NETWORK' | 'REDIRECT' | 'REJECTED' | 'SERVER' | 'UNPARSEABLE_CHALLENGE';
      message: string;
      httpStatus?: number;
    };

// ------------------------------------------------------------------ request-body validation (JSON-Schema subset)

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a request body against the subset of JSON Schema the catalog uses. Unknown keywords are ignored. */
export function validateBody(schema: Json | undefined, bodyText: string): { ok: boolean; issues: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return { ok: false, issues: ['body is not valid JSON'] };
  }
  const issues: string[] = [];
  if (!schema) return { ok: true, issues };
  if (schema.type === 'object') {
    if (!isRecord(value)) return { ok: false, issues: ['body must be a JSON object'] };
    const props = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
    for (const k of required) if (!(k in value)) issues.push(`missing required field "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      const def = props[k];
      if (def === undefined) {
        if (schema.additionalProperties === false) issues.push(`unexpected field "${k}"`);
        continue;
      }
      if (!isRecord(def)) continue;
      const t = def.type;
      if (t === 'string') {
        if (typeof v !== 'string') issues.push(`"${k}" must be a string`);
        else {
          if (typeof def.minLength === 'number' && v.length < def.minLength) issues.push(`"${k}" is too short`);
          if (typeof def.maxLength === 'number' && v.length > def.maxLength) issues.push(`"${k}" is too long`);
        }
      } else if (t === 'integer' || t === 'number') {
        if (typeof v !== 'number' || (t === 'integer' && !Number.isInteger(v))) issues.push(`"${k}" must be ${t === 'integer' ? 'an integer' : 'a number'}`);
        else {
          if (typeof def.minimum === 'number' && v < def.minimum) issues.push(`"${k}" is below the minimum`);
          if (typeof def.maximum === 'number' && v > def.maximum) issues.push(`"${k}" is above the maximum`);
        }
      } else if (t === 'boolean') {
        if (typeof v !== 'boolean') issues.push(`"${k}" must be a boolean`);
      } else if (t === 'array') {
        if (!Array.isArray(v)) issues.push(`"${k}" must be an array`);
      }
      if (Array.isArray(def.enum) && !def.enum.includes(v as never)) issues.push(`"${k}" is not one of the allowed values`);
    }
  }
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ offers

function toOffer(raw: unknown, serviceUrl: string): { offer?: PaymentOffer; reason?: string } {
  if (!isRecord(raw)) return { reason: 'offer is not an object' };
  const { scheme, network, maxAmountRequired, payTo, asset, resource, maxTimeoutSeconds } = raw;
  if (typeof scheme !== 'string' || typeof network !== 'string') return { reason: 'offer lacks scheme/network' };
  if (typeof maxAmountRequired !== 'string' || !/^\d+$/.test(maxAmountRequired)) return { reason: 'offer amount is not an atomic integer' };
  if (typeof payTo !== 'string' || !isAddress(payTo)) return { reason: 'offer payTo is not an address' };
  if (typeof asset !== 'string' || !isAddress(asset)) return { reason: 'offer asset is not an address' };
  const a = assetByAddress(asset);
  return {
    offer: {
      asset: getAddress(asset),
      symbol: a?.symbol,
      known: a !== undefined,
      signable: a?.x402Signable ?? false,
      decimals: a?.decimals,
      amountAtomic: BigInt(maxAmountRequired),
      payTo: getAddress(payTo),
      network: sanitizeText(network, 40),
      scheme: sanitizeText(scheme, 20),
      maxTimeoutSeconds: typeof maxTimeoutSeconds === 'number' ? maxTimeoutSeconds : 0,
      resource: typeof resource === 'string' ? resource : '',
      resourceMatches: resource === serviceUrl,
      domain: isRecord(raw.extra) && typeof raw.extra.name === 'string' && typeof raw.extra.version === 'string' ? { name: sanitizeText(raw.extra.name, 60), version: sanitizeText(raw.extra.version, 20) } : undefined,
    },
  };
}

export interface DiscoverOptions {
  policy: SpendingPolicy;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Ask the service for its payment requirements. Signs nothing, pays nothing, and does not cache. */
export async function discoverRequirements(service: Service, body: string, opts: DiscoverOptions): Promise<DiscoveryResult> {
  const assessment = assessService(service, opts.policy);
  if (!assessment.contactable) return { kind: 'blocked', reasons: assessment.reasons };

  const v = validateBody(service.inputSchema, body);
  if (!v.ok) return { kind: 'invalid_body', issues: v.issues };

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(service.url, {
      method: service.method,
      headers: service.method === 'POST' ? { 'content-type': 'application/json' } : {},
      ...(service.method === 'POST' ? { body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { kind: 'error', code: timeout ? 'TIMEOUT' : 'NETWORK', message: sanitizeText(e instanceof Error ? e.message : String(e), 200) };
  }

  const status = res.status;
  if (status >= 300 && status < 400) return { kind: 'error', code: 'REDIRECT', message: 'service redirected; redirects are never followed', httpStatus: status };
  if (status !== 402) {
    if (status >= 200 && status < 300) return { kind: 'no_payment_required', httpStatus: status };
    const text = sanitizeText(await res.text().catch(() => ''), 200);
    return {
      kind: 'error',
      code: status >= 500 ? 'SERVER' : 'REJECTED',
      message: `service answered HTTP ${status}${text ? `: ${text}` : ''}`,
      httpStatus: status,
    };
  }

  const text = await res.text().catch(() => '');
  const envelope = x402.parseEnvelope(text) ?? x402.parseV2Header(res.headers.get('payment-required'), service.url);
  if (!envelope) return { kind: 'error', code: 'UNPARSEABLE_CHALLENGE', message: 'HTTP 402 without a valid x402 challenge', httpStatus: 402 };

  const offers: PaymentOffer[] = [];
  const discarded: string[] = [];
  for (const raw of envelope.accepts) {
    const r = toOffer(raw, service.url);
    if (r.offer) offers.push(r.offer);
    else discarded.push(r.reason ?? 'unknown');
  }
  return { kind: 'payment_required', x402Version: envelope.x402Version, offers, discarded, fetchedAt: (opts.now ?? Date.now)() };
}
