// The outbound gateway: the ONLY place a marketplace request leaves the server for a seller's API.
//
// THREAT: a seller (or a buyer-controlled parameter) points Payrail at something it must never reach:
//   localhost, private networks, cloud metadata (169.254.169.254), link-local, internal DNS names, or a public
//   name that RESOLVES to such an address (including after a redirect, or a DNS answer that changes between a
//   check and the connection = "DNS rebinding").
//
// DEFENCES (each is covered by a test)
//   1. https only, port 443 only, no URL credentials, no single-label or internal-looking host names.
//   2. DNS is resolved HERE, once. EVERY returned address must be public; one bad address rejects the host.
//   3. The connection is made to that resolved address (pinned) while TLS still verifies the host name, so a second
//      DNS lookup can never redirect the request.
//   4. Redirects are not followed by default; if allowed, every hop is validated from scratch.
//   5. Strict deadline, response-size cap (streamed), `accept-encoding: identity`, header allow-lists both ways,
//      CR/LF-safe headers, hop-by-hop headers stripped, a small method allow-list.
//   6. A per-key token-bucket rate limiter.
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class EgressError extends Error {
  code:
    | 'URL_INVALID' | 'SCHEME_NOT_ALLOWED' | 'USERINFO_NOT_ALLOWED' | 'PORT_NOT_ALLOWED' | 'HOST_BLOCKED' | 'ADDRESS_BLOCKED'
    | 'DNS_FAILED' | 'REDIRECT_BLOCKED' | 'TOO_MANY_REDIRECTS' | 'RESPONSE_TOO_LARGE' | 'TIMEOUT' | 'NETWORK'
    | 'HEADER_INVALID' | 'METHOD_NOT_ALLOWED' | 'RATE_LIMITED';
  constructor(code: EgressError['code'], message: string) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ address classification

function ipv4Bytes(ip: string): number[] | undefined {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return undefined;
  const b = m.slice(1).map(Number);
  return b.every((n) => n >= 0 && n <= 255) ? b : undefined;
}

/** Expand an IPv6 literal to 16 bytes (handles `::` and an embedded dotted IPv4 tail). */
function ipv6Bytes(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split('%')[0]!;
  if (isIP(s) !== 6) return undefined;
  const tail = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const v4 = ipv4Bytes(tail[2]!);
    if (!v4) return undefined;
    s = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, rest, extra] = s.split('::');
  if (extra !== undefined) return undefined;
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return undefined;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return undefined;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

/** Why an IPv4 address (as 4 bytes) must not be contacted, or undefined if it is a public unicast address. */
function blockedV4(b: number[]): string | undefined {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  if (a === 0) return 'this-network (0.0.0.0/8)';
  if (a === 10) return 'private network (10.0.0.0/8)';
  if (a === 100 && c >= 64 && c <= 127) return 'carrier-grade NAT (100.64.0.0/10)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && c === 254) return 'link-local / cloud metadata (169.254.0.0/16)';
  if (a === 172 && c >= 16 && c <= 31) return 'private network (172.16.0.0/12)';
  if (a === 192 && c === 0 && d === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && c === 0 && d === 2) return 'documentation range (192.0.2.0/24)';
  if (a === 192 && c === 88 && d === 99) return '6to4 relay (192.88.99.0/24)';
  if (a === 192 && c === 168) return 'private network (192.168.0.0/16)';
  if (a === 198 && (c === 18 || c === 19)) return 'benchmarking (198.18.0.0/15)';
  if (a === 198 && c === 51 && d === 100) return 'documentation range (198.51.100.0/24)';
  if (a === 203 && c === 0 && d === 113) return 'documentation range (203.0.113.0/24)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'reserved / broadcast (240.0.0.0/4)';
  return undefined;
}

/** Why an IP literal must not be contacted (any form: IPv4, IPv6, mapped, NAT64, 6to4), or undefined if public. */
export function blockedAddressReason(ip: string): string | undefined {
  const v4 = ipv4Bytes(ip);
  if (v4) return blockedV4(v4);
  const b = ipv6Bytes(ip);
  if (!b) return 'not a valid IP address';
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 15) && (b[15] === 0 || b[15] === 1)) return b[15] === 1 ? 'IPv6 loopback (::1)' : 'IPv6 unspecified (::)';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4 address
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12)) ?? undefined;
  if (allZero(0, 12) && !(allZero(12, 16))) return blockedV4(b.slice(12)) ?? 'IPv4-compatible IPv6 address';
  // NAT64 (64:ff9b::/96): judge the embedded IPv4 address
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return blockedV4(b.slice(12)) ?? 'NAT64 translation prefix';
  if (b[0] === 0x01 && allZero(1, 8)) return 'discard prefix (100::/64)';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'Teredo (2001::/32)';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation range (2001:db8::/32)';
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)) ?? '6to4 tunnel (2002::/16)';
  if ((b[0]! & 0xfe) === 0xfc) return 'unique local address (fc00::/7)';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'site-local (fec0::/10)';
  if (b[0] === 0xff) return 'multicast (ff00::/8)';
  return undefined;
}

