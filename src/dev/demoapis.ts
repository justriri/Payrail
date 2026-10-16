// Two CONTROLLED demo APIs, served entirely in-process. They exist so the whole marketplace flow can be exercised
// end to end with predictable behaviour, including deliberate failures. They are never reachable from the internet and
// a normal listing can never be routed to them (only listings flagged `demo` use this network).
//
//   demo-prices.payrail.example  GET  /v1/price   id=eth|btc|celo  [scenario]   token price with an `asOf` timestamp
//   demo-echo.payrail.example    POST /v1/echo    text            [scenario]   returns the text with its length
//
// scenario (failure injection): ok | stale | http500 | html | empty | wrongtype | missing | hang | badkey
import type { Db } from '../db.ts';
import { lookup as dnsLookup, resolveTxt } from 'node:dns/promises';
import { httpsTransport } from '../egress.ts';
import type { EgressRequest, EgressResponse, Resolver, Transport } from '../egress.ts';
import { createAccount } from '../ledger.ts';
import { putCredential } from '../vault.ts';
import type { MasterKey } from '../vault.ts';
import { approveContract, proposeContract } from '../contracts.ts';
import { audit } from '../db.ts';
import { randomUUID } from 'node:crypto';

export const DEMO_PRICE_HOST = 'demo-prices.payrail.example';
export const DEMO_ECHO_HOST = 'demo-echo.payrail.example';
/** the key the demo price API expects; it lives only in the vault and this demo code */
export const DEMO_PRICE_KEY = 'demo-price-key-not-a-real-secret';

