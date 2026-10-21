// Textile FX v2 RFQ client (read/quote only: it never signs or broadcasts a transaction).
// Endpoints and fields follow docs.textilecredit.com/api/v2 and the live /v2/openapi.json.
// Responses are validated at runtime; unexpected shapes are reported, not assumed.
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

export const TEXTILE_API = 'https://api.textilecredit.com/v2';

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class TextileError extends Error {
  httpStatus: number;
  code: string;
  reason: string | undefined;
  requestId: string | undefined;
  details: unknown;
  constructor(
    message: string,
    info: { httpStatus: number; code: string; reason?: string; requestId?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'TextileError';
    this.httpStatus = info.httpStatus;
    this.code = info.code;
    this.reason = info.reason;
    this.requestId = info.requestId;
    this.details = info.details;
  }
}

async function post(path: string, body: unknown, timeoutMs = 75_000) {
  const res = await fetch(TEXTILE_API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const rateRemaining = res.headers.get('x-ratelimit-remaining') ?? undefined;
  if (!res.ok) {
    const err = isRecord(json) && isRecord(json.error) ? json.error : {};
    const details = isRecord(err.details) ? err.details : undefined;
    throw new TextileError(String(err.message ?? `HTTP ${res.status}`), {
      httpStatus: res.status,
      code: String(err.code ?? 'unknown'),
      reason: details && typeof details.reason === 'string' ? details.reason : undefined,
      requestId: typeof err.request_id === 'string' ? err.request_id : requestId,
      details,
    });
  }
  return { json, requestId, rateRemaining };
}

/** Read-only GET. A transient failure (DNS hiccup, reset, timeout, HTTP 429/5xx) is retried a couple of times: a one-off blip must not look like "Textile lists nothing". */
async function get(path: string, timeoutMs = 20_000, attempts = 3) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(TEXTILE_API + path, { signal: AbortSignal.timeout(timeoutMs) });
      const json: unknown = await res.json().catch(() => undefined);
      if (res.ok) return json;
      last = new TextileError(`HTTP ${res.status}`, { httpStatus: res.status, code: 'http_error' });
      if (res.status !== 429 && res.status < 500) throw last; // a definite answer (404, 400...) is not retried
    } catch (e) {
      if (e instanceof TextileError && e.httpStatus > 0 && e.httpStatus !== 429 && e.httpStatus < 500) throw e;
      last = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1) ** 2));
  }
  throw last;
}

function unwrap(json: unknown): Json {
  if (!isRecord(json)) throw new Error('Textile response is not a JSON object');
  return isRecord(json.data) ? json.data : json;
}

function atomic(v: unknown, field: string): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`Textile response field "${field}" is missing or not an atomic-unit string`);
}

// ---------------------------------------------------------------- levels (public ladder)

export interface PairLevel {
  minSellAmount: bigint;
  maxSellAmount: bigint;
  levelCount: number;
}

export async function getPairLevel(chainId: number, sellToken: Address, buyToken: Address): Promise<PairLevel | undefined> {
  const d = unwrap(await get(`/rfq/levels?chainId=${chainId}`));
  const pairs = Array.isArray(d.pairs) ? d.pairs : [];
  for (const p of pairs) {
    if (!isRecord(p)) continue;
    if (
      String(p.sellToken).toLowerCase() === sellToken.toLowerCase() &&
      String(p.buyToken).toLowerCase() === buyToken.toLowerCase()
    ) {
      const levels = Array.isArray(p.levels) ? p.levels : [];
      if (levels.length === 0) return undefined; // listed but no liquidity
      return {
        minSellAmount: atomic(p.minSellAmount, 'minSellAmount'),
        maxSellAmount: atomic(p.maxSellAmount, 'maxSellAmount'),
        levelCount: levels.length,
      };
    }
  }
  return undefined;
}

export interface LadderPair {
  sellToken: Address;
  buyToken: Address;
  minSellAmount: bigint;
  maxSellAmount: bigint;
  /** Indicative (sell, buy) points, ascending. Empty means no liquidity right now. */
  levels: Array<{ sellAmount: bigint; buyAmount: bigint }>;
}

