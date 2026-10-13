// Resolve an UNCERTAIN payment by RE-VERIFYING it from the chain. Sends nothing and signs nothing.
//
// A payment receipt is never edited. The result is written as a separate record, receipts/resolutions/
// <receiptId>.json, which history, the duplicate guard, order recovery and evidence all read:
//   SETTLED      the chain shows the payment settled (authorization used, or a matching Transfer): the money
//                is spent. Never pay for the same thing again.
//   NOT_SETTLED  the chain proves the authorization expired unused: nothing was charged. The payment then
//                counts as REJECTED (a deliberate retry is allowed) and no longer blocks.
//   (nothing)    still unknown: no record is written and the payment keeps blocking.
//
// When the outcome is definitive, the matching payment journal (receipts/pending/<id>.json, matched by plan
// id) is cleared, so a human no longer has to delete files by hand.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { isSettled, verifySettlement } from './verify.ts';
import type { SettlementEvidence, VerifyDeps } from './verify.ts';

export interface PaymentResolution {
  schemaVersion: 1;
  receiptId: string;
  resolvedAt: string;
  outcome: 'SETTLED' | 'NOT_SETTLED';
  /** True if the receipt already recorded that the service delivered. */
  deliveredPerReceipt: boolean;
  evidence: SettlementEvidence;
  note: string;
}

export type ResolvePaymentResult =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'already_resolved'; resolution: PaymentResolution }
  | { kind: 'resolved'; resolution: PaymentResolution; clearedPending: string[] }
  | { kind: 'still_uncertain'; evidence: SettlementEvidence; message: string };

const msg = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]!.slice(0, 300) : String(e).slice(0, 300));

export async function resolvePayment(
  dir: string,
  receiptId: string,
  deps: { verify: VerifyDeps; now(): Date },
): Promise<ResolvePaymentResult> {
  const refuse = (code: string, message: string): ResolvePaymentResult => ({ kind: 'refused', code, message });
  if (!/^[A-Za-z0-9._-]+$/.test(receiptId)) return refuse('BAD_ID', 'receipt id may contain only letters, digits, dot, dash and underscore');

  const resFile = join(dir, 'resolutions', `${receiptId}.json`);
  if (existsSync(resFile)) {
    try {
      return { kind: 'already_resolved', resolution: JSON.parse(readFileSync(resFile, 'utf8')) as PaymentResolution };
    } catch (e) {
      return refuse('RESOLUTION_UNREADABLE', `a resolution file exists but cannot be read: ${msg(e)}`);
    }
  }

  const receiptFile = join(dir, `${receiptId}.json`);
  if (!existsSync(receiptFile)) return refuse('RECEIPT_NOT_FOUND', `no receipt ${receiptId}`);
  let r: Record<string, any>;
  try {
    r = JSON.parse(readFileSync(receiptFile, 'utf8')) as Record<string, any>;
  } catch (e) {
    return refuse('RECEIPT_UNREADABLE', msg(e));
  }
  if (r.status !== 'UNCERTAIN') return refuse('NOT_UNCERTAIN', `receipt status is ${String(r.status)}; only an UNCERTAIN payment is resolved this way`);

  const auth = r.payment?.authorization as { from: string; nonce: string; validAfter: string; validBefore: string } | null | undefined;
  if (!auth || typeof auth.nonce !== 'string') {
    return refuse(
      'NO_AUTHORIZATION_RECORDED',
      'this receipt has no recorded payment authorization (the payment may have been interrupted before one was returned), so it cannot be re-verified from the chain; inspect the wallet on a block explorer',
    );
  }
  let amount: bigint;
  try {
    amount = BigInt(r.payment.amountAtomic);
  } catch {
    return refuse('RECEIPT_UNREADABLE', 'the receipt has no valid amount');
  }

  let ev: SettlementEvidence;
  try {
    ev = await verifySettlement(
      {
        asset: r.payment.asset as Address,
        amountAtomic: amount,
        payer: r.payment.payer as Address,
        payTo: r.payment.payTo as Address,
        txHash: typeof r.payment.txHash === 'string' ? r.payment.txHash : undefined,
        authorization: { from: auth.from as Address, nonce: auth.nonce, validAfter: auth.validAfter, validBefore: auth.validBefore },
        timestamp: String(r.createdAt),
      },
      deps.verify,
    );
  } catch (e) {
    return refuse('VERIFY_FAILED', msg(e));
  }

  const settled = isSettled(ev);
  const notSettled = !settled && ev.authorizationState === 'not_settled';
  if (!settled && !notSettled) {
    return { kind: 'still_uncertain', evidence: ev, message: `the chain does not decide it yet (authorization ${ev.authorizationState}); it keeps blocking and nothing was changed` };
  }

  const resolution: PaymentResolution = {
    schemaVersion: 1,
    receiptId,
    resolvedAt: deps.now().toISOString(),
    outcome: settled ? 'SETTLED' : 'NOT_SETTLED',
    deliveredPerReceipt: r.outcome?.delivered === true,
    evidence: ev,
    note: settled
      ? 'the chain shows this payment settled; the money is spent. Do not pay for it again.'
      : 'the chain shows the authorization expired unused; nothing was charged. A deliberate retry is allowed.',
  };
  try {
    mkdirSync(join(dir, 'resolutions'), { recursive: true });
    writeFileSync(resFile, JSON.stringify(resolution, null, 2), { flag: 'wx' }); // additive; never overwrites
  } catch (e) {
    return refuse('RESOLUTION_NOT_SAVED', `the outcome is ${resolution.outcome} but could not be saved: ${msg(e)}`);
  }

  // Clear ONLY the payment journal(s) of this payment (matched by plan id), now that the outcome is decided.
  const cleared: string[] = [];
  const pdir = join(dir, 'pending');
  if (existsSync(pdir) && typeof r.planId === 'string') {
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (e.isDirectory() || !e.name.endsWith('.json') || e.name.startsWith('swap-')) continue;
      try {
        const j = JSON.parse(readFileSync(join(pdir, e.name), 'utf8')) as Record<string, unknown>;
        if (j.planId === r.planId) {
          unlinkSync(join(pdir, e.name));
          cleared.push(e.name);
        }
      } catch {
        /* leave anything unreadable in place: it keeps blocking */
      }
    }
  }
  return { kind: 'resolved', resolution, clearedPending: cleared };
}
