// The payment planner. It DECIDES how a service should be paid for and explains why.
// It never signs, sends, swaps or pays. Execution requires authorizeExecution(), which re-checks
// the plan and policy and is the only producer of an ExecutionAuthorization.
import { randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { TEXTILE_REACTOR } from './config.ts';
import { ASSETS, assetBySymbol, microUsd } from './assets.ts';
import type { Asset } from './assets.ts';
import { mintAuthorization, mintSwapAuthorization } from './authorization.ts';
import type { ExecutionAuthorization, SwapAuthorization } from './authorization.ts';
import type { Service } from './catalog.ts';
import { sha256Hex } from './executor.ts';
import { assessService, evaluateConversionPolicy, evaluatePolicy, formatUsd } from './policy.ts';
import type { SpendingPolicy } from './policy.ts';
import type { DiscoveryResult, PaymentOffer } from './requirements.ts';
import type { RouteProvider, RouteResult } from './routes.ts';

export type PlanStatus =
  | 'DIRECT_PAY'
  | 'SWAP_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_SUPPORTED_ROUTE'
  | 'UNSUPPORTED_NETWORK'
  | 'QUOTE_EXPIRED'
  | 'POLICY_BLOCKED'
  | 'NEEDS_REVIEW';

/**
 * Quote lifecycle. These are different things and are never conflated:
 *  none      - nothing priced (direct pay needs no quote)
 *  preview   - indicative; reserves nothing; cannot be executed
 *  firm      - signed, bound to a wallet, has an expiry (not implemented yet)
 *  (executable transaction / on-chain settlement exist only after execution)
 */
export type QuoteState = 'none' | 'preview' | 'firm';

export interface Blocker {
  code: string;
  message: string;
}

export interface GasAssessment {
  required: boolean;
  ok: boolean;
  basis: string;
  estimatedCostWei: bigint | undefined;
  nativeBalanceWei: bigint | undefined;
  feeTokenFallback: boolean;
  notes: string[];
}

export interface PaymentPlan {
  planId: string;
  createdAtMs: number;
  validUntilMs: number;
  status: PlanStatus;
  route: 'direct' | 'swap' | null;
  /** True only if authorizeExecution() could succeed for this plan (given approval, if required). */
  executable: boolean;
  payer: Address;
  service: { id: string; title: string; url: string; method: string };
  bodyHash: string;
  payment: {
    asset: Address;
    symbol: string;
    decimals: number;
    amountAtomic: bigint;
    payTo: Address;
    network: string;
    scheme: string;
  } | null;
  price: { indicativeMaxAtomic: bigint | undefined; actualAtomic: bigint | undefined; basis: 'http-402 challenge' };
  /** Every offer the service made that Payrail can pay in, with what the wallet holds of that asset. */
  accepted?: Array<{ symbol: string; amountAtomic: bigint; decimals: number; heldAtomic: bigint; payTo: Address }>;
  funding:
    | { kind: 'direct'; symbol: string; balanceAtomic: bigint }
    | {
        kind: 'swap';
        provider: string;
        quoteState: QuoteState;
        sellSymbol: string;
        sellAmountAtomic: bigint;
        sellDecimals: number;
        receiveSymbol: string;
        receiveAmountAtomic: bigint;
        feeAtomic: bigint;
        takerPaysAtomic: bigint;
        surplusAtomic: bigint;
        minSellAmountAtomic: bigint;
      }
    | null;
  gas: GasAssessment | null;
  costs: { servicePriceMicroUsd: bigint | undefined; conversionFeeMicroUsd: bigint | undefined; totalMicroUsd: bigint | undefined };
  policy: { applied: string[]; blocked: string[] };
  approval: { required: boolean; reasons: string[] };
  uncertainties: string[];
  blockers: Blocker[];
  explanation: string[];
}

export interface PlanDeps {
  now(): number;
  policy: SpendingPolicy;
  discover(service: Service, body: string): Promise<DiscoveryResult>;
  getBalances(owner: Address, assets: readonly Asset[]): Promise<Map<string, bigint>>;
  getNativeBalance(owner: Address): Promise<bigint>;
  gasPriceWei(): Promise<bigint>;
  routes: RouteProvider;
  /** True only when a swap executor is actually wired in this process. */
  swapExecution?: boolean;
  /** Total already spent (atomic 6-decimal units) in the window starting at sinceMs, from receipt history. */
  spentSince(sinceMs: number): bigint;
  newId?: () => string;
}

export interface PlanRequest {
  service: Service;
  body: string;
  payer: Address;
  /** If a firm quote already exists, its expiry is honoured. */
  firmQuote?: { expiresAtMs: number };
  /**
   * The currency the USER chose to pay with (e.g. 'cNGN'). When set, ONLY that currency may fund the payment:
   * an accepted asset is paid directly from it, anything else must be a permitted swap source and is converted.
   * Unset = the planner picks (direct if possible, else the largest convertible balance).
   */
  sourceSymbol?: string;
}

const DAY_MS = 86_400_000;
const key = (a: Address | string) => a.toLowerCase();
const human = (v: bigint, d: number) => formatUnits(v, d);

export async function planPayment(deps: PlanDeps, req: PlanRequest): Promise<PaymentPlan> {
  const now = deps.now();
  const policy = deps.policy;
  const { service } = req;

  const plan: PaymentPlan = {
    planId: (deps.newId ?? randomUUID)(),
    createdAtMs: now,
    validUntilMs: now + policy.planTtlMs,
    status: 'NEEDS_REVIEW',
    route: null,
    executable: false,
    payer: req.payer,
    service: { id: service.id, title: service.title, url: service.url, method: service.method },
    bodyHash: sha256Hex(req.body),
    payment: null,
    price: { indicativeMaxAtomic: service.price?.maxAtomic, actualAtomic: undefined, basis: 'http-402 challenge' },
    funding: null,
    gas: null,
    costs: { servicePriceMicroUsd: undefined, conversionFeeMicroUsd: undefined, totalMicroUsd: undefined },
    policy: { applied: [], blocked: [] },
    approval: { required: true, reasons: [] },
    uncertainties: [],
    blockers: [],
    explanation: [],
  };
  const done = (status: PlanStatus, ...lines: string[]): PaymentPlan => {
    plan.status = status;
    plan.explanation.push(...lines);
    return plan;
  };
  const block = (code: string, message: string) => plan.blockers.push({ code, message });

  // 0. A firm quote that has already expired blocks everything.
  if (req.firmQuote && now > req.firmQuote.expiresAtMs) {
    block('QUOTE_EXPIRED', 'the firm quote has expired');
    return done('QUOTE_EXPIRED', 'The firm quote expired; request a new quote before executing.');
  }

  // 1. The endpoint must be one Payrail may contact at all.
  const assessment = assessService(service, policy);
  if (!assessment.contactable) {
    for (const r of assessment.reasons) block('ENDPOINT_NOT_ALLOWED', r);
    plan.policy.blocked.push(...assessment.reasons);
    return done('POLICY_BLOCKED', `Service "${service.id}" cannot be contacted under the current policy.`);
  }

  // 2. Actual payment requirements (never the catalog price).
  const d = await deps.discover(service, req.body);
  if (d.kind === 'blocked') {
    for (const r of d.reasons) block('ENDPOINT_NOT_ALLOWED', r);
    return done('POLICY_BLOCKED', 'The endpoint was refused before any request was made.');
  }
  if (d.kind === 'invalid_body') {
    for (const i of d.issues) block('INVALID_REQUEST_BODY', i);
    return done('NEEDS_REVIEW', 'The request body does not satisfy the service input schema, so it cannot be priced.');
  }
  if (d.kind === 'error') {
    block('REQUIREMENTS_UNAVAILABLE', `${d.code}: ${d.message}`);
    return done('NEEDS_REVIEW', 'The service did not return usable payment requirements.');
  }
  if (d.kind === 'no_payment_required') {
    block('NO_PAYMENT_REQUIRED', `service answered HTTP ${d.httpStatus} without asking for payment`);
    return done('NEEDS_REVIEW', 'The service did not ask for payment; there is nothing to plan.');
  }

  const onNetwork = d.offers.filter((o) => o.network === policy.network);
  if (d.offers.length === 0) {
    block('NO_OFFERS', `no usable offers (${d.discarded.join('; ') || 'none listed'})`);
    return done('NEEDS_REVIEW', 'The service listed no valid payment offers.');
  }
  if (onNetwork.length === 0) {
    const nets = [...new Set(d.offers.map((o) => o.network))].join(', ');
    block('UNSUPPORTED_NETWORK', `service accepts payment on: ${nets}; Payrail pays on ${policy.network}`);
    return done('UNSUPPORTED_NETWORK', `The service does not accept payment on ${policy.network} (it accepts: ${nets}).`);
  }

  const usable: Array<{ offer: PaymentOffer; asset: Asset }> = [];
  for (const o of onNetwork) {
    const why: string[] = [];
    if (o.scheme !== 'exact') why.push(`scheme ${o.scheme}`);
    if (!o.resourceMatches) why.push('challenge resource differs from the service URL');
    const asset = o.known ? ASSETS.find((a) => key(a.address) === key(o.asset)) : undefined;
    if (!asset) why.push('asset is not in the Payrail registry');
    else {
      if (!asset.x402Signable) why.push(`${asset.symbol} cannot sign x402 payments`);
      if (asset.decimals !== 6) why.push(`${asset.symbol} is not a 6-decimal asset`);
      if (!policy.allowedPaymentAssets.includes(asset.symbol)) why.push(`${asset.symbol} is not permitted by policy`);
    }
    if (why.length === 0 && asset) usable.push({ offer: o, asset });
    else plan.uncertainties.push(`offer in ${asset?.symbol ?? o.asset} ignored: ${why.join(', ')}`);
  }
  if (usable.length === 0) {
    block('NO_PAYABLE_ASSET', 'none of the accepted assets can be paid by Payrail');
    return done('NO_SUPPORTED_ROUTE', 'The service accepts assets Payrail cannot (or may not) pay with.');
  }
  const rank = (s: string) => {
    const i = policy.preferredAssets.indexOf(s);
    return i === -1 ? 999 : i;
  };
  usable.sort((a, b) => rank(a.asset.symbol) - rank(b.asset.symbol));

  // 3. Policy on the price (before any thought of funding or swapping).
  const first = usable[0]!;
  plan.price.actualAtomic = first.offer.amountAtomic;
  const spent = deps.spentSince(now - DAY_MS);
  const priceUsd = microUsd(first.asset, first.offer.amountAtomic);
  plan.costs.servicePriceMicroUsd = priceUsd;

  // Hard policy limits come first: a human cannot approve past a limit, so this is the more precise answer.
  const direct = evaluatePolicy(
    { service, priceMicroUsd: priceUsd, assetSymbol: first.asset.symbol, route: 'direct', spentLast24hMicroUsd: spent },
    policy,
  );
  plan.policy.applied = direct.applied;
  if (direct.blocked.length > 0) {
    plan.policy.blocked = direct.blocked;
    for (const b of direct.blocked) block('POLICY', b);
    return done('POLICY_BLOCKED', 'Spending policy forbids this payment.', ...direct.blocked);
  }

  // Indicative vs actual: a large gap is not auto-trusted.
  const ind = service.price?.maxAtomic;
  if (ind === undefined) plan.uncertainties.push('catalog gave no indicative price to compare against');
  else if (first.offer.amountAtomic > ind * policy.priceToleranceFactor) {
    block('PRICE_MISMATCH', `actual price ${first.offer.amountAtomic} is more than ${policy.priceToleranceFactor}x the indicative ${ind}`);
    return done('NEEDS_REVIEW', 'The service asks for far more than its catalog price; a human should review.');
  } else if (first.offer.amountAtomic > ind) {
    plan.uncertainties.push(`actual price ${first.offer.amountAtomic} is above the indicative ${ind}`);
  }

  // 4. Balances.
  const swapSources = policy.allowedSwapSources.map((s) => assetBySymbol(s)).filter((a): a is Asset => a !== undefined);
  const feeAssets = ASSETS.filter((a) => a.gasCapable && a.usdStable);
  const wanted = [...new Map([...usable.map((u) => u.asset), ...swapSources, ...feeAssets].map((a) => [key(a.address), a])).values()];
  let balances: Map<string, bigint>;
  try {
    balances = await deps.getBalances(req.payer, wanted);
  } catch (e) {
    block('BALANCES_UNAVAILABLE', e instanceof Error ? e.message.slice(0, 200) : 'balance read failed');
    return done('NEEDS_REVIEW', 'Wallet balances could not be read, so nothing can be planned safely.');
  }
  const bal = (a: Asset) => balances.get(key(a.address)) ?? 0n;
  plan.accepted = usable.map((u) => ({
    symbol: u.asset.symbol,
    amountAtomic: u.offer.amountAtomic,
    decimals: u.asset.decimals,
    heldAtomic: bal(u.asset),
    payTo: u.offer.payTo,
  }));

  // 5. DIRECT: any accepted, permitted asset the wallet already holds enough of (or the one the user chose).
  const wantSource = req.sourceSymbol;
  const sourceIsAccepted = wantSource !== undefined && usable.some((u) => u.asset.symbol === wantSource);
  if (wantSource !== undefined && !sourceIsAccepted && !policy.allowedSwapSources.includes(wantSource)) {
    block('SOURCE_NOT_SUPPORTED', `${wantSource} cannot be used to pay for this service: it is neither accepted by the service nor a permitted conversion source`);
    return done('NO_SUPPORTED_ROUTE', `You chose to pay with ${wantSource}, which Payrail cannot use for this service.`);
  }
  const direct1 = usable.find(
    (u) => bal(u.asset) >= u.offer.amountAtomic && (wantSource === undefined || (sourceIsAccepted && u.asset.symbol === wantSource)),
  );
  if (!direct1 && sourceIsAccepted) {
    const chosen = usable.find((u) => u.asset.symbol === wantSource)!;
    block('NO_FUNDS', `${wantSource} balance is below the price`);
    return done(
      'INSUFFICIENT_BALANCE',
      `The service needs ${human(chosen.offer.amountAtomic, chosen.asset.decimals)} ${wantSource}; the wallet holds ${human(bal(chosen.asset), chosen.asset.decimals)}.`,
    );
  }
  if (direct1) {
    const { offer, asset } = direct1;
    plan.payment = {
      asset: offer.asset,
      symbol: asset.symbol,
      decimals: asset.decimals,
      amountAtomic: offer.amountAtomic,
      payTo: offer.payTo,
      network: offer.network,
      scheme: offer.scheme,
    };
    plan.price.actualAtomic = offer.amountAtomic;
    plan.costs.servicePriceMicroUsd = microUsd(asset, offer.amountAtomic);
    plan.costs.conversionFeeMicroUsd = 0n;
    plan.costs.totalMicroUsd = plan.costs.servicePriceMicroUsd;
    plan.funding = { kind: 'direct', symbol: asset.symbol, balanceAtomic: bal(asset) };
    plan.route = 'direct';
    plan.gas = {
      required: false,
      ok: true,
      basis: 'x402 settlement is submitted and paid for by the gateway',
      estimatedCostWei: 0n,
      nativeBalanceWei: undefined,
      feeTokenFallback: false,
      notes: [],
    };
    plan.approval = { required: direct.approvalReasons.length > 0, reasons: direct.approvalReasons };
    plan.executable = plan.blockers.length === 0;
    return done(
      plan.approval.required ? 'APPROVAL_REQUIRED' : 'DIRECT_PAY',
      `The wallet already holds ${human(bal(asset), asset.decimals)} ${asset.symbol}, an asset the service accepts. No conversion is needed.`,
      `Pay ${human(offer.amountAtomic, asset.decimals)} ${asset.symbol} to ${offer.payTo} directly.`,
      plan.approval.required ? `Human approval is required: ${direct.approvalReasons.join('; ')}.` : 'Within policy; no human approval needed.',
    );
  }

  // 6. SWAP: hold something convertible?
  const sources = swapSources
    .filter((a) => bal(a) > 0n && (wantSource === undefined || a.symbol === wantSource))
    .sort((a, b) => (bal(b) > bal(a) ? 1 : -1));
  const heldAccepted = usable.map((u) => `${human(bal(u.asset), u.asset.decimals)} ${u.asset.symbol}`).join(', ');
  if (sources.length === 0) {
    block('NO_FUNDS', 'no accepted asset and no swappable balance');
    return done(
      'INSUFFICIENT_BALANCE',
      `The service needs ${human(first.offer.amountAtomic, first.asset.decimals)} ${first.asset.symbol} (or an equivalent accepted asset).`,
      `The wallet holds ${heldAccepted || 'none of them'}, and no convertible local currency.`,
    );
  }

  const attempts: RouteResult[] = [];
  let found: { route: Extract<RouteResult, { kind: 'route' }>; target: { offer: PaymentOffer; asset: Asset } } | undefined;
  outer: for (const target of usable) {
    for (const source of sources) {
      if (attempts.length >= 6) break outer; // bound provider calls
      const r = await deps.routes.findRoute({
        chainId: policy.chainId,
        sell: source,
        buy: target.asset,
        minBuyAmount: target.offer.amountAtomic,
        maxSellAmount: bal(source),
      });
      attempts.push(r);
      if (r.kind === 'route') {
        found = { route: r, target };
        break outer;
      }
    }
  }

  if (!found) {
    for (const a of attempts) if (a.kind === 'none') plan.uncertainties.push(`${a.sell.symbol} -> ${a.buy.symbol}: ${a.code} (${a.message})`);
    const errors = attempts.filter((a) => a.kind === 'none' && a.code === 'PROVIDER_ERROR');
    const small = attempts.filter((a) => a.kind === 'none' && (a.code === 'BELOW_MINIMUM' || a.code === 'EXCEEDS_BALANCE'));
    if (errors.length > 0) {
      block('ROUTE_PROVIDER_ERROR', 'the conversion provider could not be reached or answered unexpectedly');
      return done('NEEDS_REVIEW', 'A conversion route could not be assessed because the provider failed; try again.');
    }
    if (small.length > 0) {
      block('BALANCE_TOO_SMALL', 'a route exists but the wallet holds less than the minimum or required amount');
      return done('INSUFFICIENT_BALANCE', 'A conversion route exists, but the wallet does not hold enough of the source currency.');
    }
    block('NO_ROUTE', 'no supported conversion route to an accepted asset');
    return done('NO_SUPPORTED_ROUTE', 'No live conversion route connects the held currencies to an accepted asset.');
  }

  const { route, target } = found;
  const notionalUsd = microUsd(target.asset, route.buyAmount);
  const swapPolicy = evaluatePolicy(
    {
      service,
      priceMicroUsd: microUsd(target.asset, target.offer.amountAtomic),
      assetSymbol: target.asset.symbol,
      route: 'swap',
      swap: { sourceSymbol: route.sell.symbol, notionalMicroUsd: notionalUsd },
      spentLast24hMicroUsd: spent,
    },
    policy,
  );
  plan.policy.applied = swapPolicy.applied;

  plan.payment = {
    asset: target.offer.asset,
    symbol: target.asset.symbol,
    decimals: target.asset.decimals,
    amountAtomic: target.offer.amountAtomic,
    payTo: target.offer.payTo,
    network: target.offer.network,
    scheme: target.offer.scheme,
  };
  plan.price.actualAtomic = target.offer.amountAtomic;
  plan.route = 'swap';
  const feeUsd = route.takerPays > 0n ? microUsd(target.asset, (route.feeAmount * route.buyAmount) / route.takerPays) : undefined;
  plan.funding = {
    kind: 'swap',
    provider: route.provider,
    quoteState: 'preview',
    sellSymbol: route.sell.symbol,
    sellAmountAtomic: route.sellAmount,
    sellDecimals: route.sell.decimals,
    receiveSymbol: target.asset.symbol,
    receiveAmountAtomic: route.buyAmount,
    feeAtomic: route.feeAmount,
    takerPaysAtomic: route.takerPays,
    surplusAtomic: route.buyAmount - target.offer.amountAtomic,
    minSellAmountAtomic: route.minSellAmount,
  };
  plan.costs.servicePriceMicroUsd = microUsd(target.asset, target.offer.amountAtomic);
  plan.costs.conversionFeeMicroUsd = feeUsd;
  plan.costs.totalMicroUsd =
    plan.costs.servicePriceMicroUsd !== undefined && feeUsd !== undefined ? plan.costs.servicePriceMicroUsd + feeUsd : undefined;

  // Gas for the approve + swap transactions the wallet itself must send.
  const [nativeBalance, gasPrice] = await Promise.all([
    deps.getNativeBalance(req.payer).catch(() => undefined),
    deps.gasPriceWei().catch(() => undefined),
  ]);
  const g = policy.gas;
  const gas: GasAssessment = {
    required: true,
    ok: false,
    basis: `ASSUMED ${g.approveGasUnits + g.swapGasUnits} gas units x live gas price x ${g.safetyFactorPercent}% (estimate, not measured)`,
    estimatedCostWei: gasPrice === undefined ? undefined : ((g.approveGasUnits + g.swapGasUnits) * gasPrice * g.safetyFactorPercent) / 100n,
    nativeBalanceWei: nativeBalance,
    feeTokenFallback: false,
    notes: [],
  };
  if (nativeBalance === undefined || gasPrice === undefined || gas.estimatedCostWei === undefined) {
    gas.notes.push('gas price or CELO balance could not be read');
  } else if (nativeBalance >= gas.estimatedCostWei) {
    gas.ok = true;
  } else {
    let feeTokenMicro = 0n;
    for (const a of feeAssets) feeTokenMicro += microUsd(a, bal(a)) ?? 0n;
    if (feeTokenMicro >= g.minFeeTokenMicroUsd) {
      gas.ok = true;
      gas.feeTokenFallback = true;
      gas.notes.push(`CELO is short; gas would be paid in a held fee token (~${formatUsd(feeTokenMicro)}). Cost conversion not computed.`);
    }
  }
  plan.gas = gas;
  if (!gas.ok) {
    block('INSUFFICIENT_GAS', 'the wallet cannot pay gas for the approve and swap transactions');
  }

  // Swap-specific policy.
  if (swapPolicy.blocked.length > 0) {
    plan.policy.blocked = swapPolicy.blocked;
    for (const b of swapPolicy.blocked) block('POLICY', b);
    return done('POLICY_BLOCKED', 'Spending policy forbids this conversion.', ...swapPolicy.blocked);
  }
  plan.approval = { required: swapPolicy.approvalReasons.length > 0, reasons: swapPolicy.approvalReasons };

  // A preview can never be executed. FIRM_QUOTE_REQUIRED is removed only by the swap pipeline obtaining a
  // real, validated quote (swapexec.ts). It stays on the plan because the plan itself is preview-based.
  block('FIRM_QUOTE_REQUIRED', 'only an indicative preview exists; a firm quote bound to the wallet is required before any swap');
  if (!deps.swapExecution) block('SWAP_EXECUTION_NOT_IMPLEMENTED', 'the swap executor is not enabled in this process');

  const summary = [
    `The wallet holds no accepted asset in sufficient amount (${heldAccepted}).`,
    `Convert ${human(route.sellAmount, route.sell.decimals)} ${route.sell.symbol} -> ~${human(route.buyAmount, target.asset.decimals)} ${target.asset.symbol} via ${route.provider} (INDICATIVE PREVIEW, not a firm quote).`,
    `Conversion fee (included): ${human(route.feeAmount, route.sell.decimals)} ${route.sell.symbol}. Surplus kept after paying: ~${human(route.buyAmount - target.offer.amountAtomic, target.asset.decimals)} ${target.asset.symbol}.`,
    `Then pay ${human(target.offer.amountAtomic, target.asset.decimals)} ${target.asset.symbol} to ${target.offer.payTo}.`,
    `Corridor minimum: ${human(route.minSellAmount, route.sell.decimals)} ${route.sell.symbol} (so the conversion is larger than the price).`,
  ];
  if (!gas.ok) {
    return done('INSUFFICIENT_BALANCE', ...summary, 'Gas cannot be paid: the wallet needs CELO (or a held fee token such as USDT/USDC).');
  }
  // "Executable" for a swap means: it may ENTER the swap pipeline (which requests the firm quote).
  // The only blocker allowed at this point is FIRM_QUOTE_REQUIRED, which the pipeline itself resolves.
  plan.executable = plan.blockers.every((b) => b.code === 'FIRM_QUOTE_REQUIRED');
  return done(plan.approval.required ? 'APPROVAL_REQUIRED' : 'SWAP_REQUIRED', ...summary);
}

// ------------------------------------------------------------------ execution gate

export class AuthorizationRefused extends Error {
  code: 'NOT_EXECUTABLE' | 'PLAN_EXPIRED' | 'APPROVAL_REQUIRED' | 'BODY_MISMATCH' | 'ROUTE_NOT_SUPPORTED' | 'POLICY';
  constructor(code: AuthorizationRefused['code'], message: string) {
    super(message);
    this.name = 'AuthorizationRefused';
    this.code = code;
  }
}

/**
 * The only way to obtain an ExecutionAuthorization. Plans are re-checked here at execution time:
 * staleness, blockers, approval and the exact request body.
 */
export function authorizeExecution(
  plan: PaymentPlan,
  opts: { now: number; body: string; approvedBy?: string; hardCapAtomic?: bigint },
): ExecutionAuthorization {
  if (opts.now > plan.validUntilMs) {
    throw new AuthorizationRefused('PLAN_EXPIRED', 'the plan is stale (QUOTE_EXPIRED); plan again before paying');
  }
  if (plan.route !== 'direct') {
    throw new AuthorizationRefused('ROUTE_NOT_SUPPORTED', 'only direct payments can be executed at this stage; swaps are plan-only');
  }
  if (!plan.executable || plan.blockers.length > 0 || plan.payment === null) {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `plan status ${plan.status} is not executable: ${plan.blockers.map((b) => b.code).join(', ') || 'no payment'}`);
  }
  if (plan.status !== 'DIRECT_PAY' && plan.status !== 'APPROVAL_REQUIRED') {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `plan status ${plan.status} is not executable`);
  }
  if (plan.approval.required && !opts.approvedBy) {
    throw new AuthorizationRefused('APPROVAL_REQUIRED', `human approval required: ${plan.approval.reasons.join('; ')}`);
  }
  if (sha256Hex(opts.body) !== plan.bodyHash) {
    throw new AuthorizationRefused('BODY_MISMATCH', 'the request body differs from the body that was priced');
  }
  const amount = plan.payment.amountAtomic;
  if (opts.hardCapAtomic !== undefined && amount > opts.hardCapAtomic) {
    throw new AuthorizationRefused('POLICY', `amount ${amount} exceeds the hard cap ${opts.hardCapAtomic}`);
  }
  return mintAuthorization({
    planId: plan.planId,
    route: 'direct',
    serviceId: plan.service.id,
    method: 'POST',
    url: plan.service.url,
    bodyHash: plan.bodyHash,
    payment: {
      network: 'celo',
      chainId: 42220,
      asset: plan.payment.asset,
      symbol: plan.payment.symbol,
      payTo: plan.payment.payTo,
      amountAtomic: amount,
    },
    maxAmountAtomic: amount,
    payer: plan.payer,
    createdAtMs: opts.now,
    expiresAtMs: plan.validUntilMs,
    approvedBy: opts.approvedBy ?? 'policy:auto',
  });
}

