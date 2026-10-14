// Payrail web API: the server side of the browser interface.
//
// DESIGN
//   * The browser NEVER sees or asks for a private key. Signing happens in this process, using the key file the
//     operator loaded with `node --env-file=...` (the same wallet architecture as the CLI). Without a key the
//     interface still works for inspecting and planning.
//   * It adds no new way to spend. Every payment still goes through planOrder -> executeOrder (preflight, order lock,
//     authorization gate, journals, verification, receipts). The browser's "Approve" becomes `approvedBy: 'human:web'`
//     bound to the plan, plus hard bounds (max sell, min receive) that the swap confirmers enforce.
//   * What the user approved is what runs: the server RE-PLANS at approval time and refuses (asking the user to
//     review again) if the terms changed or the new quote falls outside the bounds the user saw.
//   * The service response is third-party data: it is stored verbatim and served as inert text (never HTML).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { ASSETS, assetBySymbol, microUsd } from './assets.ts';
import type { Asset } from './assets.ts';
import { searchServices } from './catalog.ts';
import { handleMarket } from './market.ts';
import { RateLimiter } from './egress.ts';
import type { MarketRuntime } from './market.ts';
import type { Catalog, Service } from './catalog.ts';
import { executeOrder, loadOrder, planOrder, reconcileOrder, resumeOrder } from './orchestrator.ts';
import type { OrderContext, OrderDeps, OrderPlan } from './orchestrator.ts';
import type { OrderRecord } from './orderstore.ts';
import { assessService, formatUsd } from './policy.ts';
import type { SpendingPolicy } from './policy.ts';

// ------------------------------------------------------------------ runtime contract

export interface ApprovalBounds {
  /** The most of the sell asset (atomic) a conversion may debit or approve. */
  maxSellAtomic: bigint;
  /** The least of the buy asset (atomic) the conversion must deliver. */
  minReceiveAtomic: bigint;
}

export interface WebRuntime {
  /** 'simulated' = fakes (no chain, no money). Shown prominently in the UI and on every API answer. */
  mode: 'live' | 'simulated';
  wallet: Address;
  /** True when this process holds a signing key (loaded by the operator from outside the project). */
  signing: boolean;
  attributionTag: string;
  chainId: number;
  policy: SpendingPolicy;
  receiptDir: string;
  catalog(): Promise<Catalog>;
  balances(): Promise<{ nativeWei: bigint; tokens: Array<{ asset: Asset; atomic: bigint }> }>;
  /** Order dependencies. `bounds` are given only when executing: they limit what the swap confirmers accept. */
  orderDeps(opts: { bounds?: ApprovalBounds; log?: (line: string) => void; /** the exact request body being paid for */ body?: string }): OrderDeps;
  now(): number;
  explorerTx(hash: string): string;
  /** Optional: unlock the signing key from an encrypted keystore with a passphrase, entirely inside this process. */
  signer?: {
    canUnlock(): boolean;
    unlock(passphrase: string): Promise<{ ok: true } | { ok: false; message: string }>;
    lock(): void;
  };
}

// ------------------------------------------------------------------ view models

export interface Problem {
  code: string;
  /** Plain-language message for the user. */
  message: string;
}

export interface InspectView {
  ok: true;
  mode: 'live' | 'simulated';
  planId: string;
  validUntil: string;
  status: 'READY' | 'APPROVAL_REQUIRED' | 'BLOCKED';
  canApprove: boolean;
  route: 'direct' | 'swap' | null;
  service: { id: string; title: string; description: string; url: string; method: string; bodyExample: string };
  payTo: string | null;
  price: { symbol: string; amount: string; usd: string | null } | null;
  accepted: Array<{ symbol: string; amount: string; held: string }>;
  fundingOptions: Array<{ symbol: string; held: string; kind: 'direct' | 'convert'; selected: boolean }>;
  conversion: {
    provider: string;
    sellSymbol: string;
    sell: string;
    receiveSymbol: string;
    receive: string;
    rate: string;
    inverseRate: string;
    fee: string;
    keptAfterPaying: string;
    corridorMinimum: string;
    isPreview: true;
  } | null;
  costs: { servicePriceUsd: string | null; conversionFeeUsd: string | null; totalUsd: string | null; gasCelo: string | null; gasOk: boolean };
  maxSpend: { sell: string | null; gasCelo: string | null; payment: string | null };
  approval: { required: boolean; reasons: string[] };
  /** What the user approves: a digest of the stable terms, and the hard bounds. */
  terms: { digest: string; maxSellAtomic: string | null; minReceiveAtomic: string | null };
  steps: string[];
  problems: Problem[];
  uncertainties: string[];
  explanation: string[];
}

/** One browsable service. Derived from the catalog; every text field is untrusted display data. */
export interface CatalogItem {
  id: string;
  title: string;
  description: string;
  platform: string;
  method: string;
  url: string;
  /** Where the listing comes from. Today only the Buy gateway; seller-listed APIs will be another source. */
  source: string;
  available: boolean;
  /** Indicative only: the service's own 402 challenge is the real price. */
  price: { usd: string | null; minUsd: string | null; maxUsd: string | null; variable: boolean } | null;
  verdict: {
    /** May Payrail contact this endpoint at all (allow-listed host, https, no credentials)? */
    contactable: boolean;
    /** Can it be paid without a per-use human approval under the current policy? */
    autoPay: boolean;
    /** Is even its cheapest listed price within the per-payment limit? */
    withinLimit: boolean;
    reasons: string[];
  };
  hasInputSchema: boolean;
}

