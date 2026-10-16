// Marketplace service layer + JSON API router. Transport-agnostic: webapi.ts mounts `handleMarket` under /api/market/.
// MODE: test credits only. No real funds move here; the Buy/x402 flow remains a separate, unchanged path.
import type { Catalog } from './catalog.ts';
import { ContractError, approveContract, currentContract, getContract, inferContract, listContracts, proposeContract } from './contracts.ts';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { executeRequest, executionResult } from './execute.ts';
import type { ExecuteOptions } from './execute.ts';
import { GatewayError, MAX_INPUT_BYTES, MAX_INPUT_KEYS, callUpstream } from './gateway.ts';
import { LedgerError, balance, createAccount, deposit } from './ledger.ts';
import {
  SellerError, authenticate, challengeFor, createSandboxSeller, checkDomainProof, completeLogin, getListing, listingsOf, publishListing, startLogin, submitListing, submitWalletProof, unpublishListing,
} from './seller.ts';
import type { DomainDeps, Listing } from './seller.ts';
import { TesterError, recentTests, runTest } from './tester.ts';
import type { CallOptions } from './gateway.ts';
import { VaultError, listCredentials, putCredential, revokeCredential } from './vault.ts';
import type { MasterKey } from './vault.ts';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { isSandboxHost } from './hosts.ts';
import { AgentError, authenticateAgent, createAgent, executeAsAgent, listAgents, revokeAgent } from './agents.ts';
import { FundingError, confirmDeposit, fundingMessage, fundingMessageOnChain, fundingWallets, registerFundingWallet } from './funding.ts';
import { takerControlTypedData, verifyTakerProof } from './takerproof.ts';
import { CELO_CHAIN_ID } from './conversion.ts';
import { WalletAuthError, completeBuyerLogin, startBuyerLogin } from './walletauth.ts';
import { BuyPayError, formatUsdt } from './buypay.ts';
import type { BuyPay } from './buypay.ts';
import { BuyConvertError } from './buyconvert.ts';
import type { BuyConvert } from './buyconvert.ts';
import type { FundingConfig } from './funding.ts';
import { PayoutError, cancelPayout, payoutsOf, requestPayout } from './payouts.ts';
import { publishReadiness, updateListingDetails } from './seller.ts';
import { buyerStatement, quoteFor, receiptFor, sellerStatement } from './billing.ts';
import { agentExecutionIds, agentUsage } from './agents.ts';
import type { PayoutPolicy } from './payouts.ts';
import { EscrowError, executeEscrowRequest } from './escrow.ts';
import { FundingOpError, approveFunding, fundingEvents, fundingView, getFundingOp, listFundingOps, recordClientTx, requestFundingQuote, verifyAndCredit } from './marketfunding.ts';
import type { FundingConfig as ConversionFundingConfig } from './marketfunding.ts';
import { fundingConfigFor, fundingConfigForOp, routeLimits } from './multifunding.ts';
import type { ConversionRuntime } from './multifunding.ts';
import {
  PayoutConvError, confirmConversionQuote, executeConversionPayout, getPayoutPreference, payoutAddressMessage, payoutAddresses, payoutEvents,
  recheckConversionPayout, registerPayoutAddress, requestConversionPayout, requoteConversionPayout, retryConversionDelivery, setPayoutPreference,
} from './payoutconv.ts';
import { approvePayout, getPayout } from './payouts.ts';
import type { EscrowClient } from './escrow.ts';

/** Test credits live in their own ledger asset so they can never mix with real funds. */
export const TEST_ASSET = 'TESTUSDT';
export const LIVE_ASSET = 'USDT';
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
  /** Buy AI purchases paid by the buyer's own wallet (x402 / EIP-3009). Only present when the operator enabled it (PAYRAIL_BUY_PAYMENTS=1). */
  buy?: BuyPay;
  /** Paying a Buy API with cNGN etc.: Textile converts in the BUYER's wallet, then Buy is paid in USDT. Its own opt-in (PAYRAIL_BUY_CONVERSION=1). */
  buyConvert?: BuyConvert;
  /** true when the Buy catalog comes from the simulator rather than the real gateway */
  buySimulated?: boolean;
  /** enable sandbox sellers (server-derived test wallets, in-process sandbox hosts). Test-credit mode only. */
  sandbox?: boolean;
  /** marketplace funding through the Textile conversion (simulated unless real-funds mode is on) */
  funding?: ConversionFundingConfig;
  /** Stage 1 multi-currency: route discovery, asset-agnostic funding, payout preferences and simulated payout conversion */
  conversion?: ConversionRuntime;
  /** real-funds mode. Absent = test credits only and every real-money route answers LIVE_DISABLED. */
  /**
   * DEVELOPMENT TESTS ONLY. The failure-injection scenario names the simulated providers understand. scripts/serve.ts never sets
   * this, so production accepts no scenario parameter at all.
   */
  dev?: { fundingScenarios?: readonly string[]; payoutScenarios?: readonly string[]; legacyScenarios?: readonly string[] };
  live?: {
    funding: FundingConfig;
    payout: PayoutPolicy;
    /** seller payout REQUESTS over HTTP stay refused unless this is explicitly true (the secure payout architecture is not reviewed yet) */
    payoutRequestsEnabled?: boolean;
  };
  /** alternative settlement through the on-chain escrow contract (testnet-verified only) */
  escrow?: {
    client: EscrowClient;
    asset: string;
    /** present when this is the Celo Sepolia TESTNET deployment; enables the testnet deposit helper */
    testnet?: { chainId: number; escrow: string; token: string; wallet: string; explorer: string; deposit(amountAtomic: bigint): Promise<string> };
  };
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
  /** Buy items: the Buy platform (x, instagram, flights, ...) and the upstream provider */
  platform?: string;
  provider?: string;
  /** where the listing comes from, in plain terms */
  origin: 'buy-gateway' | 'buy-gateway-simulated' | 'payrail-seller' | 'payrail-sandbox' | 'payrail-demo';
  originLabel: string;
  /** who publishes it (a display name or shortened wallet; never a full credential) */
  seller?: string;
  /** buy services open in the existing pay flow */
  url?: string;
}

export const ORIGIN_LABELS: Record<MarketItem['origin'], string> = {
  'buy-gateway': 'Buy gateway service (independent, paid directly with x402)',
  'buy-gateway-simulated': 'Buy gateway service, SIMULATED copy (not the real service)',
  'payrail-seller': 'Independent Payrail seller API (paid only if the response qualifies)',
  'payrail-sandbox': 'Sandbox seller API (served by Payrail itself; ownership NOT really verified)',
  'payrail-demo': 'Demo API (controlled test data served by Payrail)',
};

/** a sandbox account is derived from a per-session seed; the seed is the random label embedded in the account */
const sandboxSeed = (mk: MasterKey, seed: string): `0x${string}` => `0x${createHmac('sha256', mk.key).update(`sandbox-seed:${seed}`).digest('hex')}`;

/** Machine-readable description of the agent API, served at GET /api/market/agent/spec (no key needed). */
export const AGENT_SPEC = {
  name: 'Payrail agent API',
  version: 1,
  base: '/api/market',
  auth: 'Authorization: Bearer <agent key>  (keys start with "pra_"; created by the buyer account owner; shown once)',
  endpoints: [
    { method: 'GET', path: '/agent/me', purpose: 'Your limits, rolling 24h usage and the owner credits you can spend' },
    { method: 'GET', path: '/agent/catalog', purpose: 'Available APIs with price, response requirements, freshness and availability' },
    { method: 'GET', path: '/agent/listing/{id}', purpose: 'Inspect one API (quote and conditions) before buying' },
    { method: 'POST', path: '/agent/execute', body: { listingId: 'string', idempotencyKey: 'string 8-50 chars [A-Za-z0-9_.:-]', input: 'flat object' }, purpose: 'Run one request. Charged only if the response qualifies' },
    { method: 'GET', path: '/agent/receipt/{receiptId}', purpose: 'Receipt for one of your own requests' },
    { method: 'GET', path: '/agent/executions', purpose: 'Your recent requests' },
  ],
  outcomes: {
    QUALIFIED: 'Response met the contract; the amount was charged.',
    NOT_QUALIFIED: 'Response failed validation or was never sent; nothing charged.',
    UNRESOLVED: 'Outcome unknown; amount held, not charged; do not retry with a new key.',
    RELEASED_UNRESOLVED: 'Unknown outcome expired; released; nothing charged.',
    IN_PROGRESS: 'Still running; retry with the same idempotencyKey to read the stored outcome.',
  },
  errors: {
    KEY_INVALID: { http: 401, meaning: 'Missing, malformed or revoked agent key' },
    INSUFFICIENT_CREDITS: { http: 402, meaning: 'The owner has fewer credits than the price' },
    BAD_INPUT: { http: 400, meaning: 'Invalid input or idempotency key' },
    NOT_FOUND: { http: 404, meaning: 'Unknown listing or receipt' },
    LISTING_NOT_PUBLISHED: { http: 409, meaning: 'The API is not currently available' },
    CONTRACT_NOT_APPROVED: { http: 409, meaning: 'The API has no approved response contract' },
    LISTING_NOT_ALLOWED: { http: 403, meaning: 'Outside this key allow-list' },
    PER_REQUEST_CAP: { http: 403, meaning: 'Price exceeds the per-request limit' },
    DAILY_CAP: { http: 403, meaning: 'Rolling 24-hour limit reached' },
    IDEMPOTENCY_CONFLICT: { http: 409, meaning: 'Key already used for a different request' },
    RATE_LIMITED: { http: 429, meaning: 'Too many calls to this API' },
  },
  validationNote: 'Responses are validated structurally against the approved contract. A valid response is not guaranteed to be true.',
} as const;

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
/** Parse a human decimal string into atomic units for an asset with `decimals` (up to 18). */
export function parseUnitsText(s: unknown, decimals: number): bigint {
  if (typeof s !== 'string' || !/^\d{1,15}(\.\d{1,18})?$/.test(s.trim())) throw bad(`amount must look like 12.5 (up to ${decimals} decimals)`);
  const [w, f = ''] = s.trim().split('.');
  if (f.length > decimals) throw bad(`this asset has ${decimals} decimals`);
  const v = BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
  if (v <= 0n) throw bad('amount must be greater than zero');
  return v;
}
const fmtUnits = (v: bigint, decimals: number): string => {
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, '0');
  const f = s.slice(-decimals).replace(/0+$/, '');
  return `${s.slice(0, -decimals)}${f ? `.${f}` : ''}`;
};
export function parseAtomic(s: unknown): bigint {
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(s.trim())) throw bad('amount must look like 0.02 (up to 6 decimals)');
  const [w, f = ''] = s.trim().split('.');
  const v = BigInt(w!) * 10n ** BigInt(DECIMALS) + BigInt(f.padEnd(DECIMALS, '0'));
  if (v <= 0n) throw bad('amount must be greater than zero');
  return v;
}

