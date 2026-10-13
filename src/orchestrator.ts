// The order orchestrator: ONE flow from "I want this service" to "here is the proof it was paid for".
//
//   discover price + accepted assets -> inspect balances -> decide direct vs convert -> total the cost
//   -> explain the route -> approval bound to the exact plan -> PREFLIGHT -> [convert] -> wait for the
//   converted funds -> re-price -> pay -> independent verification -> receipts + order history
//
// It adds no new way to spend. Every spend still goes through the gates that already exist:
//   authorizeSwap / authorizeExecution (planner.ts)  -> the only producers of authorizations,
//   runSwap / runAmmSwap (swapexec.ts)                -> human or bounded confirmation, simulation, tagging,
//   executeDirectPayment (executor.ts)                -> lock, duplicate/limit guards, journal, verification.
// The orchestrator sequences them and refuses to continue whenever a step is not provably complete.
//
// Safeguards owned here:
//   * an ORDER-LEVEL lock (locks/order.lock) so two orders can never interleave convert/pay steps;
//   * a PREFLIGHT that proves payment is permitted (no unresolved journal, order not already paid, daily
//     payment limit, daily swap cap) BEFORE any funds are converted;
//   * approval bound to a DIGEST of the exact plan (a changed plan needs a new approval);
//   * crash RECOVERY that rebuilds an order's state from the swap journal, the chain and the payment
//     journals, and never repeats a conversion or a payment because a local record was stale.
//
// Nothing here is specific to one service, one venue or one currency pair.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import type { ExecutionAuthorization, SwapAuthorization } from './authorization.ts';
import type { Service } from './catalog.ts';
import { sha256Hex } from './executor.ts';
import type { ExecutionResult } from './executor.ts';
import { listPending, readHistory, spentSince } from './history.ts';
import { LockError, acquireLock } from './lock.ts';
import type { HeldLock, LockOptions } from './lock.ts';
import { createOrderFile, listOrders, loadOrder, saveOrder } from './orderstore.ts';
import type { OrderConversion, OrderLink, OrderRecord, OrderState, OrderStepRecord } from './orderstore.ts';
import { AuthorizationRefused, authorizeExecution, authorizeSwap } from './planner.ts';
import type { Blocker, PaymentPlan } from './planner.ts';
import { formatUsd } from './policy.ts';
import type { SwapOutcome } from './swapexec.ts';
import { checkSwapDailyCap, loadSwapRecord, newSwapNotionalMicroUsd } from './swapjournal.ts';
import type { SwapRecord } from './swapjournal.ts';

export { listOrders, loadOrder };
export type { OrderRecord, OrderState, OrderStepRecord, OrderLink, OrderConversion };

// ------------------------------------------------------------------ types

export type OrderPlanStatus = 'READY' | 'APPROVAL_REQUIRED' | 'BLOCKED';

export interface OrderStep {
  kind: 'convert' | 'pay';
  summary: string;
  /** For a convert step: the conversion venue the plan chose. */
  provider?: string;
}

export interface OrderPlan {
  orderId: string;
  createdAtMs: number;
  validUntilMs: number;
  status: OrderPlanStatus;
  /** True only if executeOrder() could proceed (given approval, when required). */
  executable: boolean;
  route: 'direct' | 'swap' | null;
  /** The service provider the service came from (e.g. 'buy-gateway'). */
  serviceProvider: string;
  /** The underlying payment plan (price, accepted assets, balances, route, policy, gas). */
  payment: PaymentPlan;
  steps: OrderStep[];
  totals: {
    servicePriceMicroUsd: bigint | undefined;
    conversionFeeMicroUsd: bigint | undefined;
    totalMicroUsd: bigint | undefined;
    gasEstimateWei: bigint | undefined;
  };
  approval: { required: boolean; reasons: string[] };
  /**
   * Digest of the EXACT plan (what is paid, to whom, via which conversion, at what cost). An approval is only
   * valid for the plan with this digest. It excludes the order id and timestamps, so re-planning an unchanged
   * situation yields the same digest and a human can approve what they saw.
   */
  digest: string;
  blockers: Blocker[];
  explanation: string[];
}

export type OrderOutcome =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'finished'; state: OrderState; record: OrderRecord };

export interface OrderContext {
  service: Service;
  /** Which service provider the service came from. */
  serviceProvider: string;
  body: string;
  payer: Address;
}

export interface FundsRequest {
  asset: Address;
  owner: Address;
  /** At least this much must be visible. */
  minAtomic: bigint;
  /** The conversion's transaction hashes (to anchor an exact-block read at or after the swap's block). */
  txHashes: string[];
}

export interface OrderDeps {
  now(): number;
  receiptDir: string;
  /** Plan the payment for a service (discovery + balances + routing + policy). Read-only. */
  plan(ctx: { service: Service; body: string; payer: Address }): Promise<PaymentPlan>;
  /**
   * Conversion executors keyed by the provider name a plan can choose (e.g. 'textile-fx-v2', 'mento-router-v3').
   * Each one runs ONE authorized swap, including its own confirmation gates and verification.
   */
  swapRunners: Readonly<Record<string, (auth: SwapAuthorization) => Promise<SwapOutcome>>>;
  /** Pay for the service once with an authorization the planner minted. `link` stamps the receipt. */
  pay(auth: ExecutionAuthorization, link: OrderLink): Promise<ExecutionResult>;
  /** Rolling 24h payment ceiling (atomic, 6-decimal stables). Checked in the preflight and again by the executor. */
  maxPerDayAtomic?: bigint;
  /** Rolling 24h swap-value ceiling (micro-USD). Checked in the preflight and again inside the swap lock. */
  dailySwapCapMicroUsd?: bigint;
  /** Extra preflight checks (e.g. wallet-specific). Return a refusal to stop before anything is converted. */
  preflight?(order: OrderPlan): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * After a conversion: wait (bounded) until the converted funds are visible by EXACT-BLOCK reads, so the
   * re-price does not run against a lagging node. Absent = no waiting.
   */
  awaitConvertedFunds?(req: FundsRequest): Promise<{ ok: boolean; detail: string }>;
  /** Independently re-establish a conversion from the chain (used by crash recovery and resume). */
  verifyConversionOnChain?(swap: SwapRecord): Promise<{ established: boolean; detail: string; retryable?: boolean }>;
  /** Order-lock tuning (tests use short timings). */
  orderLock?: LockOptions;
  newId?: () => string;
  log?: (line: string) => void;
}

// ------------------------------------------------------------------ digest

