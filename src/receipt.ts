// Receipts. Schema v1 is a superset of the receipt written by the first verified payment
// (which has no schemaVersion/status and is read as a legacy receipt).
// Receipts contain only public facts: never keys, signatures or claim tokens.
import type { Address } from 'viem';
import { formatUnits } from 'viem';
import type { ExecutionAuthorization } from './authorization.ts';
import type { OrderLink } from './orderstore.ts';
import { isSettled } from './verify.ts';
import type { SettlementEvidence } from './verify.ts';

export const RECEIPT_SCHEMA_VERSION = 1;

/**
 * CONFIRMED  paid, delivered and independently settled.
 * REJECTED   proven not settled (authorization expired unused); safe to retry deliberately.
 * UNCERTAIN  may have settled; NEVER retry automatically. Resolve from chain state first.
 */
export type PaymentStatus = 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN';

export interface Classification {
  status: PaymentStatus;
  retryAllowed: boolean;
  reason: string;
}

export function classifyPayment(x: {
  delivered: boolean;
  evidence: SettlementEvidence | undefined;
}): Classification {
  const settled = isSettled(x.evidence);
  if (x.delivered && settled) {
    return { status: 'CONFIRMED', retryAllowed: false, reason: 'delivered and independently settled' };
  }
  if (!settled && x.evidence?.authorizationState === 'not_settled') {
    return { status: 'REJECTED', retryAllowed: true, reason: 'authorization expired unused; nothing was charged' };
  }
  return {
    status: 'UNCERTAIN',
    retryAllowed: false,
    reason: settled ? 'settled but the service did not confirm delivery' : 'settlement could not be confirmed',
  };
}

export interface ReceiptInput {
  now: Date;
  auth: ExecutionAuthorization;
  payment: {
    txHash: string | undefined;
    authorization: { from: Address; nonce: string; validAfter: string; validBefore: string } | undefined;
  };
  evidence: SettlementEvidence | undefined;
  httpStatus: number | undefined;
  clientOutcome: string | undefined;
  delivered: boolean;
  responseSummary: string;
  /** sha256 of the exact response body bytes, and where the body was stored (relative to the receipts folder). */
  responseSha256?: string;
  responseFile?: string;
  balances: { before: bigint; after: bigint | undefined };
  attributionTag: string;
  /** Present when the payment was made through the order flow: records the ACTUAL route and conversion. */
  order?: OrderLink;
}

/** The receipt id for a payment finished at date (also names the saved response body). */
export function receiptIdFor(date: Date): string {
  return `direct-${date.toISOString().replace(/[:.]/g, '-')}`;
}

function flowText(o: OrderLink | undefined): string {
  if (o?.route === 'converted') return `converted via ${o.conversion?.provider ?? 'a conversion venue'}, then paid directly`;
  return 'direct (no swap needed)';
}

function conversionOf(o: OrderLink | undefined) {
  const c = o?.route === 'converted' ? o.conversion : undefined;
  if (!c) return null;
  return {
    provider: c.provider,
    swapPlanId: c.swapPlanId,
    state: c.state,
    txHashes: c.txHashes,
    sell: c.sellSymbol ? { symbol: c.sellSymbol, amountAtomic: c.sellAmountAtomic ?? null } : null,
    buy: c.buySymbol ? { symbol: c.buySymbol, receivedAtomic: c.receivedAtomic ?? null } : null,
  };
}

export function buildReceipt(i: ReceiptInput) {
  const c = classifyPayment({ delivered: i.delivered, evidence: i.evidence });
  const a = i.auth;
  const decimals = 6; // all payable assets today are 6-decimal stablecoins; enforced upstream by the planner
  const id = receiptIdFor(i.now);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    id,
    planId: a.planId,
    createdAt: i.now.toISOString(),
    status: c.status,
    retryAllowed: c.retryAllowed,
    statusReason: c.reason,
    flow: flowText(i.order),
    orderId: i.order?.orderId ?? null,
    input: { token: a.payment.symbol, amountAtomic: a.payment.amountAtomic.toString(), amount: formatUnits(a.payment.amountAtomic, decimals) },
    conversion: conversionOf(i.order),
    service: { capability: a.serviceId, url: a.url, bodyHash: a.bodyHash },
    payment: {
      protocol: 'x402 v1 / exact',
      network: a.payment.network,
      chainId: a.payment.chainId,
      payer: a.payer,
      payTo: a.payment.payTo,
      asset: a.payment.asset,
      amountAtomic: a.payment.amountAtomic.toString(),
      txHash: i.payment.txHash ?? i.evidence?.txHash ?? null,
      authorization: i.payment.authorization ?? null,
      settlement: {
        authorizationState: i.evidence?.authorizationState ?? 'unknown',
        transferVerified: i.evidence?.transferVerified ?? false,
        notes: i.evidence?.notes ?? [],
      },
    },
    fees: { conversionFee: '0', gas: '0 (gateway sponsors x402 settlement)' },
    outcome: {
      httpStatus: i.httpStatus ?? null,
      clientOutcome: i.clientOutcome ?? null,
      delivered: i.delivered,
      settled: isSettled(i.evidence),
      responseSummary: i.responseSummary,
      responseSha256: i.responseSha256 ?? null,
      responseFile: i.responseFile ?? null,
    },
    approval: { approvedBy: a.approvedBy },
    attribution: {
      tag: i.attributionTag,
      tagged: false,
      reason:
        'x402 settlements are submitted by the facilitator and attribution tags are not yet supported by x402; ' +
        'the hackathon organizers confirmed no tag is needed for Buy. Payrail only signs the authorization.',
    },
    balances: {
      before: i.balances.before.toString(),
      after: i.balances.after === undefined ? null : i.balances.after.toString(),
    },
  };
}

export type Receipt = ReturnType<typeof buildReceipt>;