// ------------------------------------------------------------------ catalog

/** a short, non-sensitive seller label: a display name, or a shortened wallet address */
export function sellerLabel(db: Db, sellerId: string): string {
  const a = queryOne(db, 'SELECT display_name, wallet_address FROM accounts WHERE id = ?', sellerId);
  const name = String(a?.display_name ?? '').trim();
  const w = String(a?.wallet_address ?? '');
  const short = (x: string) => `${x.slice(0, 6)}…${x.slice(-4)}`;
  if (name && !/^0x[0-9a-fA-F]{40}$/.test(name)) return name.slice(0, 40);
  const addr = /^0x[0-9a-fA-F]{40}$/.test(name) ? name : w;
  return addr ? short(addr) : 'Payrail seller';
}

/**
 * PRODUCTION RULE: a listing can be sold only if it is priced in real USDT, is not a Payrail demo, and does not live on the
 * in-process sandbox network. Anything else (demo listings, test-credit listings, sandbox listings) is invisible and
 * unpurchasable when the server runs in real-funds mode, whatever the client asks for.
 */
export function isRealListing(l: { asset: string; demo: boolean; host: string | null }): boolean {
  return l.asset === 'USDT' && !l.demo && !isSandboxHost(String(l.host ?? ''));
}

export function payrailItems(db: Db, opts: { realOnly?: boolean } = {}): MarketItem[] {
  const rows = query(db, "SELECT * FROM listings WHERE status = 'published' ORDER BY created_at, name").filter(
    (r) => !opts.realOnly || isRealListing({ asset: String(r.asset), demo: Number(r.demo) === 1, host: r.host === null ? null : String(r.host) }),
  );
  return rows.map((r) => ({
    seller: Number(r.demo) === 1 ? 'Payrail demo' : sellerLabel(db, String(r.seller_id)),
    id: String(r.id),
    title: String(r.name),
    description: String(r.description),
    source: 'payrail',
    execution: 'payrail-gateway',
    pricing: { kind: 'fixed', atomic: String(r.price_atomic), usd: formatAtomic(BigInt(r.price_atomic as bigint)), asset: String(r.asset) },
    payOnlyForQualifying: true,
    demo: Number(r.demo) === 1,
    available: true,
    origin: Number(r.demo) === 1 ? 'payrail-demo' : isSandboxHost(String(r.host ?? '')) ? 'payrail-sandbox' : 'payrail-seller',
    originLabel: ORIGIN_LABELS[Number(r.demo) === 1 ? 'payrail-demo' : isSandboxHost(String(r.host ?? '')) ? 'payrail-sandbox' : 'payrail-seller'],
  }));
}

