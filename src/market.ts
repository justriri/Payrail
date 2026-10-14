// Marketplace service layer + JSON API router. Transport-agnostic: webapi.ts mounts `handleMarket` under /api/market/.
// MODE: test credits only. No real funds move here; the Buy/x402 flow remains a separate, unchanged path.
import type { Catalog } from './catalog.ts';
import { ContractError, approveContract, currentContract, getContract, inferContract, listContracts, proposeContract } from './contracts.ts';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { executeRequest, executionResult } from './execute.ts';
import type { ExecuteOptions } from './execute.ts';
import { GatewayError, callUpstream } from './gateway.ts';
import { LedgerError, balance, createAccount, deposit } from './ledger.ts';
import {
  SellerError, authenticate, challengeFor, checkDomainProof, completeLogin, getListing, listingsOf, publishListing, startLogin, submitListing, submitWalletProof, unpublishListing,
} from './seller.ts';
import type { DomainDeps, Listing } from './seller.ts';
import { TesterError, recentTests, runTest } from './tester.ts';
import type { CallOptions } from './gateway.ts';
import { VaultError, listCredentials, putCredential, revokeCredential } from './vault.ts';
import type { MasterKey } from './vault.ts';
import { randomBytes, createHash } from 'node:crypto';

export const ASSET = 'USDT';
export const DECIMALS = 6;
/** a buyer may hold at most this many test credits in total granted (atomic, 6 decimals) */
export const TEST_CREDIT_CAP = 5_000_000n;

export interface MarketRuntime {
  db: Db;
  keys: readonly MasterKey[];
  /** the key new credentials are encrypted with */
  activeKey: MasterKey;
  now?: () => number;
  execute?: ExecuteOptions;
  /** options for seller tests and domain checks (tests inject fakes; production leaves undefined) */
  testCall?: Omit<CallOptions, 'purpose'>;
  domain?: DomainDeps;
  /** the Buy gateway catalog, when available */
  buyCatalog?: () => Promise<Catalog>;
}

export interface MarketItem {
  id: string;
  title: string;
  description: string;
  source: 'payrail' | 'buy';
  /** how it is paid: Payrail's outcome-based gateway (test credits) or the direct x402 flow of the Buy gateway */
  execution: 'payrail-gateway' | 'x402-direct';
  pricing: { kind: 'fixed'; atomic: string; usd: string; asset: string } | { kind: 'indicative'; minUsd: string; maxUsd: string } | null;
  payOnlyForQualifying: boolean;
  demo: boolean;
  available: boolean;
  /** buy services open in the existing pay flow */
  url?: string;
}

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (m: string, code = 'BAD_REQUEST') => new ApiError(400, code, m);