/** The whole public price ladder for a chain (GET /v2/rfq/levels). No auth, reserves nothing. */
export async function getLadder(chainId: number): Promise<{ asOf: string | undefined; pairs: LadderPair[] }> {
  const d = unwrap(await get(`/rfq/levels?chainId=${chainId}`));
  const pairs: LadderPair[] = [];
  for (const p of Array.isArray(d.pairs) ? d.pairs : []) {
    if (!isRecord(p) || typeof p.sellToken !== 'string' || typeof p.buyToken !== 'string') continue;
    const levels: LadderPair['levels'] = [];
    for (const l of Array.isArray(p.levels) ? p.levels : []) {
      if (isRecord(l) && typeof l.sellAmount === 'string' && typeof l.buyAmount === 'string' && /^\d+$/.test(l.sellAmount) && /^\d+$/.test(l.buyAmount)) {
        levels.push({ sellAmount: BigInt(l.sellAmount), buyAmount: BigInt(l.buyAmount) });
      }
    }
    pairs.push({
      sellToken: getAddress(p.sellToken),
      buyToken: getAddress(p.buyToken),
      minSellAmount: typeof p.minSellAmount === 'string' && /^\d+$/.test(p.minSellAmount) ? BigInt(p.minSellAmount) : 0n,
      maxSellAmount: typeof p.maxSellAmount === 'string' && /^\d+$/.test(p.maxSellAmount) ? BigInt(p.maxSellAmount) : 0n,
      levels,
    });
  }
  return { asOf: typeof d.asOf === 'string' ? d.asOf : undefined, pairs };
}

// ---------------------------------------------------------------- preview (indicative)

export type PreviewResult =
  | {
      kind: 'preview';
      sellAmount: bigint;
      buyAmount: bigint;
      feeAmount: bigint;
      takerPays: bigint;
      rateRay: string | undefined;
      availableSellAmount: bigint | undefined;
      requestId: string | undefined;
      rateRemaining: string | undefined;
    }
  | { kind: 'no_quote'; reason: string | undefined; requestId: string | undefined };

export async function preview(args: {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
}): Promise<PreviewResult> {
  const { json, requestId, rateRemaining } = await post('/rfq/preview', {
    chainId: args.chainId,
    sellToken: args.sellToken,
    buyToken: args.buyToken,
    sellAmount: args.sellAmount.toString(),
  });
  const d = unwrap(json);
  if (d.status === 'no_quote') {
    return { kind: 'no_quote', reason: typeof d.reason === 'string' ? d.reason : undefined, requestId };
  }
  if (d.status !== 'preview') {
    throw new Error(`Unexpected preview status ${JSON.stringify(d.status)} (keys: ${Object.keys(d).join(', ')})`);
  }
  return {
    kind: 'preview',
    sellAmount: atomic(d.sellAmount, 'sellAmount'),
    buyAmount: atomic(d.buyAmount, 'buyAmount'),
    feeAmount: atomic(d.feeAmount, 'feeAmount'),
    takerPays: atomic(d.takerPays, 'takerPays'),
    rateRay: typeof d.rateRay === 'string' ? d.rateRay : undefined,
    availableSellAmount: typeof d.availableSellAmount === 'string' ? atomic(d.availableSellAmount, 'availableSellAmount') : undefined,
    requestId,
    rateRemaining,
  };
}

// ---------------------------------------------------------------- firm quote

export interface TakerProof {
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
}

export interface Instruction {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
}

/**
 * A credential that can never leak through logging or JSON: it serializes as "[redacted]" and only
 * reveal() returns the value. Used for the Textile claim token.
 */
export interface Secret {
  reveal(): string;
  toJSON(): string;
  toString(): string;
}

export function secret(value: string): Secret {
  const s = {
    reveal: () => value,
    toJSON: () => '[redacted]',
    toString: () => '[redacted]',
    [Symbol.for('nodejs.util.inspect.custom')]: () => '[redacted]',
  };
  return Object.freeze(s) as Secret;
}

