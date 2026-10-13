// Firm-quote validation and transaction-sequence construction for a swap. PURE functions: no network.
//
// Principle: a quote is data from a third party. Nothing in it is executed until it has been checked
// against (a) the authorization that was granted, (b) an explicit allow-list of contracts and shapes, and
// (c) the verified reactor ABI. Anything unrecognised is REJECTED, never "best effort".
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { assetByAddress } from './assets.ts';
import type { Asset } from './assets.ts';
import { withTag, assertTagged } from './attribution.ts';
import type { SwapAuthorization } from './authorization.ts';
import { TEXTILE_PREFERRED_FILLER, TEXTILE_REACTOR } from './config.ts';
import { EXECUTE_BATCH_SELECTOR, EXECUTE_SELECTOR, decodeLimitOrder, decodeSwapOrders } from './reactor.ts';
import type { DecodedLimitOrder } from './reactor.ts';
import type { FirmQuoteResult, Instruction } from './textile.ts';
import { toDataSuffix } from '@celo/attribution-tags';

export type QuotedSwap = Extract<FirmQuoteResult, { kind: 'quoted' }>;

export interface ValidationContext {
  nowMs: number;
  chainId: number;
  /** Minimum time that must remain before expiresAt for the sequence to be attempted. */
  minRemainingMs: number;
  /** Maximum protocol fee as basis points of takerPays (sanity bound, not a pricing claim). */
  maxFeeBps: number;
}

