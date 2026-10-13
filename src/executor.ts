// Direct-payment executor: the existing, live-verified payingFetch flow, wrapped in safeguards.
//
// It accepts ONLY an ExecutionAuthorization (see authorization.ts). Order of operations:
//   authorization valid -> duplicate guard -> balance -> [challenge re-check -> journal -> sign -> send]
//   -> independent settlement verification -> receipt -> clear journal (only if resolved)
//
// A paid request is sent at most once and never retried here. Anything that might have settled is
// recorded as UNCERTAIN and leaves the pending journal in place, which blocks further payments.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, LocalAccount } from 'viem';
import { BuyError, x402 } from '@celo/buy-core';
import { isAuthorized } from './authorization.ts';
import type { ExecutionAuthorization } from './authorization.ts';
import { checkChallenge } from './buy.ts';
import { DuplicateGuardError, assertNoPriorPayment, clearPending, readHistory, spentSince, writePending } from './history.ts';
import { LockError, acquireLock } from './lock.ts';
import type { HeldLock, LockOptions } from './lock.ts';
import type { OrderLink } from './orderstore.ts';
import { buildReceipt, receiptIdFor } from './receipt.ts';
import type { Receipt } from './receipt.ts';
import { verifySettlement } from './verify.ts';
import type { SettlementEvidence, VerifyDeps } from './verify.ts';

export interface ExecuteDeps {
  account: LocalAccount;
  /** Request body that was priced; must hash to authorization.bodyHash. */
  body: string;
  receiptDir: string;
  attributionTag: string;
  verify: VerifyDeps;
  getBalance(asset: Address, owner: Address): Promise<bigint>;
  readBalance?: x402.BalanceReader;
  fetchImpl?: typeof fetch;
  now?: () => number;
  again?: boolean;
  log?: (line: string) => void;
  /** Cross-process lock tuning (tests use short timings). */
  lock?: LockOptions;
  /** Rolling 24h ceiling re-checked inside the lock (atomic units). Omitted = not enforced here. */
  maxPerDayAtomic?: bigint;
  /** Store the exact service response next to the receipt as proof of delivery (default true). */
  saveResponseBody?: boolean;
  /** Set by the order flow: stamps the receipt and pending journal with the order and the ACTUAL route. */
  order?: OrderLink;
  /**
   * Duplicate guard scope. 'order' (default): only a receipt for the same plan/order blocks, so a new order is
   * allowed. 'global': any prior receipt blocks (the strict rehearsal behaviour). A pending journal always blocks.
   */
  guard?: 'order' | 'global';
}

export type ExecutionResult =
  | { kind: 'not_sent'; code: string; message: string }
  | { kind: 'completed'; receipt: Receipt; receiptFile: string; httpStatus: number }
  | { kind: 'in_doubt'; message: string; receiptFile: string | undefined };

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Third-party response bodies are untrusted: only their structure is ever summarized. */
export function summarizeResponse(rawText: string): string {
  try {
    const j: unknown = JSON.parse(rawText);
    if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
      const keys = Object.keys(j).slice(0, 12).map((k) => k.slice(0, 40));
      const out = (j as Record<string, unknown>).output;
      const shape = Array.isArray(out) ? `array(${out.length})` : out === undefined ? 'n/a' : typeof out;
      return `JSON keys [${keys.join(', ')}]; output: ${shape}; ${rawText.length} bytes`;
    }
  } catch {
    /* fall through */
  }
  return `non-JSON body, ${rawText.length} bytes`;
}

function errCode(e: unknown): { code: string; message: string } {
  if (e instanceof BuyError) return { code: e.code, message: e.message.slice(0, 300) };
  if (e instanceof Error) return { code: 'ERROR', message: e.message.split('\n')[0]!.slice(0, 300) };
  return { code: 'ERROR', message: String(e).slice(0, 300) };
}