export interface CatalogView {
  ok: true;
  mode: 'live' | 'simulated';
  source: string;
  /** True when this is a cached copy because a refresh failed (it may be out of date). */
  stale: boolean;
  fetchedAt: string;
  total: number;
  matched: number;
  offset: number;
  limit: number;
  platforms: Array<{ platform: string; count: number }>;
  items: CatalogItem[];
}

export interface OrderView {
  ok: true;
  mode: 'live' | 'simulated';
  orderId: string;
  /** Plain stages for the progress bar. */
  stage: 'running' | 'converting' | 'paying' | 'completed' | 'stopped' | 'uncertain' | 'refused';
  state: string;
  code: string;
  headline: string;
  detail: string;
  /** What the user should do (or explicitly NOT do) next. */
  nextAction: string;
  logs: string[];
  conversion: { provider: string; state: string; txs: Array<{ hash: string; url: string }> } | null;
  payment: { status: string; txHash: string | null; url: string | null; receiptId: string | null; delivered: boolean | null; httpStatus: number | null; sha256: string | null } | null;
  hasResponse: boolean;
  canResume: boolean;
}

// ------------------------------------------------------------------ pure helpers (unit-tested)

const human = (v: bigint, d: number) => formatUnits(v, d);
const bi = (s: string | null | undefined) => (s ? BigInt(s) : undefined);

