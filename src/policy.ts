// Spending policy. Limits are ENFORCED in code (evaluatePolicy returns hard blocks), not just displayed.
// Money amounts are bigint micro-USD (6 decimals) so there is no floating-point rounding anywhere.
//
// Defaults are deliberately small and conservative. Anything not explicitly permitted is blocked or
// needs human approval.
import type { Service } from './catalog.ts';

export interface SpendingPolicy {
  network: 'celo';
  chainId: number;
  /** Hosts a service URL may use. Any other host is never contacted and never paid. */
  allowedHosts: readonly string[];
  /** Services that may be paid without a human prompt (still subject to every limit below). */
  autoPayServiceIds: readonly string[];
  /** Assets that may be used to pay a service directly (symbols). */
  allowedPaymentAssets: readonly string[];
  /** Order of preference when several accepted assets are held. */
  preferredAssets: readonly string[];
  /** Assets that may be sold in a conversion (symbols). */
  allowedSwapSources: readonly string[];
  maxPerPaymentMicroUsd: bigint;
  maxPerDayMicroUsd: bigint;
  /** Largest value that may move through a conversion (Textile has a ~$1 minimum). */
  maxSwapNotionalMicroUsd: bigint;
  /** Cumulative value that may move through swaps in any rolling 24h, in addition to the per-swap limit. */
  maxSwapPerDayMicroUsd: bigint;
  /** Standalone conversions (top-ups) permitted as [sell symbol, buy symbol]. Anything else is blocked. */
  allowedConversions: ReadonlyArray<readonly [string, string]>;
  /** Worst acceptable price movement between the preview and the firm quote, in basis points. */
  conversionSlippageBps: number;
  requireApprovalForSwap: boolean;
  /** Payments above this need a human, even for auto-pay services. */
  requireApprovalAboveMicroUsd: bigint;
  /** How long a plan stays valid before it must be re-planned. */
  planTtlMs: number;
  /** Actual 402 price may exceed the indicative catalog price by this factor before review is required. */
  priceToleranceFactor: bigint;
  gas: {
    /** ASSUMED upper bounds, not measured. They are flagged as estimates in every plan. */
    approveGasUnits: bigint;
    swapGasUnits: bigint;
    safetyFactorPercent: bigint;
    /** Minimum fee-token (USDC/USDT/USAT/USDm) holding that counts as able to pay gas, in micro-USD. */
    minFeeTokenMicroUsd: bigint;
  };
}

export const DEFAULT_POLICY: SpendingPolicy = Object.freeze({
  network: 'celo',
  chainId: 42220,
  allowedHosts: Object.freeze(['gateway.usebuy.ai']),
  autoPayServiceIds: Object.freeze(['x.posts.search']),
  allowedPaymentAssets: Object.freeze(['USDT', 'USDC', 'USAT']),
  preferredAssets: Object.freeze(['USDT', 'USDC', 'USAT']),
  allowedSwapSources: Object.freeze(['cNGN', 'wARS', 'wBRL', 'IDRX']),
  maxPerPaymentMicroUsd: 10_000n, // $0.01
  maxPerDayMicroUsd: 250_000n, // $0.25
  maxSwapNotionalMicroUsd: 2_000_000n, // $2.00
  maxSwapPerDayMicroUsd: 5_000_000n, // $5.00 per rolling 24h
  allowedConversions: Object.freeze([
    ['USDT', 'cNGN'],
    ['USDT', 'wARS'],
    ['USDT', 'wBRL'],
    ['USDT', 'IDRX'],
    ['cNGN', 'USDT'],
    ['wARS', 'USDT'],
    ['wBRL', 'USDT'],
    ['IDRX', 'USDT'],
    ['USDm', 'USDT'],
    ['USDT', 'USDm'],
  ] as const),
  conversionSlippageBps: 100,
  requireApprovalForSwap: true,
  requireApprovalAboveMicroUsd: 10_000n, // $0.01
  planTtlMs: 60_000,
  priceToleranceFactor: 2n,
  gas: {
    approveGasUnits: 100_000n,
    swapGasUnits: 450_000n,
    safetyFactorPercent: 200n,
    minFeeTokenMicroUsd: 100_000n, // $0.10
  },
} satisfies SpendingPolicy);