export interface QuoteValidation {
  ok: boolean;
  /** 'EXPIRED' is distinguished because it is a normal, retryable-by-replanning outcome. */
  expired: boolean;
  problems: string[];
  /** Non-fatal observations (e.g. a field the docs did not guarantee was absent). */
  notes: string[];
  expiresAtMs: number | undefined;
  decoded: { order: DecodedLimitOrder | undefined; approveSpender: Address | undefined; approveAmount: bigint | undefined };
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Parse an API timestamp. Accepts ISO strings and epoch seconds/milliseconds. Returns ms or undefined. */
export function parseDeadlineMs(v: unknown): number | undefined {
  if (typeof v === 'string' && v.length > 0) {
    if (/^\d+$/.test(v)) return parseDeadlineMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  return undefined;
}

function checkInstruction(label: string, ins: Instruction, ctx: ValidationContext, problems: string[]) {
  if (ins.chainId !== ctx.chainId) problems.push(`${label}: chainId ${ins.chainId} is not ${ctx.chainId}`);
  if (ins.value !== '0') problems.push(`${label}: value ${JSON.stringify(ins.value)} is not "0"`);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(ins.data) || ins.data.length < 10) problems.push(`${label}: calldata is not valid hex`);
}

export function validateFirmQuote(auth: SwapAuthorization, q: QuotedSwap, ctx: ValidationContext): QuoteValidation {
  const problems: string[] = [];
  const notes: string[] = [];
  const decoded: QuoteValidation['decoded'] = { order: undefined, approveSpender: undefined, approveAmount: undefined };

  // identity
  if (!q.id) problems.push('quote has no id');
  if (!eq(q.taker, auth.payer)) problems.push(`quote taker ${q.taker} is not the authorized wallet`);
  if (!eq(q.reactor, TEXTILE_REACTOR)) problems.push(`quote reactor ${q.reactor} is not the verified Textile reactor`);
  if (q.spender === undefined) {
    // The Textile docs say "approve takerPays to quote.reactor"; only the OpenAPI schema adds `spender`
    // (for vault-routed fills). Absent means an ordinary quote: the reactor is the spender, and the
    // approval/swap targets below are still checked against the reactor.
    notes.push('quote did not state a spender; using the reactor, as the Textile docs specify');
  } else if (!eq(q.spender, q.reactor)) {
    problems.push(`quote routes through ${q.spender}, not the reactor (vault-routed fills are not supported)`);
  }
  if (q.ordersCount !== 1) problems.push(`quote contains ${q.ordersCount} orders (bundles are not supported)`);

  // amounts
  if (q.sellAmount !== auth.sell.sellAmountAtomic) {
    problems.push(`quote sellAmount ${q.sellAmount} differs from the authorized input ${auth.sell.sellAmountAtomic}`);
  }
  if (q.takerPays > auth.sell.maxTakerPaysAtomic) {
    problems.push(`takerPays ${q.takerPays} exceeds the authorized maximum ${auth.sell.maxTakerPaysAtomic}`);
  }
  if (q.takerPays > q.sellAmount) problems.push(`takerPays ${q.takerPays} exceeds the requested sellAmount ${q.sellAmount}`);
  if (q.sellAmount - q.takerPays > 2n) problems.push('takerPays is more than 2 atomic units below sellAmount (unexpected)');
  if (q.buyAmount < auth.buy.minBuyAtomic) {
    problems.push(`buyAmount ${q.buyAmount} is below the service price ${auth.buy.minBuyAtomic}`);
  }
  const floor = (auth.buy.expectedBuyAtomic * BigInt(10_000 - auth.slippageBps)) / 10_000n;
  if (q.buyAmount < floor) {
    problems.push(`buyAmount ${q.buyAmount} is worse than the preview ${auth.buy.expectedBuyAtomic} by more than ${auth.slippageBps} bps`);
  }
  if (q.feeAmount * 10_000n > q.takerPays * BigInt(ctx.maxFeeBps)) {
    problems.push(`fee ${q.feeAmount} exceeds ${ctx.maxFeeBps} bps of takerPays`);
  }

  // expiry
  const expiresAtMs = parseDeadlineMs(q.deadlines.expiresAt);
  let expired = false;
  if (expiresAtMs === undefined) problems.push('quote has no usable expiresAt');
  else if (expiresAtMs <= ctx.nowMs) {
    expired = true;
    problems.push('quote has already expired');
  } else if (expiresAtMs - ctx.nowMs < ctx.minRemainingMs) {
    expired = true;
    problems.push(`only ${expiresAtMs - ctx.nowMs} ms remain, below the ${ctx.minRemainingMs} ms needed to act`);
  }

  // transactions
  checkInstruction('approval', q.approval, ctx, problems);
  checkInstruction('swap', q.swap, ctx, problems);

  if (!eq(q.approval.to, auth.sell.asset)) problems.push(`approval targets ${q.approval.to}, not the sell token ${auth.sell.asset}`);
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: q.approval.data });
    if (d.functionName !== 'approve') problems.push(`approval calldata calls ${d.functionName}, not approve`);
    else {
      const [spender, amount] = d.args as readonly [Address, bigint];
      decoded.approveSpender = getAddress(spender);
      decoded.approveAmount = amount;
      if (q.spender !== undefined && !eq(spender, q.spender)) problems.push(`approval spender ${spender} is not the quote spender`);
      if (amount !== q.takerPays) problems.push(`approval amount ${amount} is not exactly takerPays ${q.takerPays} (no unlimited approvals)`);
    }
  } catch {
    problems.push('approval calldata could not be decoded as an ERC-20 call');
  }

  if (q.spender !== undefined && !eq(q.swap.to, q.spender)) problems.push(`swap targets ${q.swap.to}, not the quote spender ${q.spender}`);
  if (!eq(q.swap.to, TEXTILE_REACTOR)) problems.push(`swap targets ${q.swap.to}, which is not the verified Textile reactor`);
  const selector = q.swap.data.slice(0, 10).toLowerCase();
  if (selector !== EXECUTE_SELECTOR.toLowerCase() && selector !== EXECUTE_BATCH_SELECTOR.toLowerCase()) {
    problems.push(`swap selector ${q.swap.data.slice(0, 10)} is neither execute(SignedOrder) nor executeBatch(SignedOrder[])`);
  } else {
    try {
      const orders = decodeSwapOrders(q.swap.data);
      if (orders.length !== 1) {
        problems.push(`swap carries ${orders.length} orders; only a single-order swap is supported`);
        return { ok: false, expired, problems, notes, expiresAtMs, decoded };
      }
      const ex = orders[0]!;
      if (q.encodedOrder !== undefined && ex.order.toLowerCase() !== q.encodedOrder.toLowerCase()) {
        problems.push('swap calldata carries a different order than the quote returned');
      }
      const o = decodeLimitOrder(ex.order);
      decoded.order = o;
      if (!eq(o.reactor, TEXTILE_REACTOR)) problems.push(`order targets reactor ${o.reactor}`);
      if (eq(o.swapper, auth.payer)) problems.push('order swapper is the taker (expected the maker)');
      if (!eq(o.input.token, auth.buy.asset)) problems.push(`order delivers ${o.input.token}, not the expected buy token ${auth.buy.asset}`);
      if (o.input.amount !== q.buyAmount) problems.push(`order delivers ${o.input.amount}, not the quoted buyAmount ${q.buyAmount}`);
      if (o.outputs.length === 0) problems.push('order has no outputs');
      let paid = 0n;
      for (const out of o.outputs) {
        if (!eq(out.token, auth.sell.asset)) problems.push(`order charges ${out.token}, not the sell token ${auth.sell.asset}`);
        paid += out.amount;
      }
      if (paid > q.takerPays) problems.push(`order outputs total ${paid}, above takerPays ${q.takerPays}`);
      if (o.deadline * 1000n <= BigInt(ctx.nowMs)) problems.push('order deadline has passed');
      if (o.validationContract !== '0x0000000000000000000000000000000000000000') {
        if (!eq(o.validationContract, TEXTILE_PREFERRED_FILLER)) {
          problems.push(`order has an additional validation contract ${o.validationContract} that is not the verified PreferredFillerValidation`);
        } else {
          // PreferredFillerValidation can only restrict WHO may fill. Check it names this wallet.
          try {
            const [fillers, until] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint256' }], o.validationData);
            if (fillers.length === 0 || fillers.length > 10) problems.push(`validation data lists ${fillers.length} preferred fillers (expected 1..10)`);
            const exclusive = until * 1000n > BigInt(ctx.nowMs);
            if (exclusive && !fillers.some((f) => eq(f, auth.payer))) {
              problems.push('the order is exclusive to other fillers; this wallet would be refused on-chain');
            }
            notes.push(`order restricts fillers (PreferredFillerValidation): ${fillers.length} preferred, exclusive until ${new Date(Number(until) * 1000).toISOString()}`);
          } catch {
            problems.push('the order validation data could not be decoded as (address[], uint256)');
          }
        }
      }
    } catch {
      problems.push('swap calldata or order could not be decoded with the verified reactor ABI');
    }
  }

  return { ok: problems.length === 0, expired, problems, notes, expiresAtMs, decoded };
}

