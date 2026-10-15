// The only module (with vault.ts) allowed to touch plaintext seller credentials. It builds one outbound request to a
// listing's FIXED endpoint, attaches credentials, sends it through the SSRF-safe egress layer, and returns a redacted result.
// Buyers and agents influence only the `input` values, never the URL, host, path, headers or credentials.
import type { Db } from './db.ts';
import { safeFetch, EgressError, RateLimiter } from './egress.ts';
import type { FetchOptions } from './egress.ts';
import { VaultError, openForGateway, redact } from './vault.ts';
import type { MasterKey } from './vault.ts';
import { getListing } from './seller.ts';
import type { UpstreamResult } from './contracts.ts';

export class GatewayError extends Error {
  code: 'NOT_FOUND' | 'LISTING_NOT_VERIFIED' | 'BAD_INPUT' | 'RATE_LIMITED' | 'UPSTREAM_UNREACHABLE' | 'UPSTREAM_TIMEOUT' | 'EGRESS_BLOCKED' | 'CREDENTIAL_UNREADABLE';
  constructor(code: GatewayError['code'], message: string) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

export interface UpstreamCall extends UpstreamResult {
  /** body text with any credential value removed */
  bodyText: string;
  truncated: false;
  connectedTo: string;
}

export const MAX_INPUT_KEYS = 20;
export const MAX_INPUT_BYTES = 8_192;
const limiter = new RateLimiter(10, 2);

export interface CallOptions {
  purpose: 'gateway-execution' | 'seller-test';
  now?: () => number;
  fetchOptions?: FetchOptions;
  /** per-listing limiter override (tests) */
  limiter?: RateLimiter;
}

/** Validate the buyer/seller input: a flat object of short scalar values. */
export function cleanInput(input: unknown): Record<string, string | number | boolean> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new GatewayError('BAD_INPUT', 'input must be an object');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_INPUT_KEYS) throw new GatewayError('BAD_INPUT', 'too many input fields');
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/.test(k) || k === '__proto__') throw new GatewayError('BAD_INPUT', `invalid input name "${k}"`);
    if (typeof v === 'string' ? v.length > 500 : typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean') throw new GatewayError('BAD_INPUT', `invalid value for "${k}"`);
    out[k] = v as string | number | boolean;
  }
  if (JSON.stringify(out).length > MAX_INPUT_BYTES) throw new GatewayError('BAD_INPUT', 'input too large');
  return out;
}

/** One upstream call. Throws GatewayError when the call could not be completed (the caller decides what that means for billing). */
export async function callUpstream(db: Db, keys: readonly MasterKey[], listingId: string, input: unknown, opts: CallOptions): Promise<UpstreamCall> {
  const now = opts.now ?? Date.now;
  const l = getListing(db, listingId);
  if (!l) throw new GatewayError('NOT_FOUND', `no listing ${listingId}`);
  // credentials are only ever sent to a host whose ownership was verified
  // An unpublished listing was verified before it was unpublished, so its owner may keep testing it; buyers cannot run it.
  const allowed = opts.purpose === 'seller-test' ? ['verified', 'published', 'unpublished'] : ['verified', 'published'];
  if (!allowed.includes(l.status)) throw new GatewayError('LISTING_NOT_VERIFIED', `listing is ${l.status}`);
  const clean = cleanInput(input);
  if (!(opts.limiter ?? limiter).take(listingId)) throw new GatewayError('RATE_LIMITED', 'too many calls to this listing');

  let creds: ReturnType<typeof openForGateway>;
  try {
    creds = openForGateway(db, keys, listingId, opts.purpose, now);
  } catch (e) {
    // nothing has been sent: the stored credential cannot be decrypted with the keys this server has loaded
    if (e instanceof VaultError) throw new GatewayError('CREDENTIAL_UNREADABLE', 'The stored API credential cannot be decrypted with the vault key currently loaded. The seller must re-enter it.');
    throw e;
  }
  const secrets = creds.map((c) => c.value);
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'payrail-gateway/1' };
  for (const c of creds) headers[c.headerName.toLowerCase()] = c.value;

  let url = l.endpointUrl;
  const o: FetchOptions = { ...(opts.fetchOptions ?? {}), method: l.method, maxRedirects: 0 };
  if (l.method === 'GET') {
    const qs = new URLSearchParams(Object.entries(clean).map(([k, v]): [string, string] => [k, String(v)]));
    if ([...qs].length) url += `?${qs.toString()}`;
  } else {
    headers['content-type'] = 'application/json';
    o.body = JSON.stringify(clean);
  }
  o.headers = headers;
  o.maxBytes ??= 256 * 1024;
  o.timeoutMs ??= 10_000;
  try {
    const r = await safeFetch(url, o);
    const text = redact(r.body.toString('utf8'), secrets);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, contentType: r.headers['content-type'], json, elapsedMs: r.elapsedMs, bodyBytes: r.body.length, bodyText: text, truncated: false, connectedTo: r.connectedTo };
  } catch (e) {
    if (e instanceof EgressError) {
      const m = redact(e.message, secrets);
      if (e.code === 'TIMEOUT') throw new GatewayError('UPSTREAM_TIMEOUT', m);
      if (['ADDRESS_BLOCKED', 'HOST_BLOCKED', 'REDIRECT_BLOCKED', 'SCHEME_NOT_ALLOWED', 'PORT_NOT_ALLOWED'].includes(e.code)) throw new GatewayError('EGRESS_BLOCKED', m);
      throw new GatewayError('UPSTREAM_UNREACHABLE', m);
    }
    throw new GatewayError('UPSTREAM_UNREACHABLE', redact((e as Error).message, secrets));
  } finally {
    secrets.length = 0;
  }
}
