// BUYER-SIGNED conversion. The server never holds the buyer's key and never signs for them:
//   1. the buyer's wallet signs Textile's TakerControl proof (EIP-712) in the browser,
//   2. the server asks Textile for a FIRM quote bound to that wallet and validates every field of it
//      (taker, reactor, spender, exact approval, single order, amounts, expiry, calldata) with the same code the
//      operator pipeline uses (validateFirmQuote / buildSequence),
//   3. the server returns only validated, attribution-tagged transaction steps; the buyer's wallet sends them,
//   4. the buyer reports transaction hashes; the funding engine verifies the receipts independently before any credit.
// Textile pays the signing wallet, so the converted USDT lands in the buyer's own wallet and must then be sent to the
// marketplace address FROM that wallet; only that verified transfer is credited.
//
// STATUS: built and tested against fakes. NOT exercised against the live Textile network.
import type { Address, Hex } from 'viem';
import { TEXTILE_REACTOR } from './config.ts';
import type { SwapAuthorization } from './authorization.ts';
import type { AssetRef, ConversionProvider } from './conversion.ts';
import { USDT_CELO } from './conversion.ts';
import type { ConverterQuote, FundingConverter, FundingOp } from './marketfunding.ts';
import { buildSequence, validateFirmQuote } from './swapquote.ts';
import type { FirmQuoteResult, TakerProof } from './textile.ts';

export interface PreparedStep {
  kind: 'approve_reset' | 'approve' | 'swap';
  to: Address;
  /** attribution-tagged calldata exactly as it must be sent; value is always 0 */
  data: Hex;
}
export type PrepareResult =
  | { kind: 'ready'; quoteId: string; expiresAtMs: number; steps: PreparedStep[]; takerPays: string; buyAmount: string; feeAmount: string; notes: string[] }
  | { kind: 'no_quote'; reason: string }
  | { kind: 'rejected'; problems: string[]; expired: boolean };

export interface BuyerSwapDeps {
  firmQuote(a: { chainId: number; sellToken: Address; buyToken: Address; sellAmount: bigint; taker: Address; takerProof: TakerProof }): Promise<FirmQuoteResult>;
  getAllowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  provider: ConversionProvider;
  chainId: number;
  tag: string;
  now?: () => number;
  /** the quote must leave at least this long to sign and send (default 25 s) */
  minRemainingMs?: number;
}

export interface BuyerSwapRuntime {
  converterFor(asset: AssetRef, o: { taker: string; depositAddress: string }): FundingConverter;
  prepare(a: { op: FundingOp; wallet: string; sell: AssetRef; proof: TakerProof }): Promise<PrepareResult>;
}

export function createBuyerSwapRuntime(deps: BuyerSwapDeps): BuyerSwapRuntime {
  const now = deps.now ?? Date.now;
  return {
    converterFor(asset, { taker, depositAddress }): FundingConverter {
      const isUsdt = asset.symbol === 'USDT';
      return {
        mode: 'live',
        sellSymbol: asset.symbol,
        buySymbol: 'USDT',
        sellDecimals: asset.decimals,
        sellChainId: asset.chainId,
        sellAddress: asset.address,
        passthrough: isUsdt,
        clientSigned: true,
        recipient: taker,
        depositAddress,
        async quote({ sellAtomic }): Promise<ConverterQuote> {
          if (isUsdt) {
            return { quoteId: `usdt_${now()}`, provider: 'none (already USDT)', rate: '1 USDT = 1 USDT', feeAtomic: 0n, expectedBuyAtomic: sellAtomic, minBuyAtomic: sellAtomic, expiresAtMs: now() + 10 * 60_000, notes: ['No conversion needed: only your deposit to the marketplace is verified.'] };
          }
          const q = await deps.provider.quote({ direction: 'funding', from: asset, to: USDT_CELO, inputAtomic: sellAtomic });
          return { quoteId: q.id, provider: q.provider, rate: q.rate, feeAtomic: q.feeAtomic, expectedBuyAtomic: q.expectedOutputAtomic, minBuyAtomic: q.minOutputAtomic, expiresAtMs: q.expiresAtMs, notes: [...q.notes, 'Your own wallet signs every step. A firm quote is requested only when you start signing.'] };
        },
        async execute() {
          // never reached: approveFunding does not call execute for a clientSigned converter
          return { kind: 'failed', code: 'NOT_ALLOWED', message: 'this conversion is signed by the buyer, not by the server' };
        },
      };
    },

    async prepare({ op, wallet, sell, proof }): Promise<PrepareResult> {
      const t = now();
      const auth: SwapAuthorization = {
        planId: op.id,
        route: 'swap',
        serviceId: 'marketplace-funding',
        payer: wallet as Address,
        chainId: deps.chainId,
        provider: 'textile-fx-v2',
        sell: { asset: sell.address as Address, symbol: sell.symbol, decimals: sell.decimals, sellAmountAtomic: op.sellAtomic, maxTakerPaysAtomic: op.sellAtomic },
        buy: { asset: USDT_CELO.address as Address, symbol: 'USDT', minBuyAtomic: op.minAtomic, expectedBuyAtomic: op.expectedAtomic },
        slippageBps: 100,
        createdAtMs: t,
        expiresAtMs: t + 120_000,
        approvedBy: `buyer:${op.buyerId}:${op.approvalDigest.slice(0, 16)}`,
      };
      const q = await deps.firmQuote({ chainId: deps.chainId, sellToken: auth.sell.asset, buyToken: auth.buy.asset, sellAmount: op.sellAtomic, taker: wallet as Address, takerProof: proof });
      if (q.kind === 'no_quote') return { kind: 'no_quote', reason: q.reason ?? 'no market maker is quoting this route right now' };
      const v = validateFirmQuote(auth, q, { nowMs: t, chainId: deps.chainId, minRemainingMs: deps.minRemainingMs ?? 25_000, maxFeeBps: 100 });
      if (!v.ok) return { kind: 'rejected', problems: v.problems, expired: v.expired };
      if (q.reactor.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) return { kind: 'rejected', problems: ['reactor is not the verified Textile reactor'], expired: false };
      const allowance = await deps.getAllowance(auth.sell.asset, wallet as Address, (q.spender ?? q.reactor) as Address);
      const seq = buildSequence({ auth, quote: q, currentAllowance: allowance, tag: deps.tag });
      return {
        kind: 'ready',
        quoteId: q.id,
        expiresAtMs: v.expiresAtMs!,
        steps: seq.steps.map((s) => ({ kind: s.kind, to: s.to, data: s.taggedData })),
        takerPays: q.takerPays.toString(),
        buyAmount: q.buyAmount.toString(),
        feeAmount: q.feeAmount.toString(),
        notes: [seq.reason, ...v.notes],
      };
    },
  };
}
