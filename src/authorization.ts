// An ExecutionAuthorization is the ONLY thing the executor accepts. It binds a payment to one exact
// request (URL + body hash), one recipient, one asset and one amount, with an expiry.
//
// mintAuthorization() must only be called from planner.ts (authorizeExecution). A test enforces that,
// so there is no code path that pays without a plan that passed policy.
import type { Address } from 'viem';

export interface ExecutionAuthorization {
  readonly planId: string;
  readonly route: 'direct';
  readonly serviceId: string;
  readonly method: 'POST';
  readonly url: string;
  /** sha256 of the exact request body that was priced. A different body is a different price. */
  readonly bodyHash: string;
  readonly payment: {
    readonly network: 'celo';
    readonly chainId: number;
    readonly asset: Address;
    readonly symbol: string;
    readonly payTo: Address;
    readonly amountAtomic: bigint;
  };
  /** Hard ceiling passed to the payment client; never above policy. */
  readonly maxAmountAtomic: bigint;
  readonly payer: Address;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** Who approved: 'policy:auto' or 'human:<how>'. */
  readonly approvedBy: string;
}

/**
 * A SwapAuthorization permits ONE firm-quote request and the validated transaction sequence that follows,
 * for exactly this plan. It is minted only by planner.ts (authorizeSwap). A second, separate gate
 * (BroadcastAuthorization, swapexec.ts) is required after the real quote has been seen and simulated.
 */
export interface SwapAuthorization {
  readonly planId: string;
  readonly route: 'swap';
  readonly serviceId: string;
  readonly payer: Address;
  readonly chainId: number;
  /** Which conversion venue this authorization is for (e.g. 'textile-fx-v2', 'mento-router-v3'). */
  readonly provider: string;
  readonly sell: {
    readonly asset: Address;
    readonly symbol: string;
    readonly decimals: number;
    /** Exact input amount that will be requested (atomic). */
    readonly sellAmountAtomic: bigint;
    /** The firm quote may not debit more than this. */
    readonly maxTakerPaysAtomic: bigint;
  };
  readonly buy: {
    readonly asset: Address;
    readonly symbol: string;
    /** The firm quote must deliver at least this (the service price). */
    readonly minBuyAtomic: bigint;
    /** What the preview suggested; the firm quote may not be materially worse. */
    readonly expectedBuyAtomic: bigint;
  };
  readonly slippageBps: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly approvedBy: string;
}

const minted = new WeakSet<object>();
const mintedSwap = new WeakSet<object>();

/** Internal: called only by planner.ts. */
export function mintSwapAuthorization(a: SwapAuthorization): SwapAuthorization {
  const frozen = Object.freeze({ ...a, sell: Object.freeze({ ...a.sell }), buy: Object.freeze({ ...a.buy }) });
  mintedSwap.add(frozen);
  return frozen;
}

export function isSwapAuthorized(value: unknown): value is SwapAuthorization {
  return typeof value === 'object' && value !== null && mintedSwap.has(value);
}

/** Internal: called only by planner.ts. */
export function mintAuthorization(a: ExecutionAuthorization): ExecutionAuthorization {
  const frozen = Object.freeze({ ...a, payment: Object.freeze({ ...a.payment }) });
  minted.add(frozen);
  return frozen;
}

export function isAuthorized(value: unknown): value is ExecutionAuthorization {
  return typeof value === 'object' && value !== null && minted.has(value);
}