/**
 * The only way to obtain a SwapAuthorization. It permits requesting ONE firm quote and the validated
 * sequence that follows; broadcasting additionally needs the human confirmation inside swapexec.ts.
 */
export function authorizeSwap(
  plan: PaymentPlan,
  opts: { now: number; approvedBy?: string; slippageBps?: number },
): SwapAuthorization {
  if (opts.now > plan.validUntilMs) {
    throw new AuthorizationRefused('PLAN_EXPIRED', 'the plan is stale (QUOTE_EXPIRED); plan again before swapping');
  }
  if (plan.route !== 'swap' || plan.funding?.kind !== 'swap' || plan.payment === null) {
    throw new AuthorizationRefused('NOT_EXECUTABLE', 'this plan is not a swap plan');
  }
  if (plan.status !== 'SWAP_REQUIRED' && plan.status !== 'APPROVAL_REQUIRED') {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `plan status ${plan.status} cannot be swapped`);
  }
  const blocking = plan.blockers.filter((b) => b.code !== 'FIRM_QUOTE_REQUIRED');
  if (!plan.executable || blocking.length > 0) {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `swap plan is blocked: ${blocking.map((b) => b.code).join(', ') || 'not executable'}`);
  }
  if (plan.gas === null || !plan.gas.ok) {
    throw new AuthorizationRefused('NOT_EXECUTABLE', 'gas for the swap transactions is not available');
  }
  if (plan.approval.required && !opts.approvedBy) {
    throw new AuthorizationRefused('APPROVAL_REQUIRED', `human approval required: ${plan.approval.reasons.join('; ')}`);
  }
  const f = plan.funding;
  const sell = assetBySymbol(f.sellSymbol);
  if (!sell) throw new AuthorizationRefused('NOT_EXECUTABLE', `unknown sell asset ${f.sellSymbol}`);
  return mintSwapAuthorization({
    planId: plan.planId,
    route: 'swap',
    serviceId: plan.service.id,
    payer: plan.payer,
    chainId: 42220,
    provider: f.provider,
    sell: {
      asset: sell.address,
      symbol: f.sellSymbol,
      decimals: f.sellDecimals,
      sellAmountAtomic: f.sellAmountAtomic,
      maxTakerPaysAtomic: f.sellAmountAtomic,
    },
    buy: {
      asset: plan.payment.asset,
      symbol: plan.payment.symbol,
      minBuyAtomic: plan.payment.amountAtomic,
      expectedBuyAtomic: f.receiveAmountAtomic,
    },
    slippageBps: opts.slippageBps ?? 100,
    createdAtMs: opts.now,
    expiresAtMs: plan.validUntilMs,
    approvedBy: opts.approvedBy ?? 'policy:auto',
  });
}