/** "0.25" -> 250000n. Throws on anything that is not a plain non-negative decimal with <= 6 places. */
export function parseUsd(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`not a USD amount with at most 6 decimals: ${JSON.stringify(text)}`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

export function formatUsd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `$${whole}${frac ? '.' + frac : ''}`;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/** Overrides are read from env; invalid values throw (fail loudly, never silently fall back to looser limits). */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env, base: SpendingPolicy = DEFAULT_POLICY): SpendingPolicy {
  const p: SpendingPolicy = {
    ...base,
    gas: { ...base.gas },
  };
  if (env.PAYRAIL_MAX_PER_PAYMENT_USD) p.maxPerPaymentMicroUsd = parseUsd(env.PAYRAIL_MAX_PER_PAYMENT_USD);
  if (env.PAYRAIL_MAX_PER_DAY_USD) p.maxPerDayMicroUsd = parseUsd(env.PAYRAIL_MAX_PER_DAY_USD);
  if (env.PAYRAIL_MAX_SWAP_USD) p.maxSwapNotionalMicroUsd = parseUsd(env.PAYRAIL_MAX_SWAP_USD);
  if (env.PAYRAIL_MAX_SWAP_PER_DAY_USD) p.maxSwapPerDayMicroUsd = parseUsd(env.PAYRAIL_MAX_SWAP_PER_DAY_USD);
  if (env.PAYRAIL_APPROVAL_ABOVE_USD) p.requireApprovalAboveMicroUsd = parseUsd(env.PAYRAIL_APPROVAL_ABOVE_USD);
  if (env.PAYRAIL_AUTOPAY_SERVICES !== undefined) p.autoPayServiceIds = list(env.PAYRAIL_AUTOPAY_SERVICES);
  if (env.PAYRAIL_ALLOWED_HOSTS) p.allowedHosts = list(env.PAYRAIL_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  if (env.PAYRAIL_REQUIRE_SWAP_APPROVAL) p.requireApprovalForSwap = env.PAYRAIL_REQUIRE_SWAP_APPROVAL !== 'false';
  if (env.PAYRAIL_ALLOWED_CONVERSIONS !== undefined) {
    p.allowedConversions = list(env.PAYRAIL_ALLOWED_CONVERSIONS).map((pair) => {
      const [s, b, extra] = pair.split(':');
      if (!s || !b || extra !== undefined) throw new Error(`PAYRAIL_ALLOWED_CONVERSIONS entry must be SELL:BUY, got ${JSON.stringify(pair)}`);
      return [s, b] as const;
    });
  }
  if (env.PAYRAIL_CONVERSION_SLIPPAGE_BPS) {
    const n = Number(env.PAYRAIL_CONVERSION_SLIPPAGE_BPS);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('PAYRAIL_CONVERSION_SLIPPAGE_BPS must be an integer 0..1000');
    p.conversionSlippageBps = n;
  }
  return p;
}

// ------------------------------------------------------------------ standalone conversion policy

export interface ConversionPolicyInput {
  sellSymbol: string;
  buySymbol: string;
  /** USD value moved through the conversion, or undefined if it cannot be valued. */
  notionalMicroUsd: bigint | undefined;
}

export function evaluateConversionPolicy(input: ConversionPolicyInput, policy: SpendingPolicy): PolicyResult {
  const applied: string[] = [];
  const blocked: string[] = [];
  const approvalReasons: string[] = [];

  applied.push(`allowed conversions: ${policy.allowedConversions.map(([s, b]) => `${s}->${b}`).join(', ') || '(none)'}`);
  if (!policy.allowedConversions.some(([s, b]) => s === input.sellSymbol && b === input.buySymbol)) {
    blocked.push(`conversion ${input.sellSymbol} -> ${input.buySymbol} is not permitted by policy`);
  }
  applied.push(`max value through a conversion: ${formatUsd(policy.maxSwapNotionalMicroUsd)}`);
  if (input.notionalMicroUsd === undefined) {
    blocked.push('the conversion value cannot be determined, so the limit cannot be enforced');
  } else if (input.notionalMicroUsd > policy.maxSwapNotionalMicroUsd) {
    blocked.push(`conversion value ${formatUsd(input.notionalMicroUsd)} exceeds the limit ${formatUsd(policy.maxSwapNotionalMicroUsd)}`);
  }
  if (policy.requireApprovalForSwap) {
    applied.push('conversions require human approval');
    approvalReasons.push('policy requires human approval for any currency conversion');
  }
  return { applied, blocked, approvalReasons };
}

// ------------------------------------------------------------------ endpoint / service assessment

export interface ServiceAssessment {
  /** May Payrail contact this endpoint at all (e.g. to read its payment requirements)? */
  contactable: boolean;
  /** May it be paid without a human prompt (subject to limits)? Catalog listing alone never earns this. */
  autoPayable: boolean;
  reasons: string[];
}

export function assessService(service: Service, policy: SpendingPolicy): ServiceAssessment {
  const reasons: string[] = [];
  let contactable = true;
  let host = '';
  try {
    const u = new URL(service.url);
    host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:') {
      contactable = false;
      reasons.push('endpoint is not https');
    }
    if (u.username || u.password) {
      contactable = false;
      reasons.push('endpoint URL contains credentials');
    }
    if (u.port !== '' && u.port !== '443') {
      contactable = false;
      reasons.push(`endpoint uses a non-standard port ${u.port}`);
    }
  } catch {
    contactable = false;
    reasons.push('endpoint is not a valid URL');
  }
  if (contactable && !policy.allowedHosts.includes(host)) {
    contactable = false;
    reasons.push(`host ${host} is not on the allowed-hosts list`);
  }
  if (!service.available) reasons.push('catalog marks the service unavailable');
  const autoPayable = contactable && service.available && policy.autoPayServiceIds.includes(service.id);
  if (contactable && !policy.autoPayServiceIds.includes(service.id)) {
    reasons.push('service is not on the auto-pay allow-list; a human must approve each payment');
  }
  return { contactable, autoPayable, reasons };
}