export async function mergedCatalog(rt: MarketRuntime, q?: string): Promise<{ items: MarketItem[]; buy: { available: boolean; stale?: boolean; message?: string; fetchedAt?: string; count?: number } }> {
  let items = payrailItems(rt.db, { realOnly: Boolean(rt.live) });
  let buy: { available: boolean; stale?: boolean; message?: string; fetchedAt?: string; count?: number } = { available: false, message: 'Buy catalog not connected' };
  if (rt.buyCatalog) {
    try {
      const cat = await rt.buyCatalog();
      buy = { available: true, stale: cat.stale, fetchedAt: new Date(cat.fetchedAt).toISOString(), count: cat.services.length };
      items = items.concat(
        cat.services.map((s): MarketItem => ({
          id: s.id,
          title: s.title,
          description: s.description,
          source: 'buy',
          execution: 'x402-direct',
          platform: s.platform,
          ...(s.provider ? { provider: s.provider } : {}),
          seller: s.provider ? `${s.provider} via Buy AI` : 'Buy AI',
          pricing: s.price ? { kind: 'indicative', minUsd: formatAtomic(s.price.minAtomic), maxUsd: formatAtomic(s.price.maxAtomic) } : null,
          payOnlyForQualifying: false,
          demo: false,
          available: s.available,
          origin: rt.buySimulated ? 'buy-gateway-simulated' : 'buy-gateway',
          originLabel: ORIGIN_LABELS[rt.buySimulated ? 'buy-gateway-simulated' : 'buy-gateway'],
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
  if (total + amount > TEST_CREDIT_CAP) throw new ApiError(409, 'TEST_CREDIT_CAP', `test credits are capped at ${formatAtomic(TEST_CREDIT_CAP)} ${TEST_ASSET} per buyer`);
  const n = Number(queryOne<{ n: bigint }>(rt.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE kind = 'deposit' AND ref LIKE ?", `testcredit:${buyerId}:%`)!.n);
  deposit(rt.db, { buyerId, asset: TEST_ASSET, amountAtomic: amount, ref: `testcredit:${buyerId}:${n + 1}`, memo: 'TEST CREDITS (not real money)' }, rt.now ?? Date.now);
  return { granted: amount, total: total + amount };
}
function sumGranted(db: Db, buyerId: string): bigint {
  const r = queryOne<{ s: bigint | null }>(
    db,
    "SELECT SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.tx_id JOIN ledger_accounts a ON a.id = e.account_id WHERE t.kind = 'deposit' AND t.ref LIKE 'testcredit:%' AND a.owner_id = ? AND a.kind = 'buyer_available' AND e.asset = ?",
    buyerId,
    TEST_ASSET,
  );
  return BigInt(r?.s ?? 0n);
}

// ------------------------------------------------------------------ views

function listingView(db: Db, l: Listing, forOwner: boolean, keyIds: readonly string[] = []) {
  const c = currentContract(db, l.id);
  const base = {
    id: l.id,
    name: l.name,
    description: l.description,
    status: l.status,
    host: l.host,
    method: l.method,
    price: { atomic: l.priceAtomic.toString(), usd: formatAtomic(l.priceAtomic), asset: l.asset },
    seller: l.demo ? 'Payrail demo' : sellerLabel(db, l.sellerId),
    feePercent: l.feeBps / 100,
    demo: l.demo,
    sandbox: isSandboxHost(l.host),
    contract: c ? { id: c.id, version: c.version, rules: c.body.success } : null,
  };
  if (!forOwner) return base;
  const ch = l.demo ? null : challengeFor(db, l.id);
  const contracts = listContracts(db, l.id);
  const approved = contracts.find((v) => v.status === 'approved');
  const proposed = contracts.filter((v) => v.status === 'proposed');
  const readiness = publishReadiness(db, l);
  const stats = queryOne<{ n: bigint; q: bigint | null; s: bigint | null }>(
    db,
    "SELECT COUNT(*) AS n, SUM(CASE WHEN state = 'QUALIFIED' THEN 1 ELSE 0 END) AS q, SUM(COALESCE(seller_atomic, 0)) AS s FROM executions WHERE listing_id = ?",
    l.id,
  );
  const wallet = Boolean(ch?.walletVerified) || l.demo;
  const domain = Boolean(ch?.domainVerified) || l.demo;
  // a label derived ONLY from persisted state; nothing here is optimistic
  const displayStatus =
    l.status === 'published' ? 'Published'
      : l.status === 'suspended' ? 'Suspended'
        : l.status === 'unpublished' ? 'Unpublished (private)'
          : l.status === 'verified' ? (approved ? 'Contract approved: ready to publish' : proposed.length ? 'Verified: contract awaiting approval' : 'Verified: needs a response contract')
            : wallet || domain ? 'Pending verification' : 'Draft';
  return {
    ...base,
    endpointUrl: l.endpointUrl,
    verifiedAt: l.verifiedAt,
    challenge: ch,
    contracts: contracts.map((v) => ({ id: v.id, version: v.version, status: v.status, rules: v.body.success })),
    credentials: listCredentials(db, l.id).map((c) => ({ ...c, usable: keyIds.includes(c.keyId) })),
    tests: recentTests(db, l.id, 5),
    displayStatus,
    public: l.status === 'published',
    visibility: l.status === 'published' ? 'Public: buyers can find and run it in the marketplace' : 'Private: only you can see it',
    ownership: { wallet, domain, domainMethod: ch?.domainMethod ?? null, verified: l.verifiedAt !== null || l.demo },
    contractStatus: approved ? { state: 'approved', version: approved.version } : proposed.length ? { state: 'proposed', version: proposed[proposed.length - 1]!.version } : { state: 'none', version: null },
    publishReadiness: readiness,
    stats: { requests: Number(stats?.n ?? 0n), qualified: Number(stats?.q ?? 0n), earned: formatAtomic(BigInt(stats?.s ?? 0n)) },
    editable: !l.demo && l.status !== 'suspended',
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

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function mapError(e: unknown): MarketResponse {
  if (e instanceof ApiError) return { status: e.status, body: { ok: false, code: e.code, message: e.message, retryable: e.status >= 500 || e.status === 429 } };
  const code = (e as { code?: string }).code ?? 'ERROR';
  const message = (e as Error).message;
  const known = e instanceof LedgerError || e instanceof SellerError || e instanceof VaultError || e instanceof ContractError || e instanceof GatewayError || e instanceof TesterError || e instanceof FundingError || e instanceof PayoutError || e instanceof AgentError || e instanceof EscrowError || e instanceof FundingOpError || e instanceof PayoutConvError || e instanceof WalletAuthError || e instanceof BuyPayError || e instanceof BuyConvertError;
  if (!known) return { status: 500, body: { ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' } };
  const status: Record<string, number> = {
    SESSION_INVALID: 401, NOT_OWNER: 403, NOT_FOUND: 404, INSUFFICIENT_CREDITS: 402, IDEMPOTENCY_CONFLICT: 409, WRONG_STATE: 409, HOST_CLAIMED: 409,
    LISTING_NOT_PUBLISHED: 409, CONTRACT_NOT_APPROVED: 409, RATE_LIMITED: 429, DOMAIN_PROOF_FAILED: 422, BAD_SIGNATURE: 422, WRONG_NETWORK: 422, NONCE_INVALID: 401, SERVICE_UNAVAILABLE: 409, INVALID_INPUT: 422, NO_USDT_OFFER: 409, PRICE_ABOVE_LIMIT: 422, CHALLENGE_REJECTED: 409, GATEWAY_UNREACHABLE: 502, INSUFFICIENT_USDT: 409, UNSUPPORTED_CURRENCY: 422, ABOVE_LIMIT: 422, NO_QUOTE: 409, TX_ALREADY_USED: 409, QUOTE_STALE: 409,
    WALLET_TAKEN: 409, NO_FUNDING_WALLET: 409, TX_NOT_FOUND: 404, TX_REVERTED: 422, NOT_ENOUGH_CONFIRMATIONS: 409, NO_MATCHING_TRANSFER: 422, OVER_LIMIT: 422, READ_FAILED: 502,
    KEY_INVALID: 401, LISTING_NOT_ALLOWED: 403, ROUTE_UNAVAILABLE: 409, ADDRESS_REQUIRED: 409, ADDRESS_TAKEN: 409, BELOW_FLOOR: 422, ABOVE_DEPTH: 422, NOT_ENABLED: 409, PER_REQUEST_CAP: 403, DAILY_CAP: 403, INSUFFICIENT_EARNINGS: 409, NO_WALLET: 409, TEST_ASSET: 422, NO_SELLER_WALLET: 409, HOLD_FAILED: 502,
    BAD_AMOUNT: 400, BELOW_MINIMUM: 422, ABOVE_MAXIMUM: 422, DAILY_LIMIT: 429, TOO_MANY_OPEN: 409, QUOTE_UNAVAILABLE: 502, QUOTE_EXPIRED: 409, DIGEST_MISMATCH: 409, SIGNING_UNAVAILABLE: 409, NOT_ALLOWED: 403,
  };
  const s = status[code] ?? 400;
  const hints: Record<string, string> = {
    INSUFFICIENT_CREDITS: 'Add credits to the buyer account, then retry with a NEW idempotency key.',
    IDEMPOTENCY_CONFLICT: 'This idempotency key was already used for a different request. Use a new key for a new request.',
    DAILY_CAP: 'The rolling 24-hour limit for this agent is used up. Wait, or ask the owner to raise the limit.',
    PER_REQUEST_CAP: 'This listing costs more than the agent per-request limit.',
    LISTING_NOT_ALLOWED: 'This agent is restricted to an allow-list of listings.',
    LISTING_NOT_PUBLISHED: 'The listing is not currently available.',
    KEY_INVALID: 'Check the agent key; keys are shown once at creation and cannot be recovered.',
    RATE_LIMITED: 'Slow down and retry shortly.',
  };
  return { status: s, body: { ok: false, code, message, retryable: s === 429 || s >= 500, ...(hints[code] ? { hint: hints[code] } : {}) } };
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
  /** production only: refuse to sell anything that is not a verified, real-USDT, non-demo, non-sandbox listing */
  const assertRealListing = (listingId: string) => {
    const l = getListing(db, listingId);
    if (!l || !isRealListing(l)) throw new ApiError(409, 'NOT_REAL_LISTING', 'this listing cannot be purchased: only real-USDT listings with verified ownership are sold in real-funds mode');
  };

  // ---- public
  if (method === 'GET' && path === '/catalog') {
    const c = await mergedCatalog(rt, req.query.get('q') ?? undefined);
    return ok({ mode: rt.live ? 'real-funds' : 'test-credits', ...c });
  }
  if (method === 'GET' && (m = path.match(/^\/listing\/([\w-]{1,80})$/))) {
    const l = getListing(db, m[1]!);
    if (!l || l.status !== 'published' || (rt.live && !isRealListing(l))) throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    return ok({
      listing: listingView(db, l, false),
      quote: quoteFor(db, l.id, { escrowEnabled: Boolean(rt.escrow) }),
      inputRules: {
        format: 'A flat JSON object. Values may be text (up to 500 characters), numbers or true/false. No nested objects or lists.',
        method: l.method,
        maxFields: MAX_INPUT_KEYS,
        maxBytes: MAX_INPUT_BYTES,
        nameRule: 'Field names start with a letter or underscore and may contain letters, digits, dot, dash and underscore (up to 41 characters).',
        note: 'The seller does not publish a field list; the response contract above says what a qualifying response looks like. Malformed input is refused before anything is reserved.',
      },
    });
  }
  if (method === 'GET' && (m = path.match(/^\/quote\/([\w-]{1,80})$/))) {
    const q = quoteFor(db, m[1]!, { escrowEnabled: Boolean(rt.escrow) });
    if (!q) throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    const l = getListing(db, m[1]!);
    if (!l || l.status !== 'published' || (rt.live && !isRealListing(l))) throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    return ok({ quote: q });
  }

  // ---- buyer
  if (method === 'POST' && path === '/buyer') {
    if (rt.live) throw new ApiError(403, 'NOT_AVAILABLE', 'anonymous test buyers do not exist in real-funds mode: sign in with your wallet (POST /buyer/login/start)');
    return ok(createBuyer(rt), 201);
  }
  if (method === 'GET' && path === '/me') {
    const id = account();
    const kind = kindOf(id);
    if (rt.live) {
      // real-funds mode reports REAL balances only; test-credit balances are never shown or spendable
      const real: Record<string, unknown> = { accountId: id, kind, mode: 'real-funds', asset: LIVE_ASSET };
      if (kind === 'buyer') real.live = { asset: LIVE_ASSET, available: formatAtomic(balance(db, id, 'buyer_available', LIVE_ASSET)), held: formatAtomic(balance(db, id, 'buyer_held', LIVE_ASSET)) };
      else real.live = { asset: LIVE_ASSET, earnings: formatAtomic(balance(db, id, 'seller_earnings', LIVE_ASSET)), pendingPayout: formatAtomic(balance(db, id, 'payout_pending', LIVE_ASSET)) };
      return ok(real);
    }
    const out: Record<string, unknown> = { accountId: id, kind, mode: 'test-credits', asset: TEST_ASSET };
    if (kind === 'buyer') {
      out.available = formatAtomic(balance(db, id, 'buyer_available', TEST_ASSET));
      out.held = formatAtomic(balance(db, id, 'buyer_held', TEST_ASSET));
      out.creditCap = formatAtomic(TEST_CREDIT_CAP);
      if (rt.live) {
        out.live = { asset: LIVE_ASSET, available: formatAtomic(balance(db, id, 'buyer_available', LIVE_ASSET)), held: formatAtomic(balance(db, id, 'buyer_held', LIVE_ASSET)) };
      }
    } else {
      out.earnings = formatAtomic(balance(db, id, 'seller_earnings', TEST_ASSET));
      if (rt.live) out.live = { asset: LIVE_ASSET, earnings: formatAtomic(balance(db, id, 'seller_earnings', LIVE_ASSET)), pendingPayout: formatAtomic(balance(db, id, 'payout_pending', LIVE_ASSET)) };
    }
    return ok(out);
  }
  // ---- Buy AI: the catalogue is fetched from Buy, and the buyer's OWN wallet pays Buy directly (x402 / EIP-3009)
  if (path.startsWith('/buy/')) {
    const buyConfig = rt.buy?.config();
    const feeNote = 'The platform fee is recorded as DUE (3%) but is NOT collected in this version: the Buy payment goes entirely to Buy, and Payrail is not a party to it.';
    if (method === 'GET' && (m = path.match(/^\/buy\/service\/([\w.-]{1,160})$/))) {
      if (!rt.buyCatalog) throw new ApiError(404, 'NOT_FOUND', 'the Buy catalogue is not connected on this server');
      const cat = await rt.buyCatalog();
      const svc = cat.services.find((x) => x.id === m![1]);
      if (!svc) throw new ApiError(404, 'NOT_FOUND', 'no such Buy API in the current catalogue');
      let host = '';
      try { host = new URL(svc.url).host; } catch { /* leave empty */ }
      return ok({
        service: {
          id: svc.id, title: svc.title, description: svc.description, platform: svc.platform, provider: svc.provider ?? null, method: svc.method, host, available: svc.available,
          price: svc.price ? { indicative: true, usd: svc.price.usd, minUsd: formatUsdt(svc.price.minAtomic), maxUsd: formatUsdt(svc.price.maxAtomic), options: svc.price.options.map((o) => ({ label: o.label, usd: o.usd })), tokens: svc.price.tokens } : null,
          inputSchema: svc.inputSchema ?? null,
        },
        payment: {
          enabled: Boolean(rt.buy) && Boolean(rt.live),
          how: 'Your wallet signs a one-time EIP-3009 authorization for the exact price in USDT on Celo. Buy settles it on-chain and runs the API. Payrail never holds your funds and never has your key.',
          network: { name: 'celo', chainId: cat.payment.chainId },
          token: { symbol: 'USDT', address: buyConfig?.usdt ?? cat.payment.tokens.find((t) => t.symbol === 'USDT')?.address ?? null },
          payTo: buyConfig?.payTo ?? cat.payment.payTo ?? null,
          scheme: 'exact',
          maxPerPayment: buyConfig ? formatUsdt(buyConfig.maxPerPaymentAtomic) : null,
        },
        fee: { percent: 3, state: 'not_collected', note: feeNote },
        source: { url: 'https://gateway.usebuy.ai/v1/catalog', fetchedAt: new Date(cat.fetchedAt).toISOString(), stale: cat.stale },
      });
    }
    if (method === 'GET' && path === '/buy/currencies') {
      if (!rt.live || !rt.buyConvert) {
        return ok({ enabled: false, currencies: [], note: 'Paying with another currency is not enabled on this server. Only USDT on Celo can be used.' });
      }
      const list = await rt.buyConvert.currencies();
      return ok({
        enabled: true,
        settlement: { symbol: 'USDT', note: 'Buy AI is paid in USDT on Celo. Textile Protocol converts your currency into USDT in your own wallet first; it does not pay Buy.' },
        conversionLimit: rt.buyConvert.config().maxUsdt,
        currencies: list,
      });
    }
    if (!rt.live) throw new ApiError(403, 'NOT_AVAILABLE', 'Buy payments exist only in the production environment');
    if (!rt.buy) throw new ApiError(409, 'BUY_PAYMENTS_DISABLED', 'Buy payments are not enabled on this server (the operator must set PAYRAIL_BUY_PAYMENTS=1). Nothing can be paid.');
    const buyBuyer = () => {
      const bid = buyer();
      const w = queryOne(db, "SELECT wallet FROM account_wallets WHERE account_id = ? AND kind = 'buyer'", bid);
      if (!w) throw new ApiError(409, 'NO_WALLET', 'sign in with your wallet first');
      return { id: bid, wallet: String(w.wallet) };
    };
    if (method === 'POST' && path === '/buy/quote') {
      const b = buyBuyer();
      let conversionId: string | undefined;
      if (typeof body.conversionId === 'string' && body.conversionId) {
        // only a conversion that was PROVEN on-chain for this buyer may be attached to an order
        if (!rt.buyConvert?.confirmedFor(b.id, body.conversionId)) throw new ApiError(409, 'CONVERSION_NOT_CONFIRMED', 'that conversion is not confirmed on-chain, so it cannot be attached to a purchase');
        conversionId = body.conversionId;
      }
      return ok(await rt.buy.quote({ buyerId: b.id, wallet: b.wallet, serviceId: str(body.serviceId, 'serviceId', 160), input: body.input ?? {}, ...(conversionId ? { conversionId } : {}) }), 201);
    }
    if (method === 'POST' && path === '/buy/pay') {
      const b = buyBuyer();
      const r = await rt.buy.pay({ buyerId: b.id, orderId: str(body.orderId, 'orderId', 80), signature: str(body.signature, 'signature', 400) });
      return ok({ ...r, conversion: r.order.conversionId && rt.buyConvert ? rt.buyConvert.confirmedFor(b.id, r.order.conversionId) ?? null : null });
    }
    // ---- pay with another currency: Textile converts in the buyer's own wallet, THEN the Buy payment above is made in USDT
    if (path.startsWith('/buy/convert/')) {
      const bc = rt.buyConvert;
      if (!bc) throw new ApiError(409, 'CONVERSION_DISABLED', 'paying with another currency is not enabled on this server (the operator must set PAYRAIL_BUY_CONVERSION=1). Only USDT can be used.');
      if (method === 'POST' && path === '/buy/convert/estimate') {
        const b = buyBuyer();
        const need = await rt.buy.shortfall({ buyerId: b.id, orderId: str(body.orderId, 'orderId', 80) });
        if (need.shortfallAtomic <= 0n) throw new ApiError(409, 'NO_CONVERSION_NEEDED', 'your wallet already holds enough USDT for this API; pay directly');
        const r = await bc.estimate({ buyerId: b.id, wallet: b.wallet, symbol: str(body.symbol, 'symbol', 20), targetAtomic: need.shortfallAtomic });
        return ok({ ...r, funding: { usdtBalance: need.balance, apiPrice: need.amount, shortfall: need.shortfall } }, 201);
      }
      if (method === 'POST' && path === '/buy/convert/proof') {
        const b = buyBuyer();
        const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
        const issuedAt = now();
        const t = takerControlTypedData(b.wallet as `0x${string}`, bc.config().chainId, nonce, issuedAt);
        return ok({
          typedData: { domain: t.domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], ...t.types }, primaryType: t.primaryType, message: { taker: t.message.taker, chainId: String(t.message.chainId), nonce, issuedAt: String(issuedAt) } },
          nonce, issuedAt,
          note: 'This signature lets Textile bind a price to YOUR wallet. It moves nothing.',
        });
      }
      if (method === 'POST' && path === '/buy/convert/prepare') {
        const b = buyBuyer();
        const issued = Number(body.issuedAt);
        const nonce = str(body.nonce, 'nonce', 70) as `0x${string}`;
        const signature = str(body.signature, 'signature', 400) as `0x${string}`;
        if (!Number.isFinite(issued) || Math.abs(now() - issued) > 5 * 60_000) throw new ApiError(422, 'PROOF_EXPIRED', 'the authorization is stale; sign again');
        if (!(await verifyTakerProof({ taker: b.wallet as `0x${string}`, chainId: bc.config().chainId, nonce, issuedAtMs: issued, signature }))) throw new ApiError(422, 'BAD_SIGNATURE', 'the signature was not made by your signed-in wallet');
        const r = await bc.prepare({ buyerId: b.id, wallet: b.wallet, conversionId: str(body.conversionId, 'conversionId', 80), proof: { nonce, issuedAt: issued, signature } });
        return ok({ ...r, chainId: bc.config().chainId, note: 'These are the only transactions your wallet should send for this conversion. Check the destination in your wallet before confirming.' });
      }
      if (method === 'POST' && path === '/buy/convert/tx') {
        const b = buyBuyer();
        const kind = body.kind === 'approve' || body.kind === 'swap' ? body.kind : undefined;
        if (!kind) throw bad('kind must be approve or swap');
        return ok({ conversion: await bc.recordTx({ buyerId: b.id, conversionId: str(body.conversionId, 'conversionId', 80), kind, txHash: str(body.txHash, 'txHash', 80) }) });
      }
      if (method === 'GET' && (m = path.match(/^\/buy\/convert\/([\w-]{1,80})$/))) {
        const id = buyer();
        return ok({ conversion: bc.get(id, m[1]!), events: bc.events(id, m[1]!) });
      }
      if (method === 'POST' && (m = path.match(/^\/buy\/convert\/([\w-]{1,80})\/recheck$/))) {
        const id = buyer();
        return ok({ conversion: await bc.verify({ buyerId: id, conversionId: m[1]! }) });
      }
    }
    if (method === 'GET' && path === '/buy/orders') return ok({ orders: rt.buy.list(buyer()) });
    if (method === 'GET' && (m = path.match(/^\/buy\/order\/([\w-]{1,80})$/))) {
      const id = buyer();
      const o = rt.buy.order(id, m[1]!);
      return ok({ order: o, events: rt.buy.events(id, m[1]!), conversion: o.conversionId && rt.buyConvert ? rt.buyConvert.confirmedFor(id, o.conversionId) ?? null : null });
    }
    if (method === 'POST' && (m = path.match(/^\/buy\/order\/([\w-]{1,80})\/recheck$/))) {
      const id = buyer();
      return ok({ order: await rt.buy.recheck({ buyerId: id, orderId: m[1]! }) });
    }
  }

  if (method === 'POST' && path === '/credits') {
    if (rt.live) throw new ApiError(403, 'NOT_AVAILABLE', 'test credits do not exist in real-funds mode');
    const id = buyer();
    const r = grantTestCredits(rt, id, parseAtomic(body.amount ?? '1'));
    return ok({ granted: formatAtomic(r.granted), totalGranted: formatAtomic(r.total), note: 'TEST CREDITS - not real money' });
  }
  if (method === 'POST' && path === '/execute') {
    const id = buyer();
    if (body.settlement === 'escrow') {
      if (!rt.escrow) throw new ApiError(409, 'ESCROW_DISABLED', 'escrow settlement is not enabled on this server');
      const er = await executeEscrowRequest(db, rt.keys, rt.escrow.client, { buyerId: id, listingId: str(body.listingId, 'listingId', 80), idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 100), input: body.input ?? {}, asset: rt.escrow.asset }, { ...(rt.execute?.call ? { call: rt.execute.call } : {}), ...(rt.execute?.demoCall ? { demoCall: rt.execute.demoCall } : {}), ...(rt.now ? { now: rt.now } : {}) });
      return ok({ result: er, settlement: 'escrow' }, er.replay ? 200 : 201);
    }
    if (rt.live) assertRealListing(str(body.listingId, 'listingId', 80));
    const r = await executeRequest(db, rt.keys, { buyerId: id, listingId: str(body.listingId, 'listingId', 80), idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 100), input: body.input ?? {} }, rt.execute ?? {});
    return ok({ result: r }, r.replay ? 200 : 201);
  }
  if (method === 'GET' && path === '/me/statement') {
    const id = buyer();
    return ok({ statement: buyerStatement(db, id) });
  }
  if (method === 'GET' && (m = path.match(/^\/receipt\/([\w-]{1,80})$/))) {
    const id = buyer();
    const e = queryOne(db, 'SELECT buyer_id FROM executions WHERE id = ?', m[1]!);
    if (!e || String(e.buyer_id) !== id) throw new ApiError(404, 'NOT_FOUND', 'no such receipt');
    return ok({ receipt: receiptFor(db, m[1]!) });
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

  // ---- real funds (only when live mode is configured)
  const liveOnly = () => {
    if (!rt.live) throw new ApiError(409, 'LIVE_DISABLED', 'real-funds mode is not enabled on this server; the marketplace is running on test credits');
    return rt.live.funding;
  };
  if (method === 'GET' && path === '/funding') {
    const id = buyer();
    if (!rt.live) return ok({ enabled: false });
    const f = rt.live.funding;
    return ok({
      enabled: true,
      asset: f.asset,
      chainId: f.chainId,
      token: f.token,
      depositAddress: f.depositAddress,
      minConfirmations: f.minConfirmations,
      maxDeposit: formatAtomic(f.maxDepositAtomic),
      wallets: fundingWallets(db, id),
      walletMessageTemplate: fundingMessage(id, '<your wallet address in lowercase>'),
      howTo: 'Register the wallet you will send from (sign the message), then send the deposit token from that wallet to the deposit address, then paste the transaction hash. Only transfers from your registered wallet are credited.',
    });
  }
  if (method === 'POST' && path === '/funding/wallet') {
    const id = buyer();
    liveOnly();
    return ok(await registerFundingWallet(db, id, str(body.wallet, 'wallet', 60), str(body.signature, 'signature', 400), now), 201);
  }
  if (method === 'POST' && path === '/funding/confirm') {
    const id = buyer();
    const r = await confirmDeposit(db, liveOnly(), id, str(body.txHash, 'txHash', 80), now);
    return ok({ credited: r.credited.map((c) => ({ amount: formatAtomic(c.amountAtomic), logIndex: c.logIndex, alreadyCredited: !c.created })), confirmations: r.confirmations });
  }
  if (method === 'GET' && path === '/seller/payouts') {
    const id = seller();
    return ok({ enabled: Boolean(rt.live), payouts: payoutsOf(db, id).map((p) => ({ id: p.id, amount: formatAtomic(p.amountAtomic), asset: p.asset, destination: p.destination, state: p.state, txHash: p.txHash, requestedAt: p.requestedAt, note: p.note })) });
  }
  if (method === 'POST' && path === '/seller/payouts') {
    const id = seller();
    if (!rt.live) throw new ApiError(409, 'LIVE_DISABLED', 'payouts are not enabled; earnings here are test credits and cannot be paid out');
    if (!rt.live.payoutRequestsEnabled) throw new ApiError(409, 'PAYOUTS_DISABLED', 'seller payouts are disabled for live use until the secure payout architecture is implemented and reviewed. Earnings stay in your balance.');
    const p = requestPayout(db, id, { asset: LIVE_ASSET, amountAtomic: parseAtomic(body.amount) }, rt.live.payout, now);
    return ok({ payout: { id: p.id, state: p.state, destination: p.destination, amount: formatAtomic(p.amountAtomic) }, note: 'Waiting for operator approval. Funds are reserved and cannot be spent twice.' }, 201);
  }
  if (method === 'POST' && (m = path.match(/^\/seller\/payouts\/([\w-]{1,80})\/cancel$/))) {
    const id = seller();
    const cur = payoutsOf(db, id).find((p) => p.id === m![1]);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'no such payout');
    return ok({ payout: { id: cur.id, state: cancelPayout(db, cur.id, id, now).state } });
  }

  // ---- agents (owner side)
  if (method === 'POST' && path === '/agents') {
    const id = buyer();
    const list = Array.isArray(body.allowedListings) ? body.allowedListings.filter((x): x is string => typeof x === 'string') : undefined;
    const r = createAgent(db, id, { name: str(body.name, 'name', 60), perRequestCapAtomic: parseAtomic(body.perRequestCap), dailyCapAtomic: parseAtomic(body.dailyCap), ...(list && list.length ? { allowedListings: list } : {}) }, now);
    return ok({ agent: { id: r.agent.id, name: r.agent.name, perRequestCap: formatAtomic(r.agent.perRequestCapAtomic), dailyCap: formatAtomic(r.agent.dailyCapAtomic) }, key: r.key, note: 'Copy the key now. It is shown once and only its hash is stored.' }, 201);
  }
  if (method === 'GET' && path === '/agents') {
    const id = buyer();
    return ok({
      agents: listAgents(db, id, now).map((a) => ({ id: a.id, name: a.name, status: a.status, perRequestCap: formatAtomic(a.perRequestCapAtomic), dailyCap: formatAtomic(a.dailyCapAtomic), spentLast24h: formatAtomic(a.spentLast24hAtomic), allowedListings: a.allowedListings })),
    });
  }
  if (method === 'POST' && (m = path.match(/^\/agents\/([\w-]{1,80})\/revoke$/))) {
    const id = buyer();
    return ok({ agent: { id: m[1], status: revokeAgent(db, id, m[1]!, now).status } });
  }
  // ---- agents (the agent itself; authenticated by its own key, which a browser never holds)
  if (method === 'GET' && path === '/agent/spec') return ok({ spec: AGENT_SPEC });
  if (path.startsWith('/agent/')) {
    if (!req.bearer) throw new AgentError('KEY_INVALID', 'send the agent key as a Bearer token');
    const agent = authenticateAgent(db, req.bearer);
    const usage = () => agentUsage(db, agent, now);
    const listingFor = (id: string) => {
      const q = quoteFor(db, id, { escrowEnabled: false });
      const l = getListing(db, id);
      if (!q || !l || l.status !== 'published') return undefined;
      const allowed = !agent.allowedListings || agent.allowedListings.includes(id);
      const price = BigInt(q.buyerPays.atomic);
      const withinCap = price <= agent.perRequestCapAtomic;
      const withinDaily = price <= usage().remainingDailyAtomic;
      return {
        id,
        name: q.name,
        description: q.description,
        method: l.method,
        asset: q.asset,
        available: q.available,
        unavailableReason: q.unavailableReason,
        price: q.buyerPays,
        platformFee: q.platformFee,
        sellerReceives: q.sellerReceives,
        responseRequirements: q.chargedOnlyIf,
        freshness: q.freshness,
        maxLatencyMs: q.maxLatencyMs,
        contract: q.contract,
        input: { type: 'object', rules: 'flat object of short string, number or boolean values (max 20 fields)', via: l.method === 'GET' ? 'query string' : 'JSON body' },
        notCharged: q.notCharged,
        validationNote: q.validationNote,
        forThisAgent: { allowed, withinPerRequestCap: withinCap, withinDailyBudget: withinDaily, canExecute: q.available && allowed && withinCap && withinDaily },
        origin: l.demo ? 'payrail-demo' : isSandboxHost(l.host) ? 'payrail-sandbox' : 'payrail-seller',
      };
    };
    if (method === 'GET' && path === '/agent/me') {
      const u = usage();
      return ok({
        agent: { id: agent.id, name: agent.name, status: agent.status },
        limits: { perRequest: formatAtomic(agent.perRequestCapAtomic), daily: formatAtomic(agent.dailyCapAtomic), allowedListings: agent.allowedListings },
        usage: { spentLast24h: formatAtomic(u.spentLast24hAtomic), remainingDaily: formatAtomic(u.remainingDailyAtomic) },
        credits: (rt.live ? [LIVE_ASSET] : [TEST_ASSET]).map((asset) => ({ asset, available: formatAtomic(balance(db, agent.ownerId, 'buyer_available', asset)) })),
      });
    }
    if (method === 'GET' && path === '/agent/catalog') {
      const items = query(db, "SELECT id FROM listings WHERE status = 'published' ORDER BY created_at, name").map((r) => listingFor(String(r.id))).filter((x) => x !== undefined);
      return ok({ count: items.length, items });
    }
    if (method === 'GET' && (m = path.match(/^\/agent\/listing\/([\w-]{1,80})$/))) {
      const item = listingFor(m[1]!);
      if (!item) throw new ApiError(404, 'LISTING_NOT_PUBLISHED', 'no such available listing');
      return ok({ listing: item });
    }
    if (method === 'POST' && path === '/agent/execute') {
      if (rt.live) assertRealListing(str(body.listingId, 'listingId', 80));
      const r = await executeAsAgent(db, rt.keys, agent, { listingId: str(body.listingId, 'listingId', 80), idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 50), input: body.input ?? {} }, rt.execute ?? {});
      const receipt = receiptFor(db, r.executionId)!;
      const advice =
        r.state === 'QUALIFIED' ? 'Charged. Use result.body.'
          : r.state === 'NOT_QUALIFIED' ? 'Not charged. The response failed validation or the request was not sent. Use a new idempotencyKey to try again.'
            : r.state === 'HELD' ? 'In progress. Retry with the SAME idempotencyKey to read the stored outcome; never a new key.'
              : r.state === 'UNRESOLVED' ? 'Outcome unknown. Nothing is charged. Poll GET /agent/receipt/{executionId}; the hold is released to the owner if it stays unresolved. Do not retry with a new key.'
                : 'Released to the owner. Not charged.';
      return ok({ outcome: receipt.outcome, charged: r.charged, result: r, receipt, advice }, r.replay ? 200 : 201);
    }
    if (method === 'GET' && (m = path.match(/^\/agent\/receipt\/([\w-]{1,80})$/))) {
      const e = queryOne(db, 'SELECT agent_id FROM executions WHERE id = ?', m[1]!);
      // an agent can only ever read receipts of requests made with its own key
      if (!e || String(e.agent_id ?? '') !== agent.id) throw new ApiError(404, 'NOT_FOUND', 'no such receipt');
      return ok({ receipt: receiptFor(db, m[1]!) });
    }
    if (method === 'GET' && path === '/agent/executions') {
      return ok({ executions: agentExecutionIds(db, agent.id).map((id) => { const r = receiptFor(db, id)!; return { receiptId: r.receiptId, at: r.createdAt, listing: r.listing, outcome: r.outcome, charged: r.charged.display, asset: r.asset }; }) });
    }
  }

  // ---- multi-asset funding (Stage 1, simulated provider): any enabled asset -> USDT -> marketplace balance
  if (path.startsWith('/fund/') && rt.conversion) {
    const id = buyer();
    const c = rt.conversion;
    if (rt.live && c.simulated) throw new ApiError(403, 'NOT_AVAILABLE', 'simulated conversion does not exist in real-funds mode');
    // defence in depth: a live provider is never used unless real-funds mode was explicitly enabled
    if (!c.simulated && !rt.live) throw new ApiError(409, 'LIVE_DISABLED', 'live conversion is disabled: real-funds mode is not enabled');
    const walletOf = (buyerId: string): string | undefined => fundingWallets(db, buyerId)[0];
    const demoKey = () => privateKeyToAccount(sandboxSeed(rt.activeKey, `fund-wallet:${id}`));
    if (method === 'GET' && path === '/fund/wallet') {
      return ok({
        expectedChainId: c.chainId,
        wallets: fundingWallets(db, id),
        messageTemplate: fundingMessageOnChain(id, '<your wallet address in lowercase>', c.chainId),
        demoAvailable: Boolean(rt.sandbox) && !rt.live && c.simulated,
        simulated: c.simulated,
        note: 'Connecting a wallet proves you control it. It never gives Payrail access to your funds. Only transfers FROM this wallet can be credited to you.',
      });
    }
    if (method === 'POST' && path === '/fund/wallet') {
      const chainId = Number(body.chainId ?? c.chainId);
      if (chainId !== c.chainId) throw new ApiError(422, 'WRONG_NETWORK', `connect your wallet to chain ${c.chainId} (Celo mainnet); it reported chain ${chainId}`);
      let wallet = typeof body.wallet === 'string' ? body.wallet : '';
      let signature = typeof body.signature === 'string' ? body.signature : '';
      let demo = false;
      if (body.demo === true) {
        if (!rt.sandbox || rt.live || !c.simulated) throw new ApiError(409, 'SANDBOX_DISABLED', 'the demo wallet exists only in simulation');
        const k = demoKey();
        wallet = k.address;
        signature = await k.signMessage({ message: fundingMessageOnChain(id, k.address.toLowerCase(), c.chainId) });
        demo = true;
      }
      const r = await registerFundingWallet(db, id, wallet, signature, now, c.chainId);
      return ok({ address: r.address, chainId: c.chainId, demo, simulated: c.simulated }, 201);
    }
    if (method === 'POST' && path === '/fund/wallet/authorization-check') {
      // Proves the connected wallet can produce the TakerControl authorization Textile needs. Sends NOTHING to Textile.
      const w = walletOf(id);
      if (!w) throw new ApiError(409, 'NO_FUNDING_WALLET', 'connect and verify a wallet first');
      const issued = Number(body.issuedAt);
      if (typeof body.signature !== 'string') {
        const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
        const issuedAt = now();
        const t = takerControlTypedData(w as `0x${string}`, c.chainId, nonce, issuedAt);
        return ok({
          typedData: { domain: t.domain, types: t.types, primaryType: t.primaryType, message: { taker: t.message.taker, chainId: String(t.message.chainId), nonce, issuedAt: String(issuedAt) } },
          nonce, issuedAt, wallet: w,
          note: 'Sign this in your wallet. It is checked here and is NOT sent to Textile; no quote is requested and nothing is converted.',
        });
      }
      if (!Number.isFinite(issued) || Math.abs(now() - issued) > 5 * 60_000) throw new ApiError(422, 'PROOF_EXPIRED', 'the authorization request is stale; start again');
      let signature = body.signature;
      if (body.demo === true) {
        if (!rt.sandbox || rt.live || !c.simulated) throw new ApiError(409, 'SANDBOX_DISABLED', 'the demo wallet exists only in simulation');
        const k = demoKey();
        const t = takerControlTypedData(k.address, c.chainId, str(body.nonce, 'nonce', 70) as `0x${string}`, issued);
        signature = await k.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      }
      const okSig = await verifyTakerProof({ taker: w as `0x${string}`, chainId: c.chainId, nonce: str(body.nonce, 'nonce', 70) as `0x${string}`, issuedAtMs: issued, signature: signature as `0x${string}` });
      if (!okSig) throw new ApiError(422, 'BAD_SIGNATURE', 'the signature was not made by your verified wallet over this authorization');
      audit(db, id, 'funding.taker_authorization_checked', w, undefined, new Date(now()));
      return ok({ verified: true, wallet: w, sentToTextile: false });
    }
    const routeView = (r: Awaited<ReturnType<typeof c.registry.routes>>[number]) => ({
      symbol: (r.from.symbol), chainId: r.from.chainId, address: r.from.address, decimals: r.from.decimals,
      passthrough: r.passthrough === true, available: r.available, enabled: r.enabled, usable: r.usable, reason: r.reason,
      evidence: r.evidence,
      min: fmtUnits(r.minInputAtomic, r.from.decimals), max: fmtUnits(r.maxInputAtomic, r.from.decimals), provider: r.provider,
    });
    if (method === 'GET' && path === '/fund/routes') {
      const rs = await c.registry.routes('funding');
      return ok({
        simulated: c.simulated,
        note: 'Routes are discovered live from the provider and filtered by the operator allow-list. A route that works into USDT says nothing about the reverse direction.',
        deliversTo: 'USDT on Celo',
        routes: rs.map(routeView),
        scenarios: c.simulated ? (rt.dev?.fundingScenarios ?? []) : [],
      });
    }
    if (method === 'GET' && path === '/fund/config') {
      return ok({
        enabled: true, multiAsset: true, mode: c.simulated ? 'simulated' : 'live', simulated: c.simulated,
        banner: c.simulated ? 'SIMULATED conversion: no real assets are spent and no real USDT is received. Credits are test credits.' : 'LIVE conversion into USDT.',
        buy: 'USDT', creditAsset: c.creditAsset, creditLabel: c.simulated ? 'test credits (simulated funding)' : 'USDT',
        depositAddress: c.depositAddress, minConfirmations: c.minConfirmations, usdt: c.usdt, buyerSigned: Boolean(c.buyerSwap && !c.simulated && rt.live), chainId: c.chainId,
        steps: ['Pick an asset and an amount and get a quote (nothing is converted yet)', 'Review the rate, fee, minimum and what will be credited, then approve', 'Your wallet converts, then deposits the USDT; each step is verified on-chain before your balance is credited'],
        scenarios: c.simulated ? (rt.dev?.fundingScenarios ?? []) : [],
      });
    }
    if (method === 'GET' && path === '/fund/ops') {
      return ok({
        operations: listFundingOps(db, id).map((o) => fundingView(o, now())),
        balances: { asset: c.creditAsset, available: formatAtomic(balance(db, id, 'buyer_available', c.creditAsset)), held: formatAtomic(balance(db, id, 'buyer_held', c.creditAsset)) },
      });
    }
    if (method === 'GET' && (m = path.match(/^\/fund\/ops\/([\w-]{1,80})$/))) {
      const o = getFundingOp(db, m[1]!);
      if (!o || o.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
    if (method === 'POST' && path === '/fund/quote') {
      const symbol = typeof body.asset === 'string' && body.asset ? body.asset : 'cNGN';
      const route = await c.registry.find('funding', symbol);
      if (!route) throw new ApiError(422, 'UNSUPPORTED_ASSET', `${symbol} is not a supported funding asset: no verified conversion route to USDT exists`);
      if (!route.usable) throw new ApiError(422, 'UNSUPPORTED_ASSET', `${route.from.symbol} cannot be used to fund right now: ${route.reason ?? 'unavailable'}`);
      const amount = parseUnitsText(body.amount, route.from.decimals);
      const key = typeof body.idempotencyKey === 'string' && /^[\w.:-]{8,100}$/.test(body.idempotencyKey) ? body.idempotencyKey : `q-${randomBytes(12).toString('hex')}`;
      const scenario = c.simulated && typeof body.scenario === 'string' && (rt.dev?.fundingScenarios ?? []).includes(body.scenario) ? body.scenario : undefined;
      const w = walletOf(id);
      // simulation may use a stand-in wallet; anything live needs a wallet the buyer proved
      if (!c.simulated && !w) throw new ApiError(409, 'NO_FUNDING_WALLET', 'connect and verify your wallet before requesting a funding quote');
      const cfg = fundingConfigFor(c, route.from, id, routeLimits(route), w);
      const o = await requestFundingQuote(db, cfg, { buyerId: id, sellAtomic: amount, idempotencyKey: key, ...(scenario ? { scenario } : {}) }, now);
      return ok({ operation: fundingView(o, now()) }, 201);
    }
    if (method === 'POST' && (path === '/fund/approve' || path === '/fund/check')) {
      const opId = str(body.opId, 'opId', 80);
      const cur = getFundingOp(db, opId);
      if (!cur || cur.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      const cfg = fundingConfigForOp(c, cur);
      const o = path === '/fund/approve'
        ? await approveFunding(db, cfg, { opId, buyerId: id, digest: str(body.digest, 'digest', 100) }, now)
        : await verifyAndCredit(db, cfg, opId, now);
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
    // ---- buyer-signed conversion: the server prepares VALIDATED steps; the buyer's own wallet signs and sends them
    if (method === 'POST' && path === '/fund/prepare') {
      if (!c.buyerSwap || c.simulated || !rt.live) throw new ApiError(409, 'NOT_ENABLED', 'buyer-signed conversion is not enabled on this server');
      const opId = str(body.opId, 'opId', 80);
      const cur = getFundingOp(db, opId);
      if (!cur || cur.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      if (cur.state !== 'CONVERTING' || cur.stage !== 'client') throw new ApiError(409, 'WRONG_STATE', 'approve the quote first; this operation is not waiting for your wallet');
      const w = walletOf(id);
      if (!w || !cur.taker || w.toLowerCase() !== cur.taker.toLowerCase()) throw new ApiError(409, 'NO_FUNDING_WALLET', 'the verified wallet does not match this operation');
      const issued = Number(body.issuedAt);
      const nonce = str(body.nonce, 'nonce', 70) as `0x${string}`;
      const signature = str(body.signature, 'signature', 400) as `0x${string}`;
      if (!Number.isFinite(issued) || Math.abs(now() - issued) > 5 * 60_000) throw new ApiError(422, 'PROOF_EXPIRED', 'the authorization is stale; sign again');
      if (!(await verifyTakerProof({ taker: w as `0x${string}`, chainId: c.chainId, nonce, issuedAtMs: issued, signature }))) throw new ApiError(422, 'BAD_SIGNATURE', 'the signature was not made by your verified wallet');
      const sell = { chainId: cur.sellChainId ?? c.chainId, address: cur.sellAddress ?? '', symbol: cur.sellSymbol, decimals: cur.sellDecimals };
      const prepared = await c.buyerSwap.prepare({ op: cur, wallet: w, sell, proof: { nonce, issuedAt: issued, signature } });
      audit(db, id, 'funding.prepared', cur.id, { result: prepared.kind }, new Date(now()));
      return ok({ prepared, chainId: c.chainId, note: 'These are the only transactions your wallet should send for this conversion. Check the destination in your wallet before confirming.' });
    }
    if (method === 'POST' && path === '/fund/tx') {
      if (!c.buyerSwap || c.simulated || !rt.live) throw new ApiError(409, 'NOT_ENABLED', 'buyer-signed conversion is not enabled on this server');
      const opId = str(body.opId, 'opId', 80);
      const kind = body.kind === 'approve' || body.kind === 'swap' || body.kind === 'deposit' ? body.kind : undefined;
      if (!kind) throw bad('kind must be approve, swap or deposit');
      const cur = getFundingOp(db, opId);
      if (!cur || cur.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      const o = await recordClientTx(db, fundingConfigForOp(c, cur), { opId, buyerId: id, kind, txHash: str(body.txHash, 'txHash', 80) }, now);
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
  }

  // ---- marketplace funding: cNGN -> (Textile) -> USDT -> marketplace balance
  if (path.startsWith('/fund/')) {
    if (rt.live) throw new ApiError(403, 'NOT_AVAILABLE', 'simulated marketplace funding does not exist in real-funds mode');
    const id = buyer();
    const f = rt.funding;
    if (!f) throw new ApiError(409, 'FUNDING_DISABLED', 'marketplace funding is not configured on this server');
    // defence in depth: a live converter is never used unless real-funds mode was explicitly enabled
    if (f.converter.mode === 'live' && !rt.live) throw new ApiError(409, 'LIVE_DISABLED', 'live conversion is disabled: real-funds mode is not enabled');
    const dec = (v: bigint) => formatAtomic(v);
    if (method === 'GET' && path === '/fund/config') {
      const sim = f.converter.mode === 'simulated';
      return ok({
        enabled: true,
        mode: f.converter.mode,
        simulated: sim,
        banner: sim ? 'SIMULATED conversion: no real cNGN is spent and no real USDT is received. Credits are test credits.' : 'LIVE conversion of real cNGN into real USDT.',
        sell: f.converter.sellSymbol,
        buy: f.converter.buySymbol,
        creditAsset: f.creditAsset,
        creditLabel: sim ? 'test credits (simulated funding)' : 'USDT',
        limits: { min: dec(f.limits.minSellAtomic), max: dec(f.limits.maxSellAtomic), perDay: dec(f.limits.maxPerDaySellAtomic), openOperations: f.limits.maxOpenOps },
        minConfirmations: f.minConfirmations,
        scenarios: sim ? (rt.dev?.legacyScenarios ?? []) : [],
        recipient: f.converter.recipient,
        steps: ['Enter a cNGN amount and get a quote (nothing is converted yet)', 'Review the rate, fees, minimum and what will be credited, then approve', 'The conversion is verified on-chain before your balance is credited'],
      });
    }
    if (method === 'GET' && path === '/fund/ops') {
      const ops = listFundingOps(db, id).map((o) => fundingView(o, now()));
      return ok({
        operations: ops,
        balances: { asset: f.creditAsset, available: formatAtomic(balance(db, id, 'buyer_available', f.creditAsset)), held: formatAtomic(balance(db, id, 'buyer_held', f.creditAsset)) },
      });
    }
    if (method === 'GET' && (m = path.match(/^\/fund\/ops\/([\w-]{1,80})$/))) {
      const o = getFundingOp(db, m[1]!);
      if (!o || o.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
    if (method === 'POST' && path === '/fund/quote') {
      const sell = parseAtomic(body.amount);
      const key = typeof body.idempotencyKey === 'string' && /^[\w.:-]{8,100}$/.test(body.idempotencyKey) ? body.idempotencyKey : `q-${randomBytes(12).toString('hex')}`;
      const scenario = f.converter.mode === 'simulated' && typeof body.scenario === 'string' && (rt.dev?.legacyScenarios ?? []).includes(body.scenario) ? body.scenario : undefined;
      const o = await requestFundingQuote(db, f, { buyerId: id, sellAtomic: sell, idempotencyKey: key, ...(scenario ? { scenario } : {}) }, now);
      return ok({ operation: fundingView(o, now()) }, 201);
    }
    if (method === 'POST' && path === '/fund/approve') {
      const o = await approveFunding(db, f, { opId: str(body.opId, 'opId', 80), buyerId: id, digest: str(body.digest, 'digest', 100) }, now);
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
    if (method === 'POST' && path === '/fund/check') {
      const opId = str(body.opId, 'opId', 80);
      const cur = getFundingOp(db, opId);
      if (!cur || cur.buyerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such funding operation');
      const o = await verifyAndCredit(db, f, opId, now);
      return ok({ operation: fundingView(o, now()), events: fundingEvents(db, o.id) });
    }
  }

  // ---- configuration the screens use to explain themselves
  if (method === 'GET' && path === '/config') {
    const tn = rt.escrow?.testnet;
    return ok({
      environment: rt.live ? 'production' : 'development',
      currency: rt.live ? 'USDT' : 'TESTUSDT',
      mode: rt.live ? 'real-funds' : 'test-credits',
      sandbox: Boolean(rt.sandbox) && !rt.live,
      realFunds: Boolean(rt.live),
      buySimulated: Boolean(rt.buySimulated),
      escrow: tn ? { network: 'Celo Sepolia TESTNET', chainId: tn.chainId, contract: tn.escrow, token: tn.token, wallet: tn.wallet, explorer: tn.explorer } : null,
      legend: rt.live ? { 'buy-gateway': ORIGIN_LABELS['buy-gateway'], 'payrail-seller': ORIGIN_LABELS['payrail-seller'] } : ORIGIN_LABELS,
      ...(rt.live ? {
        network: {
          name: 'Celo mainnet',
          chainId: rt.live.funding.chainId,
          token: { symbol: rt.live.funding.asset, address: rt.live.funding.token, decimals: 6 },
          depositAddress: rt.live.funding.depositAddress,
          minConfirmations: rt.live.funding.minConfirmations,
          maxDeposit: formatAtomic(rt.live.funding.maxDepositAtomic),
          platformFeePercent: 3,
        },
        features: {
          conversion: Boolean(rt.conversion && !rt.conversion.simulated),
          buyPayments: Boolean(rt.buy),
          buyConversion: Boolean(rt.buy && rt.buyConvert),
          payouts: Boolean(rt.live.payoutRequestsEnabled),
        },
      } : {}),
    });
  }

  // ---- escrow (TESTNET only)
  if (method === 'GET' && path === '/escrow') {
    const id = buyer();
    const tn = rt.escrow?.testnet;
    if (!rt.escrow || !tn) return ok({ enabled: false });
    const w = fundingWallets(db, id)[0] ?? null;
    return ok({ enabled: true, network: 'Celo Sepolia TESTNET', contract: tn.escrow, token: tn.token, explorer: tn.explorer, wallet: w, available: w ? formatAtomic(await rt.escrow.client.available(w)) : null, operatorWallet: tn.wallet });
  }
  if (method === 'POST' && path === '/escrow/testnet-deposit') {
    const id = buyer();
    const tn = rt.escrow?.testnet;
    if (!rt.escrow || !tn) throw new ApiError(409, 'ESCROW_DISABLED', 'testnet escrow is not enabled on this server');
    if (rt.live) throw new ApiError(409, 'ESCROW_DISABLED', 'the testnet escrow helper is disabled in real-funds mode');
    const amount = parseAtomic(body.amount ?? '0.1');
    if (amount > 1_000_000n) throw bad('testnet deposits are limited to 1 test token at a time');
    let w = fundingWallets(db, id)[0];
    if (!w) {
      // TESTNET CONVENIENCE: the server's testnet operator wallet funds the escrow on the buyer's behalf, so that wallet is
      // recorded as this buyer's funding wallet. Only one buyer can hold it (wallets are unique per buyer).
      const taken = queryOne(db, 'SELECT buyer_id FROM funding_wallets WHERE address = ?', tn.wallet.toLowerCase());
      if (taken) throw new ApiError(409, 'WALLET_TAKEN', 'the testnet escrow wallet is already used by another test buyer');
      db.prepare('INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES (?, ?, ?, ?)').run(tn.wallet.toLowerCase(), id, 'testnet-operator-wallet', new Date(now()).toISOString());
      w = tn.wallet.toLowerCase();
    }
    if (w.toLowerCase() !== tn.wallet.toLowerCase()) throw new ApiError(409, 'NOT_TESTNET_WALLET', 'your registered funding wallet is not the testnet operator wallet, so the server cannot deposit for it');
    const tx = await tn.deposit(amount);
    return ok({ txHash: tx, link: `${tn.explorer}/tx/${tx}`, note: 'TESTNET transaction with a mock token. No real value.' }, 201);
  }

  // ---- seller sandbox sign-in (test-credit mode only)
  if (method === 'POST' && path === '/seller/sandbox/login') {
    if (!rt.sandbox || rt.live) throw new ApiError(409, 'SANDBOX_DISABLED', 'sandbox sellers are only available in test-credit mode');
    const seed = typeof body.seed === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.seed) ? body.seed : randomBytes(16).toString('hex');
    const wallet = privateKeyToAccount(sandboxSeed(rt.activeKey, seed)).address;
    const r = createSandboxSeller(db, wallet, 'Sandbox seller', now);
    return ok({ ...r, wallet, seed, note: 'Sandbox seller: a test wallet derived by this server. Not a real identity.' });
  }

  // ---- seller payout preferences and conversion payouts (Stage 1: simulated provider)
  if (path.startsWith('/seller/payout/') || /^\/seller\/payouts\/(convert|[\w-]{1,80}(\/(confirm|requote|check|retry-delivery|simulate-approve|simulate-execute))?)$/.test(path)) {
    const sid = seller();
    const c = rt.conversion;
    if (!c) throw new ApiError(409, 'CONVERSION_DISABLED', 'payout conversion is not configured on this server');
    const view = (pid: string) => {
      const p = getPayout(db, pid)!;
      const dec = p.target?.decimals ?? 6;
      return {
        id: p.id, state: p.state, stage: p.stage, mode: p.mode, simulated: p.mode === 'convert-simulated' || p.mode === 'usdt-simulated',
        // one word for the whole lifecycle: nothing is 'completed' until the destination payment was verified
        lifecycle: p.state === 'confirmed' ? 'completed' : p.state === 'failed' || p.state === 'cancelled' ? 'failed' : p.stage === 'review' || p.stage === 'converted_undelivered' ? 'review-required' : 'pending',
        usdt: { atomic: p.amountAtomic.toString(), display: formatAtomic(p.amountAtomic), asset: p.asset },
        target: p.target ? { symbol: p.target.symbol, chainId: p.target.chainId, address: p.target.address, decimals: dec, deliveryAddress: p.target.deliveryAddress } : null,
        rate: p.rate,
        expected: p.expectedTarget === null ? null : fmtUnits(p.expectedTarget, dec),
        minimum: p.minTarget === null ? null : fmtUnits(p.minTarget, dec),
        fee: p.feeTarget === null ? null : fmtUnits(p.feeTarget, dec),
        received: p.receivedTarget === null ? null : fmtUnits(p.receivedTarget, dec),
        quoteExpiresAt: p.quoteExpiresAt,
        approvalDigest: p.stage === 'quoted' ? p.approvalDigest : null,
        preferenceVersion: p.preferenceVersion,
        conversionTx: p.conversionTx, deliveryTx: p.deliveryTx,
        failure: p.failure,
        events: payoutEvents(db, p.id),
      };
    };
    const owned = (pid: string) => {
      const p = getPayout(db, pid);
      if (!p || p.sellerId !== sid) throw new ApiError(404, 'NOT_FOUND', 'no such payout');
      return p;
    };
    if (method === 'GET' && path === '/seller/payout/settings') {
      const routes = await c.registry.routes('payout');
      const pref = getPayoutPreference(db, sid, typeof req.query.get('listingId') === 'string' ? req.query.get('listingId') : null);
      return ok({
        simulated: c.simulated,
        preference: { symbol: pref.asset.symbol, version: pref.version, source: pref.source },
        options: routes.map((r) => ({
          symbol: r.to.symbol, chainId: r.to.chainId, address: r.to.address, decimals: r.to.decimals, passthrough: r.passthrough === true,
          available: r.available, enabled: r.enabled, usable: r.usable, reason: r.reason, evidence: r.evidence,
          minUsdt: formatAtomic(r.passthrough ? 0n : r.minInputAtomic), maxUsdt: formatAtomic(r.maxInputAtomic),
        })),
        addresses: payoutAddresses(db, sid),
        rules: [
          'Prices, balances, fees and earnings stay in USDT. Conversion only changes what you receive.',
          'A change applies to payouts requested after you save it. Payouts already requested keep the asset and quote you confirmed.',
          'You see the expected amount, rate, fee and guaranteed minimum before anything is converted, and you confirm that exact quote.',
          'If a conversion cannot be verified, the payout is not marked paid. If it provably did not happen, your USDT earnings are restored.',
          'Not every asset can be paid out: a route that works into USDT may not work in reverse, and some routes are shallow.',
        ],
      });
    }
    if (method === 'POST' && path === '/seller/payout/preference') {
      const pref = await setPayoutPreference(db, c.registry, { sellerId: sid, symbol: str(body.symbol, 'symbol', 20), ...(typeof body.listingId === 'string' && body.listingId ? { listingId: body.listingId } : {}) }, now);
      return ok({ preference: { symbol: pref.asset.symbol, version: pref.version, source: pref.source }, note: 'Applies to payouts you request from now on.' });
    }
    if (method === 'GET' && path === '/seller/payout/address-message') {
      const chainId = Number(req.query.get('chainId') ?? '42220');
      const address = req.query.get('address') ?? '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isInteger(chainId)) throw bad('address and chainId are required');
      return ok({ message: payoutAddressMessage(sid, chainId, address) });
    }
    if (method === 'POST' && path === '/seller/payout/address') {
      const chainId = Number(body.chainId ?? 42220);
      let address = typeof body.address === 'string' ? body.address : '';
      let signature = typeof body.signature === 'string' ? body.signature : '';
      if (body.sandbox === true) {
        if (!rt.sandbox || rt.live) throw new ApiError(409, 'SANDBOX_DISABLED', 'sandbox signing is only available in test-credit mode');
        const acct = queryOne(db, 'SELECT wallet_address FROM accounts WHERE id = ?', sid);
        const key = privateKeyToAccount(sandboxSeed(rt.activeKey, str(body.seed, 'seed', 64)));
        if (!acct || String(acct.wallet_address) !== key.address.toLowerCase()) throw new ApiError(403, 'NOT_SANDBOX_ACCOUNT', 'this account is not a sandbox seller');
        address = key.address;
        signature = await key.signMessage({ message: payoutAddressMessage(sid, chainId, key.address) });
      }
      const r = await registerPayoutAddress(db, { sellerId: sid, chainId, address, signature }, now);
      return ok({ address: r.address, chainId: r.chainId }, 201);
    }
    if (method === 'POST' && path === '/seller/payouts/convert') {
      if (!c.payout) throw new ApiError(409, 'CONVERSION_DISABLED', 'payout conversion is not configured');
      if (rt.live && c.simulated) throw new ApiError(403, 'NOT_AVAILABLE', 'simulated payouts do not exist in real-funds mode');
      const asset = c.simulated ? TEST_ASSET : LIVE_ASSET;
      const amount = parseAtomic(body.amount);
      const scenario = c.simulated && typeof body.scenario === 'string' && (rt.dev?.payoutScenarios ?? []).includes(body.scenario) ? body.scenario : undefined;
      const p = await requestConversionPayout(db, c.payout, { sellerId: sid, amountAtomic: amount, asset, ...(typeof body.listingId === 'string' && body.listingId ? { listingId: body.listingId } : {}), ...(scenario ? { scenario } : {}) }, now);
      return ok({ payout: view(p.id) }, 201);
    }
    if (method === 'GET' && (m = path.match(/^\/seller\/payouts\/([\w-]{1,80})$/))) {
      owned(m[1]!);
      return ok({ payout: view(m[1]!) });
    }
    if (method === 'POST' && (m = path.match(/^\/seller\/payouts\/([\w-]{1,80})\/(confirm|requote|check|retry-delivery|simulate-approve|simulate-execute)$/))) {
      owned(m[1]!);
      if (!c.payout) throw new ApiError(409, 'CONVERSION_DISABLED', 'payout conversion is not configured');
      const pid = m[1]!;
      const action = m[2]!;
      if (action === 'confirm') confirmConversionQuote(db, { sellerId: sid, payoutId: pid, digest: str(body.digest, 'digest', 100) }, now);
      else if (action === 'requote') await requoteConversionPayout(db, c.payout, { sellerId: sid, payoutId: pid }, now);
      else if (action === 'check') await recheckConversionPayout(db, c.payout, pid, now);
      else if (action === 'retry-delivery') await retryConversionDelivery(db, c.payout, pid, now);
      else {
        // SIMULATION ONLY: stands in for the operator CLI approval and the bounded custody signer
        if (!c.simulated || rt.live) throw new ApiError(409, 'SIMULATION_ONLY', 'this control exists only in simulation; real payouts are approved and executed by the operator tooling');
        if (action === 'simulate-approve') approvePayout(db, pid, 'simulated-operator', now);
        else {
          const scenario = typeof body.scenario === 'string' && (rt.dev?.payoutScenarios ?? []).includes(body.scenario) ? body.scenario : undefined;
          await executeConversionPayout(db, c.payout, { payoutId: pid, ...(scenario ? { scenario } : {}) }, now);
        }
      }
      return ok({ payout: view(pid) });
    }
  }

  // ---- buyer wallet sign-in (signature proves wallet control; the message names the network; single-use nonce)
  if (method === 'POST' && path === '/buyer/login/start') {
    const expected = rt.conversion?.chainId ?? CELO_CHAIN_ID;
    return ok({ ...startBuyerLogin(db, { wallet: str(body.wallet, 'wallet', 60), chainId: Number(body.chainId), expectedChainId: expected }, now), expectedChainId: expected });
  }
  if (method === 'POST' && path === '/buyer/login/complete') {
    const r = await completeBuyerLogin(db, { wallet: str(body.wallet, 'wallet', 60), nonce: str(body.nonce, 'nonce', 80), signature: str(body.signature, 'signature', 400) }, now);
    return ok({ ...r, mode: rt.live ? 'live' : 'test-credits' }, r.created ? 201 : 200);
  }

  // ---- seller sign-in
  if (method === 'POST' && path === '/seller/login/start') {
    // network check when the wallet reports its chain (the UI always does); the signature itself proves wallet control only
    const expected = rt.conversion?.chainId ?? CELO_CHAIN_ID;
    if (body.chainId !== undefined && Number(body.chainId) !== expected) throw new ApiError(422, 'WRONG_NETWORK', `switch your wallet to chain ${expected}`);
    return ok(startLogin(db, str(body.wallet, 'wallet', 60), now));
  }
  if (method === 'POST' && path === '/seller/login/complete') {
    const r = await completeLogin(db, { wallet: str(body.wallet, 'wallet', 60), nonce: str(body.nonce, 'nonce', 80), signature: str(body.signature, 'signature', 400) }, now);
    return ok(r);
  }

  // ---- seller
  if (method === 'GET' && path === '/seller/listings') {
    const id = seller();
    return ok({ listings: listingsOf(db, id).map((l) => listingView(db, l, true, rt.keys.map((k) => k.id))) });
  }
  if (method === 'POST' && path === '/seller/listings') {
    const id = seller();
    const meth = body.method === 'POST' ? 'POST' : 'GET';
    if (rt.live && isSandboxHost(safeHost(str(body.endpointUrl, 'endpointUrl', 500)))) throw new ApiError(422, 'NOT_A_REAL_ENDPOINT', 'sandbox endpoints cannot be listed in real-funds mode: use your real, public https API');
    const r = submitListing(
      db,
      id,
      { name: str(body.name, 'name', 80), description: typeof body.description === 'string' ? body.description : '', endpointUrl: str(body.endpointUrl, 'endpointUrl', 500), method: meth, priceAtomic: parseAtomic(body.price), asset: rt.live ? liveOnly().asset : body.live === true ? liveOnly().asset : TEST_ASSET },
      now,
    );
    return ok({ listing: listingView(db, r.listing, true, rt.keys.map((k) => k.id)) }, 201);
  }
  if ((m = path.match(/^\/seller\/listing\/([\w-]{1,80})(?:\/([a-z-]+))?$/))) {
    const id = seller();
    const lid = m[1]!;
    const action = m[2];
    const l = getListing(db, lid);
    if (!l || l.sellerId !== id) throw new ApiError(404, 'NOT_FOUND', 'no such listing');
    const view = () => ok({ listing: listingView(db, getListing(db, lid)!, true, rt.keys.map((k) => k.id)) });
    if (method === 'GET' && !action) return view();
    if (method === 'POST') {
      switch (action) {
        case 'wallet-proof': {
          let signature: string;
          if (body.sandbox === true) {
            if (!rt.sandbox || rt.live) throw new ApiError(409, 'SANDBOX_DISABLED', 'sandbox signing is only available in test-credit mode');
            const acct = queryOne(db, 'SELECT wallet_address FROM accounts WHERE id = ?', id);
            const ch = challengeFor(db, lid)!;
            const seed = str(body.seed, 'seed', 64);
            const key = privateKeyToAccount(sandboxSeed(rt.activeKey, seed));
            if (!acct || String(acct.wallet_address) !== key.address.toLowerCase()) throw new ApiError(403, 'NOT_SANDBOX_ACCOUNT', 'this account is not a sandbox seller');
            signature = await key.signMessage({ message: ch.walletMessage });
          } else {
            signature = str(body.signature, 'signature', 400);
          }
          await submitWalletProof(db, id, lid, signature, now);
          return view();
        }
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
        case 'details': {
          const patch: { name?: string; description?: string; priceAtomic?: bigint } = {};
          if (typeof body.name === 'string') patch.name = body.name;
          if (typeof body.description === 'string') patch.description = body.description;
          if (body.price !== undefined) patch.priceAtomic = parseAtomic(body.price);
          updateListingDetails(db, id, lid, patch, now);
          return view();
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
  if (method === 'GET' && path === '/seller/statement') {
    const id = seller();
    return ok({ statement: sellerStatement(db, id) });
  }
  if (method === 'GET' && path === '/seller/earnings') {
    const id = seller();
    const states = query(db, 'SELECT e.state, COUNT(*) AS n, SUM(COALESCE(e.seller_atomic, 0)) AS s FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? GROUP BY e.state', id);
    const recent = query(db, 'SELECT e.*, l.name FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? ORDER BY e.created_at DESC LIMIT 30', id);
    const earnAsset = rt.live ? LIVE_ASSET : TEST_ASSET;
    return ok({
      asset: earnAsset,
      earnings: formatAtomic(balance(db, id, 'seller_earnings', earnAsset)),
      byState: states.map((r) => ({ state: String(r.state), count: Number(r.n), sellerAtomic: formatAtomic(BigInt(r.s as bigint)) })),
      recent: recent.map(executionRow),
      note: rt.live ? 'Real USDT earnings in your Payrail balance. Payouts are disabled until the secure payout flow is reviewed.' : 'Test credits. Settlement of real funds is not enabled.',
    });
  }
  audit(db, 'system', 'market.unknown_route', `${method} ${path.slice(0, 80)}`, undefined, new Date(now()));
  throw new ApiError(404, 'NOT_FOUND', 'unknown endpoint');
}