// ------------------------------------------------------------------ standalone conversion (top-up) planning

export type ConversionStatus =
  | 'SWAP_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_SUPPORTED_ROUTE'
  | 'POLICY_BLOCKED'
  | 'NEEDS_REVIEW'
  | 'QUOTE_EXPIRED';

export interface ConversionPlan {
  planId: string;
  createdAtMs: number;
  validUntilMs: number;
  status: ConversionStatus;
  /** May enter the swap pipeline (whose only remaining blocker is obtaining the firm quote). */
  executable: boolean;
  payer: Address;
  sell: { symbol: string; asset: Address; decimals: number; amountAtomic: bigint; balanceAtomic: bigint };
  buy: { symbol: string; asset: Address; decimals: number; expectedAtomic: bigint; minAtomic: bigint; balanceBeforeAtomic: bigint };
  quote: {
    state: QuoteState;
    provider: string;
    feeAtomic: bigint;
    takerPaysAtomic: bigint;
    corridorMinAtomic: bigint;
    depthAtomic: bigint | undefined;
    /** Buy units per 1 sell unit, from the indicative preview. */
    rate: string;
  } | null;
  allowance: {
    spender: Address;
    currentAtomic: bigint;
    requiredAtomic: bigint;
    approvalRequired: boolean;
    resetRequired: boolean;
  } | null;
  gas: (GasAssessment & { approveGasMeasured: bigint | undefined; transactions: number }) | null;
  /** What the wallet would hold afterwards (indicative; the swap output is the quote's, not a promise). */
  after: { sellAtomic: bigint; buyAtomic: bigint } | null;
  /** Transactions whose exact bytes are known BEFORE any firm quote. The swap calldata only exists after one. */
  knownTransactions: Array<{ kind: 'approve_reset' | 'approve'; to: Address; description: string }>;
  policy: { applied: string[]; blocked: string[] };
  approval: { required: boolean; reasons: string[] };
  uncertainties: string[];
  blockers: Blocker[];
  explanation: string[];
}

