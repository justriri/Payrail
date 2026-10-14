// LIVE Textile conversion for marketplace funding: an adapter around the EXISTING standalone-conversion pipeline
// (planConversion -> authorizeConversion -> runSwap with bounded confirmers). It adds no new signing path:
//   * the only transactions are the ones runSwap already validates (exact approve to the verified reactor, tagged swap),
//   * the confirmers are bounded to exactly the amounts of the quote the buyer approved,
//   * and the funding engine independently verifies the swap receipt before any credit.
//
// STATUS: NOT exercised against the live network. It is wired only when real-funds mode is explicitly enabled
// (PAYRAIL_MARKET_LIVE=1), which this project has not done. Textile output is delivered to the signing wallet (the
// reactor pays msg.sender; there is no recipient parameter), so funding credits are only valid when the signing wallet is
// the marketplace custody wallet. See docs/MARKETPLACE-FUNDING.md.
import type { Address } from 'viem';
import { assetBySymbol } from './assets.ts';
import { boundedConfirmers } from './liveswap.ts';
import { authorizeConversion, planConversion } from './planner.ts';
import type { ConversionDeps, ConversionPlan } from './planner.ts';
import { runSwap } from './swapexec.ts';
import type { SwapDeps } from './swapexec.ts';
import { FundingOpError } from './marketfunding.ts';
import type { ConverterQuote, ExecuteResult, FundingConverter } from './marketfunding.ts';

export function createLiveFundingConverter(o: {
  wallet: Address;
  planDeps: ConversionDeps;
  /** Builds swap dependencies bound to the unlocked signing account; throws if no key is loaded. */
  makeSwapDeps(): SwapDeps;
  attributionTag: string;
  now?: () => number;
  log?: (line: string) => void;
}): FundingConverter {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const plans = new Map<string, ConversionPlan>();
  const sell = assetBySymbol('cNGN');
  const buy = assetBySymbol('USDT');
  if (!sell || !buy) throw new Error('cNGN or USDT is missing from the asset registry');

  return {
    mode: 'live',
    sellSymbol: 'cNGN',
    buySymbol: 'USDT',
    recipient: o.wallet,
    async quote({ sellAtomic }): Promise<ConverterQuote> {
      const plan = await planConversion(o.planDeps, { sell: 'cNGN', buy: 'USDT', sellAmountAtomic: sellAtomic, payer: o.wallet });
      if (!plan.executable || !plan.quote || (plan.status !== 'SWAP_REQUIRED' && plan.status !== 'APPROVAL_REQUIRED')) {
        throw new Error(`conversion is not available: ${plan.blockers.map((b) => b.code).join(', ') || plan.status}`);
      }
      plans.set(plan.planId, plan);
      return {
        quoteId: plan.planId,
        provider: plan.quote.provider,
        rate: plan.quote.rate,
        feeAtomic: plan.quote.feeAtomic,
        expectedBuyAtomic: plan.buy.expectedAtomic,
        minBuyAtomic: plan.buy.minAtomic,
        expiresAtMs: plan.validUntilMs,
        notes: [...plan.uncertainties],
      };
    },
    async execute({ opId, quoteId, sellAtomic, minBuyAtomic, digest }): Promise<ExecuteResult> {
      const plan = plans.get(quoteId);
      if (!plan) return { kind: 'failed', code: 'QUOTE_STALE', message: 'the quote is no longer held by this server (it restarted); request a new quote' };
      plans.delete(quoteId);
      let swapDeps: SwapDeps;
      try {
        swapDeps = o.makeSwapDeps();
      } catch {
        throw new FundingOpError('SIGNING_UNAVAILABLE', 'No wallet key is unlocked on this server, so it cannot convert. Unlock it first.');
      }
      let auth;
      try {
        auth = authorizeConversion(plan, { now: now(), approvedBy: `human:marketplace-funding:${opId}:${digest.slice(0, 16)}` });
      } catch (e) {
        return { kind: 'failed', code: 'NOT_AUTHORIZED', message: (e as Error).message };
      }
      const confirmers = boundedConfirmers(
        {
          sellSymbol: 'cNGN',
          sellAsset: sell.address,
          maxSellAtomic: sellAtomic,
          minReceiveAtomic: minBuyAtomic,
          spender: plan.allowance!.spender,
          attributionTag: o.attributionTag,
          minSecondsRemaining: 10,
        },
        log,
      );
      const outcome = await runSwap(auth, swapDeps, { confirm: confirmers.confirm, confirmApproval: confirmers.confirmApproval });
      if (outcome.kind === 'refused') return { kind: 'failed', code: outcome.code, message: outcome.message };
      const steps = outcome.record.steps;
      const approveTxs = steps.filter((s) => s.kind.startsWith('approve') && s.hash).map((s) => s.hash!);
      const swap = steps.find((s) => s.kind === 'swap' && s.hash);
      if (outcome.state === 'UNCERTAIN') return { kind: 'uncertain', ...(swap?.hash ? { swapTx: swap.hash } : {}), approveTxs, message: outcome.record.message };
      if (outcome.state === 'CONFIRMED' && swap?.hash) return { kind: 'submitted', swapTx: swap.hash, approveTxs };
      return { kind: 'failed', code: outcome.record.code, message: outcome.record.message };
    },
  };
}
