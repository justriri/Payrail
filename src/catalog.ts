// Service catalog: fetch, validate, normalize, search, cache.
//
// TRUST MODEL. Everything in a catalog is third-party data:
//  - text fields (title, description, ...) are sanitized and used for DISPLAY and SEARCH only;
//    no policy decision ever reads them;
//  - prices are INDICATIVE. The HTTP 402 challenge (requirements.ts) is the only price authority;
//  - being listed proves nothing about safety. Whether an endpoint may be contacted or paid is decided
//    by policy.ts (host allow-list, auto-pay allow-list), never by the catalog.
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

export const DEFAULT_CATALOG_URL = 'https://gateway.usebuy.ai/v1/catalog';

export class CatalogError extends Error {
  code: 'FETCH_FAILED' | 'TIMEOUT' | 'TOO_LARGE' | 'NOT_JSON' | 'MALFORMED';
  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

export interface PriceOption {
  /** e.g. "durationMinutes=5" */
  label: string;
  atomic: bigint;
  usd: string;
}

export interface IndicativePrice {
  /** Always true: a catalog price is never authoritative. */
  indicative: true;
  model: string;
  /** Lowest and highest listed amounts, atomic units of a 6-decimal stablecoin. */
  minAtomic: bigint;
  maxAtomic: bigint;
  usd: string;
  options: PriceOption[];
  tokens: string[];
}

export interface Service {
  id: string;
  /** UNTRUSTED display text. */
  title: string;
  /** UNTRUSTED display text. */
  description: string;
  platform: string;
  provider: string | undefined;
  method: string;
  url: string;
  available: boolean;
  price: IndicativePrice | undefined;
  /** UNTRUSTED. Used only to validate request bodies before an unpaid request. */
  inputSchema: Record<string, unknown> | undefined;
}

export interface CatalogPaymentFacts {
  protocol: string;
  x402Version: number;
  network: string;
  chainId: number;
  payTo: Address | undefined;
  tokens: Array<{ symbol: string; address: Address; decimals: number }>;
}

export interface Catalog {
  fetchedAt: number;
  source: string;
  payment: CatalogPaymentFacts;
  services: Service[];
  /** Entries that were dropped, with the reason. A bad entry never poisons the rest. */
  rejected: Array<{ index: number; id: string | undefined; reason: string }>;
  /** True when this is a cached copy served because a refresh failed. */
  stale: boolean;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strip control and bidi-override characters, collapse whitespace, bound the length. */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ');
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METHODS = new Set(['GET', 'POST']);

function parsePrice(entry: Json): IndicativePrice | undefined {
  const model = sanitizeText(entry.pricingModel ?? (isRecord(entry.price) ? entry.price.pricingModel : ''), 40) || 'unknown';
  const toOption = (o: Json, label: string): PriceOption | undefined => {
    if (typeof o.atomic !== 'string' || !/^\d+$/.test(o.atomic)) return undefined;
    return { label, atomic: BigInt(o.atomic), usd: sanitizeText(o.usd, 24) };
  };
  const tokens = (o: Json) =>
    Array.isArray(o.tokens) ? o.tokens.filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9]{1,16}$/.test(t)) : [];

  if (Array.isArray(entry.priceOptions) && entry.priceOptions.length > 0) {
    const options: PriceOption[] = [];
    let tokenList: string[] = [];
    for (const raw of entry.priceOptions) {
      if (!isRecord(raw)) continue;
      const label = Object.entries(raw)
        .filter(([k, v]) => !['usd', 'atomic', 'tokens', 'prorated'].includes(k) && (typeof v === 'string' || typeof v === 'number'))
        .map(([k, v]) => `${sanitizeText(k, 24)}=${sanitizeText(String(v), 24)}`)
        .join(', ');
      const opt = toOption(raw, label || 'option');
      if (opt) {
        options.push(opt);
        if (tokenList.length === 0) tokenList = tokens(raw);
      }
    }
    if (options.length === 0) return undefined;
    const amounts = options.map((o) => o.atomic);
    const min = amounts.reduce((a, b) => (b < a ? b : a));
    const max = amounts.reduce((a, b) => (b > a ? b : a));
    return { indicative: true, model, minAtomic: min, maxAtomic: max, usd: options.find((o) => o.atomic === min)!.usd, options, tokens: tokenList };
  }
  if (isRecord(entry.price)) {
    const opt = toOption(entry.price, 'default');
    if (!opt) return undefined;
    return { indicative: true, model, minAtomic: opt.atomic, maxAtomic: opt.atomic, usd: opt.usd, options: [opt], tokens: tokens(entry.price) };
  }
  return undefined;
}

function parseService(raw: unknown, index: number, seen: Set<string>): { service?: Service; reject?: string; id?: string } {
  if (!isRecord(raw)) return { reject: 'entry is not an object' };
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (id === undefined || !ID_RE.test(id)) return { id, reject: 'missing or invalid id' };
  if (seen.has(id)) return { id, reject: 'duplicate id' };
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : '';
  if (!METHODS.has(method)) return { id, reject: `unsupported method ${JSON.stringify(sanitizeText(raw.method, 12))}` };
  if (typeof raw.url !== 'string') return { id, reject: 'missing url' };
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return { id, reject: 'url is not valid' };
  }
  if (url.protocol !== 'https:') return { id, reject: 'url is not https' };
  if (url.username || url.password) return { id, reject: 'url contains credentials' };

  const agent = isRecord(raw.agent) ? raw.agent : {};
  let inputSchema: Record<string, unknown> | undefined;
  if (isRecord(raw.inputSchema)) {
    try {
      if (JSON.stringify(raw.inputSchema).length <= 20_000) inputSchema = raw.inputSchema;
    } catch {
      inputSchema = undefined;
    }
  }
  seen.add(id);
  void index;
  return {
    id,
    service: {
      id,
      title: sanitizeText(raw.title, 120) || id,
      description: sanitizeText(raw.description, 500),
      platform: sanitizeText(raw.platform, 40) || 'unknown',
      provider: sanitizeText(agent.provider, 60) || undefined,
      method,
      url: url.toString(),
      available: raw.available === true,
      price: parsePrice(raw),
      inputSchema,
    },
  };
}