export interface ConversionDeps {
  now(): number;
  policy: SpendingPolicy;
  getBalances(owner: Address, assets: readonly Asset[]): Promise<Map<string, bigint>>;
  getNativeBalance(owner: Address): Promise<bigint>;
  gasPriceWei(): Promise<bigint>;
  getAllowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** Optional: a MEASURED gas figure for an approve (eth_estimateGas, read-only). */
  measureApproveGas?(token: Address, owner: Address, spender: Address, amount: bigint): Promise<bigint>;
  routes: RouteProvider;
  swapExecution?: boolean;
  newId?: () => string;
}

export async function planConversion(
  deps: ConversionDeps,
  req: { sell: string; buy: string; sellAmountAtomic: bigint; payer: Address },
): Promise<ConversionPlan> {
  const now = deps.now();
  const policy = deps.policy;
  const sellAsset = assetBySymbol(req.sell);
  const buyAsset = assetBySymbol(req.buy);

  const plan: ConversionPlan = {
    planId: (deps.newId ?? randomUUID)(),
    createdAtMs: now,
    validUntilMs: now + policy.planTtlMs,
    status: 'NEEDS_REVIEW',
    executable: false,
    payer: req.payer,
    sell: {
      symbol: req.sell,
      asset: sellAsset?.address ?? ('0x0000000000000000000000000000000000000000' as Address),
      decimals: sellAsset?.decimals ?? 0,
      amountAtomic: req.sellAmountAtomic,
      balanceAtomic: 0n,
    },
    buy: {
      symbol: req.buy,
      asset: buyAsset?.address ?? ('0x0000000000000000000000000000000000000000' as Address),
      decimals: buyAsset?.decimals ?? 0,
      expectedAtomic: 0n,
      minAtomic: 0n,
      balanceBeforeAtomic: 0n,
    },
    quote: null,
    allowance: null,
    gas: null,
    after: null,
    knownTransactions: [],
    policy: { applied: [], blocked: [] },
    approval: { required: true, reasons: [] },
    uncertainties: [],
    blockers: [],
    explanation: [],
  };
  const done = (status: ConversionStatus, ...lines: string[]): ConversionPlan => {
    plan.status = status;
    plan.explanation.push(...lines);
    return plan;
  };
  const block = (code: string, message: string) => plan.blockers.push({ code, message });

  if (!sellAsset || !buyAsset) {
    block('UNKNOWN_ASSET', `unknown asset in ${req.sell} -> ${req.buy}`);
    return done('NEEDS_REVIEW', 'One of the assets is not in the Payrail registry.');
  }
  if (req.sellAmountAtomic <= 0n) {
    block('INVALID_AMOUNT', 'amount must be positive');
    return done('NEEDS_REVIEW', 'The amount to convert must be greater than zero.');
  }

  // Pair permission is checked before any network call.
  const pre = evaluateConversionPolicy({ sellSymbol: req.sell, buySymbol: req.buy, notionalMicroUsd: microUsd(sellAsset, req.sellAmountAtomic) ?? microUsd(buyAsset, 0n) }, policy);
  plan.policy.applied = pre.applied;
  const pairBlocked = pre.blocked.filter((b) => b.includes('not permitted'));
  if (pairBlocked.length > 0) {
    plan.policy.blocked = pairBlocked;
    for (const b of pairBlocked) block('POLICY', b);
    return done('POLICY_BLOCKED', 'Spending policy does not permit this conversion.', ...pairBlocked);
  }

  if (!deps.routes.quoteExactInput) {
    block('ROUTE_PROVIDER_UNSUPPORTED', 'the route provider cannot price an exact-input conversion');
    return done('NO_SUPPORTED_ROUTE', 'No conversion provider can price this request.');
  }
  const route = await deps.routes.quoteExactInput({ chainId: policy.chainId, sell: sellAsset, buy: buyAsset, sellAmount: req.sellAmountAtomic });
  if (route.kind === 'none') {
    plan.uncertainties.push(`${route.provider}: ${route.code} (${route.message})`);
    if (route.code === 'PROVIDER_ERROR') {
      block('ROUTE_PROVIDER_ERROR', route.message);
      return done('NEEDS_REVIEW', 'The conversion provider failed; try again.');
    }
    if (route.code === 'BELOW_MINIMUM' || route.code === 'INSUFFICIENT_DEPTH') {
      block(route.code, route.message);
      return done('NEEDS_REVIEW', `The amount is outside the corridor's live limits (${route.message}).`);
    }
    block('NO_ROUTE', route.message);
    return done('NO_SUPPORTED_ROUTE', `No live conversion route from ${req.sell} to ${req.buy} (${route.code}).`);
  }

  const expected = route.buyAmount;
  const floor = (expected * BigInt(10_000 - policy.conversionSlippageBps)) / 10_000n;
  plan.buy.expectedAtomic = expected;
  plan.buy.minAtomic = floor;
  const ratePerUnit = Number(formatUnits(expected, buyAsset.decimals)) / Number(formatUnits(route.sellAmount, sellAsset.decimals));
  plan.quote = {
    state: 'preview',
    provider: route.provider,
    feeAtomic: route.feeAmount,
    takerPaysAtomic: route.takerPays,
    corridorMinAtomic: route.minSellAmount,
    depthAtomic: route.availableSellAmount,
    rate: ratePerUnit.toPrecision(8),
  };

  // Policy with the real notional.
  const notional = microUsd(sellAsset, route.sellAmount) ?? microUsd(buyAsset, expected);
  const pol = evaluateConversionPolicy({ sellSymbol: req.sell, buySymbol: req.buy, notionalMicroUsd: notional }, policy);
  plan.policy = { applied: pol.applied, blocked: pol.blocked };
  if (pol.blocked.length > 0) {
    for (const b of pol.blocked) block('POLICY', b);
    return done('POLICY_BLOCKED', 'Spending policy forbids this conversion.', ...pol.blocked);
  }
  plan.approval = { required: pol.approvalReasons.length > 0, reasons: pol.approvalReasons };

  // Balances and allowance.
  const feeAssets = ASSETS.filter((a) => a.gasCapable && a.usdStable);
  let balances: Map<string, bigint>;
  let allowance: bigint;
  try {
    const wanted = [...new Map([sellAsset, buyAsset, ...feeAssets].map((a) => [key(a.address), a])).values()];
    [balances, allowance] = await Promise.all([
      deps.getBalances(req.payer, wanted),
      deps.getAllowance(sellAsset.address, req.payer, route.spender ?? TEXTILE_REACTOR),
    ]);
  } catch (e) {
    block('CHAIN_UNREADABLE', e instanceof Error ? e.message.slice(0, 200) : 'chain read failed');
    return done('NEEDS_REVIEW', 'Wallet state could not be read, so the conversion cannot be planned safely.');
  }
  const bal = (a: Asset) => balances.get(key(a.address)) ?? 0n;
  plan.sell.balanceAtomic = bal(sellAsset);
  plan.buy.balanceBeforeAtomic = bal(buyAsset);
  plan.after = { sellAtomic: bal(sellAsset) - req.sellAmountAtomic, buyAtomic: bal(buyAsset) + expected };

  if (bal(sellAsset) < req.sellAmountAtomic) {
    const short = req.sellAmountAtomic - bal(sellAsset);
    block('INSUFFICIENT_BALANCE', `short by ${short} atomic ${req.sell}`);
    plan.after = null;
    return done(
      'INSUFFICIENT_BALANCE',
      `Converting ${human(req.sellAmountAtomic, sellAsset.decimals)} ${req.sell} needs that much in the wallet, which holds ${human(bal(sellAsset), sellAsset.decimals)}.`,
      `Short by ${human(short, sellAsset.decimals)} ${req.sell}. (The corridor minimum is ${human(route.minSellAmount, sellAsset.decimals)} ${req.sell}.)`,
    );
  }

  const approvalRequired = allowance < req.sellAmountAtomic;
  const resetRequired = approvalRequired && allowance > 0n && sellAsset.allowanceReset !== 'not_required';
  const spender: Address = route.spender ?? TEXTILE_REACTOR;
  if (route.note) plan.uncertainties.push(route.note);
  plan.allowance = { spender, currentAtomic: allowance, requiredAtomic: req.sellAmountAtomic, approvalRequired, resetRequired };
  if (resetRequired) {
    plan.knownTransactions.push({ kind: 'approve_reset', to: sellAsset.address, description: `approve(${spender}, 0)` });
  }
  if (approvalRequired) {
    plan.knownTransactions.push({
      kind: 'approve',
      to: sellAsset.address,
      description: `approve(${spender}, ${req.sellAmountAtomic}) = exactly ${human(req.sellAmountAtomic, sellAsset.decimals)} ${req.sell}, no unlimited allowance`,
    });
  }

  // Gas for the transactions the wallet itself must send.
  const g = policy.gas;
  const txs = (resetRequired ? 1 : 0) + (approvalRequired ? 1 : 0) + 1;
  let measured: bigint | undefined;
  if (approvalRequired && deps.measureApproveGas) {
    measured = await deps.measureApproveGas(sellAsset.address, req.payer, spender, req.sellAmountAtomic).catch(() => undefined);
  }
  const approveUnits = measured ?? g.approveGasUnits;
  const units = (resetRequired ? approveUnits : 0n) + (approvalRequired ? approveUnits : 0n) + g.swapGasUnits;
  const [native, gasPrice] = await Promise.all([deps.getNativeBalance(req.payer).catch(() => undefined), deps.gasPriceWei().catch(() => undefined)]);
  const gas: NonNullable<ConversionPlan['gas']> = {
    required: true,
    ok: false,
    basis: `${measured !== undefined ? `approve MEASURED at ${measured} gas; ` : ''}swap gas ASSUMED at ${g.swapGasUnits} (not measurable before a firm quote); x live gas price x ${g.safetyFactorPercent}%`,
    estimatedCostWei: gasPrice === undefined ? undefined : (units * gasPrice * g.safetyFactorPercent) / 100n,
    nativeBalanceWei: native,
    feeTokenFallback: false,
    notes: [],
    approveGasMeasured: measured,
    transactions: txs,
  };
  if (native !== undefined && gas.estimatedCostWei !== undefined && native >= gas.estimatedCostWei) gas.ok = true;
  else {
    let feeMicro = 0n;
    for (const a of feeAssets) if (a !== sellAsset) feeMicro += microUsd(a, bal(a)) ?? 0n;
    if (feeMicro >= g.minFeeTokenMicroUsd) {
      gas.ok = true;
      gas.feeTokenFallback = true;
      gas.notes.push('CELO is short; gas would be paid in a held fee token. Cost conversion not computed.');
    } else gas.notes.push('neither CELO nor a held fee token covers the estimated gas');
  }
  plan.gas = gas;
  if (!gas.ok) {
    block('INSUFFICIENT_GAS', 'the wallet cannot pay gas for the approve and swap transactions');
    return done('INSUFFICIENT_BALANCE', 'Gas cannot be paid: the wallet needs more CELO.');
  }

  block('FIRM_QUOTE_REQUIRED', 'only an indicative preview exists; the firm quote is requested by the swap pipeline after you authorize it');
  if (!deps.swapExecution) block('SWAP_EXECUTION_NOT_IMPLEMENTED', 'the swap executor is not enabled in this process');
  plan.executable = plan.blockers.every((b) => b.code === 'FIRM_QUOTE_REQUIRED');
  return done(
    plan.approval.required ? 'APPROVAL_REQUIRED' : 'SWAP_REQUIRED',
    `Convert ${human(req.sellAmountAtomic, sellAsset.decimals)} ${req.sell} -> about ${human(expected, buyAsset.decimals)} ${req.buy} via ${route.provider} (INDICATIVE PREVIEW, not a firm quote).`,
    `Fee (already inside the amount): ${human(route.feeAmount, sellAsset.decimals)} ${req.sell}. The firm quote must deliver at least ${human(floor, buyAsset.decimals)} ${req.buy} (${policy.conversionSlippageBps} bps tolerance), or nothing is sent.`,
    approvalRequired
      ? `An approval is needed first: ${resetRequired ? 'reset to 0, then ' : ''}approve exactly ${human(req.sellAmountAtomic, sellAsset.decimals)} ${req.sell} to ${spender} (the ${route.provider} contract).`
      : 'The existing allowance already covers it: no approval transaction is needed.',
  );
}