const PRICES: Record<string, number> = { eth: 2450.17, btc: 61250.5, celo: 0.42 };
const json = (status: number, body: unknown, type = 'application/json'): EgressResponse => ({ status, headers: { 'content-type': type }, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
const HANG = Symbol('hang');

function params(r: EgressRequest): Record<string, string> {
  const q = r.path.includes('?') ? r.path.slice(r.path.indexOf('?') + 1) : '';
  const o: Record<string, string> = Object.fromEntries(new URLSearchParams(q));
  if (r.body && r.body.length) {
    try {
      const b = JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(b)) o[k] = String(v);
    } catch {
      /* ignore */
    }
  }
  return o;
}

async function scenarioResponse(scenario: string, good: () => unknown): Promise<EgressResponse | typeof HANG> {
  switch (scenario) {
    case 'http500': return json(500, { error: 'internal error' });
    case 'html': return json(200, '<html><body>maintenance</body></html>', 'text/html');
    case 'empty': return json(200, '');
    case 'hang': return HANG;
    default: return json(200, good());
  }
}

export function demoHandler(r: EgressRequest, now: () => number): Promise<EgressResponse | typeof HANG> {
  const p = params(r);
  const scenario = p.scenario ?? 'ok';
  const path = r.path.split('?')[0];
  if (r.hostname === DEMO_PRICE_HOST && path === '/v1/price') {
    if (r.headers['x-api-key'] !== DEMO_PRICE_KEY || scenario === 'badkey') return Promise.resolve(json(401, { error: 'invalid api key' }));
    const id = (p.id ?? '').toLowerCase();
    if (!(id in PRICES)) return Promise.resolve(json(404, { error: 'unknown token' }));
    return scenarioResponse(scenario, () => {
      const base = { id, price: PRICES[id]!, currency: 'USD', asOf: new Date(scenario === 'stale' ? now() - 3_600_000 : now()).toISOString() };
      if (scenario === 'wrongtype') return { ...base, price: String(base.price) };
      if (scenario === 'missing') return { id, currency: 'USD', asOf: base.asOf };
      return base;
    });
  }
  if (r.hostname === DEMO_ECHO_HOST && path === '/v1/echo') {
    const text = p.text ?? '';
    return scenarioResponse(scenario, () => {
      const base = { text, length: text.length, echoedAt: new Date(now()).toISOString() };
      if (scenario === 'wrongtype') return { ...base, length: String(base.length) };
      if (scenario === 'missing') return { echoedAt: base.echoedAt };
      return base;
    });
  }
  return Promise.resolve(json(404, { error: 'not found' }));
}

/** A resolver + transport pair that serves ONLY the demo hosts. Any other host cannot be resolved. */
export function createDemoNetwork(now: () => number = Date.now): { resolver: Resolver; transport: Transport } {
  const resolver: Resolver = async (host) => {
    if (host === DEMO_PRICE_HOST || host === DEMO_ECHO_HOST) return [{ address: '93.184.216.34', family: 4 }];
    throw new Error(`demo network does not know ${host}`);
  };
  const transport: Transport = async (r) => {
    if (r.hostname !== DEMO_PRICE_HOST && r.hostname !== DEMO_ECHO_HOST) throw new Error('not a demo host');
    const res = await demoHandler(r, now);
    if (res === HANG) return new Promise<EgressResponse>(() => undefined);
    return res;
  };
  return { resolver, transport };
}

export const PRICE_CONTRACT = {
  schema: 1,
  success: {
    statuses: [200],
    contentType: 'application/json',
    maxLatencyMs: 2_000,
    fields: [{ path: 'price', type: 'number', min: 0 }, { path: 'id', type: 'string' }, { path: 'asOf', type: 'string' }],
    nonEmpty: ['id'],
    freshness: { path: 'asOf', maxAgeSeconds: 60, format: 'iso' },
  },
};
export const ECHO_CONTRACT = {
  schema: 1,
  success: {
    statuses: [200],
    contentType: 'application/json',
    maxLatencyMs: 2_000,
    fields: [{ path: 'text', type: 'string' }, { path: 'length', type: 'number', min: 0 }],
  },
};

/**
 * Create the demo seller and two PUBLISHED demo listings (idempotent: returns the existing ones on a second call).
 * Ownership proofs are skipped for these platform-operated listings and they are flagged `demo`, so they can only be
 * served by the in-process demo network.
 */
export function seedDemo(db: Db, mk: MasterKey, now: () => number = Date.now): { sellerId: string; priceListingId: string; echoListingId: string } {
  const existing = db.prepare("SELECT id, endpoint_url FROM listings WHERE demo = 1").all() as Array<{ id: string; endpoint_url: string }>;
  const seller = (db.prepare("SELECT id FROM accounts WHERE id = 'seller_demo'").get() as { id: string } | undefined)?.id ?? createAccount(db, { id: 'seller_demo', kind: 'seller', displayName: 'Payrail demo seller' }, now);
  const find = (host: string) => existing.find((l) => l.endpoint_url.includes(host))?.id;
  const make = (host: string, path: string, method: 'GET' | 'POST', name: string, description: string, price: bigint, contract: unknown, cred: boolean): string => {
    const id = `lst_demo_${randomUUID().slice(0, 8)}`;
    const at = new Date(now()).toISOString();
    db.prepare(
      "INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, endpoint_url, http_method, description, host, verified_at, demo) VALUES (?, ?, ?, 'verified', ?, 'TESTUSDT', ?, ?, ?, ?, ?, ?, 1)",
    ).run(id, seller, name, price, at, `https://${host}${path}`, method, description, host, at);
    audit(db, 'system', 'demo.seeded', id, { host }, new Date(now()));
    if (cred) putCredential(db, mk, { listingId: id, label: 'api-key', headerName: 'X-Api-Key', value: DEMO_PRICE_KEY, actor: 'system' }, now);
    const v = proposeContract(db, id, seller, contract, now);
    approveContract(db, v.id, seller, now);
    db.prepare("UPDATE listings SET status = 'published' WHERE id = ?").run(id);
    return id;
  };
  const priceListingId = find(DEMO_PRICE_HOST) ?? make(DEMO_PRICE_HOST, '/v1/price', 'GET', 'Demo token price (fresh within 60s)', 'DEMO: a controlled in-process API. Returns a token price with a timestamp; stale or malformed answers are not charged.', 20_000n, PRICE_CONTRACT, true);
  const echoListingId = find(DEMO_ECHO_HOST) ?? make(DEMO_ECHO_HOST, '/v1/echo', 'POST', 'Demo text echo', 'DEMO: a controlled in-process API with failure injection (scenario input).', 5_000n, ECHO_CONTRACT, false);
  // if the vault key changed since seeding (e.g. an ephemeral key was replaced by a persistent one), re-store the demo credential
  const active = db.prepare("SELECT key_id FROM credentials WHERE listing_id = ? AND status = 'active'").get(priceListingId) as { key_id: string } | undefined;
  if (!active || active.key_id !== mk.id) putCredential(db, mk, { listingId: priceListingId, label: 'api-key', headerName: 'X-Api-Key', value: DEMO_PRICE_KEY, actor: 'system' }, now);
  return { sellerId: seller, priceListingId, echoListingId };
}

// ------------------------------------------------------------------ sandbox network
//
// SANDBOX: any host ending in `.sandbox.payrail.example` is served IN-PROCESS by Payrail itself, so a seller can walk the
// whole listing flow in a browser without owning a domain. Because Payrail serves both the API and the verification
// token for these hosts, a sandbox verification proves NOTHING about real ownership and is labelled as such. Every other
// host is passed through to the real resolver/transport unchanged (and is still subject to all egress checks).
import { SANDBOX_SUFFIX, isSandboxHost } from '../hosts.ts';
export { SANDBOX_SUFFIX, isSandboxHost };

function challengeToken(db: Db, host: string): string | undefined {
  const r = db
    .prepare('SELECT c.token AS token FROM ownership_challenges c JOIN listings l ON l.id = c.listing_id WHERE l.host = ? ORDER BY c.created_at DESC LIMIT 1')
    .get(host) as { token: string } | undefined;
  return r?.token;
}

export function createSandboxNetwork(db: Db, now: () => number = Date.now): { resolver: Resolver; transport: Transport; txt: (name: string) => Promise<string[][]> } {
  const resolver: Resolver = async (host) => {
    if (isSandboxHost(host)) return [{ address: '93.184.216.34', family: 4 }];
    if (host === DEMO_PRICE_HOST || host === DEMO_ECHO_HOST) return [{ address: '93.184.216.34', family: 4 }];
    return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
  };
  const transport: Transport = async (r) => {
    const demoHost = r.hostname === DEMO_PRICE_HOST || r.hostname === DEMO_ECHO_HOST;
    if (!isSandboxHost(r.hostname) && !demoHost) return httpsTransport(r);
    const path = r.path.split('?')[0];
    let res: EgressResponse | typeof HANG;
    if (demoHost) {
      res = await demoHandler(r, now);
    } else if (path === '/.well-known/payrail-verification.txt') {
      const t = challengeToken(db, r.hostname);
      res = t ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`payrail-verify=${t}`) } : json(404, { error: 'no listing for this host' });
    } else if (path === '/v1/price') {
      res = await demoHandler({ ...r, hostname: DEMO_PRICE_HOST, headers: { ...r.headers, 'x-api-key': DEMO_PRICE_KEY } }, now);
    } else if (path === '/v1/echo') {
      res = await demoHandler({ ...r, hostname: DEMO_ECHO_HOST }, now);
    } else {
      res = json(404, { error: 'sandbox serves /v1/price and /v1/echo' });
    }
    if (res === HANG) return new Promise<EgressResponse>(() => undefined);
    return res;
  };
  const txt = async (name: string): Promise<string[][]> => {
    const m = /^_payrail-challenge\.(.+)$/.exec(name);
    if (m && isSandboxHost(m[1]!)) {
      const t = challengeToken(db, m[1]!);
      return t ? [[`payrail-verify=${t}`]] : [];
    }
    return resolveTxt(name);
  };
  return { resolver, transport, txt };
}