/** Resolve what the user pasted (a URL or a catalog id) to a catalog service. Only listed services can be paid. */
export function resolveService(input: string, catalog: Catalog): { ok: true; service: Service } | { ok: false; problem: Problem } {
  const raw = input.trim();
  if (!raw) return { ok: false, problem: { code: 'EMPTY', message: 'Paste an API service URL.' } };
  const byId = catalog.services.find((s) => s.id === raw);
  if (byId) return { ok: true, service: byId };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: { code: 'NOT_A_URL', message: 'That is not a valid URL. Paste the full API address, starting with https://.' } };
  }
  if (url.protocol !== 'https:') return { ok: false, problem: { code: 'NOT_HTTPS', message: 'Only https:// service addresses are supported.' } };
  const key = (u: URL) => `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  const hit = catalog.services.find((s) => {
    try {
      return key(new URL(s.url)) === key(url);
    } catch {
      return false;
    }
  });
  if (hit) return { ok: true, service: hit };
  const known = new Set(catalog.services.map((s) => new URL(s.url).host.toLowerCase()));
  return {
    ok: false,
    problem: {
      code: 'UNSUPPORTED_SERVICE',
      message: known.has(url.host.toLowerCase())
        ? `That address is not a listed service on ${url.host}. Payrail only pays services it can identify in the catalog.`
        : `${url.host} is not a supported payment gateway. Payrail currently pays services listed in the Buy gateway catalog (${[...known].join(', ') || 'unavailable'}).`,
    },
  };
}

/** A small example request body generated from the service's input schema (untrusted; only property names/types are used). */
export function exampleBody(schema: Record<string, unknown> | undefined): string {
  const props = schema && typeof schema === 'object' ? (schema as { properties?: Record<string, { type?: unknown; enum?: unknown[]; default?: unknown }> }).properties : undefined;
  if (!props || typeof props !== 'object') return '{}';
  const required = new Set(Array.isArray((schema as { required?: unknown }).required) ? ((schema as { required: unknown[] }).required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props).slice(0, 24)) {
    const hasDefault = p && (p.default !== undefined || (Array.isArray(p.enum) && p.enum.length > 0));
    // required fields always get a placeholder; optional ones only when the schema gives a safe default/enum
    if (!required.has(k) && !hasDefault) continue;
    if (p && p.default !== undefined) out[k] = p.default;
    else if (p && Array.isArray(p.enum) && p.enum.length > 0) out[k] = p.enum[0];
    else if (p?.type === 'number' || p?.type === 'integer') out[k] = 1;
    else if (p?.type === 'boolean') out[k] = false;
    else if (p?.type === 'array') out[k] = [];
    else out[k] = 'example';
  }
  return JSON.stringify(out, null, 2);
}

/** User-facing wording for planner blocker codes. Unknown codes fall back to the planner's own message. */
export function friendlyProblem(code: string, message: string): Problem {
  const m: Record<string, string> = {
    ENDPOINT_NOT_ALLOWED: 'This service is not on Payrail\'s allow-list, so it will not be contacted.',
    INVALID_REQUEST_BODY: 'The request body does not match what this service expects. Fix it and inspect again.',
    REQUIREMENTS_UNAVAILABLE: 'The service did not return usable payment details. Try again in a moment.',
    NO_PAYMENT_REQUIRED: 'This service did not ask for payment, so there is nothing to pay.',
    NO_OFFERS: 'The service listed no valid payment options.',
    UNSUPPORTED_NETWORK: 'This service does not accept payment on Celo.',
    NO_PAYABLE_ASSET: 'The service accepts only currencies Payrail cannot pay with.',
    POLICY: `Your spending limits do not allow this: ${message}`,
    PRICE_MISMATCH: 'The service is asking for far more than its listed price. Review before paying.',
    BALANCES_UNAVAILABLE: 'Your balances could not be read right now. Try again.',
    NO_FUNDS: 'You do not hold enough of the currency needed (or the one you chose).',
    BALANCE_TOO_SMALL: 'A conversion route exists, but your balance is below its minimum size.',
    NO_ROUTE: 'No live conversion route connects the currency you chose to one this service accepts.',
    ROUTE_PROVIDER_ERROR: 'The conversion provider could not be reached. Try again shortly.',
    INSUFFICIENT_GAS: 'The wallet needs a little CELO to pay network fees for the conversion.',
    SOURCE_NOT_SUPPORTED: 'That currency cannot be used for this service.',
    NO_CONVERSION_EXECUTOR: 'No executor is configured for the conversion route this plan needs.',
    SWAP_EXECUTION_NOT_IMPLEMENTED: 'Conversions are not enabled in this process.',
    QUOTE_EXPIRED: 'The quote expired. Inspect again.',
  };
  return { code, message: m[code] ?? message };
}

/** The user-facing meaning of every terminal order state, and what to do next. Never says "failed" when unsure. */
export function describeOrder(rec: OrderRecord | undefined, job: { status: string; refused?: { code: string; message: string } } | undefined): Pick<OrderView, 'stage' | 'headline' | 'detail' | 'nextAction' | 'canResume'> {
  if (job?.refused) {
    return {
      stage: 'refused',
      headline: 'Payment did not start',
      detail: `${job.refused.message} (${job.refused.code}). Nothing was converted or paid.`,
      nextAction: 'Fix the problem described above and inspect the service again.',
      canResume: false,
    };
  }
  if (!rec) {
    return { stage: 'running', headline: 'Starting…', detail: 'Preparing the order.', nextAction: 'Please wait.', canResume: false };
  }
  const converted = rec.conversion?.state === 'CONFIRMED';
  switch (rec.state) {
    case 'COMPLETED':
      return { stage: 'completed', headline: 'Paid and delivered', detail: rec.message, nextAction: 'Your API response is shown below.', canResume: false };
    case 'CONVERTING':
      return { stage: 'converting', headline: 'Converting your currency', detail: 'Approving and swapping. This can take a minute or two.', nextAction: 'Please wait. Do not close the server.', canResume: false };
    case 'CONVERTED':
    case 'PAYING':
      return { stage: 'paying', headline: 'Paying the service', detail: rec.message, nextAction: 'Please wait.', canResume: false };
    case 'STOPPED':
      return {
        stage: 'stopped',
        headline: converted ? 'Converted, but the service was not paid' : 'Stopped. Nothing was paid',
        detail: rec.message,
        nextAction: converted
          ? 'Your converted funds are safe in your wallet. You can try the payment again with "Resume payment".'
          : 'Nothing was spent on the payment. You can inspect and try again.',
        canResume: converted && rec.payment?.status !== 'CONFIRMED',
      };
    case 'UNCERTAIN':
      return {
        stage: 'uncertain',
        headline: 'Payment status is uncertain',
        detail: rec.message,
        nextAction:
          'DO NOT pay again. The payment may have gone through. Use "Check status" to re-verify from the chain; if it stays uncertain, contact the provider with the receipt id.',
        canResume: false,
      };
    default:
      return { stage: 'running', headline: rec.state, detail: rec.message, nextAction: 'Please wait.', canResume: false };
  }
}

/** Stable terms digest: what the user is approving, independent of tiny quote movements. */
export function termsDigest(o: OrderPlan, sourceSymbol: string | undefined): string {
  const p = o.payment;
  const f = p.funding;
  const canonical = {
    service: p.service.id,
    bodyHash: p.bodyHash,
    payer: p.payer.toLowerCase(),
    route: o.route,
    payTo: p.payment?.payTo.toLowerCase() ?? null,
    asset: p.payment?.asset.toLowerCase() ?? null,
    amountAtomic: p.payment?.amountAtomic.toString() ?? null,
    venue: f?.kind === 'swap' ? f.provider : null,
    sell: f?.kind === 'swap' ? f.sellSymbol : f?.kind === 'direct' ? f.symbol : null,
    chosen: sourceSymbol ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Hard bounds shown to (and approved by) the user for a conversion. */
export function boundsFor(o: OrderPlan, slippageBps: number, balanceAtomic: bigint | undefined): ApprovalBounds | undefined {
  const f = o.payment.funding;
  if (f?.kind !== 'swap' || !o.payment.payment) return undefined;
  let maxSell = (f.sellAmountAtomic * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  if (balanceAtomic !== undefined && maxSell > balanceAtomic) maxSell = balanceAtomic;
  const floor = (f.receiveAmountAtomic * BigInt(10_000 - slippageBps)) / 10_000n;
  const price = o.payment.payment.amountAtomic;
  return { maxSellAtomic: maxSell, minReceiveAtomic: floor > price ? floor : price };
}

// ------------------------------------------------------------------ the service object

interface CachedPlan {
  ctx: OrderContext;
  sourceSymbol: string | undefined;
  createdAt: number;
  used: boolean;
}
interface Job {
  orderId: string;
  status: 'running' | 'finished';
  logs: string[];
  refused?: { code: string; message: string };
  ctx: OrderContext;
}

export function createWebApp(rt: WebRuntime) {
  const plans = new Map<string, CachedPlan>();
  const jobs = new Map<string, Job>();
  let running = false;
  const PLAN_KEEP_MS = 10 * 60_000;

  const prune = () => {
    const t = rt.now();
    for (const [k, v] of plans) if (t - v.createdAt > PLAN_KEEP_MS) plans.delete(k);
  };

  async function status() {
    const b = await rt.balances();
    const tokens = b.tokens.map((t) => ({ symbol: t.asset.symbol, amount: human(t.atomic, t.asset.decimals), decimals: t.asset.decimals }));
    return {
      ok: true as const,
      mode: rt.mode,
      wallet: rt.wallet,
      signing: rt.signing,
      canUnlock: !rt.signing && rt.signer?.canUnlock() === true,
      chainId: rt.chainId,
      attributionTag: rt.attributionTag,
      balances: [...tokens, { symbol: 'CELO', amount: human(b.nativeWei, 18), decimals: 18 }],
      limits: {
        perPaymentUsd: formatUsd(rt.policy.maxPerPaymentMicroUsd),
        perDayUsd: formatUsd(rt.policy.maxPerDayMicroUsd),
        perSwapUsd: formatUsd(rt.policy.maxSwapNotionalMicroUsd),
        swapsPerDayUsd: formatUsd(rt.policy.maxSwapPerDayMicroUsd),
      },
      convertibleFrom: [...rt.policy.allowedSwapSources],
    };
  }

  async function inspect(input: { url: string; body?: string; source?: string }): Promise<InspectView | { ok: false; problems: Problem[] }> {
    prune();
    let catalog: Catalog;
    try {
      catalog = await rt.catalog();
    } catch (e) {
      return { ok: false, problems: [{ code: 'CATALOG_UNAVAILABLE', message: `The service catalog is unavailable right now (${e instanceof Error ? e.message.slice(0, 120) : 'error'}). Try again shortly.` }] };
    }
    const found = resolveService(input.url, catalog);
    if (!found.ok) return { ok: false, problems: [found.problem] };
    const service = found.service;
    const body = input.body !== undefined && input.body.trim() !== '' ? input.body : exampleBody(service.inputSchema);
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, problems: [{ code: 'BAD_JSON', message: 'The request body is not valid JSON.' }] };
    }
    const source = input.source && input.source !== 'auto' ? input.source : undefined;
    const ctx: OrderContext = { service, serviceProvider: 'buy-gateway', body, payer: rt.wallet, ...(source ? { sourceSymbol: source } : {}) };

    let plan: OrderPlan;
    try {
      plan = await planOrder(rt.orderDeps({}), ctx);
    } catch (e) {
      return { ok: false, problems: [{ code: 'PLAN_FAILED', message: `Could not inspect the service: ${e instanceof Error ? e.message.slice(0, 160) : 'error'}` }] };
    }
    plans.set(plan.orderId, { ctx, sourceSymbol: source, createdAt: rt.now(), used: false });
    return await toInspectView(plan, service, body, source);
  }

  async function catalogList(q: { query?: string; platform?: string; availableOnly?: boolean; withinLimits?: boolean; offset?: number; limit?: number }): Promise<CatalogView | { ok: false; problems: Problem[] }> {
    let cat: Catalog;
    try {
      cat = await rt.catalog();
    } catch (e) {
      return {
        ok: false,
        problems: [{ code: 'CATALOG_UNAVAILABLE', message: `The service catalog could not be loaded (${e instanceof Error ? e.message.slice(0, 120) : 'error'}). Check your connection and try again.` }],
      };
    }
    const cap = rt.policy.maxPerPaymentMicroUsd;
    const matched = searchServices(cat.services, {
      ...(q.query ? { query: q.query.slice(0, 80) } : {}),
      ...(q.platform ? { platform: q.platform } : {}),
      availableOnly: q.availableOnly === true,
      ...(q.withinLimits ? { maxPriceAtomic: cap } : {}),
    });
    const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const counts = new Map<string, number>();
    for (const s of cat.services) counts.set(s.platform, (counts.get(s.platform) ?? 0) + 1);
    const items: CatalogItem[] = matched.slice(offset, offset + limit).map((s) => {
      const a = assessService(s, rt.policy);
      const p = s.price;
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        platform: s.platform,
        method: s.method,
        url: s.url,
        source: 'buy-gateway',
        available: s.available,
        price: p
          ? {
              usd: p.usd,
              minUsd: p.minAtomic === p.maxAtomic ? null : formatUsd(p.minAtomic),
              maxUsd: p.minAtomic === p.maxAtomic ? null : formatUsd(p.maxAtomic),
              variable: p.minAtomic !== p.maxAtomic,
            }
          : null,
        verdict: {
          contactable: a.contactable,
          autoPay: a.autoPayable,
          withinLimit: p !== undefined && p.minAtomic <= cap,
          reasons: a.reasons,
        },
        hasInputSchema: s.inputSchema !== undefined,
      };
    });
    return {
      ok: true,
      mode: rt.mode,
      source: 'buy-gateway',
      stale: cat.stale === true,
      fetchedAt: new Date(cat.fetchedAt).toISOString(),
      total: cat.services.length,
      matched: matched.length,
      offset,
      limit,
      platforms: [...counts.entries()].map(([platform, count]) => ({ platform, count })).sort((x, y) => y.count - x.count || x.platform.localeCompare(y.platform)),
      items,
    };
  }

  async function toInspectView(plan: OrderPlan, service: Service, body: string, source: string | undefined): Promise<InspectView> {
    const p = plan.payment;
    const bal = await rt.balances();
    const held = (a: Asset) => bal.tokens.find((t) => t.asset.address.toLowerCase() === a.address.toLowerCase())?.atomic ?? 0n;
    const f = p.funding;
    const pay = p.payment;
    const payAsset = pay ? assetBySymbol(pay.symbol) : undefined;

    const accepted = (p.accepted ?? []).map((a) => ({ symbol: a.symbol, amount: human(a.amountAtomic, a.decimals), held: human(a.heldAtomic, a.decimals) }));
    const options: InspectView['fundingOptions'] = [];
    for (const a of p.accepted ?? []) {
      const asset = assetBySymbol(a.symbol);
      if (asset) options.push({ symbol: a.symbol, held: human(held(asset), asset.decimals), kind: 'direct', selected: false });
    }
    for (const sym of rt.policy.allowedSwapSources) {
      const asset = assetBySymbol(sym);
      if (asset && held(asset) > 0n && !options.some((o) => o.symbol === sym)) options.push({ symbol: sym, held: human(held(asset), asset.decimals), kind: 'convert', selected: false });
    }
    const chosen = source ?? (f?.kind === 'swap' ? f.sellSymbol : f?.kind === 'direct' ? f.symbol : undefined);
    for (const o of options) o.selected = o.symbol === chosen;

    let conversion: InspectView['conversion'] = null;
    let bounds: ApprovalBounds | undefined;
    if (f?.kind === 'swap' && payAsset) {
      const sellAsset = assetBySymbol(f.sellSymbol)!;
      const rateNum = Number(formatUnits(f.receiveAmountAtomic, payAsset.decimals)) / Math.max(Number(formatUnits(f.sellAmountAtomic, f.sellDecimals)), 1e-18);
      conversion = {
        provider: f.provider,
        sellSymbol: f.sellSymbol,
        sell: human(f.sellAmountAtomic, f.sellDecimals),
        receiveSymbol: f.receiveSymbol,
        receive: human(f.receiveAmountAtomic, payAsset.decimals),
        rate: `1 ${f.sellSymbol} ≈ ${rateNum.toPrecision(4)} ${f.receiveSymbol}`,
        inverseRate: `1 ${f.receiveSymbol} ≈ ${(1 / rateNum).toPrecision(5)} ${f.sellSymbol}`,
        fee: `${human(f.feeAtomic, f.sellDecimals)} ${f.sellSymbol}`,
        keptAfterPaying: `${human(f.surplusAtomic, payAsset.decimals)} ${f.receiveSymbol}`,
        corridorMinimum: `${human(f.minSellAmountAtomic, f.sellDecimals)} ${f.sellSymbol}`,
        isPreview: true,
      };
      bounds = boundsFor(plan, rt.policy.conversionSlippageBps, held(sellAsset));
    }

    const gas = p.gas;
    const gasCelo = gas?.estimatedCostWei !== undefined && gas.required ? human(gas.estimatedCostWei, 18) : null;
    const usd = (v: bigint | undefined) => (v === undefined ? null : formatUsd(v));
    const executable = plan.executable && plan.status !== 'BLOCKED';
    const problems: Problem[] = plan.blockers
      .filter((b) => b.code !== 'FIRM_QUOTE_REQUIRED')
      .map((b) => friendlyProblem(b.code, b.message));
    if (p.status === 'POLICY_BLOCKED' && p.policy.blocked.length > 0 && problems.length === 0) {
      for (const b of p.policy.blocked) problems.push({ code: 'POLICY', message: `Your spending limits do not allow this: ${b}` });
    }
    if (!executable && problems.length === 0) problems.push({ code: p.status, message: `This order cannot run (${p.status}).` });
    if (executable && !rt.signing) {
      problems.push({
        code: 'SIGNING_UNAVAILABLE',
        message: 'Payments are disabled: this server was started without a wallet key. Plans and quotes still work. Restart it with your key file to pay.',
      });
    }

    return {
      ok: true,
      mode: rt.mode,
      planId: plan.orderId,
      validUntil: new Date(plan.validUntilMs).toISOString(),
      status: plan.status,
      canApprove: executable && rt.signing,
      route: plan.route,
      service: { id: service.id, title: service.title, description: service.description, url: service.url, method: service.method, bodyExample: body },
      payTo: pay?.payTo ?? null,
      price: pay ? { symbol: pay.symbol, amount: human(pay.amountAtomic, pay.decimals), usd: usd(p.costs.servicePriceMicroUsd) } : null,
      accepted,
      fundingOptions: options,
      conversion,
      costs: {
        servicePriceUsd: usd(p.costs.servicePriceMicroUsd),
        conversionFeeUsd: usd(p.costs.conversionFeeMicroUsd),
        totalUsd: usd(p.costs.totalMicroUsd),
        gasCelo,
        gasOk: gas?.ok ?? true,
      },
      maxSpend: {
        sell: bounds && conversion ? `${human(bounds.maxSellAtomic, assetBySymbol(conversion.sellSymbol)!.decimals)} ${conversion.sellSymbol}` : null,
        gasCelo,
        payment: pay ? `${human(pay.amountAtomic, pay.decimals)} ${pay.symbol}` : null,
      },
      approval: plan.approval,
      terms: {
        digest: termsDigest(plan, source),
        maxSellAtomic: bounds?.maxSellAtomic.toString() ?? null,
        minReceiveAtomic: bounds?.minReceiveAtomic.toString() ?? null,
      },
      steps: plan.steps.map((s) => s.summary),
      problems,
      uncertainties: p.uncertainties,
      explanation: plan.explanation,
    };
  }

  /** Approve a plan the user reviewed: re-plan, check the terms and bounds, then run the order in the background. */
  async function approve(input: { planId: string; termsDigest: string; maxSellAtomic?: string | null; minReceiveAtomic?: string | null }): Promise<
    | { ok: true; orderId: string }
    | { ok: false; status: number; problems: Problem[]; replan?: InspectView }
  > {
    prune();
    const cached = plans.get(input.planId);
    if (!cached) return { ok: false, status: 404, problems: [{ code: 'PLAN_UNKNOWN', message: 'That plan is no longer available. Inspect the service again.' }] };
    if (cached.used) return { ok: false, status: 409, problems: [{ code: 'PLAN_USED', message: 'That plan was already approved. Inspect again to start a new order.' }] };
    if (!rt.signing) return { ok: false, status: 409, problems: [{ code: 'SIGNING_UNAVAILABLE', message: 'This server has no wallet key loaded, so it cannot pay. Restart it with your key file.' }] };
    if (running) return { ok: false, status: 409, problems: [{ code: 'BUSY', message: 'Another order is already running. Wait for it to finish.' }] };

    // Re-plan: the quote may have moved since the user looked, and a plan is only valid for a minute.
    let fresh: OrderPlan;
    try {
      fresh = await planOrder(rt.orderDeps({}), cached.ctx);
    } catch (e) {
      return { ok: false, status: 502, problems: [{ code: 'PLAN_FAILED', message: `Could not re-check the quote: ${e instanceof Error ? e.message.slice(0, 160) : 'error'}` }] };
    }
    const reinspect = async () => toInspectView(fresh, cached.ctx.service, cached.ctx.body, cached.sourceSymbol);
    if (!fresh.executable || fresh.status === 'BLOCKED') {
      return { ok: false, status: 409, problems: [{ code: 'NOT_EXECUTABLE', message: 'The order can no longer run as planned. Please review the updated details.' }], replan: await reinspect() };
    }
    if (termsDigest(fresh, cached.sourceSymbol) !== input.termsDigest) {
      plans.set(fresh.orderId, { ...cached, createdAt: rt.now(), used: false });
      return { ok: false, status: 409, problems: [{ code: 'TERMS_CHANGED', message: 'The price, payee or route changed since you reviewed it. Please review the updated details and approve again.' }], replan: await reinspect() };
    }

    const bal = await rt.balances();
    const sellAsset = fresh.payment.funding?.kind === 'swap' ? assetBySymbol(fresh.payment.funding.sellSymbol) : undefined;
    const heldSell = sellAsset ? bal.tokens.find((t) => t.asset.address.toLowerCase() === sellAsset.address.toLowerCase())?.atomic : undefined;
    const freshBounds = boundsFor(fresh, rt.policy.conversionSlippageBps, heldSell);
    const approvedMax = bi(input.maxSellAtomic);
    const approvedMin = bi(input.minReceiveAtomic);
    let bounds: ApprovalBounds | undefined;
    if (freshBounds) {
      if (approvedMax === undefined || approvedMin === undefined) {
        return { ok: false, status: 400, problems: [{ code: 'BOUNDS_REQUIRED', message: 'The approval must include the limits you reviewed.' }] };
      }
      const f = fresh.payment.funding;
      if (f?.kind === 'swap' && (f.sellAmountAtomic > approvedMax || f.receiveAmountAtomic < approvedMin)) {
        plans.set(fresh.orderId, { ...cached, createdAt: rt.now(), used: false });
        return { ok: false, status: 409, problems: [{ code: 'QUOTE_MOVED', message: 'The conversion quote moved outside the limits you approved. Please review the new numbers and approve again.' }], replan: await reinspect() };
      }
      // enforce exactly what the user approved (never the server's looser recomputation)
      bounds = { maxSellAtomic: approvedMax, minReceiveAtomic: approvedMin };
    }

    cached.used = true;
    running = true;
    const job: Job = { orderId: fresh.orderId, status: 'running', logs: [], ctx: cached.ctx };
    jobs.set(fresh.orderId, job);
    const log = (l: string) => {
      job.logs.push(l.replace(/\s+/g, ' ').slice(0, 300));
      if (job.logs.length > 200) job.logs.shift();
    };
    const deps = rt.orderDeps({ ...(bounds ? { bounds } : {}), log, body: cached.ctx.body });
    // Run in the background; the browser polls /api/order/:id.
    void (async () => {
      try {
        const out = await executeOrder(fresh, cached.ctx, deps, { approvedBy: 'human:web', approvedDigest: fresh.digest });
        if (out.kind === 'refused') job.refused = { code: out.code, message: out.message };
      } catch (e) {
        job.refused = { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message.slice(0, 200) : 'error' };
      } finally {
        job.status = 'finished';
        running = false;
      }
    })();
    return { ok: true, orderId: fresh.orderId };
  }

  function orderView(orderId: string): OrderView | undefined {
    const job = jobs.get(orderId);
    const rec = loadOrder(rt.receiptDir, orderId);
    if (!job && !rec) return undefined;
    const d = describeOrder(rec, job);
    const txs = (rec?.conversion?.txHashes ?? []).map((h) => ({ hash: h, url: rt.explorerTx(h) }));
    const pay = rec?.payment;
    return {
      ok: true,
      mode: rt.mode,
      orderId,
      state: rec?.state ?? (job?.refused ? 'REFUSED' : 'STARTING'),
      code: rec?.code ?? job?.refused?.code ?? 'STARTING',
      ...d,
      logs: job?.logs ?? [],
      conversion: rec?.conversion ? { provider: rec.conversion.provider, state: rec.conversion.state, txs } : null,
      payment: pay
        ? {
            status: pay.status,
            txHash: pay.txHash ?? null,
            url: pay.txHash ? rt.explorerTx(pay.txHash) : null,
            receiptId: pay.receiptId ?? null,
            delivered: pay.delivery?.delivered ?? null,
            httpStatus: pay.delivery?.httpStatus ?? null,
            sha256: pay.delivery?.responseSha256 ?? null,
          }
        : null,
      hasResponse: rec?.state === 'COMPLETED' && Boolean(pay?.delivery?.responseFile),
      canResume: d.canResume && job !== undefined,
    };
  }

  /** The saved service response (verbatim). Only for a COMPLETED order; the path cannot leave the responses folder. */
  function responseBody(orderId: string): { ok: true; text: string; truncated: boolean; sha256: string | null } | { ok: false; status: number; problem: Problem } {
    const rec = loadOrder(rt.receiptDir, orderId);
    if (!rec || rec.state !== 'COMPLETED' || !rec.payment?.delivery?.responseFile) {
      return { ok: false, status: 404, problem: { code: 'NO_RESPONSE', message: 'There is no delivered response for this order (yet).' } };
    }
    const base = resolve(rt.receiptDir, 'responses');
    const file = resolve(rt.receiptDir, normalize(rec.payment.delivery.responseFile));
    if (!file.startsWith(base + sep)) return { ok: false, status: 400, problem: { code: 'BAD_PATH', message: 'The stored response path is not valid.' } };
    try {
      const buf = readFileSync(file);
      const MAX = 256 * 1024;
      return { ok: true, text: buf.subarray(0, MAX).toString('utf8'), truncated: buf.length > MAX, sha256: rec.payment.delivery.responseSha256 ?? null };
    } catch {
      return { ok: false, status: 404, problem: { code: 'RESPONSE_MISSING', message: 'The saved response file could not be read.' } };
    }
  }

  async function checkStatus(orderId: string): Promise<OrderView | undefined> {
    // Re-verify from journals and the chain (sends nothing), then return the refreshed view.
    try {
      await reconcileOrder(orderId, rt.orderDeps({}));
    } catch {
      /* the view below still reflects the last known state */
    }
    return orderView(orderId);
  }

  async function resume(orderId: string): Promise<{ ok: true } | { ok: false; status: number; problems: Problem[] }> {
    const job = jobs.get(orderId);
    if (!job) return { ok: false, status: 404, problems: [{ code: 'NO_CONTEXT', message: 'This order was started in an earlier session. Resume it from the command line: node scripts/order.ts --resume <id>.' }] };
    if (!rt.signing) return { ok: false, status: 409, problems: [{ code: 'SIGNING_UNAVAILABLE', message: 'This server has no wallet key loaded.' }] };
    if (running) return { ok: false, status: 409, problems: [{ code: 'BUSY', message: 'Another order is already running.' }] };
    running = true;
    job.status = 'running';
    job.refused = undefined;
    const deps = rt.orderDeps({ log: (l) => job.logs.push(l.slice(0, 300)), body: job.ctx.body });
    void (async () => {
      try {
        const out = await resumeOrder(orderId, job.ctx, deps, { approvedBy: 'human:web' });
        if (out.kind === 'refused') job.refused = { code: out.code, message: out.message };
      } catch (e) {
        job.refused = { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message.slice(0, 200) : 'error' };
      } finally {
        job.status = 'finished';
        running = false;
      }
    })();
    return { ok: true };
  }

  return { status, catalogList, inspect, approve, orderView, responseBody, checkStatus, resume, isBusy: () => running };
}

export type WebApp = ReturnType<typeof createWebApp>;

// ------------------------------------------------------------------ HTTP server

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** A local-only HTTP server. Bound to 127.0.0.1; state-changing calls need a per-run token and a same-origin Origin. */
export function createWebServer(rt: WebRuntime, opts: { webDir?: string; token?: string; market?: MarketRuntime } = {}): { server: Server; token: string; app: WebApp } {
  const app = createWebApp(rt);
  const unlockLimiter = new RateLimiter(5, 5 / 60);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const dir = opts.webDir ?? WEB_DIR;

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(payload);
  };

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown> | undefined> =>
    new Promise((ok) => {
      let n = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 64 * 1024) {
          req.destroy();
          ok(undefined);
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          ok(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
        } catch {
          ok(undefined);
        }
      });
      req.on('error', () => ok(undefined));
    });

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      const port = (server.address() as { port?: number } | null)?.port;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, { ok: false, problems: [{ code: 'BAD_HOST', message: 'This interface is local-only.' }] });
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = req.method ?? 'GET';

      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[a-z0-9._-]+$/i.test(name) || !(name in { 'index.html': 1, 'app.js': 1, 'style.css': 1, 'market.html': 1, 'market.js': 1 })) return send(res, 404, 'not found', 'text/plain');
        let text = readFileSync(join(dir, name), 'utf8');
        if (name === 'index.html' || name === 'market.html') text = text.replace('__PAYRAIL_TOKEN__', token).replace('__PAYRAIL_MODE__', rt.mode);
        const ext = name.slice(name.lastIndexOf('.'));
        return send(res, 200, text, TYPES[ext] ?? 'text/plain');
      }

      if (method === 'GET' && url.pathname === '/api/status') return send(res, 200, await app.status());
      if (method === 'GET' && url.pathname === '/api/catalog') {
        const g = url.searchParams;
        const num = (k: string) => (g.has(k) && /^\d+$/.test(g.get(k) ?? '') ? Number(g.get(k)) : undefined);
        const r = await app.catalogList({
          ...(g.get('q') ? { query: g.get('q')! } : {}),
          ...(g.get('platform') ? { platform: g.get('platform')! } : {}),
          availableOnly: g.get('available') === '1',
          withinLimits: g.get('within') === '1',
          ...(num('offset') !== undefined ? { offset: num('offset')! } : {}),
          ...(num('limit') !== undefined ? { limit: num('limit')! } : {}),
        });
        return send(res, r.ok ? 200 : 502, r);
      }

      if (opts.market && url.pathname.startsWith('/api/market/') && method === 'GET') {
        const bearer = /^Bearer (\S{20,200})$/.exec(String(req.headers.authorization ?? ''))?.[1];
        const r = await handleMarket(opts.market, { method: 'GET', path: url.pathname.slice('/api/market'.length), query: url.searchParams, body: {}, bearer });
        return send(res, r.status, r.body);
      }

      let m: RegExpMatchArray | null;
      if (method === 'GET' && (m = url.pathname.match(/^\/api\/order\/([0-9a-f-]{36})$/))) {
        const v = app.orderView(m[1]!);
        return v ? send(res, 200, v) : send(res, 404, { ok: false, problems: [{ code: 'UNKNOWN_ORDER', message: 'No such order.' }] });
      }
      if (method === 'GET' && (m = url.pathname.match(/^\/api\/order\/([0-9a-f-]{36})\/response$/))) {
        const r = app.responseBody(m[1]!);
        return r.ok
          ? send(res, 200, { ok: true, text: r.text, truncated: r.truncated, sha256: r.sha256 })
          : send(res, r.status, { ok: false, problems: [r.problem] });
      }

      if (method === 'POST') {
        // CSRF / DNS-rebinding defence for anything that can start a payment
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, { ok: false, problems: [{ code: 'BAD_ORIGIN', message: 'Cross-site request refused.' }] });
        const agentRoute = url.pathname === '/api/market/agent/execute' && origin === undefined;
        if (!agentRoute && req.headers['x-payrail-token'] !== token) return send(res, 403, { ok: false, problems: [{ code: 'BAD_TOKEN', message: 'Missing or wrong session token. Reload the page.' }] });
        const body = await readJson(req);
        if (!body) return send(res, 400, { ok: false, problems: [{ code: 'BAD_REQUEST', message: 'Send a small JSON body.' }] });
        const s = (v: unknown) => (typeof v === 'string' ? v : undefined);

        if (url.pathname === '/api/unlock') {
          if (!rt.signer || !rt.signer.canUnlock()) return send(res, 409, { ok: false, problems: [{ code: 'NO_KEYSTORE', message: 'No keystore is available. Create one with scripts/keystore.ts.' }] });
          if (!unlockLimiter.take('unlock')) return send(res, 429, { ok: false, problems: [{ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a minute and try again.' }] });
          const pass = typeof body.passphrase === 'string' ? body.passphrase : '';
          if (pass.length < 1 || pass.length > 256) return send(res, 400, { ok: false, problems: [{ code: 'BAD_REQUEST', message: 'Enter your passphrase.' }] });
          const r = await rt.signer.unlock(pass);
          return r.ok ? send(res, 200, { ok: true, signing: rt.signing }) : send(res, 401, { ok: false, problems: [{ code: 'UNLOCK_FAILED', message: r.message }] });
        }
        if (url.pathname === '/api/lock') {
          rt.signer?.lock();
          return send(res, 200, { ok: true, signing: rt.signing });
        }

        if (opts.market && url.pathname.startsWith('/api/market/')) {
          const bearer = /^Bearer (\S{20,200})$/.exec(String(req.headers.authorization ?? ''))?.[1];
          const r = await handleMarket(opts.market, { method: 'POST', path: url.pathname.slice('/api/market'.length), query: url.searchParams, body, bearer });
          return send(res, r.status, r.body);
        }

        if (url.pathname === '/api/inspect') {
          const url0 = s(body.url);
          if (url0 === undefined) return send(res, 400, { ok: false, problems: [{ code: 'URL_REQUIRED', message: 'Paste an API service URL.' }] });
          const bodyText = s(body.body);
          const source = s(body.source);
          const r = await app.inspect({ url: url0, ...(bodyText !== undefined ? { body: bodyText } : {}), ...(source !== undefined ? { source } : {}) });
          return send(res, r.ok ? 200 : 422, r);
        }
        if (url.pathname === '/api/approve') {
          const planId = s(body.planId);
          const digest = s(body.termsDigest);
          if (!planId || !digest) return send(res, 400, { ok: false, problems: [{ code: 'BAD_REQUEST', message: 'planId and termsDigest are required.' }] });
          const r = await app.approve({
            planId,
            termsDigest: digest,
            maxSellAtomic: s(body.maxSellAtomic) ?? null,
            minReceiveAtomic: s(body.minReceiveAtomic) ?? null,
          });
          return send(res, r.ok ? 202 : r.status, r);
        }
        if ((m = url.pathname.match(/^\/api\/order\/([0-9a-f-]{36})\/check$/))) {
          const v = await app.checkStatus(m[1]!);
          return v ? send(res, 200, v) : send(res, 404, { ok: false, problems: [{ code: 'UNKNOWN_ORDER', message: 'No such order.' }] });
        }
        if ((m = url.pathname.match(/^\/api\/order\/([0-9a-f-]{36})\/resume$/))) {
          const r = await app.resume(m[1]!);
          return send(res, r.ok ? 202 : r.status, r);
        }
      }
      return send(res, 404, { ok: false, problems: [{ code: 'NOT_FOUND', message: 'Unknown endpoint.' }] });
    } catch (e) {
      return send(res, 500, { ok: false, problems: [{ code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message.slice(0, 160) : 'error' }] });
    }
  });
  void randomUUID;
  return { server, token, app };
}
