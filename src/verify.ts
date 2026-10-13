// Independent settlement verification: do not trust the seller's word that a payment happened.
// Two sources of evidence: (1) the token contract's own record of the EIP-3009 nonce, and
// (2) a Transfer(payer -> payTo, amount) event inside the settlement transaction receipt.
import type { Address } from 'viem';

export interface PaymentRecord {
  asset: Address;
  amountAtomic: bigint;
  payer: Address;
  payTo: Address;
  /** Settlement transaction hash reported by the gateway, if any. */
  txHash: string | undefined;
  authorization: { from: Address; nonce: string; validAfter: string; validBefore: string };
  /** ISO time the paid response was received (bounds the log search). */
  timestamp: string;
}

export type AuthorizationState = 'settled' | 'not_settled' | 'pending' | 'unknown' | 'error';

export interface SettlementEvidence {
  authorizationState: AuthorizationState;
  txHash: string | undefined;
  /** A Transfer(payer -> payTo, amount) log exists in a successful receipt. */
  transferVerified: boolean;
  notes: string[];
}

export interface TransferLog {
  address: Address;
  from: Address;
  to: Address;
  value: bigint;
}

export interface VerifyDeps {
  /** Wraps @celo/buy-core's authorizationSettlement. */
  resolveAuthorization(p: PaymentRecord): Promise<
    { state: 'settled'; txHash: string } | { state: 'not_settled' | 'pending' | 'unknown'; detail: string }
  >;
  /** Returns the receipt status and its ERC-20 Transfer logs. */
  getTransferLogs(txHash: string): Promise<{ status: string; logs: TransferLog[] }>;
}

function msg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);
}

export async function verifySettlement(p: PaymentRecord, deps: VerifyDeps): Promise<SettlementEvidence> {
  const ev: SettlementEvidence = {
    authorizationState: 'unknown',
    txHash: p.txHash,
    transferVerified: false,
    notes: [],
  };
  try {
    const s = await deps.resolveAuthorization(p);
    ev.authorizationState = s.state;
    if (s.state === 'settled') ev.txHash = ev.txHash ?? s.txHash;
    else ev.notes.push(`authorization ${s.state}: ${s.detail}`);
  } catch (e) {
    ev.authorizationState = 'error';
    ev.notes.push(`could not resolve authorization: ${msg(e)}`);
  }

  if (ev.txHash) {
    try {
      const r = await deps.getTransferLogs(ev.txHash);
      if (r.status !== 'success') {
        ev.notes.push(`transaction status is ${r.status}`);
      } else {
        ev.transferVerified = r.logs.some(
          (l) =>
            l.address.toLowerCase() === p.asset.toLowerCase() &&
            l.from.toLowerCase() === p.payer.toLowerCase() &&
            l.to.toLowerCase() === p.payTo.toLowerCase() &&
            l.value === p.amountAtomic,
        );
        if (!ev.transferVerified) ev.notes.push('no matching Transfer event in the receipt');
      }
    } catch (e) {
      ev.notes.push(`could not read transaction receipt: ${msg(e)}`);
    }
  } else {
    ev.notes.push('no settlement transaction hash available');
  }
  return ev;
}

/** Settled means independent evidence exists. A seller's HTTP 200 alone is never enough. */
export function isSettled(ev: SettlementEvidence | undefined): boolean {
  return ev !== undefined && (ev.authorizationState === 'settled' || ev.transferVerified);
}