/**
 * Obtains a SwapAuthorization for a standalone conversion. It permits requesting ONE firm quote and the
 * validated sequence that follows; broadcasting additionally needs the confirmations inside swapexec.ts.
 */
export function authorizeConversion(
  plan: ConversionPlan,
  opts: { now: number; approvedBy?: string; slippageBps?: number },
): SwapAuthorization {
  if (opts.now > plan.validUntilMs) throw new AuthorizationRefused('PLAN_EXPIRED', 'the plan is stale (QUOTE_EXPIRED); plan again');
  if (plan.status !== 'SWAP_REQUIRED' && plan.status !== 'APPROVAL_REQUIRED') {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `plan status ${plan.status} cannot be converted`);
  }
  const blocking = plan.blockers.filter((b) => b.code !== 'FIRM_QUOTE_REQUIRED');
  if (!plan.executable || blocking.length > 0 || plan.quote === null) {
    throw new AuthorizationRefused('NOT_EXECUTABLE', `conversion plan is blocked: ${blocking.map((b) => b.code).join(', ') || 'not executable'}`);
  }
  if (plan.gas === null || !plan.gas.ok) throw new AuthorizationRefused('NOT_EXECUTABLE', 'gas for the transactions is not available');
  if (plan.approval.required && !opts.approvedBy) {
    throw new AuthorizationRefused('APPROVAL_REQUIRED', `human approval required: ${plan.approval.reasons.join('; ')}`);
  }
  return mintSwapAuthorization({
    planId: plan.planId,
    route: 'swap',
    serviceId: `convert:${plan.sell.symbol}->${plan.buy.symbol}`,
    payer: plan.payer,
    chainId: 42220,
    provider: plan.quote.provider,
    sell: {
      asset: plan.sell.asset,
      symbol: plan.sell.symbol,
      decimals: plan.sell.decimals,
      sellAmountAtomic: plan.sell.amountAtomic,
      maxTakerPaysAtomic: plan.sell.amountAtomic,
    },
    buy: {
      asset: plan.buy.asset,
      symbol: plan.buy.symbol,
      minBuyAtomic: plan.buy.minAtomic,
      expectedBuyAtomic: plan.buy.expectedAtomic,
    },
    slippageBps: opts.slippageBps ?? 100,
    createdAtMs: opts.now,
    expiresAtMs: plan.validUntilMs,
    approvedBy: opts.approvedBy ?? 'policy:auto',
  });
}