export type RfqStatusName = 'soliciting' | 'quoted' | 'no_quote' | 'submitted' | 'filled' | 'failed' | 'expired' | 'unknown';

export interface RfqStatusView {
  status: RfqStatusName;
  txHash: string | undefined;
  filledAt: string | undefined;
  failReason: string | undefined;
  /** True once the 24h window in which failed/expired can still flip to filled has closed. */
  lateFillCorrectionClosed: boolean;
  sellAmount: bigint | undefined;
  buyAmount: bigint | undefined;
  feeAmount: bigint | undefined;
}

const STATUS_NAMES = new Set(['soliciting', 'quoted', 'no_quote', 'submitted', 'filled', 'failed', 'expired']);

/** GET /v2/rfq/{id}. Needs the claim token; never replays the signed order. */
export async function getRfqStatus(id: string, claimToken: Secret, timeoutMs = 30_000): Promise<RfqStatusView> {
  const res = await fetch(`${TEXTILE_API}/rfq/${encodeURIComponent(id)}`, {
    headers: { 'X-Rfq-Claim': claimToken.reveal() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = isRecord(json) && isRecord(json.error) ? json.error : {};
    throw new TextileError(String(err.message ?? `HTTP ${res.status}`), { httpStatus: res.status, code: String(err.code ?? 'http_error') });
  }
  const d = unwrap(json);
  const opt = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : undefined);
  return {
    status: typeof d.status === 'string' && STATUS_NAMES.has(d.status) ? (d.status as RfqStatusName) : 'unknown',
    txHash: typeof d.txHash === 'string' ? d.txHash : undefined,
    filledAt: typeof d.filledAt === 'string' ? d.filledAt : undefined,
    failReason: typeof d.failReason === 'string' ? d.failReason : undefined,
    lateFillCorrectionClosed: d.lateFillCorrectionClosed === true,
    sellAmount: opt(d.sellAmount),
    buyAmount: opt(d.buyAmount),
    feeAmount: opt(d.feeAmount),
  };
}

/** POST /v2/rfq/{id}/cancel: tells the maker the quote is abandoned (frees its inventory hold; not the slot). */
export async function cancelRfq(id: string, claimToken: Secret, timeoutMs = 30_000): Promise<void> {
  const res = await fetch(`${TEXTILE_API}/rfq/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'X-Rfq-Claim': claimToken.reveal() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 409 means it is no longer in the quoted state (already expired/filled): nothing to release.
  if (!res.ok && res.status !== 409) throw new TextileError(`cancel HTTP ${res.status}`, { httpStatus: res.status, code: 'cancel_failed' });
}

export type FirmQuoteResult =
  | { kind: 'no_quote'; reason: string | undefined; requestId: string | undefined }
  | {
      kind: 'quoted';
      /** Contract the taker must approve and that transactions.swap targets (equals reactor on an ordinary quote). */
      spender: Address | undefined;
      /** The signed order exactly as returned (public data; returned once by the API). */
      encodedOrder: Hex | undefined;
      /** Number of signed orders in the quote (>1 means a bundle, which Payrail does not execute yet). */
      ordersCount: number;
      /** Ownership credential for status/cancel. In memory only; never logged or persisted. */
      claimToken: Secret | undefined;
      id: string;
      /** Which key carried the id ("rfqId" per docs, or "id" as in the status schema). */
      idField: string;
      status: string;
      sellAmount: bigint;
      buyAmount: bigint;
      feeAmount: bigint;
      takerPays: bigint;
      reactor: Address;
      taker: Address;
      approval: Instruction;
      swap: Instruction;
      /** Raw deadline fields exactly as returned (format is not assumed). */
      deadlines: Record<string, unknown>;
      /** The claim token itself is deliberately dropped here; only its presence is reported. */
      hasClaimToken: boolean;
      topLevelKeys: string[];
      quoteKeys: string[];
      /** Anything that differed from the documentation. */
      notes: string[];
      requestId: string | undefined;
    };

function instruction(v: unknown, label: string): Instruction {
  if (!isRecord(v)) throw new Error(`transactions.${label} is missing or not an object`);
  if (typeof v.to !== 'string' || typeof v.data !== 'string') {
    throw new Error(`transactions.${label} lacks "to" and/or "data"`);
  }
  return {
    to: getAddress(v.to),
    data: v.data as Hex,
    value: String(v.value ?? '0'),
    chainId: Number(v.chainId),
  };
}

export async function firmQuote(args: {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  takerProof: TakerProof;
}): Promise<FirmQuoteResult> {
  const { json, requestId } = await post('/rfq/request', {
    chainId: args.chainId,
    sellToken: args.sellToken,
    buyToken: args.buyToken,
    sellAmount: args.sellAmount.toString(),
    taker: args.taker,
    takerProof: args.takerProof,
  });
  const d = unwrap(json);
  if (d.status === 'no_quote') {
    return { kind: 'no_quote', reason: typeof d.reason === 'string' ? d.reason : undefined, requestId };
  }
  if (d.status !== 'quoted') {
    throw new Error(`Unexpected firm-quote status ${JSON.stringify(d.status)} (keys: ${Object.keys(d).join(', ')})`);
  }

  const notes: string[] = [];
  const quote = isRecord(d.quote) ? d.quote : undefined;
  if (!quote) throw new Error('firm quote has no "quote" object');

  const pick = (key: string): unknown => (key in quote ? quote[key] : d[key]);

  const idField = typeof d.rfqId === 'string' ? 'rfqId' : typeof d.id === 'string' ? 'id' : '';
  if (idField === '') throw new Error('firm quote has neither "rfqId" nor "id"');
  if (idField !== 'rfqId') notes.push('quote id arrived as "id", not "rfqId" as documented');

  const tx = isRecord(d.transactions) ? d.transactions : isRecord(quote.transactions) ? quote.transactions : undefined;
  if (!tx) throw new Error('firm quote has no "transactions" object');

  const deadlines: Record<string, unknown> = {};
  for (const k of ['expiresAt', 'orderDeadline', 'latestOrderDeadline', 'reservedUntil']) {
    const v = pick(k);
    if (v !== undefined) deadlines[k] = v;
  }
  if (!('expiresAt' in deadlines)) notes.push('"expiresAt" was not present; do not execute without it');

  const taker = pick('taker');
  const reactor = pick('reactor');
  if (typeof taker !== 'string' || typeof reactor !== 'string') {
    throw new Error('firm quote lacks "taker" and/or "reactor"');
  }

  const spenderRaw = pick('spender');
  const orders = Array.isArray(quote.orders) ? quote.orders : Array.isArray(d.orders) ? d.orders : [];
  const encoded = pick('encodedOrder');
  return {
    kind: 'quoted',
    spender: typeof spenderRaw === 'string' ? getAddress(spenderRaw) : undefined,
    encodedOrder: typeof encoded === 'string' ? (encoded as Hex) : undefined,
    ordersCount: orders.length > 0 ? orders.length : 1,
    claimToken: typeof d.claimToken === 'string' && d.claimToken.length > 0 ? secret(d.claimToken) : undefined,
    id: String(d[idField]),
    idField,
    status: String(d.status),
    sellAmount: atomic(pick('sellAmount'), 'sellAmount'),
    buyAmount: atomic(pick('buyAmount'), 'buyAmount'),
    feeAmount: atomic(pick('feeAmount'), 'feeAmount'),
    takerPays: atomic(pick('takerPays'), 'takerPays'),
    reactor: getAddress(reactor),
    taker: getAddress(taker),
    approval: instruction(tx.approval, 'approval'),
    swap: instruction(tx.swap, 'swap'),
    deadlines,
    hasClaimToken: typeof d.claimToken === 'string' && d.claimToken.length > 0,
    topLevelKeys: Object.keys(d),
    quoteKeys: Object.keys(quote),
    notes,
    requestId,
  };
}
