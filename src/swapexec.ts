// Swap execution: [approval] -> firm quote -> validation -> tagged-sequence simulation -> human confirmation
// -> journaled broadcast -> independent on-chain verification and balance reconciliation.
//
// GATES (none can be skipped; each is bound to the exact transactions it covers):
//   1. SwapAuthorization      minted by planner.authorizeSwap/authorizeConversion(); permits requesting ONE
//                             firm quote (a real side effect) and the validated sequence that follows.
//   2. Approval confirmation  (approvalPhase 'before-quote') a human confirms the exact approve transaction(s)
//                             BEFORE any quote exists, so a 60-second quote window is not spent waiting.
//   3. Swap confirmation      a human confirms the exact swap after the real quote has been validated and
//                             simulated. Minted here as a BroadcastAuthorization bound by a digest.
//
// A firm quote holds market-maker inventory and one of 4 concurrent quote slots until the signed order's
// deadline, and cancelling does not release it, so it is requested only after every cheaper check passed.
//
// Nothing here has run against a live mainnet fill: it is exercised by mocks only (test/swapexec.test.ts).
import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { assertTagged } from './attribution.ts';
import { isSwapAuthorized } from './authorization.ts';
import type { SwapAuthorization } from './authorization.ts';
import { TEXTILE_REACTOR } from './config.ts';
import { listPending } from './history.ts';
import { LockError, acquireLock } from './lock.ts';
import { checkSwapDailyCap, newSwapNotionalMicroUsd } from './swapjournal.ts';
import type { HeldLock, LockOptions } from './lock.ts';
import { loadSwapRecord, saveSwapRecord, newSwapRecord } from './swapjournal.ts';
import type { StepRecord, SwapRecord, SwapState } from './swapjournal.ts';
import type { AmmVenue } from './mento.ts';
import { buildApprovalSteps, buildSequence, buildTaggedStep, validateFirmQuote } from './swapquote.ts';
import type { SequencePlan, SequenceStep } from './swapquote.ts';
import type { FirmQuoteResult, RfqStatusView, Secret, TakerProof } from './textile.ts';

// ------------------------------------------------------------------ dependency interfaces (mockable)

export interface ChainReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  /** Price actually paid per gas unit, when the node reports it. */
  effectiveGasPrice?: bigint;
  transfers: Array<{ token: Address; from: Address; to: Address; value: bigint }>;
  fills: Array<{ reactor: Address; filler: Address; swapper: Address }>;
}
export interface MinedTx {
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
}
export type SimResult = { ok: true; returnData: Hex; gas: bigint | undefined } | { ok: false; error: string };

export interface SwapChain {
  chainId(): Promise<number>;
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** OPTIONAL. Balance as of a specific block: exact, and immune to a load-balanced node that lags. */
  tokenBalanceAt?(token: Address, owner: Address, blockNumber: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** OPTIONAL. Allowance as of a specific block (exact; immune to a lagging node). */
  allowanceAt?(token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint>;
  nativeBalance(owner: Address): Promise<bigint>;
  /** OPTIONAL. Native balance as of a specific block. */
  nativeBalanceAt?(owner: Address, blockNumber: bigint): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  simulate(call: { from: Address; to: Address; data: Hex }): Promise<SimResult>;
  /**
   * OPTIONAL. Simulate `call` as if `spender` already had `amount` allowance on `token` (a read-only state
   * override). Returns { unsupported: true } if the node or the token layout cannot do it.
   */
  simulateWithAllowance?(
    call: { from: Address; to: Address; data: Hex },
    allowance: { token: Address; owner: Address; spender: Address; amount: bigint },
  ): Promise<SimResult | { unsupported: true }>;
  /**
   * Sign locally (hash known BEFORE broadcast) and return a handle. Accepts only validated sequence steps.
   * Signing is the ONLY place a spending signature is produced.
   */
  prepare(step: SequenceStep, from: Address): Promise<{ hash: Hex; nonce: number; broadcast(): Promise<Hex> }>;
  getReceipt(hash: Hex): Promise<ChainReceipt | undefined>;
  getTransaction(hash: Hex): Promise<MinedTx | undefined>;
}

export interface SwapTextile {
  firmQuote(args: {
    chainId: number;
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    taker: Address;
    takerProof: TakerProof;
  }): Promise<FirmQuoteResult>;
  status(id: string, claim: Secret): Promise<RfqStatusView>;
  /** OPTIONAL. Release an abandoned quote's hold on maker inventory (does not free the quote slot). */
  cancel?(id: string, claim: Secret): Promise<void>;
}

export interface SwapLimits {
  /** Time that must remain on the quote when it is first inspected. */
  minRemainingMs: number;
  /** Time that must remain on the quote immediately before the swap is broadcast. */
  swapMinRemainingMs: number;
  maxFeeBps: number;
  receiptTimeoutMs: number;
  pollMs: number;
  statusPolls: number;
  gasSafetyPercent: bigint;
  /** ASSUMED gas units used before a measurement exists (flagged as an estimate everywhere). */
  assumedApproveGas: bigint;
  assumedSwapGas: bigint;
}

export const DEFAULT_SWAP_LIMITS: SwapLimits = {
  minRemainingMs: 20_000,
  swapMinRemainingMs: 5_000,
  maxFeeBps: 100,
  receiptTimeoutMs: 90_000,
  pollMs: 2_000,
  statusPolls: 5,
  gasSafetyPercent: 200n,
  assumedApproveGas: 100_000n,
  assumedSwapGas: 450_000n,
};

export interface SwapDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  chain: SwapChain;
  textile: SwapTextile;
  /** EIP-712 proof of wallet control. It cannot move funds. */
  takerProof(): Promise<TakerProof>;
  /** Wraps @celo/attribution-tags verifyTx. */
  verifyAttribution(hash: Hex): Promise<{ codes: string[]; schemaId: number } | null>;
  signer: Address;
  receiptDir: string;
  attributionTag: string;
  lock?: LockOptions;
  limits?: Partial<SwapLimits>;
  /** Cumulative USD value allowed through swaps in a rolling 24h (checked inside the lock). Omitted = not enforced here. */
  dailySwapCapMicroUsd?: bigint;
  /**
   * 'with-quote'   (default) approvals happen after the quote, inside its window.
   * 'before-quote' approvals are confirmed and mined first, as their own step; the quote is requested only
   *                after the allowance is in place. Recommended for live use (the quote lives ~60 s).
   */
  approvalPhase?: 'with-quote' | 'before-quote';
  log?: (line: string) => void;
}

export interface ApprovalSummary {
  planId: string;
  token: string;
  spender: Address;
  amountAtomic: string;
  currentAllowanceAtomic: string;
  steps: Array<{ kind: string; to: Address }>;
  reason: string;
  simulations: SwapRecord['simulations'];
  gas: { estimatedCostWei: string; nativeBalanceWei: string };
  attributionTag: string;
  digest: string;
}

export interface SwapSummary {
  planId: string;
  sell: string;
  receive: string;
  fee: string;
  takerPays: string;
  /** Quoted output in atomic units (numeric, for automated bounds checks). */
  buyAmount: string;
  expiresAt: string;
  secondsRemaining: number;
  steps: Array<{ kind: string; to: Address }>;
  approvalRequired: boolean;
  resetRequired: boolean;
  sequenceReason: string;
  simulations: SwapRecord['simulations'];
  gas: { estimatedCostWei: string; nativeBalanceWei: string; basis: string };
  attributionTag: string;
  digest: string;
}

export type SwapOutcome =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'finished'; state: SwapState; record: SwapRecord };

// ------------------------------------------------------------------ broadcast gate

export interface BroadcastAuthorization {
  readonly planId: string;
  readonly quoteId: string;
  readonly digest: string;
  readonly approvedBy: string;
  readonly expiresAtMs: number;
}
const broadcastMinted = new WeakSet<object>();
/** Internal: only runSwap() calls this, after human confirmation of the exact sequence. */
function mintBroadcastAuthorization(b: BroadcastAuthorization): BroadcastAuthorization {
  const f = Object.freeze({ ...b });
  broadcastMinted.add(f);
  return f;
}
const isBroadcastAuthorized = (v: unknown): v is BroadcastAuthorization =>
  typeof v === 'object' && v !== null && broadcastMinted.has(v);

export function sequenceDigest(quoteId: string, takerPays: bigint, steps: readonly SequenceStep[]): string {
  const canonical = JSON.stringify({ quoteId, takerPays: takerPays.toString(), steps: steps.map((s) => [s.kind, s.to.toLowerCase(), s.taggedData.toLowerCase()]) });
  return createHash('sha256').update(canonical).digest('hex');
}

// ------------------------------------------------------------------ helpers

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 240);

async function waitForReceipt(chain: SwapChain, hash: Hex, d: SwapDeps, lim: SwapLimits): Promise<ChainReceipt | undefined> {
  const deadline = d.now() + lim.receiptTimeoutMs;
  for (;;) {
    let r: ChainReceipt | undefined;
    try {
      r = await chain.getReceipt(hash);
    } catch {
      r = undefined;
    }
    if (r) return r;
    if (d.now() >= deadline) return undefined;
    await d.sleep(lim.pollMs);
  }
}

/**
 * A post-transaction balance read. A load-balanced RPC can answer from a node that has not seen the block yet,
 * which looks exactly like "nothing changed" (this happened on the first live swap). So read AT the receipt's
 * block when the chain supports it, and otherwise re-read a few times until the balance moves off its
 * pre-transaction value.
 */