export function renderConversionPlan(p: ConversionPlan): string {
  const L: string[] = [];
  const h = (v: bigint, d: number) => formatUnits(v, d);
  L.push(`STATUS: ${p.status}   executable: ${p.executable}   plan ${p.planId}`);
  L.push(`convert : ${h(p.sell.amountAtomic, p.sell.decimals)} ${p.sell.symbol} -> ${p.buy.symbol}`);
  if (p.quote) {
    L.push(`expected: ~${h(p.buy.expectedAtomic, p.buy.decimals)} ${p.buy.symbol}   (rate ${p.quote.rate} ${p.buy.symbol} per ${p.sell.symbol}; INDICATIVE preview via ${p.quote.provider})`);
    L.push(`floor   : the firm quote must deliver at least ${h(p.buy.minAtomic, p.buy.decimals)} ${p.buy.symbol}`);
    L.push(`fee     : ${h(p.quote.feeAtomic, p.sell.decimals)} ${p.sell.symbol} (already inside the amount)   corridor minimum ${h(p.quote.corridorMinAtomic, p.sell.decimals)} ${p.sell.symbol}`);
  }
  L.push(`wallet  : ${h(p.sell.balanceAtomic, p.sell.decimals)} ${p.sell.symbol}, ${h(p.buy.balanceBeforeAtomic, p.buy.decimals)} ${p.buy.symbol}`);
  if (p.after) L.push(`after   : ~${h(p.after.sellAtomic, p.sell.decimals)} ${p.sell.symbol}, ~${h(p.after.buyAtomic, p.buy.decimals)} ${p.buy.symbol}`);
  if (p.allowance) {
    L.push(`approval: current allowance ${h(p.allowance.currentAtomic, p.sell.decimals)} to ${p.allowance.spender}; ${p.allowance.approvalRequired ? (p.allowance.resetRequired ? 'RESET to 0 then approve' : 'approve') + ' required' : 'not required'}`);
  }
  for (const t of p.knownTransactions) L.push(`  tx    : ${t.kind} -> ${t.to}  ${t.description}`);
  if (p.allowance) L.push(`  tx    : swap -> ${p.allowance.spender} (the ${p.quote?.provider ?? 'venue'} contract); its exact calldata is built and simulated by the pipeline just before sending`);
  if (p.gas) {
    L.push(`gas     : ${p.gas.transactions} tx; estimated ${p.gas.estimatedCostWei === undefined ? 'unknown' : formatUnits(p.gas.estimatedCostWei, 18)} CELO of ${p.gas.nativeBalanceWei === undefined ? '?' : formatUnits(p.gas.nativeBalanceWei, 18)} (${p.gas.basis})`);
  }
  L.push(`approval: ${p.approval.required ? 'REQUIRED - ' + p.approval.reasons.join('; ') : 'not required'}`);
  L.push(`valid until: ${new Date(p.validUntilMs).toISOString()}`);
  for (const b of p.policy.blocked) L.push(`BLOCKED BY POLICY: ${b}`);
  for (const b of p.blockers) L.push(`blocker ${b.code}: ${b.message}`);
  for (const u of p.uncertainties) L.push(`uncertain: ${u}`);
  L.push('why:', ...p.explanation.map((e) => `  - ${e}`));
  return L.join('\n');
}