// ------------------------------------------------------------------ spend evaluation

export interface SpendInput {
  service: Service;
  /** The value of the service price in micro-USD, or undefined if it cannot be valued. */
  priceMicroUsd: bigint | undefined;
  assetSymbol: string;
  route: 'direct' | 'swap';
  swap?: { sourceSymbol: string; notionalMicroUsd: bigint | undefined };
  spentLast24hMicroUsd: bigint;
}

export interface PolicyResult {
  /** Rules that were checked, in plain words (shown in every plan). */
  applied: string[];
  /** Hard blocks: execution is forbidden. */
  blocked: string[];
  /** Reasons a human must approve. */
  approvalReasons: string[];
}

export function evaluatePolicy(input: SpendInput, policy: SpendingPolicy): PolicyResult {
  const applied: string[] = [];
  const blocked: string[] = [];
  const approvalReasons: string[] = [];
  const a = assessService(input.service, policy);

  applied.push(`host must be one of: ${policy.allowedHosts.join(', ')}`);
  if (!a.contactable) blocked.push(...a.reasons);

  applied.push(`payment asset must be one of: ${policy.allowedPaymentAssets.join(', ')}`);
  if (!policy.allowedPaymentAssets.includes(input.assetSymbol)) {
    blocked.push(`asset ${input.assetSymbol} is not permitted for payments`);
  }

  applied.push(`max per payment: ${formatUsd(policy.maxPerPaymentMicroUsd)}`);
  applied.push(`max per rolling 24h: ${formatUsd(policy.maxPerDayMicroUsd)} (already spent: ${formatUsd(input.spentLast24hMicroUsd)})`);
  if (input.priceMicroUsd === undefined) {
    blocked.push('the price cannot be valued in USD, so limits cannot be enforced');
  } else {
    if (input.priceMicroUsd > policy.maxPerPaymentMicroUsd) {
      blocked.push(`price ${formatUsd(input.priceMicroUsd)} exceeds the per-payment limit ${formatUsd(policy.maxPerPaymentMicroUsd)}`);
    }
    if (input.spentLast24hMicroUsd + input.priceMicroUsd > policy.maxPerDayMicroUsd) {
      blocked.push(
        `price ${formatUsd(input.priceMicroUsd)} would take 24h spending to ${formatUsd(input.spentLast24hMicroUsd + input.priceMicroUsd)}, above ${formatUsd(policy.maxPerDayMicroUsd)}`,
      );
    }
    applied.push(`payments above ${formatUsd(policy.requireApprovalAboveMicroUsd)} need human approval`);
    if (input.priceMicroUsd > policy.requireApprovalAboveMicroUsd) {
      approvalReasons.push(`price ${formatUsd(input.priceMicroUsd)} is above the no-approval threshold`);
    }
  }

  applied.push(`auto-pay only for: ${policy.autoPayServiceIds.join(', ') || '(none)'}`);
  if (!policy.autoPayServiceIds.includes(input.service.id)) {
    approvalReasons.push(`service "${input.service.id}" is not on the auto-pay allow-list`);
  }

  if (input.route === 'swap') {
    applied.push(`swap sources must be one of: ${policy.allowedSwapSources.join(', ')}`);
    applied.push(`max value through a swap: ${formatUsd(policy.maxSwapNotionalMicroUsd)}`);
    if (input.swap && !policy.allowedSwapSources.includes(input.swap.sourceSymbol)) {
      blocked.push(`${input.swap.sourceSymbol} is not a permitted swap source`);
    }
    if (input.swap?.notionalMicroUsd === undefined) {
      blocked.push('the swap value cannot be determined, so the swap limit cannot be enforced');
    } else if (input.swap.notionalMicroUsd > policy.maxSwapNotionalMicroUsd) {
      blocked.push(
        `swap value ${formatUsd(input.swap.notionalMicroUsd)} exceeds the swap limit ${formatUsd(policy.maxSwapNotionalMicroUsd)}`,
      );
    }
    if (policy.requireApprovalForSwap) {
      applied.push('swaps require human approval');
      approvalReasons.push('policy requires human approval for any currency conversion');
    }
  }

  return { applied, blocked, approvalReasons };
}