async function readAfter(deps: SwapDeps, lim: SwapLimits, token: Address, owner: Address, receipt: ChainReceipt, before: bigint): Promise<bigint | undefined> {
  let last: bigint | undefined;
  for (let i = 0; i < 6; i++) {
    try {
      last = deps.chain.tokenBalanceAt ? await deps.chain.tokenBalanceAt(token, owner, receipt.blockNumber) : await deps.chain.tokenBalance(token, owner);
      if (deps.chain.tokenBalanceAt || last !== before) return last;
    } catch {
      last = undefined;
    }
    await deps.sleep(Math.min(lim.pollMs, 1_000));
  }
  return last;
}

/** Native balance AFTER a transaction: exact-block when available, else a plain read. */
async function readNativeAfter(deps: SwapDeps, owner: Address, receipt: ChainReceipt): Promise<bigint | undefined> {
  try {
    return deps.chain.nativeBalanceAt ? await deps.chain.nativeBalanceAt(owner, receipt.blockNumber) : await deps.chain.nativeBalance(owner);
  } catch {
    return undefined;
  }
}

/** Allowance AFTER a transaction (the standing approval, if any), exact-block when available. */
async function readAllowanceAfter(deps: SwapDeps, token: Address, owner: Address, spender: Address, receipt: ChainReceipt): Promise<bigint | undefined> {
  try {
    return deps.chain.allowanceAt ? await deps.chain.allowanceAt(token, owner, spender, receipt.blockNumber) : await deps.chain.allowance(token, owner, spender);
  } catch {
    return undefined;
  }
}

type Verdict = 'identical' | 'tagged_failed' | 'outputs_differ' | 'only_untagged_failed';
function verdictOf(u: SimResult, t: SimResult): Verdict {
  if (!t.ok) return 'tagged_failed';
  if (!u.ok) return 'only_untagged_failed';
  return u.returnData === t.returnData ? 'identical' : 'outputs_differ';
}
const showSim = (r: SimResult) => (r.ok ? `ok:${r.returnData.slice(0, 18)}` : `fail:${r.error.slice(0, 80)}`);

async function simulateBoth(chain: SwapChain, from: Address, step: SequenceStep) {
  const u = await chain.simulate({ from, to: step.to, data: step.data });
  const t = await chain.simulate({ from, to: step.to, data: step.taggedData });
  return { verdict: verdictOf(u, t), tagged: showSim(t), untagged: showSim(u), gas: t.ok ? t.gas : undefined };
}

// ------------------------------------------------------------------ shared step executor

export interface StepEnv {
  deps: SwapDeps;
  lim: SwapLimits;
  rec: SwapRecord;
  lock: HeldLock;
  payer: Address;
  persist(): void;
  end(state: SwapState, code: string, message: string): SwapOutcome;
}

/**
 * Sign, journal-before-broadcast, broadcast and independently verify ONE validated, tagged step.
 * Shared by every conversion venue so they all get identical safety behavior.
 */
export function createStepExecutor(env: StepEnv) {
  const { deps, lim, rec, lock, persist, end } = env;
  let gasUnits = 0n;
  let gasCost = 0n;
  let gasCostKnown = true;
      return async (step: SequenceStep): Promise<{ ok: true; receipt: ChainReceipt } | { ok: false; outcome: SwapOutcome }> => {
        const isSwap = step.kind === 'swap';
        const fail = (state: SwapState, code: string, message: string) => ({ ok: false as const, outcome: end(state, code, message) });
        try {
          lock.assertHeld();
        } catch (e) {
          return fail(rec.fundsMayHaveMoved ? 'UNCERTAIN' : 'FAILED', 'LOCK_LOST', msg(e));
        }
        try {
          assertTagged(step.taggedData, deps.attributionTag);
        } catch (e) {
          return fail(rec.fundsMayHaveMoved ? 'UNCERTAIN' : 'FAILED', 'TAG_MISSING', `refusing to sign: ${msg(e)}`);
        }
        const stepRec: StepRecord = { kind: step.kind, to: step.to, hash: undefined, nonce: undefined, status: 'prepared', attribution: undefined, gasUsed: undefined };
        rec.steps.push(stepRec);
        let prepared: { hash: Hex; nonce: number; broadcast(): Promise<Hex> };
        try {
          prepared = await deps.chain.prepare(step, env.payer);
        } catch (e) {
          return fail(rec.fundsMayHaveMoved ? 'UNCERTAIN' : 'FAILED', 'SIGN_FAILED', `could not prepare/sign the ${step.kind} transaction: ${msg(e)}. Nothing from this step was sent.`);
        }
        stepRec.hash = prepared.hash;
        stepRec.nonce = prepared.nonce;
        rec.state = 'SUBMITTED';
        rec.code = 'SUBMITTED';
        rec.message = `${step.kind} signed; hash recorded before broadcast`;
        if (isSwap) rec.fundsMayHaveMoved = true;
        try {
          persist(); // hash + nonce are durable BEFORE the bytes leave the machine
        } catch (e) {
          return fail('FAILED', 'JOURNAL_UNAVAILABLE', `cannot record the transaction hash; refusing to broadcast: ${msg(e)}`);
        }
        try {
          await prepared.broadcast();
          stepRec.status = 'broadcast';
          persist();
        } catch (e) {
          // The node may or may not have accepted it. NEVER treat this as a retryable failure.
          stepRec.status = 'unknown';
          return fail('UNCERTAIN', 'BROADCAST_UNCERTAIN', `the ${step.kind} broadcast did not return cleanly (${msg(e)}); it may have been accepted. Check hash ${prepared.hash}. Do not retry.`);
        }
  
        const receipt = await waitForReceipt(deps.chain, prepared.hash, deps, lim);
        if (!receipt) {
          return fail('UNCERTAIN', 'RECEIPT_TIMEOUT', `no receipt for the ${step.kind} transaction ${prepared.hash} within ${lim.receiptTimeoutMs} ms; it may still confirm. Do not retry.`);
        }
        stepRec.gasUsed = receipt.gasUsed.toString();
        gasUnits += receipt.gasUsed;
        if (receipt.effectiveGasPrice !== undefined) gasCost += receipt.gasUsed * receipt.effectiveGasPrice;
        else gasCostKnown = false;
        rec.gas = {
          usedUnits: gasUnits.toString(),
          costWei: gasCostKnown ? gasCost.toString() : undefined,
          note: gasCostKnown ? 'gasUsed x effectiveGasPrice from the receipts' : 'effective gas price not reported by the node; cost unknown',
        };
        if (receipt.status === 'reverted') {
          stepRec.status = 'reverted';
          return fail('FAILED', isSwap ? 'SWAP_REVERTED' : 'APPROVAL_REVERTED', `the ${step.kind} transaction ${prepared.hash} reverted on-chain.`);
        }
        stepRec.status = 'mined';
  
        // the mined transaction must be exactly what we signed
        const mined = await deps.chain.getTransaction(prepared.hash).catch(() => undefined);
        if (!mined || mined.input.toLowerCase() !== step.taggedData.toLowerCase() || !mined.to || !eq(mined.to, step.to) || !eq(mined.from, env.payer) || mined.value !== 0n) {
          return fail('UNCERTAIN', 'MINED_TX_MISMATCH', `the mined ${step.kind} transaction ${prepared.hash} does not match what was signed; inspect it manually.`);
        }
        // attribution evidence: only claim what verifyTx actually shows
        const a = await deps.verifyAttribution(prepared.hash).catch(() => null);
        const verified = a !== null && a.codes.length === 1 && a.codes[0] === deps.attributionTag;
        stepRec.attribution = {
          verified,
          codes: a?.codes ?? null,
          note: verified ? 'verifyTx found exactly the official tag' : a === null ? 'verifyTx found no attribution' : `verifyTx found ${JSON.stringify(a.codes)}`,
        };
        return { ok: true, receipt };
      };
}

// ------------------------------------------------------------------ main entry

export interface SwapGates {
  /** Confirms the exact SWAP after the real quote was validated and simulated. */
  confirm(summary: SwapSummary): Promise<{ approved: boolean; approvedBy?: string }>;
  /** Confirms the exact APPROVAL transaction(s) (required when approvalPhase is 'before-quote' and one is needed). */
  confirmApproval?(summary: ApprovalSummary): Promise<{ approved: boolean; approvedBy?: string }>;
}

/**
 * Run a Textile firm-quote swap. If the quote ends up abandoned (rejected, declined, or any stop before the
 * swap was sent), it is released with the venue on a best-effort basis so it stops holding maker inventory.
 * (The quote SLOT is held until the order deadline regardless; cancelling does not free it.)
 */
export async function runSwap(auth: SwapAuthorization, deps: SwapDeps, opts: SwapGates): Promise<SwapOutcome> {
  const holder: { quote?: { id: string; claim: Secret | undefined } } = {};
  const outcome = await runSwapCore(auth, deps, opts, holder);
  const q = holder.quote;
  if (outcome.kind === 'finished' && q?.claim && deps.textile.cancel && (outcome.state === 'FAILED' || outcome.state === 'EXPIRED')) {
    const swapSent = outcome.record.steps.some((s) => s.kind === 'swap' && s.hash !== undefined);
    if (!swapSent) {
      const rec = outcome.record;
      const prior = rec.quote.textileStatusNote ? `${rec.quote.textileStatusNote} | ` : '';
      try {
        await deps.textile.cancel(q.id, q.claim);
        rec.quote.textileStatusNote = `${prior}abandoned quote released with the venue`;
      } catch (e) {
        rec.quote.textileStatusNote = `${prior}could not release the abandoned quote: ${msg(e)}`;
      }
      try {
        saveSwapRecord(deps.receiptDir, rec, new Date(deps.now()));
      } catch {
        /* the outcome stands; the note is informational */
      }
    }
  }
  return outcome;
}