// ------------------------------------------------------------------ URL validation

export interface UrlRules {
  allowedPorts?: readonly number[];
}

/** Validate a destination WITHOUT any network access. Returns the parts the connection will use. */
export function validateDestination(raw: string, rules: UrlRules = {}): { url: URL; hostname: string; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('URL_INVALID', 'the address is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new EgressError('SCHEME_NOT_ALLOWED', 'only https:// addresses are allowed');
  if (url.username || url.password) throw new EgressError('USERINFO_NOT_ALLOWED', 'addresses with embedded credentials are not allowed');
  const ports = rules.allowedPorts ?? [443];
  const port = url.port === '' ? 443 : Number(url.port);
  if (!ports.includes(port)) throw new EgressError('PORT_NOT_ALLOWED', `port ${port} is not allowed`);
  let hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname === '') throw new EgressError('URL_INVALID', 'the address has no host');
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) !== 0) {
    const why = blockedAddressReason(literal);
    if (why) throw new EgressError('ADDRESS_BLOCKED', `the address ${literal} is not allowed: ${why}`);
    // a public IP literal has no certificate name to verify against; names are required
    throw new EgressError('HOST_BLOCKED', 'use a host name, not an IP address');
  }
  if (!hostname.includes('.')) throw new EgressError('HOST_BLOCKED', 'single-label (internal) host names are not allowed');
  if (/(^|\.)(localhost|local|internal|intranet|lan|corp|home|localdomain|home\.arpa)$/.test(hostname)) {
    throw new EgressError('HOST_BLOCKED', `the host ${hostname} looks internal`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    throw new EgressError('HOST_BLOCKED', 'the host name contains characters that are not allowed');
  }
  return { url, hostname, port };
}

// ------------------------------------------------------------------ rate limiting

/** Token bucket per key. Deterministic with an injected clock. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private capacity: number;
  private refillPerSecond: number;
  private now: () => number;
  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
  }
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSecond);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
}

// ------------------------------------------------------------------ the request

export interface EgressRequest {
  ip: string;
  family: 4 | 6;
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  timeoutMs: number;
  maxBytes: number;
}
export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type Transport = (req: EgressRequest) => Promise<EgressResponse>;
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  /** 0 (default) = a redirect is an error. When > 0, every hop is validated from scratch. */
  maxRedirects?: number;
  allowedPorts?: readonly number[];
  resolver?: Resolver;
  transport?: Transport;
}

export interface FetchResult {
  status: number;
  /** only allow-listed response headers */
  headers: Record<string, string>;
  body: Buffer;
  /** the address that was actually connected to (for audit) */
  connectedTo: string;
  elapsedMs: number;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const BLOCKED_REQUEST_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'expect', 'accept-encoding', 'cookie']);