export async function executeDirectPayment(
  auth: ExecutionAuthorization,
  deps: ExecuteDeps,
): Promise<ExecutionResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const stop = (code: string, message: string): ExecutionResult => ({ kind: 'not_sent', code, message });

  // 1. Authorization: must have been minted by the planner, must be fresh, and must match this request.
  if (!isAuthorized(auth)) return stop('NOT_AUTHORIZED', 'refusing: no valid execution authorization from the planner');
  if (now() > auth.expiresAtMs) return stop('AUTHORIZATION_EXPIRED', 'the authorization has expired; plan again');
  if (deps.account.address.toLowerCase() !== auth.payer.toLowerCase()) {
    return stop('PAYER_MISMATCH', 'the signing wallet is not the wallet the plan was made for');
  }
  if (sha256Hex(deps.body) !== auth.bodyHash) {
    return stop('BODY_MISMATCH', 'the request body differs from the body that was priced');
  }
  if (auth.payment.amountAtomic > auth.maxAmountAtomic) {
    return stop('AMOUNT_OVER_MAX', 'authorized amount exceeds the authorized maximum');
  }

  // 1b. Mutual exclusion. Everything that decides and performs a payment happens while this process holds
  //     the cross-process lock, so no other process can pass the same checks at the same time.
  let lock: HeldLock;
  try {
    lock = await acquireLock(deps.receiptDir, deps.lock);
  } catch (e) {
    if (e instanceof LockError) return stop(e.code, e.message);
    return stop('LOCK_UNAVAILABLE', `cannot take the execution lock: ${errCode(e).message}`);
  }
  try {
  // 2. Duplicate-payment guard (receipts and the pending journal), now evaluated INSIDE the lock.
  try {
    assertNoPriorPayment(deps.receiptDir, {
      again: deps.again ?? false,
      ...(deps.guard === 'global' ? {} : { scope: { planId: auth.planId, ...(deps.order ? { orderId: deps.order.orderId } : {}) } }),
    });
  } catch (e) {
    if (e instanceof DuplicateGuardError) return stop(e.code, e.message);
    // Any other failure means we cannot prove no payment is pending: fail closed, never pay.
    return stop('GUARD_UNAVAILABLE', `cannot verify there is no pending payment: ${errCode(e).message}`);
  }

  // 2b. Rolling 24h limit, re-evaluated inside the lock from the receipts of payments that already finished.
  if (deps.maxPerDayAtomic !== undefined) {
    let spent: bigint;
    try {
      spent = spentSince(readHistory(deps.receiptDir), now() - 86_400_000);
    } catch (e) {
      return stop('LIMIT_UNVERIFIABLE', `cannot read payment history to enforce the daily limit: ${errCode(e).message}`);
    }
    if (spent + auth.payment.amountAtomic > deps.maxPerDayAtomic) {
      return stop('DAILY_LIMIT', `paying ${auth.payment.amountAtomic} would take the 24h total to ${spent + auth.payment.amountAtomic}, above ${deps.maxPerDayAtomic}`);
    }
  }

  // 3. Balance (our own read, inside the lock so a concurrent payment cannot invalidate it).
  let before: bigint;
  try {
    before = await deps.getBalance(auth.payment.asset, auth.payer);
  } catch (e) {
    return stop('BALANCE_UNREADABLE', `cannot read the wallet balance: ${errCode(e).message}`);
  }
  if (before < auth.payment.amountAtomic) {
    return stop('INSUFFICIENT_BALANCE', `balance ${before} is below the price ${auth.payment.amountAtomic}`);
  }

  // 4. The one paid request.
  const startedAt = new Date(now());
  const pendingId = `pending-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  // State set inside client callbacks lives in an object so TypeScript does not narrow it away.
  const st: { journaled: boolean; info: x402.OnPaymentInfo | undefined } = { journaled: false, info: undefined };
  let response: Response;
  try {
    response = await x402.payingFetch(
      {
        account: deps.account,
        network: 'celo',
        preferredToken: auth.payment.symbol,
        ...(deps.readBalance ? { readBalance: deps.readBalance } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
      auth.url,
      {
        method: auth.method,
        headers: { 'content-type': 'application/json' },
        body: deps.body,
        // Never follow redirects: a payment must not be steered to a different host.
        redirect: 'manual',
        maxAmount: auth.maxAmountAtomic < auth.payment.amountAtomic ? auth.maxAmountAtomic : auth.payment.amountAtomic,
        maxRetries: 1,
        // Re-check the challenge the server really sent. Throwing aborts before anything is signed.
        onChallenge: (req) => {
          const problems = checkChallenge(req, {
            resource: auth.url,
            asset: auth.payment.asset,
            payTo: auth.payment.payTo,
            maxAtomic: auth.payment.amountAtomic,
          });
          if (problems.length > 0) throw new Error(`challenge refused: ${problems.join('; ')}`);
        },
        // Journal BEFORE the request leaves. If this write fails, the payment is aborted.
        onBeforePayment: () => {
          // A process that was frozen or starved may have had its lock broken. Never send without it.
          lock.assertHeld();
          writePending(deps.receiptDir, {
            id: pendingId,
            createdAt: startedAt.toISOString(),
            state: 'in_flight',
            planId: auth.planId,
            serviceId: auth.serviceId,
            url: auth.url,
            payer: auth.payer,
            asset: auth.payment.asset,
            payTo: auth.payment.payTo,
            amountAtomic: auth.payment.amountAtomic.toString(),
            ...(deps.order ? { orderId: deps.order.orderId } : {}),
            note: 'Payment signed and sent; outcome not yet recorded. Resolve before paying again.',
          });
          st.journaled = true;
          log(`signing and sending ${auth.payment.amountAtomic} atomic ${auth.payment.symbol} to ${auth.payment.payTo}`);
        },
        onPayment: (i) => {
          st.info = i;
        },
        onAccountingError: (err) => log(`[WARN] accounting hook failed: ${errCode(err).message}`),
      },
    );
  } catch (e) {
    const { code, message } = errCode(e);
    if (!st.journaled) return stop(code, `payment was not sent: ${message}`);
    // Something threw after the payment may have left the machine. Never assume it failed.
    const receiptFile = tryWriteReceipt(auth, deps, startedAt, undefined, undefined, undefined, false, 'payment request threw after sending', before, undefined);
    return {
      kind: 'in_doubt',
      message: `the payment may or may not have settled (${message}). The pending journal blocks further payments; resolve from chain state first.`,
      receiptFile,
    };
  }

  const httpStatus = response.status;
  let text = '';
  try {
    text = await response.text();
  } catch {
    /* a body read failure does not change the payment facts */
  }

  if (!st.journaled) {
    // The server answered without ever asking for payment: nothing was sent.
    return stop('NO_PAYMENT_REQUIRED', `service answered HTTP ${httpStatus} without a payment challenge; nothing was paid`);
  }
  const info = st.info;
  if (!info) {
    // Journaled, but the final response was still a 402 or otherwise unrecorded: ambiguous, never retry.
    const receiptFile = tryWriteReceipt(auth, deps, startedAt, undefined, undefined, httpStatus, false, summarizeResponse(text), before, undefined);
    return {
      kind: 'in_doubt',
      message: `payment was sent but the service answered HTTP ${httpStatus} without a recorded outcome; do not retry.`,
      receiptFile,
    };
  }

  // 5. Independent verification: never trust the seller's HTTP 200 alone.
  const paymentInfo: x402.OnPaymentInfo = info;
  const evidence: SettlementEvidence = await verifySettlement(
    {
      asset: auth.payment.asset,
      amountAtomic: auth.payment.amountAtomic,
      payer: auth.payer,
      payTo: auth.payment.payTo,
      txHash: paymentInfo.txHash,
      authorization: {
        from: paymentInfo.authorization.from as Address,
        nonce: paymentInfo.authorization.nonce,
        validAfter: paymentInfo.authorization.validAfter,
        validBefore: paymentInfo.authorization.validBefore,
      },
      timestamp: paymentInfo.timestamp,
    },
    deps.verify,
  );

  let after: bigint | undefined;
  try {
    after = await deps.getBalance(auth.payment.asset, auth.payer);
  } catch {
    after = undefined;
  }

  const delivered = paymentInfo.outcome === 'confirmed' && httpStatus >= 200 && httpStatus < 300;

  // Keep the proof of WHAT was delivered: the exact response bytes, hashed, stored next to the receipt.
  // It is third-party data: stored verbatim and never parsed, executed or trusted.
  const finishedAt = new Date(now());
  const responseSha256 = sha256Hex(text);
  let responseFile: string | undefined;
  if (deps.saveResponseBody !== false && text.length > 0) {
    try {
      const dir = join(deps.receiptDir, 'responses');
      mkdirSync(dir, { recursive: true });
      const name = `${receiptIdFor(finishedAt)}.body`;
      writeFileSync(join(dir, name), text, { flag: 'wx' });
      responseFile = `responses/${name}`;
    } catch {
      responseFile = undefined; // the digest still proves what was received; the payment is unaffected
    }
  }
  const receipt = buildReceipt({
    now: finishedAt,
    ...(responseSha256 ? { responseSha256 } : {}),
    ...(responseFile ? { responseFile } : {}),
    auth,
    payment: { txHash: paymentInfo.txHash, authorization: { ...paymentInfo.authorization, from: paymentInfo.authorization.from as Address } },
    evidence,
    httpStatus,
    clientOutcome: paymentInfo.outcome,
    delivered,
    responseSummary: summarizeResponse(text),
    balances: { before, after },
    attributionTag: deps.attributionTag,
    ...(deps.order ? { order: deps.order } : {}),
  });

  let receiptFile: string;
  try {
    mkdirSync(deps.receiptDir, { recursive: true });
    receiptFile = join(deps.receiptDir, `${receipt.id}.json`);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  } catch (e) {
    return {
      kind: 'in_doubt',
      message: `payment completed (${receipt.status}) but the receipt could not be saved: ${errCode(e).message}. Pending journal kept.`,
      receiptFile: undefined,
    };
  }

  // Only a resolved outcome clears the journal. UNCERTAIN keeps blocking until a human resolves it.
  if (receipt.status === 'CONFIRMED' || receipt.status === 'REJECTED') clearPending(deps.receiptDir, pendingId);
  return { kind: 'completed', receipt, receiptFile, httpStatus };
  } finally {
    // The lock is released on every path, including exceptions. A crash leaves a lock file that is
    // broken later only if its owner is provably dead (see lock.ts).
    lock.release();
  }
}

/** Best-effort UNCERTAIN receipt for the in-doubt paths; returns the file path or undefined. */
function tryWriteReceipt(
  auth: ExecutionAuthorization,
  deps: ExecuteDeps,
  startedAt: Date,
  evidence: SettlementEvidence | undefined,
  clientOutcome: string | undefined,
  httpStatus: number | undefined,
  delivered: boolean,
  summary: string,
  before: bigint,
  after: bigint | undefined,
): string | undefined {
  try {
    const receipt = buildReceipt({
      now: new Date((deps.now ?? Date.now)()),
      auth,
      payment: { txHash: undefined, authorization: undefined },
      evidence,
      httpStatus,
      clientOutcome,
      delivered,
      responseSummary: summary,
      balances: { before, after },
      attributionTag: deps.attributionTag,
      ...(deps.order ? { order: deps.order } : {}),
    });
    mkdirSync(deps.receiptDir, { recursive: true });
    const file = join(deps.receiptDir, `${receipt.id}.json`);
    writeFileSync(file, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    void startedAt;
    return file;
  } catch {
    return undefined;
  }
}