async function runSwapCore(
  auth: SwapAuthorization,
  deps: SwapDeps,
  opts: SwapGates,
  holder: { quote?: { id: string; claim: Secret | undefined } },
): Promise<SwapOutcome> {
  const lim: SwapLimits = { ...DEFAULT_SWAP_LIMITS, ...(deps.limits ?? {}) };
  const log = deps.log ?? (() => undefined);
  const refuse = (code: string, message: string): SwapOutcome => ({ kind: 'refused', code, message });

  // ---- gate 1 and cheap, side-effect-free checks
  if (!isSwapAuthorized(auth)) return refuse('NOT_AUTHORIZED', 'no valid swap authorization from the planner');
  if (deps.now() > auth.expiresAtMs) return refuse('AUTHORIZATION_EXPIRED', 'the swap authorization has expired; plan again');
  if (!eq(deps.signer, auth.payer)) return refuse('PAYER_MISMATCH', 'the signing wallet is not the wallet that was planned');

  let lock: HeldLock;
  try {
    lock = await acquireLock(deps.receiptDir, deps.lock);
  } catch (e) {
    return e instanceof LockError ? refuse(e.code, e.message) : refuse('LOCK_UNAVAILABLE', msg(e));
  }

  try {
    // ---- a plan is single-use: a record for this planId (in any state) means it was already run
    try {
      if (loadSwapRecord(deps.receiptDir, auth.planId) !== undefined) {
        return refuse('ALREADY_EXECUTED', `plan ${auth.planId} has already been run; plan again for a new swap`);
      }
    } catch (e) {
      return refuse('GUARD_UNAVAILABLE', `cannot check whether this plan was already run: ${msg(e)}`);
    }

    // ---- anything unresolved (a pending payment or swap) blocks a new swap
    let pending: string[];
    try {
      pending = listPending(deps.receiptDir);
    } catch (e) {
      return refuse('GUARD_UNAVAILABLE', `cannot verify there is no unresolved payment or swap: ${msg(e)}`);
    }
    if (pending.length > 0) {
      return refuse('PENDING_UNRESOLVED', `an unresolved payment or swap exists (${pending[0]}); a human must resolve it first`);
    }

    // ---- cumulative daily swap cap, re-checked INSIDE the lock from the journals
    if (deps.dailySwapCapMicroUsd !== undefined) {
      const cap = checkSwapDailyCap(deps.receiptDir, {
        nowMs: deps.now(),
        addMicro: newSwapNotionalMicroUsd({ sell: auth.sell, buy: auth.buy }),
        capMicro: deps.dailySwapCapMicroUsd,
      });
      if (!cap.ok) return refuse(cap.code, cap.message);
    }

    // ---- environment checks
    let chainId: number;
    let sellBalance: bigint;
    let buyBefore: bigint;
    let native: bigint;
    let gasPrice: bigint;
    try {
      [chainId, sellBalance, buyBefore, native, gasPrice] = await Promise.all([
        deps.chain.chainId(),
        deps.chain.tokenBalance(auth.sell.asset, auth.payer),
        deps.chain.tokenBalance(auth.buy.asset, auth.payer),
        deps.chain.nativeBalance(auth.payer),
        deps.chain.gasPrice(),
      ]);
    } catch (e) {
      return refuse('CHAIN_UNREADABLE', `cannot read chain state: ${msg(e)}`);
    }
    if (chainId !== auth.chainId) return refuse('CHAIN_MISMATCH', `connected to chain ${chainId}, expected ${auth.chainId}`);
    if (sellBalance < auth.sell.sellAmountAtomic) {
      return refuse('INSUFFICIENT_BALANCE', `${auth.sell.symbol} balance ${sellBalance} is below the swap input ${auth.sell.sellAmountAtomic}`);
    }
    // worst case: reset + approve + swap, using ASSUMED gas units, before any measurement exists
    const worstGas = lim.assumedApproveGas * 2n + lim.assumedSwapGas;
    const gasNeed = (worstGas * gasPrice * lim.gasSafetyPercent) / 100n;
    if (native < gasNeed) {
      return refuse('INSUFFICIENT_GAS', `CELO balance ${native} wei is below the estimated worst-case gas ${gasNeed} wei (assumed ${worstGas} units)`);
    }

    // ---- start the record BEFORE any side effect
    const rec = newSwapRecord({
      planId: auth.planId,
      now: new Date(deps.now()),
      route: { sellSymbol: auth.sell.symbol, sellAsset: auth.sell.asset, buySymbol: auth.buy.symbol, buyAsset: auth.buy.asset, provider: auth.provider },
      requestedSell: auth.sell.sellAmountAtomic,
      minBuy: auth.buy.minBuyAtomic,
      tag: deps.attributionTag,
    });
    rec.balances.sellBefore = sellBalance.toString();
    rec.balances.buyBefore = buyBefore.toString();
    rec.balances.nativeBefore = native.toString();
    const persist = () => saveSwapRecord(deps.receiptDir, rec, new Date(deps.now()));
    const end = (state: SwapState, code: string, message: string): SwapOutcome => {
      rec.state = state;
      rec.code = code;
      rec.message = message;
      try {
        persist();
      } catch (e) {
        return { kind: 'finished', state: 'UNCERTAIN', record: { ...rec, state: 'UNCERTAIN', code: 'JOURNAL_WRITE_FAILED', message: `${message} (and the journal write failed: ${msg(e)})` } };
      }
      return { kind: 'finished', state, record: rec };
    };
    try {
      persist();
    } catch (e) {
      return refuse('JOURNAL_UNAVAILABLE', `cannot write the swap journal; nothing was requested: ${msg(e)}`);
    }

    // ---- shared: sign + journal + broadcast + verify ONE validated step
    const execStep = createStepExecutor({ deps, lim, rec, lock, payer: auth.payer, persist, end });

    const readAllowance = () => deps.chain.allowance(auth.sell.asset, auth.payer, TEXTILE_REACTOR).catch(() => undefined);

    // After an approval mines, the allowance must be read at (or after) the approval's own block: a load-balanced
    // RPC can answer "latest" from a node that has not seen that block yet and report the OLD value (observed live
    // 2026-10-14: a mined approval read back as 0). Exact-block read first; then a few bounded re-reads of latest.
    let lastApprovalBlock: bigint | undefined;
    const readAllowanceFresh = async (needed: bigint, minBlock: bigint | undefined): Promise<bigint | undefined> => {
      if (minBlock !== undefined && deps.chain.allowanceAt) {
        for (let i = 0; i < 4; i++) {
          try {
            return await deps.chain.allowanceAt(auth.sell.asset, auth.payer, TEXTILE_REACTOR, minBlock);
          } catch {
            await deps.sleep(500);
          }
        }
      }
      // No approval of ours is in play: a single plain read (waiting would only burn the quote's lifetime).
      if (minBlock === undefined) return readAllowance();
      // We sent an approval but cannot read at its block: bounded re-reads of 'latest' until it shows up.
      let v: bigint | undefined;
      for (let i = 0; i < 6; i++) {
        v = await readAllowance();
        if (v !== undefined && v >= needed) return v;
        await deps.sleep(800);
      }
      return v;
    };

    // ================= phase A (optional): approval BEFORE the quote =================
    if ((deps.approvalPhase ?? 'with-quote') === 'before-quote') {
      const current = await readAllowance();
      if (current === undefined) return end('FAILED', 'ALLOWANCE_UNREADABLE', 'cannot read the current allowance. Nothing was sent.');
      let pre: SequencePlan;
      try {
        pre = buildApprovalSteps({ auth, currentAllowance: current, tag: deps.attributionTag });
      } catch (e) {
        return end('FAILED', 'TAGGING_FAILED', `could not build a correctly tagged approval: ${msg(e)}. Nothing was sent (the tag is never dropped).`);
      }
      if (pre.approvalRequired) {
        let preGas = 0n;
        for (const step of pre.steps) {
          const s = await simulateBoth(deps.chain, auth.payer, step);
          rec.simulations.push({ step: `${step.kind} (before quote)`, tagged: s.tagged, untagged: s.untagged, verdict: s.verdict });
          if (s.verdict !== 'identical') {
            return end('FAILED', s.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `simulation of the ${step.kind} step: ${s.verdict} (tagged ${s.tagged}; untagged ${s.untagged}). Nothing was sent; the tag was not removed.`);
          }
          preGas += s.gas ?? lim.assumedApproveGas;
        }
        const preCost = ((preGas + lim.assumedSwapGas) * gasPrice * lim.gasSafetyPercent) / 100n;
        if (native < preCost) {
          return end('FAILED', 'INSUFFICIENT_GAS', `CELO ${native} wei is below the estimated gas ${preCost} wei for the approval and swap. Nothing was sent.`);
        }
        if (!opts.confirmApproval) {
          return end('FAILED', 'APPROVAL_CONFIRMATION_REQUIRED', 'an approval is needed but no approval confirmation was provided. Nothing was sent.');
        }
        const preDigest = sequenceDigest('pre-quote', auth.sell.sellAmountAtomic, pre.steps);
        rec.state = 'AWAITING_APPROVAL';
        rec.code = 'AWAITING_APPROVAL';
        rec.message = 'approval simulated; waiting for explicit confirmation of the exact approve transaction(s)';
        persist();
        let d1: { approved: boolean; approvedBy?: string };
        try {
          d1 = await opts.confirmApproval({
            planId: auth.planId,
            token: auth.sell.symbol,
            spender: TEXTILE_REACTOR,
            amountAtomic: auth.sell.sellAmountAtomic.toString(),
            currentAllowanceAtomic: current.toString(),
            steps: pre.steps.map((s) => ({ kind: s.kind, to: s.to })),
            reason: pre.reason,
            simulations: rec.simulations,
            gas: { estimatedCostWei: preCost.toString(), nativeBalanceWei: native.toString() },
            attributionTag: deps.attributionTag,
            digest: preDigest,
          });
        } catch (e) {
          return end('FAILED', 'CONFIRMATION_ERROR', `approval confirmation failed: ${msg(e)}. Nothing was sent.`);
        }
        if (!d1.approved) return end('FAILED', 'DECLINED', 'the human declined the approval; nothing was sent');
        const preAuth = mintBroadcastAuthorization({ planId: auth.planId, quoteId: 'pre-quote', digest: preDigest, approvedBy: d1.approvedBy ?? 'human:confirm', expiresAtMs: Number.MAX_SAFE_INTEGER });
        if (!isBroadcastAuthorized(preAuth) || sequenceDigest('pre-quote', auth.sell.sellAmountAtomic, pre.steps) !== preAuth.digest) {
          return end('FAILED', 'SEQUENCE_CHANGED', 'the approval sequence no longer matches what was approved; nothing was sent');
        }
        rec.approvedBy = preAuth.approvedBy;
        rec.state = 'READY_TO_EXECUTE';
        rec.code = 'READY_TO_EXECUTE';
        rec.message = 'approval confirmed; sending the approval transaction(s) before any quote is requested';
        persist();
        let approvalBlock: bigint | undefined;
        for (const step of pre.steps) {
          const r = await execStep(step);
          if (!r.ok) return r.outcome;
          approvalBlock = r.receipt.blockNumber;
        }
        lastApprovalBlock = approvalBlock;
        const after = await readAllowanceFresh(auth.sell.sellAmountAtomic, approvalBlock);
        rec.residualAllowance = after?.toString();
        if (after === undefined || after < auth.sell.sellAmountAtomic) {
          return end('FAILED', 'APPROVAL_INEFFECTIVE', 'the approval mined but the allowance is still insufficient (read at the approval block); no quote was requested');
        }
        rec.state = 'PLANNED';
        rec.code = 'APPROVED_BEFORE_QUOTE';
        rec.message = 'allowance is in place; requesting the firm quote next';
        persist();
      }
    }

    // ================= phase B: firm quote =================
    let quoteRes: FirmQuoteResult;
    try {
      const proof = await deps.takerProof();
      quoteRes = await deps.textile.firmQuote({
        chainId: auth.chainId,
        sellToken: auth.sell.asset,
        buyToken: auth.buy.asset,
        sellAmount: auth.sell.sellAmountAtomic,
        taker: auth.payer,
        takerProof: proof,
      });
    } catch (e) {
      return end('FAILED', 'QUOTE_REQUEST_ERROR', `the firm-quote request failed (${msg(e)}); a quote slot may still be held server-side. No swap transaction was sent.`);
    }
    if (quoteRes.kind === 'no_quote') {
      return end('FAILED', 'NO_QUOTE', `Textile returned no quote (${quoteRes.reason ?? 'no reason'}). No swap transaction was sent.`);
    }
    const quote = quoteRes;
    holder.quote = { id: quote.id, claim: quote.claimToken };
    rec.quote.id = quote.id;
    rec.amounts.takerPays = quote.takerPays.toString();
    rec.amounts.buy = quote.buyAmount.toString();
    rec.amounts.fee = quote.feeAmount.toString();

    const v = validateFirmQuote(auth, quote, {
      nowMs: deps.now(),
      chainId: auth.chainId,
      minRemainingMs: lim.minRemainingMs,
      maxFeeBps: lim.maxFeeBps,
    });
    rec.quote.expiresAt = v.expiresAtMs === undefined ? undefined : new Date(v.expiresAtMs).toISOString();
    rec.quote.deadlines = Object.fromEntries(Object.entries(quote.deadlines).map(([k, x]) => [k, String(x)]));
    if (v.notes.length > 0) rec.verification.notes.push(...v.notes);
    if (!v.ok) {
      return end(v.expired ? 'EXPIRED' : 'FAILED', v.expired ? 'QUOTE_EXPIRED' : 'QUOTE_INVALID', `quote rejected: ${v.problems.join('; ')}. No swap transaction was sent.`);
    }
    rec.state = 'QUOTED';
    rec.code = 'QUOTED';
    rec.message = 'firm quote validated against the authorization and the verified reactor interface';
    persist();

    // ---- build the tagged sequence from the CURRENT allowance (read at/after the last approval's block: a stale
    // 'latest' answer of 0 would otherwise trigger a redundant second approval)
    const allowance = await readAllowanceFresh(quote.takerPays, lastApprovalBlock);
    if (allowance === undefined) return end('FAILED', 'ALLOWANCE_UNREADABLE', 'cannot read the current allowance. No swap transaction was sent.');
    let seq: SequencePlan;
    try {
      seq = buildSequence({ auth, quote, currentAllowance: allowance, tag: deps.attributionTag });
    } catch (e) {
      return end('FAILED', 'TAGGING_FAILED', `could not build a correctly tagged sequence: ${msg(e)}. Nothing was sent (the tag is never dropped).`);
    }

    // ---- simulate the exact bytes that would be broadcast
    let totalGas = 0n;
    for (const step of seq.steps) {
      const isSwap = step.kind === 'swap';
      if (isSwap && seq.approvalRequired) {
        // The allowance does not exist yet. Try a read-only override; otherwise defer to post-approval.
        const sim = deps.chain.simulateWithAllowance;
        if (sim) {
          const ctxA = { token: auth.sell.asset, owner: auth.payer, spender: quote.reactor, amount: quote.takerPays };
          const u = await sim.call(deps.chain, { from: auth.payer, to: step.to, data: step.data }, ctxA);
          const t = await sim.call(deps.chain, { from: auth.payer, to: step.to, data: step.taggedData }, ctxA);
          if (!('unsupported' in u) && !('unsupported' in t)) {
            const verdict = verdictOf(u, t);
            rec.simulations.push({ step: 'swap (pre-approval, simulated allowance)', tagged: showSim(t), untagged: showSim(u), verdict });
            if (verdict !== 'identical') {
              return end('FAILED', verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `pre-approval simulation of the swap: ${verdict} (tagged ${showSim(t)}; untagged ${showSim(u)}). Nothing was sent; the tag was not removed.`);
            }
            totalGas += t.ok ? t.gas ?? lim.assumedSwapGas : lim.assumedSwapGas;
            continue;
          }
        }
        rec.simulations.push({ step: step.kind, tagged: 'deferred', untagged: 'deferred', verdict: 'deferred_until_allowance_exists' });
        totalGas += lim.assumedSwapGas;
        continue;
      }
      const s = await simulateBoth(deps.chain, auth.payer, step);
      rec.simulations.push({ step: step.kind, tagged: s.tagged, untagged: s.untagged, verdict: s.verdict });
      if (s.verdict !== 'identical') {
        return end('FAILED', s.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `simulation of the ${step.kind} step: ${s.verdict} (tagged ${s.tagged}; untagged ${s.untagged}). Nothing was sent; the tag was not removed.`);
      }
      totalGas += s.gas ?? (isSwap ? lim.assumedSwapGas : lim.assumedApproveGas);
    }
    const nativeNow = await deps.chain.nativeBalance(auth.payer).catch(() => native);
    const estCost = (totalGas * gasPrice * lim.gasSafetyPercent) / 100n;
    if (nativeNow < estCost) {
      return end('FAILED', 'INSUFFICIENT_GAS', `CELO ${nativeNow} wei is below the estimated gas ${estCost} wei for this sequence. No swap transaction was sent.`);
    }
    const digest = sequenceDigest(quote.id, quote.takerPays, seq.steps);

    // ================= gate 3: a human confirms the exact swap sequence =================
    rec.state = 'AWAITING_APPROVAL';
    rec.code = 'AWAITING_APPROVAL';
    rec.message = 'validated and simulated; waiting for explicit confirmation of the exact transactions';
    persist();
    const summary: SwapSummary = {
      planId: auth.planId,
      sell: `${quote.takerPays} atomic ${auth.sell.symbol} (${auth.sell.decimals} decimals)`,
      receive: `${quote.buyAmount} atomic ${auth.buy.symbol}`,
      fee: `${quote.feeAmount} atomic ${auth.sell.symbol} (included in the debit)`,
      takerPays: quote.takerPays.toString(),
      buyAmount: quote.buyAmount.toString(),
      expiresAt: rec.quote.expiresAt ?? 'unknown',
      secondsRemaining: Math.max(0, Math.floor(((v.expiresAtMs ?? 0) - deps.now()) / 1000)),
      steps: seq.steps.map((s) => ({ kind: s.kind, to: s.to })),
      approvalRequired: seq.approvalRequired,
      resetRequired: seq.resetRequired,
      sequenceReason: seq.reason,
      simulations: rec.simulations,
      gas: { estimatedCostWei: estCost.toString(), nativeBalanceWei: nativeNow.toString(), basis: 'simulation gas where available, otherwise ASSUMED units; x safety factor' },
      attributionTag: deps.attributionTag,
      digest,
    };
    let decision: { approved: boolean; approvedBy?: string };
    try {
      decision = await opts.confirm(summary);
    } catch (e) {
      return end('FAILED', 'CONFIRMATION_ERROR', `confirmation failed: ${msg(e)}. No swap transaction was sent.`);
    }
    if (!decision.approved) return end('FAILED', 'DECLINED', 'the human declined; no swap transaction was sent');
    const bauth = mintBroadcastAuthorization({
      planId: auth.planId,
      quoteId: quote.id,
      digest,
      approvedBy: decision.approvedBy ?? 'human:confirm',
      expiresAtMs: v.expiresAtMs ?? 0,
    });
    rec.approvedBy = bauth.approvedBy;
    rec.state = 'READY_TO_EXECUTE';
    rec.code = 'READY_TO_EXECUTE';
    rec.message = 'approved; about to sign and broadcast the approved sequence';
    persist();
    log(`broadcast authorized by ${bauth.approvedBy}`);

    // ---- execute exactly the approved sequence
    if (!isBroadcastAuthorized(bauth) || sequenceDigest(quote.id, quote.takerPays, seq.steps) !== bauth.digest) {
      return end('FAILED', 'SEQUENCE_CHANGED', 'the transaction sequence no longer matches what was approved; nothing was sent');
    }
    const textileStatusFor = async (): Promise<void> => {
      if (!quote.claimToken) {
        rec.quote.textileStatusNote = 'no claim token was returned, so Textile status could not be queried';
        return;
      }
      for (let i = 0; i < lim.statusPolls; i++) {
        try {
          const s = await deps.textile.status(quote.id, quote.claimToken);
          rec.quote.textileStatus = s.status;
          rec.quote.textileStatusNote = s.status === 'filled' ? 'Textile reports filled' : `Textile reports ${s.status}${s.failReason ? ` (${s.failReason})` : ''}`;
          if (s.status === 'filled') return;
        } catch (e) {
          rec.quote.textileStatusNote = `status query failed: ${msg(e)}`;
        }
        await deps.sleep(lim.pollMs);
      }
    };

    for (const step of seq.steps) {
      const isSwap = step.kind === 'swap';
      if (isSwap) {
        if (v.expiresAtMs !== undefined && deps.now() >= v.expiresAtMs - lim.swapMinRemainingMs) {
          rec.residualAllowance = (await readAllowance())?.toString();
          return end('EXPIRED', 'QUOTE_EXPIRED_BEFORE_SWAP', 'the quote expired before the swap could be sent; the approval (if any) remains. Nothing was swapped.');
        }
        const now = await readAllowanceFresh(quote.takerPays, lastApprovalBlock);
        rec.residualAllowance = now?.toString();
        if (now === undefined || now < quote.takerPays) {
          return end('FAILED', 'ALLOWANCE_INSUFFICIENT', 'the allowance does not cover the swap; nothing was swapped');
        }
        const s = await simulateBoth(deps.chain, auth.payer, step);
        rec.simulations.push({ step: 'swap (post-approval)', tagged: s.tagged, untagged: s.untagged, verdict: s.verdict });
        if (s.verdict !== 'identical') {
          return end(
            'FAILED',
            s.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR',
            `post-approval simulation of the swap: ${s.verdict} (tagged ${s.tagged}; untagged ${s.untagged}). The swap was NOT sent; the tag was not removed. An approval may remain on-chain.`,
          );
        }
      }
      const r = await execStep(step);
      if (!r.ok) return r.outcome;
      const receipt = r.receipt;

      if (!isSwap && step.kind === 'approve') {
        lastApprovalBlock = receipt.blockNumber;
        const after = await readAllowanceFresh(quote.takerPays, receipt.blockNumber);
        rec.residualAllowance = after?.toString();
        if (after === undefined || after < quote.takerPays) {
          return end('FAILED', 'APPROVAL_INEFFECTIVE', 'the approval mined but the allowance is still insufficient; the swap was not sent');
        }
      }

      if (isSwap) {
        // independent verification from logs and balances, not from the RPC call returning a hash
        const sellOut = receipt.transfers.filter((t) => eq(t.token, auth.sell.asset) && eq(t.from, auth.payer)).reduce((n, t) => n + t.value, 0n);
        const buyIn = receipt.transfers.filter((t) => eq(t.token, auth.buy.asset) && eq(t.to, auth.payer)).reduce((n, t) => n + t.value, 0n);
        const fill = receipt.fills.some((f) => eq(f.reactor, TEXTILE_REACTOR) && eq(f.filler, auth.payer));
        const [sellAfter, buyAfter, nativeAfter] = await Promise.all([
          readAfter(deps, lim, auth.sell.asset, auth.payer, receipt, sellBalance),
          readAfter(deps, lim, auth.buy.asset, auth.payer, receipt, buyBefore),
          readNativeAfter(deps, auth.payer, receipt),
        ]);
        rec.residualAllowance = (await readAllowanceAfter(deps, auth.sell.asset, auth.payer, quote.reactor, receipt))?.toString();
        rec.balances.sellAfter = sellAfter?.toString();
        rec.balances.buyAfter = buyAfter?.toString();
        rec.balances.nativeAfter = nativeAfter?.toString();
        rec.verification = {
          swapMined: true,
          sellDebited: sellOut.toString(),
          buyReceived: buyIn.toString(),
          fillEvent: fill,
          notes: [...rec.verification.notes],
        };
        // reconciliation: balance deltas must equal the logged transfers (we hold the lock; nothing else of ours moves)
        const sellDelta = sellAfter === undefined ? undefined : sellBalance - sellAfter;
        const buyDelta = buyAfter === undefined ? undefined : buyAfter - buyBefore;
        const reconciles = sellDelta !== undefined && buyDelta !== undefined && sellDelta === sellOut && buyDelta === buyIn;
        rec.verification.notes.push(`reconciliation: sell balance change ${sellDelta ?? 'unreadable'} vs logged ${sellOut}; buy balance change ${buyDelta ?? 'unreadable'} vs logged ${buyIn}`);

        const floor = (quote.buyAmount * BigInt(10_000 - auth.slippageBps)) / 10_000n;
        const effectsOk = fill && buyIn >= auth.buy.minBuyAtomic && buyIn >= floor && sellOut > 0n && sellOut <= quote.takerPays;
        if (!effectsOk) {
          return end('UNCERTAIN', 'VERIFICATION_MISMATCH', `the swap transaction succeeded but its effects do not match the quote (fill event ${fill}, received ${buyIn}, debited ${sellOut}); inspect it manually.`);
        }
        if (!reconciles) {
          return end('UNCERTAIN', 'RECONCILIATION_MISMATCH', 'the swap transaction and its logs look right, but the wallet balance changes do not equal the logged transfers; inspect the wallet manually.');
        }
        await textileStatusFor();
        return end('CONFIRMED', 'CONFIRMED', `swap confirmed on-chain: debited ${sellOut} ${auth.sell.symbol}, received ${buyIn} ${auth.buy.symbol}, balances reconciled. ${rec.quote.textileStatusNote ?? ''}`.trim());
      }
    }
    return end('FAILED', 'NO_SWAP_STEP', 'the sequence contained no swap step (internal error)');
  } finally {
    lock.release();
  }
}