const KEPT_RESPONSE_HEADERS = ['content-type', 'content-length', 'date', 'cache-control', 'retry-after', 'etag', 'last-modified', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

const defaultResolver: Resolver = async (h) => (await dnsLookup(h, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/** The real transport: HTTPS to the PINNED address, verifying the certificate for the host name. */
export const httpsTransport: Transport = (r) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: r.hostname,
        port: r.port,
        path: r.path,
        method: r.method,
        headers: r.headers,
        servername: r.hostname,
        timeout: r.timeoutMs,
        // pin: the socket connects to the address we validated; the host name is only used for SNI/certificate checks
        lookup: (_h, _o, cb) => (cb as unknown as (e: Error | null, a: string, f: number) => void)(null, r.ip, r.family),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > r.maxBytes) {
            req.destroy();
            reject(new EgressError('RESPONSE_TOO_LARGE', `the response exceeded ${r.maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', (e) => reject(new EgressError('NETWORK', e.message.slice(0, 120))));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new EgressError('TIMEOUT', `no response within ${r.timeoutMs} ms`));
    });
    req.on('error', (e) => reject(e instanceof EgressError ? e : new EgressError('NETWORK', e.message.slice(0, 120))));
    if (r.body) req.write(r.body);
    req.end();
  });

function cleanHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k)) throw new EgressError('HEADER_INVALID', `invalid header name ${JSON.stringify(k.slice(0, 40))}`);
    if (typeof v !== 'string' || /[\r\n\0]/.test(v) || v.length > 4096) throw new EgressError('HEADER_INVALID', `invalid value for header ${k}`);
    if (BLOCKED_REQUEST_HEADERS.has(k.toLowerCase())) throw new EgressError('HEADER_INVALID', `the header ${k} cannot be set`);
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Perform one outbound request with every defence above. Throws EgressError; never returns a partial response.
 * The deadline covers DNS, connection and the whole response.
 */
export async function safeFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const method = (opts.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new EgressError('METHOD_NOT_ALLOWED', `method ${method} is not allowed`);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 100), 30_000);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? 1_000_000, 1), 10_000_000);
  const maxRedirects = Math.min(Math.max(opts.maxRedirects ?? 0, 0), 3);
  const resolver = opts.resolver ?? defaultResolver;
  const transport = opts.transport ?? httpsTransport;
  const headers = cleanHeaders(opts.headers);
  const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  if (body && body.length > 256 * 1024) throw new EgressError('HEADER_INVALID', 'the request body is too large');

  let current = rawUrl;
  let hops = 0;
  for (;;) {
    const { url, hostname, port } = validateDestination(current, opts.allowedPorts ? { allowedPorts: opts.allowedPorts } : {});
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new EgressError('TIMEOUT', 'the deadline passed before the request was sent');

    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await Promise.race([
        resolver(hostname),
        new Promise<never>((_, rej) => setTimeout(() => rej(new EgressError('TIMEOUT', 'DNS resolution timed out')), remaining)),
      ]);
    } catch (e) {
      if (e instanceof EgressError) throw e;
      throw new EgressError('DNS_FAILED', `could not resolve ${hostname}`);
    }
    if (answers.length === 0) throw new EgressError('DNS_FAILED', `no addresses for ${hostname}`);
    // ONE bad address rejects the host: an attacker-controlled name may mix public and private answers
    for (const a of answers) {
      const why = blockedAddressReason(a.address);
      if (why) throw new EgressError('ADDRESS_BLOCKED', `${hostname} resolves to ${a.address}, which is not allowed: ${why}`);
    }
    const pick = answers.find((a) => a.family === 4) ?? answers[0]!;

    const reqHeaders: Record<string, string> = {
      ...headers,
      host: port === 443 ? hostname : `${hostname}:${port}`,
      'user-agent': 'Payrail-Gateway/1',
      'accept-encoding': 'identity',
      connection: 'close',
    };
    if (body) reqHeaders['content-length'] = String(body.length);

    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new EgressError('TIMEOUT', 'the deadline passed before the request was sent');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      transport({
        ip: pick.address,
        family: pick.family === 6 ? 6 : 4,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: reqHeaders,
        body,
        timeoutMs: left,
        maxBytes,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new EgressError('TIMEOUT', `no complete response within ${timeoutMs} ms`)), left);
      }),
    ]).finally(() => timer && clearTimeout(timer));

    if (res.body.length > maxBytes) throw new EgressError('RESPONSE_TOO_LARGE', `the response exceeded ${maxBytes} bytes`);

    if (res.status >= 300 && res.status < 400 && res.headers['location'] !== undefined) {
      if (maxRedirects === 0) throw new EgressError('REDIRECT_BLOCKED', `the service redirected (HTTP ${res.status}); redirects are not followed`);
      if (++hops > maxRedirects) throw new EgressError('TOO_MANY_REDIRECTS', 'too many redirects');
      current = new URL(res.headers['location']!, url).toString(); // validated from scratch on the next loop
      continue;
    }
    const kept: Record<string, string> = {};
    for (const k of KEPT_RESPONSE_HEADERS) if (res.headers[k] !== undefined) kept[k] = res.headers[k]!.slice(0, 200);
    return { status: res.status, headers: kept, body: res.body, connectedTo: pick.address, elapsedMs: Date.now() - started };
  }
}