/** Canonical digest of the parts of a plan a human approves. Pure; recomputed at execution time. */
export function orderPlanDigest(o: Omit<OrderPlan, 'digest'>): string {
  const p = o.payment;
  const f = p.funding;
  const canonical = {
    v: 1,
    service: { id: p.service.id, url: p.service.url, provider: o.serviceProvider },
    payer: p.payer.toLowerCase(),
    bodyHash: p.bodyHash,
    route: o.route,
    payment: p.payment
      ? {
          asset: p.payment.asset.toLowerCase(),
          symbol: p.payment.symbol,
          payTo: p.payment.payTo.toLowerCase(),
          amountAtomic: p.payment.amountAtomic.toString(),
          network: p.payment.network,
        }
      : null,
    funding:
      f?.kind === 'swap'
        ? {
            kind: 'swap',
            provider: f.provider,
            sellSymbol: f.sellSymbol,
            sellAmountAtomic: f.sellAmountAtomic.toString(),
            receiveSymbol: f.receiveSymbol,
            receiveAmountAtomic: f.receiveAmountAtomic.toString(),
            feeAtomic: f.feeAtomic.toString(),
          }
        : f
          ? { kind: 'direct', symbol: f.symbol }
          : null,
    totals: {
      service: o.totals.servicePriceMicroUsd?.toString() ?? null,
      fee: o.totals.conversionFeeMicroUsd?.toString() ?? null,
      total: o.totals.totalMicroUsd?.toString() ?? null,
    },
    approvalReasons: [...o.approval.reasons].sort(),
    steps: o.steps.map((s) => [s.kind, s.provider ?? null]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const digestMatches = (full: string, given: string) => {
  const g = given.trim().toLowerCase().replace(/^0x/, '');
  return g.length >= 12 && /^[0-9a-f]+$/.test(g) && full.startsWith(g);
};

// ------------------------------------------------------------------ planning

const human = (v: bigint, d: number) => formatUnits(v, d);

/** Build the order plan. Read-only: nothing is signed, requested from a venue, or sent. */
export async function planOrder(deps: OrderDeps, ctx: OrderContext): Promise<OrderPlan> {
  const payment = await deps.plan({ service: ctx.service, body: ctx.body, payer: ctx.payer });
  const blockers: Blocker[] = [...payment.blockers];
  const steps: OrderStep[] = [];
  const explanation: string[] = [...payment.explanation];

  if (payment.accepted && payment.accepted.length > 0) {
    explanation.unshift(
      `The service accepts: ${payment.accepted.map((a) => `${human(a.amountAtomic, a.decimals)} ${a.symbol} (wallet holds ${human(a.heldAtomic, a.decimals)})`).join(', ')}.`,
    );
  }

  let executable = payment.executable;
  const f = payment.funding;
  if (payment.route === 'swap' && f?.kind === 'swap') {
    steps.push({
      kind: 'convert',
      provider: f.provider,
      summary: `Convert ${human(f.sellAmountAtomic, f.sellDecimals)} ${f.sellSymbol} -> ~${human(f.receiveAmountAtomic, payment.payment?.decimals ?? 6)} ${f.receiveSymbol} via ${f.provider}`,
    });
    if (!deps.swapRunners[f.provider]) {
      blockers.push({ code: 'NO_CONVERSION_EXECUTOR', message: `no executor is wired for conversion provider "${f.provider}"` });
      executable = false;
    }
  }
  if (payment.payment) {
    steps.push({
      kind: 'pay',
      summary: `Pay ${human(payment.payment.amountAtomic, payment.payment.decimals)} ${payment.payment.symbol} to ${payment.payment.payTo} for ${payment.service.id}`,
    });
  }
  if (payment.route === 'swap') {
    explanation.push('After the conversion the price is re-read from the service and re-checked against what was approved before anything is paid.');
  }

  // For a swap plan, FIRM_QUOTE_REQUIRED is resolved by the swap pipeline itself; it is not a stop here.
  const real = blockers.filter((b) => b.code !== 'FIRM_QUOTE_REQUIRED');
  const status: OrderPlanStatus = !executable || real.length > 0 ? 'BLOCKED' : payment.approval.required ? 'APPROVAL_REQUIRED' : 'READY';

  const base: Omit<OrderPlan, 'digest'> = {
    orderId: (deps.newId ?? randomUUID)(),
    createdAtMs: payment.createdAtMs,
    validUntilMs: payment.validUntilMs,
    status,
    executable: executable && real.length === 0,
    route: payment.route,
    serviceProvider: ctx.serviceProvider,
    payment,
    steps,
    totals: {
      servicePriceMicroUsd: payment.costs.servicePriceMicroUsd,
      conversionFeeMicroUsd: payment.costs.conversionFeeMicroUsd,
      totalMicroUsd: payment.costs.totalMicroUsd,
      gasEstimateWei: payment.gas?.estimatedCostWei,
    },
    approval: payment.approval,
    blockers,
    explanation,
  };
  return { ...base, digest: orderPlanDigest(base) };
}

export function renderOrderPlan(o: OrderPlan): string {
  const usd = (v: bigint | undefined) => (v === undefined ? 'unknown' : formatUsd(v));
  const L: string[] = [];
  L.push(`ORDER ${o.orderId}   status: ${o.status}   route: ${o.route ?? 'none'}   executable: ${o.executable}`);
  L.push(`service: ${o.payment.service.id} (${o.serviceProvider})  ${o.payment.service.url}`);
  o.steps.forEach((s, i) => L.push(`  step ${i + 1}: [${s.kind}] ${s.summary}`));
  if (o.steps.length === 0) L.push('  (no executable steps)');
  L.push(`cost: service ${usd(o.totals.servicePriceMicroUsd)} + conversion fee ${usd(o.totals.conversionFeeMicroUsd)} = ${usd(o.totals.totalMicroUsd)}`);
  if (o.totals.gasEstimateWei !== undefined && o.route === 'swap') L.push(`gas estimate: ${o.totals.gasEstimateWei} wei (CELO), paid by the wallet for the conversion`);
  L.push(`approval: ${o.approval.required ? 'REQUIRED - ' + o.approval.reasons.join('; ') : 'not required'}`);
  L.push(`plan digest: ${o.digest}   (an approval is valid only for this exact plan)`);
  L.push(`valid until: ${new Date(o.validUntilMs).toISOString()}`);
  for (const b of o.blockers) L.push(`blocker ${b.code}: ${b.message}`);
  for (const u of o.payment.uncertainties) L.push(`uncertain: ${u}`);
  L.push('why:', ...o.explanation.map((e) => `  - ${e}`));
  return L.join('\n');
}

// ------------------------------------------------------------------ helpers

const msg = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]!.slice(0, 300) : String(e).slice(0, 300));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface OrderReceiptFacts {
  file: string;
  id: string;
  status: string;
  txHash: string | null;
  planId: string | null;
  delivered: boolean;
  httpStatus: number | null;
  responseSha256: string | null;
  responseFile: string | null;
  responseSummary: string | null;
  route: 'direct' | 'converted';
  /** Set when a later chain re-verification (receipts/resolutions) decided an UNCERTAIN payment. */
  resolution: 'SETTLED' | 'NOT_SETTLED' | undefined;
}

/** Every payment receipt stamped with this order id (the receipts are the source of truth for payment). */
function receiptsForOrder(dir: string, orderId: string): OrderReceiptFacts[] {
  const out: OrderReceiptFacts[] = [];
  for (const r of readHistory(dir).receipts) {
    if (r.orderId !== orderId) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, r.file), 'utf8')) as Record<string, any>;
      out.push({
        file: r.file,
        id: r.id,
        status: String(r.status ?? j.status ?? 'UNKNOWN'), // effective status: a NOT_SETTLED resolution reads as REJECTED
        txHash: typeof j.payment?.txHash === 'string' ? j.payment.txHash : null,
        planId: typeof j.planId === 'string' ? j.planId : null,
        delivered: j.outcome?.delivered === true,
        httpStatus: typeof j.outcome?.httpStatus === 'number' ? j.outcome.httpStatus : null,
        responseSha256: j.outcome?.responseSha256 ?? null,
        responseFile: j.outcome?.responseFile ?? null,
        responseSummary: j.outcome?.responseSummary ?? null,
        route: j.conversion ? 'converted' : 'direct',
        resolution: r.resolution,
      });
    } catch {
      /* an unreadable receipt is surfaced by history; it cannot be used as proof here */
    }
  }
  return out;
}