/** Pure: raw catalog JSON -> normalized Catalog. Throws CatalogError('MALFORMED') only if the whole document is unusable. */
export function normalizeCatalog(raw: unknown, now: number, source = DEFAULT_CATALOG_URL): Catalog {
  if (!isRecord(raw)) throw new CatalogError('MALFORMED', 'catalog is not a JSON object');
  if (!Array.isArray(raw.capabilities)) throw new CatalogError('MALFORMED', 'catalog has no capabilities array');
  if (!isRecord(raw.payment)) throw new CatalogError('MALFORMED', 'catalog has no payment block');
  const p = raw.payment;

  const tokens: CatalogPaymentFacts['tokens'] = [];
  if (Array.isArray(p.tokens)) {
    for (const t of p.tokens) {
      if (!isRecord(t) || typeof t.symbol !== 'string') continue;
      // The live catalog calls the token contract field "asset"; "address" is accepted as a fallback.
      const addr = typeof t.asset === 'string' ? t.asset : typeof t.address === 'string' ? t.address : undefined;
      if (addr !== undefined && isAddress(addr)) {
        tokens.push({ symbol: sanitizeText(t.symbol, 16), address: getAddress(addr), decimals: Number(t.decimals) });
      }
    }
  }
  const payment: CatalogPaymentFacts = {
    protocol: sanitizeText(p.protocol, 20),
    x402Version: Number(p.x402Version),
    network: sanitizeText(p.network, 40),
    chainId: Number(p.chainId),
    payTo: typeof p.payTo === 'string' && isAddress(p.payTo) ? getAddress(p.payTo) : undefined,
    tokens,
  };

  const services: Service[] = [];
  const rejected: Catalog['rejected'] = [];
  const seen = new Set<string>();
  raw.capabilities.forEach((entry, index) => {
    const r = parseService(entry, index, seen);
    if (r.service) services.push(r.service);
    else rejected.push({ index, id: r.id, reason: r.reject ?? 'unknown' });
  });
  return { fetchedAt: now, source, payment, services, rejected, stale: false };
}

// ------------------------------------------------------------------ client with a freshness policy

export interface CatalogClientOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Cached copy is served without a network call for this long. Default 5 minutes. */
  ttlMs?: number;
  /** If a refresh fails, a cached copy up to this old is served and flagged stale. Default 1 hour. */
  maxStaleMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createCatalogClient(opts: CatalogClientOptions = {}) {
  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxStaleMs = opts.maxStaleMs ?? 60 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let cached: Catalog | undefined;

  async function load(): Promise<Catalog> {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new CatalogError(timedOut ? 'TIMEOUT' : 'FETCH_FAILED', `catalog request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new CatalogError('FETCH_FAILED', `catalog HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new CatalogError('TOO_LARGE', `catalog is ${text.length} bytes (limit ${maxBytes})`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CatalogError('NOT_JSON', 'catalog response is not JSON');
    }
    return normalizeCatalog(json, now(), url);
  }

  return {
    /** Returns a fresh-enough catalog. `forceRefresh` bypasses the TTL. Never serves data older than maxStaleMs. */
    async get(options: { forceRefresh?: boolean } = {}): Promise<Catalog> {
      if (cached && !options.forceRefresh && now() - cached.fetchedAt < ttlMs) return cached;
      try {
        cached = await load();
        return cached;
      } catch (e) {
        if (cached && now() - cached.fetchedAt < maxStaleMs) return { ...cached, stale: true };
        throw e;
      }
    },
    clear(): void {
      cached = undefined;
    },
  };
}

// ------------------------------------------------------------------ search / filter

export interface ServiceFilter {
  query?: string;
  platform?: string;
  availableOnly?: boolean;
  method?: string;
  /** Only services whose indicative minimum price is at or below this (atomic units). */
  maxPriceAtomic?: bigint;
  ids?: string[];
}

export function searchServices(services: readonly Service[], f: ServiceFilter = {}): Service[] {
  const terms = (f.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ s: Service; score: number }> = [];
  for (const s of services) {
    if (f.platform && s.platform.toLowerCase() !== f.platform.toLowerCase()) continue;
    if (f.availableOnly && !s.available) continue;
    if (f.method && s.method !== f.method.toUpperCase()) continue;
    if (f.ids && !f.ids.includes(s.id)) continue;
    if (f.maxPriceAtomic !== undefined && (s.price === undefined || s.price.minAtomic > f.maxPriceAtomic)) continue;
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const inId = s.id.toLowerCase().includes(t);
      const inTitle = s.title.toLowerCase().includes(t);
      const inDesc = s.description.toLowerCase().includes(t);
      const inPlatform = s.platform.toLowerCase().includes(t);
      if (!inId && !inTitle && !inDesc && !inPlatform) {
        ok = false;
        break;
      }
      score += (inId ? 4 : 0) + (inTitle ? 3 : 0) + (inPlatform ? 2 : 0) + (inDesc ? 1 : 0);
    }
    if (ok) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id));
  return scored.map((x) => x.s);
}