// ================================================================== AMM venues (e.g. Mento)

/**
 * Convert on an on-chain AMM. There is no firm quote: the guard is `amountOutMin` inside the transaction, so it
 * reverts on-chain if the price has moved past the authorized floor. Same gates, journal, simulation of the exact
 * tagged bytes, and independent verification as runSwap().
 *
 *   authorization -> [approve: confirm, send, verify] -> live quote -> floor -> tagged swap bytes ->
 *   independent calldata check -> simulate tagged vs untagged -> confirm -> journaled broadcast -> verify
 *
 * Mock-tested only until it has run once on-chain.
 */
export async function runAmmSwap(
  auth: SwapAuthorization,
  venue: AmmVenue,
  deps: SwapDeps,
  opts: {
    confirm(summary: SwapSummary): Promise<{ approved: boolean; approvedBy?: string }>;
    confirmApproval?(summary: ApprovalSummary): Promise<{ approved: boolean; approvedBy?: string }>;
  },
): Promise<SwapOutcome> {
  const lim: SwapLimits = { ...DEFAULT_SWAP_LIMITS, ...(deps.limits ?? {}) };
  const log = deps.log ?? (() => undefined);
  const refuse = (code: string, message: string): SwapOutcome => ({ kind: 'refused', code, message });
  const DEADLINE_SEC = 300;

  if (!isSwapAuthorized(auth)) return refuse('NOT_AUTHORIZED', 'no valid swap authorization from the planner');
  if (deps.now() > auth.expiresAtMs) return refuse('AUTHORIZATION_EXPIRED', 'the authorization has expired; plan again');
  if (!eq(deps.signer, auth.payer)) return refuse('PAYER_MISMATCH', 'the signing wallet is not the wallet that was planned');
  if (auth.provider !== venue.name) return refuse('PROVIDER_MISMATCH', `authorization is for ${auth.provider}, not ${venue.name}`);

  let lock: HeldLock;
  try {
    lock = await acquireLock(deps.receiptDir, deps.lock);
  } catch (e) {
    return e instanceof LockError ? refuse(e.code, e.message) : refuse('LOCK_UNAVAILABLE', msg(e));
  }

  try {
    try {
      if (loadSwapRecord(deps.receiptDir, auth.planId) !== undefined) {
        return refuse('ALREADY_EXECUTED', `plan ${auth.planId} has already been run; plan again for a new conversion`);
      }
    } catch (e) {
      return refuse('GUARD_UNAVAILABLE', `cannot check whether this plan was already run: ${msg(e)}`);
    }
    let pending: string[];
    try {
      pending = listPending(deps.receiptDir);
    } catch (e) {
      return refuse('GUARD_UNAVAILABLE', `cannot verify there is no unresolved payment or swap: ${msg(e)}`);
    }
    if (pending.length > 0) {
      return refuse('PENDING_UNRESOLVED', `an unresolved payment or swap exists (${pending[0]}); a human must resolve it first`);
    }

    // ---- cumulative daily swap cap, re-checked INSIDE the lock from the journals
    if (deps.dailySwapCapMicroUsd !== undefined) {
      const cap = checkSwapDailyCap(deps.receiptDir, {
        nowMs: deps.now(),
        addMicro: newSwapNotionalMicroUsd({ sell: auth.sell, buy: auth.buy }),
        capMicro: deps.dailySwapCapMicroUsd,
      });
      if (!cap.ok) return refuse(cap.code, cap.message);
    }

    let chainId: number;
    let sellBalance: bigint;
    let buyBefore: bigint;
    let native: bigint;
    let gasPrice: bigint;
    try {
      [chainId, sellBalance, buyBefore, native, gasPrice] = await Promise.all([
        deps.chain.chainId(),
        deps.chain.tokenBalance(auth.sell.asset, auth.payer),
        deps.chain.tokenBalance(auth.buy.asset, auth.payer),
        deps.chain.nativeBalance(auth.payer),
        deps.chain.gasPrice(),
      ]);
    } catch (e) {
      return refuse('CHAIN_UNREADABLE', `cannot read chain state: ${msg(e)}`);
    }
    if (chainId !== auth.chainId) return refuse('CHAIN_MISMATCH', `connected to chain ${chainId}, expected ${auth.chainId}`);
    if (sellBalance < auth.sell.sellAmountAtomic) {
      return refuse('INSUFFICIENT_BALANCE', `${auth.sell.symbol} balance ${sellBalance} is below the swap input ${auth.sell.sellAmountAtomic}`);
    }
    const worstGas = lim.assumedApproveGas * 2n + lim.assumedSwapGas;
    const gasNeed = (worstGas * gasPrice * lim.gasSafetyPercent) / 100n;
    if (native < gasNeed) {
      return refuse('INSUFFICIENT_GAS', `CELO balance ${native} wei is below the estimated worst-case gas ${gasNeed} wei (assumed ${worstGas} units)`);
    }

    const rec = newSwapRecord({
      planId: auth.planId,
      now: new Date(deps.now()),
      route: { sellSymbol: auth.sell.symbol, sellAsset: auth.sell.asset, buySymbol: auth.buy.symbol, buyAsset: auth.buy.asset, provider: venue.name },
      requestedSell: auth.sell.sellAmountAtomic,
      minBuy: auth.buy.minBuyAtomic,
      tag: deps.attributionTag,
    });
    rec.balances.sellBefore = sellBalance.toString();
    rec.balances.buyBefore = buyBefore.toString();
    rec.balances.nativeBefore = native.toString();
    const persist = () => saveSwapRecord(deps.receiptDir, rec, new Date(deps.now()));
    const end = (state: SwapState, code: string, message: string): SwapOutcome => {
      rec.state = state;
      rec.code = code;
      rec.message = message;
      try {
        persist();
      } catch (e) {
        return { kind: 'finished', state: 'UNCERTAIN', record: { ...rec, state: 'UNCERTAIN', code: 'JOURNAL_WRITE_FAILED', message: `${message} (and the journal write failed: ${msg(e)})` } };
      }
      return { kind: 'finished', state, record: rec };
    };
    try {
      persist();
    } catch (e) {
      return refuse('JOURNAL_UNAVAILABLE', `cannot write the swap journal; nothing was sent: ${msg(e)}`);
    }
    const execStep = createStepExecutor({ deps, lim, rec, lock, payer: auth.payer, persist, end });
    const readAllowance = () => deps.chain.allowance(auth.sell.asset, auth.payer, venue.router).catch(() => undefined);

    // After an approval mines, the allowance must be read at (or after) the approval's own block: a load-balanced
    // RPC can answer "latest" from a node that has not seen that block yet and report the OLD value (observed live
    // 2026-10-14: a mined approval read back as 0). Exact-block read first; then a few bounded re-reads of latest.
    const readAllowanceFresh = async (needed: bigint, minBlock: bigint | undefined): Promise<bigint | undefined> => {
      if (minBlock !== undefined && deps.chain.allowanceAt) {
        for (let i = 0; i < 4; i++) {
          try {
            return await deps.chain.allowanceAt(auth.sell.asset, auth.payer, venue.router, minBlock);
          } catch {
            await deps.sleep(500);
          }
        }
      }
      // No approval of ours is in play: a single plain read (waiting would only burn the quote's lifetime).
      if (minBlock === undefined) return readAllowance();
      // We sent an approval but cannot read at its block: bounded re-reads of 'latest' until it shows up.
      let v: bigint | undefined;
      for (let i = 0; i < 6; i++) {
        v = await readAllowance();
        if (v !== undefined && v >= needed) return v;
        await deps.sleep(800);
      }
      return v;
    };

    // ---------------- approval (its own confirmed step; an AMM quote does not expire like a firm quote)
    const current = await readAllowance();
    if (current === undefined) return end('FAILED', 'ALLOWANCE_UNREADABLE', 'cannot read the current allowance. Nothing was sent.');
    let pre: SequencePlan;
    try {
      pre = buildApprovalSteps({ auth, currentAllowance: current, tag: deps.attributionTag, spender: venue.router });
    } catch (e) {
      return end('FAILED', 'TAGGING_FAILED', `could not build a correctly tagged approval: ${msg(e)}. Nothing was sent (the tag is never dropped).`);
    }
    if (pre.approvalRequired) {
      let preGas = 0n;
      for (const step of pre.steps) {
        const s = await simulateBoth(deps.chain, auth.payer, step);
        rec.simulations.push({ step: `${step.kind} (before swap)`, tagged: s.tagged, untagged: s.untagged, verdict: s.verdict });
        if (s.verdict !== 'identical') {
          return end('FAILED', s.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `simulation of the ${step.kind} step: ${s.verdict} (tagged ${s.tagged}; untagged ${s.untagged}). Nothing was sent; the tag was not removed.`);
        }
        preGas += s.gas ?? lim.assumedApproveGas;
      }
      const preCost = ((preGas + lim.assumedSwapGas) * gasPrice * lim.gasSafetyPercent) / 100n;
      if (native < preCost) return end('FAILED', 'INSUFFICIENT_GAS', `CELO ${native} wei is below the estimated gas ${preCost} wei. Nothing was sent.`);
      if (!opts.confirmApproval) return end('FAILED', 'APPROVAL_CONFIRMATION_REQUIRED', 'an approval is needed but no approval confirmation was provided. Nothing was sent.');
      const preDigest = sequenceDigest(`approval:${venue.name}`, auth.sell.sellAmountAtomic, pre.steps);
      rec.state = 'AWAITING_APPROVAL';
      rec.code = 'AWAITING_APPROVAL';
      rec.message = 'approval simulated; waiting for explicit confirmation of the exact approve transaction(s)';
      persist();
      let d1: { approved: boolean; approvedBy?: string };
      try {
        d1 = await opts.confirmApproval({
          planId: auth.planId,
          token: auth.sell.symbol,
          spender: venue.router,
          amountAtomic: auth.sell.sellAmountAtomic.toString(),
          currentAllowanceAtomic: current.toString(),
          steps: pre.steps.map((s) => ({ kind: s.kind, to: s.to })),
          reason: pre.reason,
          simulations: rec.simulations,
          gas: { estimatedCostWei: preCost.toString(), nativeBalanceWei: native.toString() },
          attributionTag: deps.attributionTag,
          digest: preDigest,
        });
      } catch (e) {
        return end('FAILED', 'CONFIRMATION_ERROR', `approval confirmation failed: ${msg(e)}. Nothing was sent.`);
      }
      if (!d1.approved) return end('FAILED', 'DECLINED', 'the human declined the approval; nothing was sent');
      const preAuth = mintBroadcastAuthorization({ planId: auth.planId, quoteId: `approval:${venue.name}`, digest: preDigest, approvedBy: d1.approvedBy ?? 'human:confirm', expiresAtMs: Number.MAX_SAFE_INTEGER });
      if (!isBroadcastAuthorized(preAuth) || sequenceDigest(`approval:${venue.name}`, auth.sell.sellAmountAtomic, pre.steps) !== preAuth.digest) {
        return end('FAILED', 'SEQUENCE_CHANGED', 'the approval sequence no longer matches what was approved; nothing was sent');
      }
      rec.approvedBy = preAuth.approvedBy;
      rec.state = 'READY_TO_EXECUTE';
      rec.code = 'READY_TO_EXECUTE';
      rec.message = 'approval confirmed; sending the approval transaction(s)';
      persist();
      let approvalBlock: bigint | undefined;
      for (const step of pre.steps) {
        const r = await execStep(step);
        if (!r.ok) return r.outcome;
        approvalBlock = r.receipt.blockNumber;
      }
      const after = await readAllowanceFresh(auth.sell.sellAmountAtomic, approvalBlock);
      rec.residualAllowance = after?.toString();
      if (after === undefined || after < auth.sell.sellAmountAtomic) {
        return end('FAILED', 'APPROVAL_INEFFECTIVE', 'the approval mined but the allowance is still insufficient; the swap was not sent');
      }
    }

    // ---------------- live quote -> floor -> the exact swap bytes
    let out: bigint;
    try {
      out = await venue.quote(auth.sell.asset, auth.buy.asset, auth.sell.sellAmountAtomic);
    } catch (e) {
      return end('FAILED', 'QUOTE_UNAVAILABLE', `the venue could not quote: ${msg(e)}. No swap was sent.${rec.steps.length ? ' An approval remains.' : ''}`);
    }
    rec.amounts.takerPays = auth.sell.sellAmountAtomic.toString();
    rec.amounts.buy = out.toString();
    rec.amounts.fee = '0';
    if (out < auth.buy.minBuyAtomic) {
      return end('FAILED', 'PRICE_MOVED', `the live quote ${out} is below the authorized floor ${auth.buy.minBuyAtomic}. No swap was sent.${rec.steps.length ? ' An approval remains.' : ''}`);
    }
    const slipFloor = (out * BigInt(10_000 - auth.slippageBps)) / 10_000n;
    const amountOutMin = slipFloor > auth.buy.minBuyAtomic ? slipFloor : auth.buy.minBuyAtomic;
    const nowSec = Math.floor(deps.now() / 1000);
    const deadline = BigInt(nowSec + DEADLINE_SEC);
    const data = venue.encodeSwap({ amountIn: auth.sell.sellAmountAtomic, amountOutMin, sell: auth.sell.asset, buy: auth.buy.asset, to: auth.payer, deadline });
    const problems = venue.validateSwap(data, {
      amountIn: auth.sell.sellAmountAtomic,
      minOut: auth.buy.minBuyAtomic,
      sell: auth.sell.asset,
      buy: auth.buy.asset,
      recipient: auth.payer,
      nowSec,
      maxDeadlineSec: DEADLINE_SEC + 60,
    });
    if (problems.length > 0) return end('FAILED', 'SWAP_CALLDATA_INVALID', `the swap calldata failed independent validation: ${problems.join('; ')}. Nothing was sent.`);
    let swapStep: SequenceStep;
    try {
      swapStep = buildTaggedStep('swap', venue.router, data, deps.attributionTag);
    } catch (e) {
      return end('FAILED', 'TAGGING_FAILED', `could not build the tagged swap: ${msg(e)}. Nothing was sent (the tag is never dropped).`);
    }

    // ---------------- simulate the exact bytes that would be broadcast
    const s = await simulateBoth(deps.chain, auth.payer, swapStep);
    rec.simulations.push({ step: 'swap', tagged: s.tagged, untagged: s.untagged, verdict: s.verdict });
    if (s.verdict !== 'identical') {
      return end('FAILED', s.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `simulation of the swap: ${s.verdict} (tagged ${s.tagged}; untagged ${s.untagged}). The swap was NOT sent; the tag was not removed.${rec.steps.length ? ' An approval remains.' : ''}`);
    }
    const nativeNow = await deps.chain.nativeBalance(auth.payer).catch(() => native);
    const estCost = ((s.gas ?? lim.assumedSwapGas) * gasPrice * lim.gasSafetyPercent) / 100n;
    if (nativeNow < estCost) return end('FAILED', 'INSUFFICIENT_GAS', `CELO ${nativeNow} wei is below the estimated gas ${estCost} wei. No swap was sent.`);
    const digest = sequenceDigest(`amm:${venue.name}`, auth.sell.sellAmountAtomic, [swapStep]);

    rec.state = 'AWAITING_APPROVAL';
    rec.code = 'AWAITING_APPROVAL';
    rec.message = 'swap validated and simulated; waiting for explicit confirmation of the exact transaction';
    persist();
    const summary: SwapSummary = {
      planId: auth.planId,
      sell: `${auth.sell.sellAmountAtomic} atomic ${auth.sell.symbol} (${auth.sell.decimals} decimals)`,
      receive: `${out} atomic ${auth.buy.symbol} quoted; at least ${amountOutMin} guaranteed by the transaction`,
      fee: 'embedded in the quoted rate (not itemised)',
      takerPays: auth.sell.sellAmountAtomic.toString(),
      buyAmount: out.toString(),
      expiresAt: new Date(Number(deadline) * 1000).toISOString(),
      secondsRemaining: DEADLINE_SEC,
      steps: [{ kind: 'swap', to: venue.router }],
      approvalRequired: false,
      resetRequired: false,
      sequenceReason: `${venue.name}: swapExactTokensForTokens, single hop, recipient is the wallet, amountOutMin ${amountOutMin}`,
      simulations: rec.simulations,
      gas: { estimatedCostWei: estCost.toString(), nativeBalanceWei: nativeNow.toString(), basis: 'simulation gas x safety factor' },
      attributionTag: deps.attributionTag,
      digest,
    };
    let decision: { approved: boolean; approvedBy?: string };
    try {
      decision = await opts.confirm(summary);
    } catch (e) {
      return end('FAILED', 'CONFIRMATION_ERROR', `confirmation failed: ${msg(e)}. No swap was sent.`);
    }
    if (!decision.approved) return end('FAILED', 'DECLINED', `the human declined; no swap was sent.${rec.steps.length ? ' An approval remains.' : ''}`);
    const bauth = mintBroadcastAuthorization({ planId: auth.planId, quoteId: `amm:${venue.name}`, digest, approvedBy: decision.approvedBy ?? 'human:confirm', expiresAtMs: Number(deadline) * 1000 });
    if (!isBroadcastAuthorized(bauth) || sequenceDigest(`amm:${venue.name}`, auth.sell.sellAmountAtomic, [swapStep]) !== bauth.digest) {
      return end('FAILED', 'SEQUENCE_CHANGED', 'the transaction no longer matches what was approved; nothing was sent');
    }
    rec.approvedBy = bauth.approvedBy;
    rec.state = 'READY_TO_EXECUTE';
    rec.code = 'READY_TO_EXECUTE';
    rec.message = 'approved; about to sign and broadcast the approved swap';
    persist();
    log(`broadcast authorized by ${bauth.approvedBy}`);

    // the world may have changed while a human was deciding: re-check immediately before sending
    const allowanceNow = await readAllowance();
    rec.residualAllowance = allowanceNow?.toString();
    if (allowanceNow === undefined || allowanceNow < auth.sell.sellAmountAtomic) {
      return end('FAILED', 'ALLOWANCE_INSUFFICIENT', 'the allowance does not cover the swap; nothing was swapped');
    }
    const re = await simulateBoth(deps.chain, auth.payer, swapStep);
    rec.simulations.push({ step: 'swap (pre-send)', tagged: re.tagged, untagged: re.untagged, verdict: re.verdict });
    if (re.verdict !== 'identical') {
      return end('FAILED', re.verdict === 'tagged_failed' ? 'TAGGED_SIMULATION_FAILED' : 'TAG_CHANGES_BEHAVIOR', `pre-send simulation: ${re.verdict}. The swap was NOT sent; the tag was not removed.`);
    }

    const r = await execStep(swapStep);
    if (!r.ok) return r.outcome;
    const receipt = r.receipt;

    // ---------------- independent verification
    const sellOut = receipt.transfers.filter((t) => eq(t.token, auth.sell.asset) && eq(t.from, auth.payer)).reduce((n, t) => n + t.value, 0n);
    const buyIn = receipt.transfers.filter((t) => eq(t.token, auth.buy.asset) && eq(t.to, auth.payer)).reduce((n, t) => n + t.value, 0n);
    const [sellAfter, buyAfter, nativeAfter] = await Promise.all([
      readAfter(deps, lim, auth.sell.asset, auth.payer, receipt, sellBalance),
      readAfter(deps, lim, auth.buy.asset, auth.payer, receipt, buyBefore),
      readNativeAfter(deps, auth.payer, receipt),
    ]);
    rec.residualAllowance = (await readAllowanceAfter(deps, auth.sell.asset, auth.payer, venue.router, receipt))?.toString();
    rec.balances.sellAfter = sellAfter?.toString();
    rec.balances.buyAfter = buyAfter?.toString();
    rec.balances.nativeAfter = nativeAfter?.toString();
    rec.verification = { swapMined: true, sellDebited: sellOut.toString(), buyReceived: buyIn.toString(), fillEvent: false, notes: [...rec.verification.notes] };
    const sellDelta = sellAfter === undefined ? undefined : sellBalance - sellAfter;
    const buyDelta = buyAfter === undefined ? undefined : buyAfter - buyBefore;
    rec.verification.notes.push(`reconciliation: sell balance change ${sellDelta ?? 'unreadable'} vs logged ${sellOut}; buy balance change ${buyDelta ?? 'unreadable'} vs logged ${buyIn}`);
    const effectsOk = sellOut > 0n && sellOut <= auth.sell.sellAmountAtomic && buyIn >= amountOutMin;
    if (!effectsOk) {
      return end('UNCERTAIN', 'VERIFICATION_MISMATCH', `the swap transaction succeeded but its effects do not match (debited ${sellOut} of ${auth.sell.sellAmountAtomic}, received ${buyIn}, required at least ${amountOutMin}); inspect it manually.`);
    }
    if (!(sellDelta !== undefined && buyDelta !== undefined && sellDelta === sellOut && buyDelta === buyIn)) {
      return end('UNCERTAIN', 'RECONCILIATION_MISMATCH', 'the swap and its logs look right, but the wallet balance changes do not equal the logged transfers; inspect the wallet manually.');
    }
    return end('CONFIRMED', 'CONFIRMED', `swap confirmed on-chain via ${venue.name}: debited ${sellOut} ${auth.sell.symbol}, received ${buyIn} ${auth.buy.symbol}, balances reconciled.`);
  } finally {
    lock.release();
  }
}