/** Payment journals (receipts/pending) stamped with this order id: a payment that may be in flight. */
function pendingForOrder(dir: string, orderId: string): string[] {
  const hits: string[] = [];
  for (const f of listPending(dir)) {
    if (f.startsWith('swap-')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, 'pending', f), 'utf8')) as Record<string, unknown>;
      if (j.orderId === orderId) hits.push(f);
    } catch {
      hits.push(f); // unreadable pending journal: assume it may be ours (fail closed)
    }
  }
  return hits;
}

function conversionFrom(provider: string, sr: SwapRecord): OrderConversion {
  return {
    provider,
    swapPlanId: sr.planId,
    state: sr.state,
    txHashes: sr.steps.map((s) => s.hash).filter((h): h is string => typeof h === 'string'),
    sellSymbol: sr.route.sellSymbol,
    sellAmountAtomic: sr.amounts.takerPays ?? sr.amounts.requestedSell,
    buySymbol: sr.route.buySymbol,
    ...(sr.verification.buyReceived ? { receivedAtomic: sr.verification.buyReceived } : {}),
  };
}

/**
 * A swap may only back an order if it delivered the asset the order approved, through the venue the plan
 * chose. Returns the reason it does not, or undefined when it matches.
 */
function conversionMismatch(sr: SwapRecord, rec: OrderRecord): string | undefined {
  if (sr.route.buyAsset.toLowerCase() !== rec.approved.asset.toLowerCase()) {
    return `the swap delivered ${sr.route.buySymbol} (${sr.route.buyAsset}), not the approved ${rec.approved.symbol} (${rec.approved.asset})`;
  }
  if (rec.approved.conversionProvider && sr.route.provider !== rec.approved.conversionProvider) {
    return `the swap ran through ${sr.route.provider}, not the planned ${rec.approved.conversionProvider}`;
  }
  return undefined;
}

const linkFor = (rec: OrderRecord): OrderLink => ({
  orderId: rec.orderId,
  route: rec.conversion ? 'converted' : 'direct',
  ...(rec.conversion ? { conversion: rec.conversion } : {}),
});

// ------------------------------------------------------------------ preflight

type Refusal = { code: string; message: string };

/**
 * Everything that must be true for the PAYMENT to be permitted, checked BEFORE any funds are converted.
 * (The executor re-checks the payment-side items inside its own lock; this prevents converting into a
 * position from which payment is then refused.)
 */