/** Re-evaluates staleness: a plan past its validity is QUOTE_EXPIRED and not executable. */
export function refreshPlanStatus(plan: PaymentPlan, now: number): PaymentPlan {
  if (now <= plan.validUntilMs || plan.status === 'QUOTE_EXPIRED') return plan;
  return {
    ...plan,
    status: 'QUOTE_EXPIRED',
    executable: false,
    blockers: [...plan.blockers, { code: 'QUOTE_EXPIRED', message: 'the plan passed its validity time' }],
    explanation: [...plan.explanation, 'The plan is stale. Prices, balances and quotes must be re-read before executing.'],
  };
}

export function renderPlan(plan: PaymentPlan): string {
  const L: string[] = [];
  const usd = (v: bigint | undefined) => (v === undefined ? 'unknown' : formatUsd(v));
  L.push(`STATUS: ${plan.status}   route: ${plan.route ?? 'none'}   executable: ${plan.executable}`);
  L.push(`service: ${plan.service.id}  ${plan.service.url}`);
  if (plan.payment) {
    L.push(`pay: ${human(plan.payment.amountAtomic, plan.payment.decimals)} ${plan.payment.symbol} to ${plan.payment.payTo} on ${plan.payment.network}`);
  }
  L.push(`price: actual (402) ${plan.price.actualAtomic ?? 'n/a'} atomic; catalog indicative max ${plan.price.indicativeMaxAtomic ?? 'n/a'}`);
  if (plan.funding?.kind === 'direct') L.push(`funding: direct from ${plan.funding.symbol} balance ${plan.funding.balanceAtomic}`);
  if (plan.funding?.kind === 'swap') {
    const f = plan.funding;
    L.push(`funding: SWAP via ${f.provider} [${f.quoteState}] ${human(f.sellAmountAtomic, f.sellDecimals)} ${f.sellSymbol} -> ~${f.receiveAmountAtomic} atomic ${f.receiveSymbol}; fee ${human(f.feeAtomic, f.sellDecimals)} ${f.sellSymbol}`);
  }
  if (plan.gas) L.push(`gas: required=${plan.gas.required} ok=${plan.gas.ok} (${plan.gas.basis})`);
  L.push(`cost: service ${usd(plan.costs.servicePriceMicroUsd)} + conversion fee ${usd(plan.costs.conversionFeeMicroUsd)} = ${usd(plan.costs.totalMicroUsd)}`);
  L.push(`approval: ${plan.approval.required ? 'REQUIRED - ' + plan.approval.reasons.join('; ') : 'not required'}`);
  L.push(`valid until: ${new Date(plan.validUntilMs).toISOString()}`);
  if (plan.policy.blocked.length) L.push(...plan.policy.blocked.map((b) => `BLOCKED BY POLICY: ${b}`));
  if (plan.blockers.length) L.push(...plan.blockers.map((b) => `blocker ${b.code}: ${b.message}`));
  if (plan.uncertainties.length) L.push(...plan.uncertainties.map((u) => `uncertain: ${u}`));
  L.push('why:', ...plan.explanation.map((e) => `  - ${e}`));
  return L.join('\n');
}