export const formatAtomic = (v: bigint): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(DECIMALS + 1, '0');
  const frac = s.slice(-DECIMALS).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -DECIMALS)}${frac ? `.${frac}` : ''}`;
};
export function parseAtomic(s: unknown): bigint {
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(s.trim())) throw bad('amount must look like 0.02 (up to 6 decimals)');
  const [w, f = ''] = s.trim().split('.');
  const v = BigInt(w!) * 10n ** BigInt(DECIMALS) + BigInt(f.padEnd(DECIMALS, '0'));
  if (v <= 0n) throw bad('amount must be greater than zero');
  return v;
}

// ------------------------------------------------------------------ catalog

export function payrailItems(db: Db): MarketItem[] {
  return query(db, "SELECT * FROM listings WHERE status = 'published' ORDER BY created_at, name").map((r) => ({
    id: String(r.id),
    title: String(r.name),
    description: String(r.description),
    source: 'payrail',
    execution: 'payrail-gateway',
    pricing: { kind: 'fixed', atomic: String(r.price_atomic), usd: formatAtomic(BigInt(r.price_atomic as bigint)), asset: String(r.asset) },
    payOnlyForQualifying: true,
    demo: Number(r.demo) === 1,
    available: true,
  }));
}

export async function mergedCatalog(rt: MarketRuntime, q?: string): Promise<{ items: MarketItem[]; buy: { available: boolean; stale?: boolean; message?: string } }> {
  let items = payrailItems(rt.db);
  let buy: { available: boolean; stale?: boolean; message?: string } = { available: false, message: 'Buy catalog not connected' };
  if (rt.buyCatalog) {
    try {
      const cat = await rt.buyCatalog();
      buy = { available: true, stale: cat.stale };
      items = items.concat(
        cat.services.map((s): MarketItem => ({
          id: s.id,
          title: s.title,
          description: s.description,
          source: 'buy',
          execution: 'x402-direct',
          pricing: s.price ? { kind: 'indicative', minUsd: formatAtomic(s.price.minAtomic), maxUsd: formatAtomic(s.price.maxAtomic) } : null,
          payOnlyForQualifying: false,
          demo: false,
          available: s.available,
          url: s.url,
        })),
      );
    } catch (e) {
      buy = { available: false, message: `Buy catalog unavailable: ${(e as Error).message.slice(0, 100)}` };
    }
  }
  const needle = q?.trim().toLowerCase();
  if (needle) items = items.filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(needle));
  return { items, buy };
}

// ------------------------------------------------------------------ accounts

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createBuyer(rt: MarketRuntime): { accountId: string; token: string } {
  const now = rt.now ?? Date.now;
  const accountId = createAccount(rt.db, { kind: 'buyer', displayName: 'Test buyer' }, now);
  const token = randomBytes(32).toString('base64url');
  rt.db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token), accountId, new Date(now()).toISOString(), new Date(now() + 7 * 86_400_000).toISOString(),
  );
  return { accountId, token };
}

/** Grant TEST credits (not real money). Capped per buyer; repeats of the same `ref` are no-ops. */
export function grantTestCredits(rt: MarketRuntime, buyerId: string, amount: bigint): { granted: bigint; total: bigint } {
  const total = sumGranted(rt.db, buyerId);
  if (amount <= 0n) throw bad('amount must be positive');
  if (total + amount > TEST_CREDIT_CAP) throw new ApiError(409, 'TEST_CREDIT_CAP', `test credits are capped at ${formatAtomic(TEST_CREDIT_CAP)} ${ASSET} per buyer`);
  const n = Number(queryOne<{ n: bigint }>(rt.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE kind = 'deposit' AND ref LIKE ?", `testcredit:${buyerId}:%`)!.n);
  deposit(rt.db, { buyerId, asset: ASSET, amountAtomic: amount, ref: `testcredit:${buyerId}:${n + 1}`, memo: 'TEST CREDITS (not real money)' }, rt.now ?? Date.now);
  return { granted: amount, total: total + amount };
}
function sumGranted(db: Db, buyerId: string): bigint {
  const r = queryOne<{ s: bigint | null }>(
    db,
    "SELECT SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.tx_id JOIN ledger_accounts a ON a.id = e.account_id WHERE t.kind = 'deposit' AND a.owner_id = ? AND a.kind = 'buyer_available'",
    buyerId,
  );
  return BigInt(r?.s ?? 0n);
}

// ------------------------------------------------------------------ views

function listingView(db: Db, l: Listing, forOwner: boolean) {
  const c = currentContract(db, l.id);
  const base = {
    id: l.id,
    name: l.name,
    description: l.description,
    status: l.status,
    host: l.host,
    method: l.method,
    price: { atomic: l.priceAtomic.toString(), usd: formatAtomic(l.priceAtomic), asset: l.asset },
    feePercent: l.feeBps / 100,
    demo: l.demo,
    contract: c ? { id: c.id, version: c.version, rules: c.body.success } : null,
  };
  if (!forOwner) return base;
  return {
    ...base,
    endpointUrl: l.endpointUrl,
    verifiedAt: l.verifiedAt,
    challenge: l.demo ? null : challengeFor(db, l.id),
    contracts: listContracts(db, l.id).map((v) => ({ id: v.id, version: v.version, status: v.status, rules: v.body.success })),
    credentials: listCredentials(db, l.id),
    tests: recentTests(db, l.id, 5),
  };
}

function executionRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    listingId: String(r.listing_id),
    listing: String(r.name ?? ''),
    state: String(r.state),
    price: formatAtomic(BigInt(r.price_atomic as bigint)),
    asset: String(r.asset),
    reason: r.reason === null ? null : String(r.reason),
    at: String(r.updated_at),
  };
}

// ------------------------------------------------------------------ router

export interface MarketRequest {
  method: 'GET' | 'POST';
  path: string; // after /api/market
  query: URLSearchParams;
  body: Record<string, unknown>;
  bearer: string | undefined;
}
export interface MarketResponse {
  status: number;
  body: unknown;
}

const str = (v: unknown, what: string, max = 500): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw bad(`${what} is required`);
  return v;
};

function mapError(e: unknown): MarketResponse {
  if (e instanceof ApiError) return { status: e.status, body: { ok: false, code: e.code, message: e.message } };
  const code = (e as { code?: string }).code ?? 'ERROR';
  const message = (e as Error).message;
  const known = e instanceof LedgerError || e instanceof SellerError || e instanceof VaultError || e instanceof ContractError || e instanceof GatewayError || e instanceof TesterError;
  if (!known) return { status: 500, body: { ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' } };
  const status: Record<string, number> = {
    SESSION_INVALID: 401, NOT_OWNER: 403, NOT_FOUND: 404, INSUFFICIENT_CREDITS: 402, IDEMPOTENCY_CONFLICT: 409, WRONG_STATE: 409, HOST_CLAIMED: 409,
    LISTING_NOT_PUBLISHED: 409, CONTRACT_NOT_APPROVED: 409, RATE_LIMITED: 429, DOMAIN_PROOF_FAILED: 422, BAD_SIGNATURE: 422,
  };
  return { status: status[code] ?? 400, body: { ok: false, code, message } };
}

export async function handleMarket(rt: MarketRuntime, req: MarketRequest): Promise<MarketResponse> {
  try {
    return await route(rt, req);
  } catch (e) {
    return mapError(e);
  }
}

async function route(rt: MarketRuntime, req: MarketRequest): Promise<MarketResponse> {
  const { db } = rt;
  const now = rt.now ?? Date.now;
  const ok = (body: unknown, status = 200): MarketResponse => ({ status, body: { ok: true, ...(body as object) } });
  const { method, path, body } = req;
  const account = (): string => {
    if (!req.bearer) throw new SellerError('SESSION_INVALID', 'sign in first');
    return authenticate(db, req.bearer, now);
  };
  const kindOf = (id: string) => String(queryOne(db, 'SELECT kind FROM accounts WHERE id = ?', id)?.kind ?? '');
  const seller = (): string => {
    const id = account();
    if (kindOf(id) !== 'seller') throw new ApiError(403, 'NOT_SELLER', 'this action is for seller accounts');
    return id;
  };
  const buyer = (): string => {
    const id = account();
    if (kindOf(id) !== 'buyer') throw new ApiError(403, 'NOT_BUYER', 'this action is for buyer accounts');
    return id;
  };
  let m: RegExpMatchArray | null;

  // ---- public
  if (method === 'GET' && path === '/catalog') {
    const c = await mergedCatalog(rt, req.query.get('q') ?? undefined);
    return ok({ mode: 'test-credits', ...c });
  }
  if (method === 'GET' && (m = path.match(/^\/listing\/([\w-]{1,80})$/))) {
    const l = getListing(db, m[1]!);
    if (!l || l.status !== 'published') throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    return ok({ listing: listingView(db, l, false) });
  }

  // ---- buyer
  if (method === 'POST' && path === '/buyer') return ok(createBuyer(rt), 201);
  if (method === 'GET' && path === '/me') {
    const id = account();
    const kind = kindOf(id);
    const out: Record<string, unknown> = { accountId: id, kind, mode: 'test-credits', asset: ASSET };
    if (kind === 'buyer') {
      out.available = formatAtomic(balance(db, id, 'buyer_available', ASSET));
      out.held = formatAtomic(balance(db, id, 'buyer_held', ASSET));
      out.creditCap = formatAtomic(TEST_CREDIT_CAP);
    } else {
      out.earnings = formatAtomic(balance(db, id, 'seller_earnings', ASSET));
    }
    return ok(out);
  }
  if (method === 'POST' && path === '/credits') {
    const id = buyer();
    const r = grantTestCredits(rt, id, parseAtomic(body.amount ?? '1'));
    return ok({ granted: formatAtomic(r.granted), totalGranted: formatAtomic(r.total), note: 'TEST CREDITS - not real money' });
  }
  if (method === 'POST' && path === '/execute') {
    const id = buyer();
    const r = await executeRequest(db, rt.keys, { buyerId: id, listingId: str(body.listingId, 'listingId', 80), idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 100), input: body.input ?? {} }, rt.execute ?? {});
    return ok({ result: r }, r.replay ? 200 : 201);
  }
  if (method === 'GET' && path === '/executions') {
    const id = buyer();
    const rows = query(db, 'SELECT e.*, l.name FROM executions e JOIN listings l ON l.id = e.listing_id WHERE e.buyer_id = ? ORDER BY e.created_at DESC LIMIT 50', id);
    return ok({ executions: rows.map(executionRow) });
  }
  if (method === 'GET' && (m = path.match(/^\/execution\/([\w-]{1,80})$/))) {
    const id = buyer();
    const e = queryOne(db, 'SELECT buyer_id FROM executions WHERE id = ?', m[1]!);
    if (!e || String(e.buyer_id) !== id) throw new ApiError(404, 'NOT_FOUND', 'no such execution');
    return ok({ result: executionResult(db, m[1]!) });
  }

  // ---- seller sign-in
  if (method === 'POST' && path === '/seller/login/start') return ok(startLogin(db, str(body.wallet, 'wallet', 60), now));
  if (method === 'POST' && path === '/seller/login/complete') {
    const r = await completeLogin(db, { wallet: str(body.wallet, 'wallet', 60), nonce: str(body.nonce, 'nonce', 80), signature: str(body.signature, 'signature', 400) }, now);
    return ok(r);
  }

  // ---- seller
  if (method === 'GET' && path === '/seller/listings') {
    const id = seller();
    return ok({ listings: listingsOf(db, id).map((l) => listingView(db, l, true)) });
  }
  if (method === 'POST' && path === '/seller/listings') {
    const id = seller();
    const meth = body.method === 'POST' ? 'POST' : 'GET';
    const r = submitListing(
      db,
      id,
      { name: str(body.name, 'name', 80), description: typeof body.description === 'string' ? body.description : '', endpointUrl: str(body.endpointUrl, 'endpointUrl', 500), method: meth, priceAtomic: parseAtomic(body.price), asset: ASSET },
      now,
    );
    return ok({ listing: listingView(db, r.listing, true) }, 201);
  }
  if ((m = path.match(/^\/seller\/listing\/([\w-]{1,80})(?:\/([a-z-]+))?$/))) {
    const id = seller();
    const lid = m[1]!;
    const action = m[2];
    const l = getListing(db, lid);
    if (!l || l.sellerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    const view = () => ok({ listing: listingView(db, getListing(db, lid)!, true) });
    if (method === 'GET' && !action) return view();
    if (method === 'POST') {
      switch (action) {
        case 'wallet-proof':
          await submitWalletProof(db, id, lid, str(body.signature, 'signature', 400), now);
          return view();
        case 'domain-proof': {
          const meth = body.method === 'well_known' ? 'well_known' : body.method === 'dns_txt' ? 'dns_txt' : undefined;
          if (!meth) throw bad('method must be dns_txt or well_known');
          await checkDomainProof(db, id, lid, meth, rt.domain ?? {}, now);
          return view();
        }
        case 'credential': {
          if (l.demo) throw new ApiError(409, 'DEMO_LISTING', 'demo listings are managed by the platform');
          const meta = putCredential(db, rt.activeKey, { listingId: lid, label: str(body.label, 'label', 60), headerName: str(body.headerName, 'headerName', 60), value: str(body.value, 'value', 4096), actor: id }, now);
          return ok({ credential: meta }, 201);
        }
        case 'revoke-credential': {
          const cid = str(body.credentialId, 'credentialId', 80);
          const c = queryOne(db, 'SELECT listing_id FROM credentials WHERE id = ?', cid);
          if (!c || String(c.listing_id) !== lid) throw new ApiError(404, 'NOT_FOUND', 'no such credential');
          return ok({ credential: revokeCredential(db, cid, id, now) });
        }
        case 'test': {
          const report = await runTest(db, rt.keys, id, lid, body.input ?? {}, { ...(typeof body.contractId === 'string' ? { contractId: body.contractId } : {}), ...(rt.testCall ? { call: rt.testCall } : l.demo && rt.execute?.demoCall ? { call: rt.execute.demoCall } : {}) });
          return ok({ report });
        }
        case 'contract': {
          const v = proposeContract(db, lid, id, body.contract, now);
          return ok({ contract: { id: v.id, version: v.version, status: v.status, rules: v.body.success } }, 201);
        }
        case 'suggest-contract': {
          const call = rt.testCall ?? (l.demo ? rt.execute?.demoCall : undefined) ?? {};
          const r = await callUpstream(db, rt.keys, lid, body.input ?? {}, { ...call, now, purpose: 'seller-test' });
          const suggestion = inferContract([{ json: r.json, elapsedMs: r.elapsedMs }]);
          return ok({ suggestion, note: 'A suggestion built from one sample. Review every rule, then propose and approve it.' });
        }
        case 'publish':
          publishListing(db, id, lid, now);
          return view();
        case 'unpublish':
          unpublishListing(db, id, lid, now);
          return view();
      }
    }
  }
  if (method === 'POST' && (m = path.match(/^\/seller\/contract\/([\w-]{1,80})\/approve$/))) {
    const id = seller();
    const v = approveContract(db, m[1]!, id, now);
    const c = getContract(db, v.id)!;
    return ok({ contract: { id: c.id, version: c.version, status: c.status } });
  }
  if (method === 'GET' && path === '/seller/earnings') {
    const id = seller();
    const states = query(db, 'SELECT e.state, COUNT(*) AS n, SUM(COALESCE(e.seller_atomic, 0)) AS s FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? GROUP BY e.state', id);
    const recent = query(db, 'SELECT e.*, l.name FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? ORDER BY e.created_at DESC LIMIT 30', id);
    return ok({
      asset: ASSET,
      earnings: formatAtomic(balance(db, id, 'seller_earnings', ASSET)),
      byState: states.map((r) => ({ state: String(r.state), count: Number(r.n), sellerAtomic: formatAtomic(BigInt(r.s as bigint)) })),
      recent: recent.map(executionRow),
      note: 'Test credits. Settlement of real funds is not enabled.',
    });
  }
  audit(db, 'system', 'market.unknown_route', `${method} ${path.slice(0, 80)}`, undefined, new Date(now()));
  throw new ApiError(404, 'NOT_FOUND', 'unknown endpoint');
}