// ------------------------------------------------------------------ approvals that precede the quote

/**
 * Approval steps that need no quote: exactly the sell amount, to the verified reactor. Built BEFORE the
 * firm quote is requested so the approval is not squeezed into the quote's ~60 second window. A later
 * quote naming a different spender is rejected, which leaves only a harmless standing allowance.
 */
export function buildApprovalSteps(args: { auth: SwapAuthorization; currentAllowance: bigint; tag: string; spender?: Address }): SequencePlan {
  const { auth, currentAllowance, tag } = args;
  const spender = getAddress(args.spender ?? TEXTILE_REACTOR);
  const need = auth.sell.sellAmountAtomic;
  const asset = assetByAddress(auth.sell.asset);
  const steps: SequenceStep[] = [];
  const add = (kind: StepKind, data: Hex) => {
    const taggedData = withTag(data, tag);
    assertTagged(taggedData, tag);
    const suffix = toDataSuffix(tag);
    if (taggedData.slice(0, taggedData.length - (suffix.length - 2)).toLowerCase() !== data.toLowerCase()) {
      throw new Error('attribution suffix changed the underlying calldata');
    }
    const step: SequenceStep = Object.freeze({ kind, to: getAddress(auth.sell.asset), data, taggedData, value: 0n as const });
    validatedSteps.add(step);
    steps.push(step);
  };
  const approve = (amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  if (currentAllowance >= need) {
    return { steps, approvalRequired: false, resetRequired: false, reason: `existing allowance ${currentAllowance} already covers ${need}` };
  }
  const resetRequired = currentAllowance > 0n && (asset?.allowanceReset ?? 'unknown') !== 'not_required';
  if (resetRequired) add('approve_reset', approve(0n));
  add('approve', approve(need));
  return {
    steps,
    approvalRequired: true,
    resetRequired,
    reason: resetRequired
      ? `allowance ${currentAllowance} is below ${need} and ${asset?.symbol ?? 'the token'} must be reset to 0 first`
      : `allowance ${currentAllowance} is below ${need}`,
  };
}

// ------------------------------------------------------------------ single tagged step

/**
 * Build ONE validated, tagged step for a venue whose calldata the caller has already independently validated
 * (e.g. an AMM swap). The tag is appended with Celo's library, asserted, and proven to be the only difference.
 */
export function buildTaggedStep(kind: StepKind, to: Address, data: Hex, tag: string): SequenceStep {
  const taggedData = withTag(data, tag);
  assertTagged(taggedData, tag);
  const suffix = toDataSuffix(tag);
  if (taggedData.slice(0, taggedData.length - (suffix.length - 2)).toLowerCase() !== data.toLowerCase()) {
    throw new Error('attribution suffix changed the underlying calldata');
  }
  const step: SequenceStep = Object.freeze({ kind, to: getAddress(to), data, taggedData, value: 0n as const });
  validatedSteps.add(step);
  return step;
}

// ------------------------------------------------------------------ sequence

export type StepKind = 'approve_reset' | 'approve' | 'swap';

export interface SequenceStep {
  kind: StepKind;
  to: Address;
  /** Untagged calldata exactly as validated. */
  data: Hex;
  /** Calldata with the attribution suffix appended (and verified). This is what would be broadcast. */
  taggedData: Hex;
  value: 0n;
}

const validatedSteps = new WeakSet<object>();
export function isValidatedStep(x: unknown): x is SequenceStep {
  return typeof x === 'object' && x !== null && validatedSteps.has(x);
}

export interface SequencePlan {
  steps: SequenceStep[];
  approvalRequired: boolean;
  resetRequired: boolean;
  reason: string;
}

/**
 * Decide which transactions are needed and build them, tagged and verified.
 * The only constructor of validated steps: the chain adapter refuses anything else.
 */
export function buildSequence(args: {
  auth: SwapAuthorization;
  quote: QuotedSwap;
  currentAllowance: bigint;
  tag: string;
}): SequencePlan {
  const { auth, quote, currentAllowance, tag } = args;
  const asset: Asset | undefined = assetByAddress(auth.sell.asset);
  const need = quote.takerPays;
  const steps: SequenceStep[] = [];
  const add = (kind: StepKind, to: Address, data: Hex) => {
    const taggedData = withTag(data, tag); // throws unless exactly one correct tag is at the end
    assertTagged(taggedData, tag);
    // The suffix must be the ONLY difference: stripping it must return the original bytes exactly.
    const suffix = toDataSuffix(tag);
    if (taggedData.slice(0, taggedData.length - (suffix.length - 2)).toLowerCase() !== data.toLowerCase()) {
      throw new Error('attribution suffix changed the underlying calldata');
    }
    const step: SequenceStep = Object.freeze({ kind, to, data, taggedData, value: 0n as const });
    validatedSteps.add(step);
    steps.push(step);
  };
  const approve = (amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(quote.spender ?? quote.reactor), amount] });

  let approvalRequired = false;
  let resetRequired = false;
  let reason: string;
  if (currentAllowance >= need) {
    reason = `existing allowance ${currentAllowance} already covers ${need}; no approval needed`;
  } else {
    approvalRequired = true;
    // A non-zero, insufficient allowance must be zeroed first unless the token is known not to need it.
    resetRequired = currentAllowance > 0n && (asset?.allowanceReset ?? 'unknown') !== 'not_required';
    if (resetRequired) {
      add('approve_reset', getAddress(auth.sell.asset), approve(0n));
      reason = `allowance ${currentAllowance} is below ${need} and ${asset?.symbol ?? 'the token'} may need a reset to 0 first`;
    } else {
      reason = `allowance ${currentAllowance} is below ${need}`;
    }
    add('approve', getAddress(auth.sell.asset), approve(need));
  }
  add('swap', getAddress(quote.swap.to), quote.swap.data);
  return { steps, approvalRequired, resetRequired, reason };
}