// ================================================================== resolving an UNCERTAIN swap from the chain

export interface ResolveResult {
  state: SwapState;
  /** True if the record was moved to a resolved state and the pending journal cleared. */
  resolved: boolean;
  record: SwapRecord;
  notes: string[];
}

/**
 * Re-verify a swap that was left UNCERTAIN (or SUBMITTED after a crash) purely from the chain, then resolve it.
 * Nothing is sent. A swap is promoted to CONFIRMED only if EVERY check passes:
 *   * every journaled step has a successful receipt, and the mined transaction is from the wallet to the
 *     expected contract with zero value;
 *   * the swap step's logged transfers debit the sell token and credit the buy token;
 *   * exact-block balances (block-1 -> block) change by exactly those transfers;
 *   * attribution is whatever verifyTx actually reports (recorded, never assumed).
 * A reverted transaction resolves to FAILED. Missing evidence leaves the record UNCERTAIN with notes.
 */
export async function resolveSwapRecord(args: {
  dir: string;
  planId: string;
  payer: Address;
  chain: SwapChain;
  verifyAttribution(hash: Hex): Promise<{ codes: string[]; schemaId: number } | null>;
  attributionTag: string;
  /** Expected venue contract for the swap step (Router or reactor), from the plan; checked against the mined tx. */
  expectSwapTarget?: Address;
  now?: () => number;
}): Promise<ResolveResult> {
  const now = args.now ?? Date.now;
  const rec = loadSwapRecord(args.dir, args.planId);
  const notes: string[] = [];
  if (!rec) throw new Error(`no swap record for ${args.planId}`);
  if (['CONFIRMED', 'FAILED', 'EXPIRED'].includes(rec.state)) {
    return { state: rec.state, resolved: false, record: rec, notes: ['already resolved'] };
  }
  const save = (state: SwapState, code: string, message: string): ResolveResult => {
    rec.state = state;
    rec.code = code;
    rec.message = message;
    saveSwapRecord(args.dir, rec, new Date(now()));
    return { state, resolved: ['CONFIRMED', 'FAILED', 'EXPIRED'].includes(state), record: rec, notes };
  };
  const keep = (why: string): ResolveResult => {
    notes.push(why);
    rec.verification.notes.push(`resolution attempt: ${why}`);
    saveSwapRecord(args.dir, rec, new Date(now()));
    return { state: rec.state, resolved: false, record: rec, notes };
  };

  const stepsWithHash = rec.steps.filter((s) => s.hash);
  if (stepsWithHash.length === 0) {
    // A step's transaction hash is journaled BEFORE it is broadcast, and a failed journal write stops the run
    // before anything is sent. So a journal with NO hash on any step cannot have broadcast a transaction.
    // Corroborate with the chain before closing it: the sell balance must be untouched.
    const neverSigned = ['PLANNED', 'QUOTED', 'AWAITING_APPROVAL', 'READY_TO_EXECUTE'].includes(rec.state);
    if (!neverSigned) return keep('the journal has no transaction hash to verify');
    const before = rec.balances.sellBefore;
    if (before === undefined) return keep('no transaction was journaled, but there is no recorded balance to corroborate that nothing was sent');
    let nowSell: bigint;
    try {
      nowSell = await args.chain.tokenBalance(rec.route.sellAsset as Address, args.payer);
    } catch (e) {
      return keep(`cannot read the sell balance to corroborate that nothing was sent: ${msg(e)}`);
    }
    if (nowSell !== BigInt(before)) {
      return keep(`no transaction was journaled, but the sell balance changed (${before} -> ${nowSell}); not closing this journal`);
    }
    notes.push(`no step has a transaction hash and the sell balance is unchanged (${nowSell}): nothing was signed or sent`);
    rec.fundsMayHaveMoved = false;
    return save('FAILED', 'NEVER_SENT', 'recovery: this swap was never signed or broadcast (no transaction hash was journaled and the sell balance is unchanged). Nothing was spent.');
  }
  const sellAsset = rec.route.sellAsset as Address;
  const buyAsset = rec.route.buyAsset as Address;

  let swapReceipt: ChainReceipt | undefined;
  for (const s of stepsWithHash) {
    const hash = s.hash as Hex;
    const receipt = await args.chain.getReceipt(hash).catch(() => undefined);
    if (!receipt) return keep(`no receipt found for ${s.kind} ${hash}; it may still be pending or may have been dropped`);
    if (receipt.status === 'reverted') {
      s.status = 'reverted';
      return save('FAILED', s.kind === 'swap' ? 'SWAP_REVERTED' : 'APPROVAL_REVERTED', `the ${s.kind} transaction ${hash} reverted on-chain (verified from its receipt).`);
    }
    const mined = await args.chain.getTransaction(hash).catch(() => undefined);
    if (!mined || !eq(mined.from, args.payer) || mined.value !== 0n || (s.to && (!mined.to || !eq(mined.to, s.to)))) {
      return keep(`the mined ${s.kind} transaction ${hash} does not match what the journal says was signed`);
    }
    s.status = 'mined';
    s.gasUsed = receipt.gasUsed.toString();
    const a = await args.verifyAttribution(hash).catch(() => null);
    const ok = a !== null && a.codes.length === 1 && a.codes[0] === args.attributionTag;
    s.attribution = { verified: ok, codes: a?.codes ?? null, note: ok ? 'verifyTx found exactly the official tag' : a === null ? 'verifyTx found no attribution' : `verifyTx found ${JSON.stringify(a.codes)}` };
    if (s.kind === 'swap') swapReceipt = receipt;
  }
  if (!swapReceipt) return keep('no swap transaction in the journal; nothing to reconcile');
  if (args.expectSwapTarget) {
    const swapStep = rec.steps.find((s) => s.kind === 'swap');
    if (swapStep && !eq(swapStep.to, args.expectSwapTarget)) return keep(`the swap targeted ${swapStep.to}, not the expected ${args.expectSwapTarget}`);
  }

  if (!args.chain.tokenBalanceAt) return keep('this chain adapter cannot read balances at an exact block, so reconciliation is not possible');
  const sellOut = swapReceipt.transfers.filter((t) => eq(t.token, sellAsset) && eq(t.from, args.payer)).reduce((n, t) => n + t.value, 0n);
  const buyIn = swapReceipt.transfers.filter((t) => eq(t.token, buyAsset) && eq(t.to, args.payer)).reduce((n, t) => n + t.value, 0n);
  const blk = swapReceipt.blockNumber;
  let sellBefore: bigint, sellAfter: bigint, buyBefore: bigint, buyAfter: bigint;
  try {
    [sellBefore, sellAfter, buyBefore, buyAfter] = await Promise.all([
      args.chain.tokenBalanceAt(sellAsset, args.payer, blk - 1n),
      args.chain.tokenBalanceAt(sellAsset, args.payer, blk),
      args.chain.tokenBalanceAt(buyAsset, args.payer, blk - 1n),
      args.chain.tokenBalanceAt(buyAsset, args.payer, blk),
    ]);
  } catch (e) {
    return keep(`could not read exact-block balances: ${msg(e)}`);
  }
  rec.balances.sellBefore = sellBefore.toString();
  rec.balances.sellAfter = sellAfter.toString();
  rec.balances.buyBefore = buyBefore.toString();
  rec.balances.buyAfter = buyAfter.toString();
  rec.verification.swapMined = true;
  rec.verification.sellDebited = sellOut.toString();
  rec.verification.buyReceived = buyIn.toString();
  const reactorFill = swapReceipt.fills.some((f) => eq(f.reactor, TEXTILE_REACTOR) && eq(f.filler, args.payer));
  rec.verification.fillEvent = reactorFill;
  rec.verification.notes.push(`exact-block reconciliation at block ${blk}: sell ${sellBefore} -> ${sellAfter} (logged ${sellOut}); buy ${buyBefore} -> ${buyAfter} (logged ${buyIn})`);

  const minBuy = BigInt(rec.amounts.minBuy);
  const requested = BigInt(rec.amounts.requestedSell);
  if (sellOut <= 0n || sellOut > requested) return keep(`logged debit ${sellOut} is not within the requested ${requested}`);
  if (buyIn < minBuy) return keep(`logged credit ${buyIn} is below the authorized floor ${minBuy}`);
  if (rec.route.provider === 'textile-fx-v2' && !reactorFill) return keep('no Fill event from the Textile reactor in the swap receipt');
  if (sellBefore - sellAfter !== sellOut || buyAfter - buyBefore !== buyIn) {
    return keep('exact-block balance changes do not equal the logged transfers');
  }
  return save(
    'CONFIRMED',
    'CONFIRMED_BY_REVERIFICATION',
    `re-verified from the chain: debited ${sellOut} ${rec.route.sellSymbol}, received ${buyIn} ${rec.route.buySymbol}, balances reconcile at block ${blk}.`,
  );
}