export async function preflightOrder(order: OrderPlan, deps: OrderDeps): Promise<Refusal | undefined> {
  const p = order.payment;
  if (p.payment === null) return { code: 'NOT_EXECUTABLE', message: 'the plan has no payment' };

  let pending: string[];
  try {
    pending = listPending(deps.receiptDir);
  } catch (e) {
    return { code: 'GUARD_UNAVAILABLE', message: `cannot verify there is no unresolved payment or swap: ${msg(e)}` };
  }
  if (pending.length > 0) {
    return { code: 'PENDING_UNRESOLVED', message: `an unresolved payment or swap exists (${pending[0]}); a human must resolve it first` };
  }

  try {
    const paid = receiptsForOrder(deps.receiptDir, order.orderId).find((r) => r.status !== 'REJECTED');
    if (paid) return { code: 'ORDER_ALREADY_PAID', message: `this order already has a ${paid.status} payment receipt (${paid.file})` };
    if (loadOrder(deps.receiptDir, order.orderId) !== undefined) {
      return { code: 'ORDER_ALREADY_USED', message: 'this order was already executed; plan a new order' };
    }
  } catch (e) {
    return { code: 'GUARD_UNAVAILABLE', message: `cannot check whether this order was already paid: ${msg(e)}` };
  }

  if (deps.maxPerDayAtomic !== undefined) {
    let spent: bigint;
    try {
      spent = spentSince(readHistory(deps.receiptDir), deps.now() - 86_400_000);
    } catch (e) {
      return { code: 'LIMIT_UNVERIFIABLE', message: `cannot read payment history to enforce the daily limit: ${msg(e)}` };
    }
    if (spent + p.payment.amountAtomic > deps.maxPerDayAtomic) {
      return {
        code: 'DAILY_LIMIT',
        message: `paying ${p.payment.amountAtomic} would take the 24h payment total to ${spent + p.payment.amountAtomic}, above ${deps.maxPerDayAtomic}; nothing was converted`,
      };
    }
  }

  const f = p.funding;
  if (p.route === 'swap' && f?.kind === 'swap' && deps.dailySwapCapMicroUsd !== undefined) {
    const cap = checkSwapDailyCap(deps.receiptDir, {
      nowMs: deps.now(),
      addMicro: newSwapNotionalMicroUsd({
        sell: { symbol: f.sellSymbol, sellAmountAtomic: f.sellAmountAtomic },
        buy: { symbol: f.receiveSymbol, expectedBuyAtomic: f.receiveAmountAtomic },
      }),
      capMicro: deps.dailySwapCapMicroUsd,
    });
    if (!cap.ok) return { code: cap.code, message: `${cap.message}; nothing was converted` };
  }

  if (deps.preflight) {
    try {
      const r = await deps.preflight(order);
      if (!r.ok) return { code: r.code, message: r.message };
    } catch (e) {
      return { code: 'PREFLIGHT_FAILED', message: `the preflight check could not complete: ${msg(e)}` };
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ execution

export interface ExecuteOrderOpts {
  /** Who approved this order (a human, or policy). Required when the plan says approval is required. */
  approvedBy?: string;
  /** The plan digest that was approved (full hex or a prefix of at least 12 characters). */
  approvedDigest?: string;
  slippageBps?: number;
}

async function withOrderLock<T>(
  deps: OrderDeps,
  refuse: (code: string, message: string) => T,
  fn: (lock: HeldLock) => Promise<T>,
): Promise<T> {
  let lock: HeldLock;
  try {
    lock = await acquireLock(deps.receiptDir, { ...(deps.orderLock ?? {}), name: 'order' });
  } catch (e) {
    return e instanceof LockError ? refuse(`ORDER_${e.code}`, e.message) : refuse('ORDER_LOCK_UNAVAILABLE', msg(e));
  }
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/**
 * Execute an order plan. Sequence: validate -> approval digest -> order lock -> preflight -> authorize ->
 * (convert) -> wait for funds -> re-price -> pay. It stops, and says exactly what state the money is in, at
 * the first step that is not provably complete. UNCERTAIN is never retried.
 */
export async function executeOrder(order: OrderPlan, ctx: OrderContext, deps: OrderDeps, opts: ExecuteOrderOpts = {}): Promise<OrderOutcome> {
  const refuse = (code: string, message: string): OrderOutcome => ({ kind: 'refused', code, message });
  const now = () => new Date(deps.now());

  if (!order.executable || order.status === 'BLOCKED') return refuse('NOT_EXECUTABLE', `the order is ${order.status}: ${order.blockers.map((b) => b.code).join(', ') || 'not executable'}`);
  if (deps.now() > order.validUntilMs) return refuse('PLAN_EXPIRED', 'the order plan is stale; plan again');
  if (sha256Hex(ctx.body) !== order.payment.bodyHash) return refuse('BODY_MISMATCH', 'the request body differs from the body that was priced');
  if (order.payment.payer.toLowerCase() !== ctx.payer.toLowerCase()) return refuse('PAYER_MISMATCH', 'the payer differs from the planned payer');
  const p = order.payment;
  if (p.payment === null || p.route === null) return refuse('NOT_EXECUTABLE', 'the plan has no payment');

  // Approval is bound to the digest of the exact plan. The digest is RECOMPUTED here: an edited plan fails.
  const { digest: _stored, ...rest } = order;
  const digest = orderPlanDigest(rest);
  if (digest !== order.digest) return refuse('PLAN_TAMPERED', 'the order plan does not match its digest');
  if (order.approval.required) {
    if (!opts.approvedBy) return refuse('APPROVAL_REQUIRED', `human approval required: ${order.approval.reasons.join('; ')}`);
    if (!opts.approvedDigest) return refuse('APPROVAL_DIGEST_REQUIRED', `approval must name the plan digest (${digest.slice(0, 12)}...): an approval is bound to the exact plan`);
  }
  if (opts.approvedDigest !== undefined && !digestMatches(digest, opts.approvedDigest)) {
    return refuse('APPROVAL_DIGEST_MISMATCH', `the approval was for a different plan (approved ${opts.approvedDigest.slice(0, 12)}..., this plan is ${digest.slice(0, 12)}...); review and approve this plan`);
  }

  return withOrderLock<OrderOutcome>(deps, refuse, async (lock) => {
    // Preflight: payment must be permitted BEFORE any funds are converted.
    const bad = await preflightOrder(order, deps);
    if (bad) return refuse(bad.code, bad.message);

    // Mint the authorization for the FIRST spend before the record exists, so a refusal leaves no trace.
    let swapAuth: SwapAuthorization | undefined;
    let payAuth: ExecutionAuthorization | undefined;
    try {
      if (p.route === 'direct') {
        payAuth = authorizeExecution(p, { now: deps.now(), body: ctx.body, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) });
      } else {
        const f = p.funding;
        if (f?.kind !== 'swap' || !deps.swapRunners[f.provider]) return refuse('NO_CONVERSION_EXECUTOR', 'no executor is wired for the planned conversion provider');
        swapAuth = authorizeSwap(p, {
          now: deps.now(),
          ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
          ...(opts.slippageBps !== undefined ? { slippageBps: opts.slippageBps } : {}),
        });
      }
    } catch (e) {
      if (e instanceof AuthorizationRefused) return refuse(e.code, e.message);
      throw e;
    }

    const t = now().toISOString();
    const rec: OrderRecord = {
      schemaVersion: 1,
      orderId: order.orderId,
      state: p.route === 'swap' ? 'CONVERTING' : 'PAYING',
      code: 'STARTED',
      message: 'order started',
      createdAt: t,
      updatedAt: t,
      service: { id: p.service.id, title: p.service.title, url: p.service.url, provider: order.serviceProvider },
      payer: p.payer,
      bodyHash: p.bodyHash,
      planDigest: digest,
      approved: {
        asset: p.payment!.asset,
        symbol: p.payment!.symbol,
        payTo: p.payment!.payTo,
        amountAtomic: p.payment!.amountAtomic.toString(),
        route: p.route as 'direct' | 'swap',
        totalMicroUsd: order.totals.totalMicroUsd?.toString(),
        conversionProvider: p.funding?.kind === 'swap' ? p.funding.provider : undefined,
      },
      approvedBy: opts.approvedBy,
      steps:
        p.route === 'swap'
          ? [{ kind: 'convert', state: 'pending' }, { kind: 'pay', state: 'pending' }]
          : [{ kind: 'pay', state: 'pending' }],
      needsAttention: false,
    };
    // Exclusive create: an order id can be executed exactly once (also across processes).
    let created: boolean;
    try {
      created = createOrderFile(deps.receiptDir, rec);
    } catch (e) {
      return refuse('ORDER_JOURNAL_UNAVAILABLE', `cannot persist the order, so nothing was started: ${msg(e)}`);
    }
    if (!created) return refuse('ORDER_ALREADY_USED', 'this order was already executed; plan a new order');

    const run: Run = { rec, deps, ctx, now, lock };

    if (swapAuth) {
      const convert = rec.steps.find((s) => s.kind === 'convert')!;
      const runner = deps.swapRunners[swapAuth.provider]!;
      convert.state = 'running';
      convert.ref = swapAuth.planId;
      rec.state = 'CONVERTING';
      try {
        persist(run);
      } catch (e) {
        return finish(run, 'STOPPED', 'ORDER_JOURNAL_UNAVAILABLE', `cannot persist the order; nothing was converted: ${msg(e)}`);
      }

      let out: SwapOutcome;
      try {
        lock.assertHeld();
        out = await runner(swapAuth);
      } catch (e) {
        convert.state = 'uncertain';
        return finish(run, 'UNCERTAIN', 'CONVERSION_ERROR', `the conversion step threw (${msg(e)}); run reconcile to rebuild this order from the swap journal and the chain, and do not retry`, true);
      }
      if (out.kind === 'refused') {
        convert.state = 'failed';
        convert.detail = `${out.code}: ${out.message}`;
        return finish(run, 'STOPPED', `CONVERSION_REFUSED_${out.code}`, `the conversion was refused before anything was sent: ${out.message}. Nothing was paid.`);
      }
      const sr = out.record;
      rec.conversion = conversionFrom(swapAuth.provider, sr);
      if (out.state !== 'CONFIRMED') {
        const moved = sr.fundsMayHaveMoved || sr.steps.some((s) => s.hash !== undefined);
        convert.state = out.state === 'FAILED' || out.state === 'EXPIRED' ? 'failed' : 'uncertain';
        convert.detail = `${out.state}: ${sr.code}`;
        if (out.state === 'FAILED' || out.state === 'EXPIRED') {
          return finish(
            run,
            'STOPPED',
            `CONVERSION_${out.state}`,
            `the conversion ended ${out.state} (${sr.code}: ${sr.message}). Nothing was paid.` + (moved ? ' A transaction was sent (e.g. an approval); see the swap record.' : ''),
            moved,
          );
        }
        return finish(run, 'UNCERTAIN', 'CONVERSION_UNCERTAIN', `the conversion is ${out.state} (${sr.code}). Nothing was paid. Resolve it with scripts/resolve.ts, then reconcile this order; it is never retried automatically.`, true);
      }
      convert.state = 'done';
      rec.state = 'CONVERTED';
      rec.code = 'CONVERTED';
      rec.message = 'conversion confirmed; waiting for the funds, then re-pricing the service before paying';
      try {
        persist(run);
      } catch {
        /* continue: the swap journal is the source of truth */
      }
      return await payPhase(run, opts.approvedBy);
    }

    // Direct: pay with the authorization minted from the plan.
    return await payWith(run, payAuth!);
  });
}

// ---- shared run plumbing

interface Run {
  rec: OrderRecord;
  deps: OrderDeps;
  ctx: OrderContext;
  now: () => Date;
  lock: HeldLock;
}

function persist(run: Run): void {
  saveOrder(run.deps.receiptDir, run.rec, run.now());
}

function finish(run: Run, state: OrderState, code: string, message: string, attention = false): OrderOutcome {
  const { rec } = run;
  rec.state = state;
  rec.code = code;
  rec.message = message;
  rec.needsAttention = attention || state === 'UNCERTAIN';
  try {
    persist(run);
  } catch {
    /* the outcome stands; the underlying journals exist */
  }
  return { kind: 'finished', state, record: rec };
}

async function payPhase(run: Run, approvedBy: string | undefined): Promise<OrderOutcome> {
  const { rec, deps, ctx } = run;
  const stopConverted = (code: string, message: string) =>
    finish(run, 'STOPPED', code, `${message} The conversion is complete: the converted funds remain in the wallet and nothing was paid.`, true);

  // Wait (bounded) until the converted funds are visible by exact-block reads, so the re-price is not run
  // against a lagging node.
  if (deps.awaitConvertedFunds && rec.conversion) {
    try {
      const w = await deps.awaitConvertedFunds({
        asset: rec.approved.asset as Address,
        owner: rec.payer as Address,
        minAtomic: BigInt(rec.approved.amountAtomic),
        txHashes: rec.conversion.txHashes,
      });
      if (!w.ok) return stopConverted('CONVERTED_FUNDS_NOT_VISIBLE', `the converted funds could not be confirmed by exact-block reads (${w.detail}).`);
    } catch (e) {
      return stopConverted('CONVERTED_FUNDS_NOT_VISIBLE', `the converted funds could not be checked (${msg(e)}).`);
    }
  }

  let fresh: PaymentPlan;
  try {
    fresh = await deps.plan({ service: ctx.service, body: ctx.body, payer: ctx.payer });
  } catch (e) {
    return stopConverted('REPRICE_FAILED', `the service could not be re-priced (${msg(e)}).`);
  }
  const fp = fresh.payment;
  if (fresh.route !== 'direct' || !fresh.executable || fresh.blockers.length > 0 || fp === null) {
    return stopConverted('PAY_BLOCKED_AFTER_CONVERSION', `after converting, the payment is ${fresh.status}: ${fresh.blockers.map((b) => b.code).join(', ') || 'not executable'}.`);
  }
  if (!same(fp.payTo, rec.approved.payTo) || !same(fp.asset, rec.approved.asset)) {
    return stopConverted('PAYMENT_TERMS_CHANGED', 'the service now asks to be paid to a different address or in a different asset than was approved.');
  }
  if (fp.amountAtomic > BigInt(rec.approved.amountAtomic)) {
    return stopConverted('PRICE_ROSE', `the price rose from ${rec.approved.amountAtomic} to ${fp.amountAtomic} atomic after the approval; approve the new price to continue.`);
  }
  let auth: ExecutionAuthorization;
  try {
    auth = authorizeExecution(fresh, { now: deps.now(), body: ctx.body, ...(approvedBy ? { approvedBy } : {}) });
  } catch (e) {
    if (e instanceof AuthorizationRefused) return stopConverted(`PAY_REFUSED_${e.code}`, `the payment could not be authorized: ${e.message}.`);
    throw e;
  }
  return await payWith(run, auth);
}

async function payWith(run: Run, auth: ExecutionAuthorization): Promise<OrderOutcome> {
  const { rec, deps } = run;
  const pay = rec.steps.find((s) => s.kind === 'pay')!;
  pay.state = 'running';
  pay.ref = auth.planId;
  rec.state = 'PAYING';
  rec.code = 'PAYING';
  rec.message = 'paying the service';
  try {
    persist(run);
  } catch (e) {
    return finish(run, 'STOPPED', 'ORDER_JOURNAL_UNAVAILABLE', `cannot persist the order; the payment was not sent: ${msg(e)}`, rec.conversion !== undefined);
  }

  const link = linkFor(rec);
  const converted = link.route === 'converted';
  let r: ExecutionResult;
  try {
    run.lock.assertHeld();
    r = await deps.pay(auth, link);
  } catch (e) {
    pay.state = 'uncertain';
    return finish(run, 'UNCERTAIN', 'PAYMENT_ERROR', `the payment step threw (${msg(e)}); run reconcile to rebuild this order from the payment journals, and do not pay again`, true);
  }
  if (r.kind === 'not_sent') {
    pay.state = 'failed';
    pay.detail = `${r.code}: ${r.message}`;
    return finish(
      run,
      'STOPPED',
      `PAYMENT_NOT_SENT_${r.code}`,
      `the payment was NOT sent (${r.code}: ${r.message}).` + (converted ? ' The conversion is complete; the converted funds remain in the wallet.' : ''),
      converted,
    );
  }
  if (r.kind === 'in_doubt') {
    pay.state = 'uncertain';
    pay.detail = r.message;
    rec.payment = { route: link.route, receiptFile: r.receiptFile, receiptId: undefined, planId: auth.planId, txHash: undefined, status: 'IN_DOUBT' };
    return finish(run, 'UNCERTAIN', 'PAYMENT_IN_DOUBT', `${r.message} Do NOT pay again.`, true);
  }
  const rc = r.receipt;
  rec.payment = {
    route: link.route,
    receiptFile: r.receiptFile,
    receiptId: rc.id,
    planId: auth.planId,
    txHash: rc.payment.txHash,
    status: rc.status,
    delivery: {
      delivered: rc.outcome.delivered,
      httpStatus: rc.outcome.httpStatus,
      responseSha256: rc.outcome.responseSha256,
      responseFile: rc.outcome.responseFile,
      responseSummary: rc.outcome.responseSummary,
    },
  };
  if (rc.status === 'CONFIRMED') {
    pay.state = 'done';
    return finish(run, 'COMPLETED', 'COMPLETED', `paid and independently verified: ${rc.statusReason}`);
  }
  pay.state = rc.status === 'REJECTED' ? 'failed' : 'uncertain';
  pay.detail = `${rc.status}: ${rc.statusReason}`;
  if (rc.status === 'REJECTED') {
    return finish(run, 'STOPPED', 'PAYMENT_REJECTED', `the payment was rejected (proven not settled): ${rc.statusReason}.` + (converted ? ' The converted funds remain in the wallet.' : ''), converted);
  }
  return finish(run, 'UNCERTAIN', `PAYMENT_${rc.status}`, `payment status ${rc.status}: ${rc.statusReason}. Do NOT pay again until the chain has been inspected.`, true);
}

// ------------------------------------------------------------------ crash recovery

export type ReconcileResult =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unchanged'; record: OrderRecord; message: string }
  | { kind: 'updated'; record: OrderRecord; changes: string[] };

/**
 * Rebuild an order's true state from facts that do not depend on the order file being up to date:
 *   * the swap journal for the recorded swap plan, re-established from the chain when a verifier is wired,
 *   * the payment receipts and payment journals stamped with this order id.
 * It NEVER sends anything: it only moves the record to what the evidence supports. A conversion is promoted
 * to CONFIRMED only when independently established; an unresolved payment keeps the order UNCERTAIN.
 */
export async function reconcileOrder(orderId: string, deps: OrderDeps): Promise<ReconcileResult> {
  const refuse = (code: string, message: string): ReconcileResult => ({ kind: 'refused', code, message });
  let rec: OrderRecord | undefined;
  try {
    rec = loadOrder(deps.receiptDir, orderId);
  } catch (e) {
    return refuse('ORDER_UNREADABLE', msg(e));
  }
  if (!rec) return refuse('ORDER_NOT_FOUND', `no order ${orderId}`);
  if (rec.state === 'COMPLETED') return { kind: 'unchanged', record: rec, message: 'order is already COMPLETED' };

  return withOrderLock<ReconcileResult>(deps, refuse, async () => {
    // re-read inside the lock
    const cur = loadOrder(deps.receiptDir, orderId)!;
    const changes: string[] = [];
    const note = (s: string) => {
      changes.push(s);
      (cur.recovery ??= []).push(`${new Date(deps.now()).toISOString()} ${s}`);
    };
    const now = new Date(deps.now());
    const before = `${cur.state}/${cur.code}/${cur.payment?.status ?? ''}/${cur.conversion?.state ?? ''}`;
    const convertStep = cur.steps.find((s) => s.kind === 'convert');
    const payStep = cur.steps.find((s) => s.kind === 'pay');

    // ---- 1. the conversion
    if (convertStep && cur.conversion?.state !== 'CONFIRMED') {
      const swapId = convertStep.ref;
      if (!swapId) {
        // the conversion was never started: the swap plan id is stored before the runner is called
        convertStep.state = 'skipped';
        cur.state = 'STOPPED';
        cur.code = 'CONVERSION_NOT_STARTED';
        cur.message = 'recovery: the conversion never started; nothing was converted or paid';
        note('conversion never started (no swap plan was recorded)');
        saveOrder(deps.receiptDir, cur, now);
        return { kind: 'updated', record: cur, changes };
      }
      let sr: SwapRecord | undefined;
      try {
        sr = loadSwapRecord(deps.receiptDir, swapId);
      } catch (e) {
        return refuse('SWAP_JOURNAL_UNREADABLE', `cannot read the swap journal for ${swapId}: ${msg(e)}`);
      }
      if (!sr) {
        convertStep.state = 'failed';
        cur.state = 'STOPPED';
        cur.code = 'CONVERSION_NOT_STARTED';
        cur.message = 'recovery: no swap journal exists for the recorded swap plan, so nothing was sent; nothing was converted or paid';
        note(`no swap journal for ${swapId}: the conversion never reached the venue or the chain`);
        saveOrder(deps.receiptDir, cur, now);
        return { kind: 'updated', record: cur, changes };
      }
      const provider = cur.approved.conversionProvider ?? sr.route.provider;
      if (sr.state === 'CONFIRMED') {
        const mismatch = conversionMismatch(sr, cur);
        if (mismatch) {
          convertStep.state = 'uncertain';
          cur.state = 'UNCERTAIN';
          cur.code = 'CONVERSION_MISMATCH';
          cur.message = `recovery: the recorded swap does not match this order (${mismatch}); nothing was paid or converted again`;
          cur.needsAttention = true;
          note(`swap ${swapId} does not match the order: ${mismatch}`);
          saveOrder(deps.receiptDir, cur, now);
          return { kind: 'updated', record: cur, changes };
        }
        if (!deps.verifyConversionOnChain) {
          return refuse('CONVERSION_NOT_VERIFIED', 'the swap journal says CONFIRMED but no independent on-chain verifier is available, so the order is not promoted');
        }
        let v: { established: boolean; detail: string; retryable?: boolean };
        try {
          v = await deps.verifyConversionOnChain(sr);
        } catch (e) {
          return refuse('CONVERSION_NOT_VERIFIED', `the on-chain verification could not run: ${msg(e)}`);
        }
        if (!v.established && v.retryable) {
          // The chain could not be read (not "the chain says no"): change NOTHING so a later reconcile can retry.
          return refuse('CONVERSION_VERIFICATION_UNAVAILABLE', `the chain could not be read right now (${v.detail}); the order was not changed, try again`);
        }
        if (!v.established) {
          // Never write CONFIRMED here: the next reconcile must re-verify instead of trusting a stale record.
          cur.conversion = { ...conversionFrom(provider, sr), state: 'UNVERIFIED' };
          cur.state = 'UNCERTAIN';
          cur.code = 'CONVERSION_NOT_ESTABLISHED';
          cur.message = `recovery: the swap journal says CONFIRMED but the chain does not establish it (${v.detail}); do not pay or convert again`;
          cur.needsAttention = true;
          note(`swap journal CONFIRMED but not established on-chain: ${v.detail}`);
          saveOrder(deps.receiptDir, cur, now);
          return { kind: 'updated', record: cur, changes };
        }
        cur.conversion = conversionFrom(provider, sr);
        convertStep.state = 'done';
        cur.state = 'CONVERTED';
        cur.code = 'RECOVERED_CONVERTED';
        cur.message = `recovery: conversion independently established (${v.detail})`;
        note(`conversion ${swapId} established from the chain (${v.detail})`);
      } else if (sr.state === 'FAILED' || sr.state === 'EXPIRED') {
        const moved = sr.fundsMayHaveMoved || sr.steps.some((s) => s.hash !== undefined);
        cur.conversion = conversionFrom(provider, sr);
        convertStep.state = 'failed';
        cur.state = 'STOPPED';
        cur.code = `CONVERSION_${sr.state}`;
        cur.message = `recovery: the conversion ended ${sr.state} (${sr.code}); nothing was paid` + (moved ? '; a transaction (e.g. an approval) was sent' : '');
        cur.needsAttention = moved;
        note(`conversion ${swapId} is ${sr.state}`);
        saveOrder(deps.receiptDir, cur, now);
        return { kind: 'updated', record: cur, changes };
      } else {
        cur.conversion = conversionFrom(provider, sr);
        convertStep.state = 'uncertain';
        cur.state = 'UNCERTAIN';
        cur.code = 'CONVERSION_UNRESOLVED';
        cur.message = `recovery: the conversion is ${sr.state} (${sr.code}); resolve it with scripts/resolve.ts, then reconcile again. Nothing was converted again or paid.`;
        cur.needsAttention = true;
        note(`conversion ${swapId} is ${sr.state}; needs resolution first`);
        saveOrder(deps.receiptDir, cur, now);
        return { kind: 'updated', record: cur, changes };
      }
    }

    // ---- 2. the payment (receipts and journals are the source of truth)
    let receipts: OrderReceiptFacts[];
    let pend: string[];
    try {
      receipts = receiptsForOrder(deps.receiptDir, orderId);
      pend = pendingForOrder(deps.receiptDir, orderId);
    } catch (e) {
      return refuse('PAYMENT_JOURNAL_UNREADABLE', msg(e));
    }
    const confirmed = receipts.find((r) => r.status === 'CONFIRMED');
    const uncertain = receipts.find((r) => r.status === 'UNCERTAIN');
    const route: 'direct' | 'converted' = cur.conversion ? 'converted' : 'direct';
    const fill = (r: OrderReceiptFacts) => {
      cur.payment = {
        route,
        receiptFile: r.file,
        receiptId: r.id,
        ...(r.planId ? { planId: r.planId } : {}),
        txHash: r.txHash,
        status: r.status,
        delivery: { delivered: r.delivered, httpStatus: r.httpStatus, responseSha256: r.responseSha256, responseFile: r.responseFile, responseSummary: r.responseSummary },
      };
    };
    if (confirmed) {
      fill(confirmed);
      if (payStep) payStep.state = 'done';
      cur.state = 'COMPLETED';
      cur.code = 'RECOVERED_COMPLETED';
      cur.message = `recovery: the payment is CONFIRMED in receipt ${confirmed.id}`;
      cur.needsAttention = false;
      note(`payment found and CONFIRMED in ${confirmed.file}`);
    } else if (uncertain?.resolution === 'SETTLED' && uncertain.delivered) {
      fill(uncertain);
      if (payStep) payStep.state = 'done';
      cur.state = 'COMPLETED';
      cur.code = 'RECOVERED_COMPLETED_BY_RESOLUTION';
      cur.message = `recovery: the payment in receipt ${uncertain.id} was re-verified from the chain as SETTLED, and the service delivered`;
      cur.needsAttention = false;
      note(`payment ${uncertain.id} resolved SETTLED from the chain (delivered)`);
    } else if (uncertain?.resolution === 'SETTLED') {
      fill(uncertain);
      if (payStep) payStep.state = 'uncertain';
      cur.state = 'UNCERTAIN';
      cur.code = 'PAYMENT_SETTLED_DELIVERY_UNCONFIRMED';
      cur.message = `recovery: the payment in receipt ${uncertain.id} SETTLED on-chain (the money is spent) but the service's delivery is not confirmed; do NOT pay again; contact the provider with the receipt`;
      cur.needsAttention = true;
      note(`payment ${uncertain.id} resolved SETTLED but delivery is unconfirmed`);
    } else if (uncertain || pend.length > 0) {
      if (uncertain) fill(uncertain);
      if (payStep) payStep.state = 'uncertain';
      cur.state = 'UNCERTAIN';
      cur.code = 'PAYMENT_UNRESOLVED';
      cur.message = `recovery: a payment for this order ${uncertain ? `is UNCERTAIN (${uncertain.file})` : `may be in flight (${pend[0]})`}; do not pay again; resolve it from chain state`;
      cur.needsAttention = true;
      note(`payment unresolved (${uncertain ? uncertain.file : pend[0]})`);
    } else if (receipts.length > 0) {
      fill(receipts[receipts.length - 1]!);
      if (payStep) payStep.state = 'failed';
      cur.state = 'STOPPED';
      cur.code = 'PAYMENT_REJECTED';
      cur.message = 'recovery: the only payment attempt was REJECTED (proven not settled)' + (cur.conversion ? '; the converted funds remain in the wallet' : '');
      cur.needsAttention = cur.conversion !== undefined;
      note('payment REJECTED');
    } else if (
      cur.state === 'PAYING' ||
      cur.state === 'CONVERTED' ||
      cur.state === 'CONVERTING' ||
      // the pay step threw before any journal or receipt existed: nothing reached the gateway
      (cur.state === 'UNCERTAIN' && cur.code === 'PAYMENT_ERROR')
    ) {
      // No receipt and no payment journal: the journal is written before anything is sent, so no payment left.
      if (payStep) payStep.state = 'pending';
      cur.state = 'STOPPED';
      cur.code = 'PAYMENT_NOT_STARTED';
      cur.message = cur.conversion
        ? 'recovery: the conversion is established and no payment was ever started; the converted funds remain in the wallet (resume to pay)'
        : 'recovery: no payment was ever started; nothing was converted or paid';
      cur.needsAttention = cur.conversion !== undefined;
      note('no payment receipt or journal exists for this order: no payment was sent');
    }
    if (changes.length === 0 || before === `${cur.state}/${cur.code}/${cur.payment?.status ?? ''}/${cur.conversion?.state ?? ''}`) {
      return { kind: 'unchanged', record: loadOrder(deps.receiptDir, orderId)!, message: 'nothing to reconcile' };
    }
    saveOrder(deps.receiptDir, cur, now);
    return { kind: 'updated', record: cur, changes };
  });
}

/**
 * Finish an order whose conversion is CONFIRMED but whose payment did not happen. The record is first
 * RECONCILED against the swap journal, the chain and the payment journals; the conversion is never repeated
 * and nothing is paid unless the conversion is independently established and no payment for this order
 * exists or may be in flight. The service is re-priced and must still match the payee, asset and ceiling
 * that were approved.
 */
export async function resumeOrder(orderId: string, ctx: OrderContext, deps: OrderDeps, opts: { approvedBy?: string } = {}): Promise<OrderOutcome> {
  const refuse = (code: string, message: string): OrderOutcome => ({ kind: 'refused', code, message });
  const first = loadOrder(deps.receiptDir, orderId);
  if (!first) return refuse('ORDER_NOT_FOUND', `no order ${orderId}`);

  // Rebuild the truth first (this takes and releases the order lock itself).
  const rc = await reconcileOrder(orderId, deps);
  if (rc.kind === 'refused') return refuse(rc.code, rc.message);

  return withOrderLock<OrderOutcome>(deps, refuse, async (lock) => {
    const rec = loadOrder(deps.receiptDir, orderId)!;
    const resumable =
      rec.conversion?.state === 'CONFIRMED' &&
      rec.steps.find((s) => s.kind === 'convert')?.state === 'done' &&
      rec.payment?.status !== 'CONFIRMED' &&
      (rec.state === 'STOPPED' || rec.state === 'CONVERTED');
    if (!resumable) return refuse('NOT_RESUMABLE', `order is ${rec.state}/${rec.code}; only a converted, unpaid, not-in-doubt order can be resumed`);
    if (rec.payer.toLowerCase() !== ctx.payer.toLowerCase()) return refuse('PAYER_MISMATCH', 'the payer differs from the order');
    if (sha256Hex(ctx.body) !== rec.bodyHash) return refuse('BODY_MISMATCH', 'the request body differs from the body that was priced');
    if (ctx.service.id !== rec.service.id) return refuse('SERVICE_MISMATCH', 'the service differs from the order');

    // Independent establishment of the conversion, every time.
    const swap = loadSwapRecord(deps.receiptDir, rec.conversion!.swapPlanId);
    if (!swap || swap.state !== 'CONFIRMED') return refuse('CONVERSION_NOT_CONFIRMED', 'the conversion is not CONFIRMED in the swap journal');
    const mismatch = conversionMismatch(swap, rec);
    if (mismatch) return refuse('CONVERSION_MISMATCH', `the recorded swap does not match this order: ${mismatch}`);
    if (deps.verifyConversionOnChain) {
      let v: { established: boolean; detail: string; retryable?: boolean };
      try {
        v = await deps.verifyConversionOnChain(swap);
      } catch (e) {
        return refuse('CONVERSION_VERIFICATION_UNAVAILABLE', `the chain could not be read (${msg(e)}); try again`);
      }
      if (v.retryable) return refuse('CONVERSION_VERIFICATION_UNAVAILABLE', `the chain could not be read right now (${v.detail}); try again`);
      if (!v.established) return refuse('CONVERSION_NOT_ESTABLISHED', `the chain does not establish the conversion: ${v.detail}`);
    }
    // No payment for this order may exist or be in flight (REJECTED ones are proven not settled).
    const live = receiptsForOrder(deps.receiptDir, orderId).filter((r) => r.status !== 'REJECTED');
    const pend = pendingForOrder(deps.receiptDir, orderId);
    if (live.length > 0 || pend.length > 0) return refuse('PAYMENT_EXISTS', 'a payment for this order already exists or may be in flight; reconcile it instead');

    const bad = await preflightPaymentOnly(rec, deps);
    if (bad) return refuse(bad.code, bad.message);

    const approvedBy = opts.approvedBy ?? rec.approvedBy;
    const pay = rec.steps.find((s) => s.kind === 'pay');
    if (pay) pay.state = 'pending';
    const run: Run = { rec, deps, ctx, now: () => new Date(deps.now()), lock };
    return await payPhase(run, approvedBy);
  });
}

/** Resume-time preflight: no unresolved journal and the daily payment limit (the conversion already happened). */
async function preflightPaymentOnly(rec: OrderRecord, deps: OrderDeps): Promise<Refusal | undefined> {
  let pending: string[];
  try {
    pending = listPending(deps.receiptDir);
  } catch (e) {
    return { code: 'GUARD_UNAVAILABLE', message: `cannot verify there is no unresolved payment or swap: ${msg(e)}` };
  }
  if (pending.length > 0) return { code: 'PENDING_UNRESOLVED', message: `an unresolved payment or swap exists (${pending[0]}); a human must resolve it first` };
  if (deps.maxPerDayAtomic !== undefined) {
    const spent = spentSince(readHistory(deps.receiptDir), deps.now() - 86_400_000);
    const amount = BigInt(rec.approved.amountAtomic);
    if (spent + amount > deps.maxPerDayAtomic) {
      return { code: 'DAILY_LIMIT', message: `paying ${amount} would take the 24h payment total above ${deps.maxPerDayAtomic}` };
    }
  }
  return undefined;
}

export function renderOrderRecord(r: OrderRecord): string {
  const L: string[] = [];
  L.push(`ORDER ${r.orderId}: ${r.state} (${r.code})`);
  L.push(`  ${r.message}`);
  L.push(`  service: ${r.service.id} (${r.service.provider})  payer: ${r.payer}`);
  L.push(`  approved: pay ${r.approved.amountAtomic} atomic ${r.approved.symbol} to ${r.approved.payTo} via ${r.approved.route}${r.approved.conversionProvider ? ` (${r.approved.conversionProvider})` : ''}${r.planDigest ? `; plan digest ${r.planDigest.slice(0, 12)}...` : ''}`);
  for (const s of r.steps) L.push(`  step ${s.kind}: ${s.state}${s.ref ? `  ref ${s.ref}` : ''}${s.detail ? `  (${s.detail})` : ''}`);
  if (r.conversion) L.push(`  conversion: ${r.conversion.provider} ${r.conversion.state}  swap plan ${r.conversion.swapPlanId}  txs: ${r.conversion.txHashes.join(', ') || 'none'}`);
  if (r.payment) {
    L.push(`  payment: ${r.payment.status} (route ${r.payment.route})  tx: ${r.payment.txHash ?? 'n/a'}  receipt: ${r.payment.receiptFile ?? 'n/a'}`);
    if (r.payment.delivery) L.push(`  delivery: delivered ${r.payment.delivery.delivered}; HTTP ${r.payment.delivery.httpStatus ?? 'n/a'}; response sha256 ${r.payment.delivery.responseSha256 ?? 'n/a'}`);
  }
  for (const n of r.recovery ?? []) L.push(`  recovery: ${n}`);
  if (r.needsAttention) L.push('  >>> NEEDS A HUMAN: value may have moved or funds are converted but unpaid.');
  return L.join('\n');
}
