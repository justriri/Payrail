// Runtime glue for asset-agnostic funding: builds the per-asset, per-buyer FundingConfig from a discovered route,
// and recovers in-flight operations after a restart. STAGE 1: the provider is simulated, and so is each buyer's "wallet"
// (a deterministic address derived from the buyer id). No keys exist anywhere in this path.
import { createHash } from 'node:crypto';
import { query } from './db.ts';
import type { Db } from './db.ts';
import type { AssetRef, RouteRegistry, RouteView } from './conversion.ts';
import { USDT_CELO } from './conversion.ts';
import type { FundingConfig, FundingOp } from './marketfunding.ts';
import { getFundingOp, parkSimulatedAfterRestart, verifyAndCredit } from './marketfunding.ts';
import type { ChainReader } from './funding.ts';
import type { SimProvider } from './dev/simconversion.ts';
import type { PayoutConversionConfig } from './payoutconv.ts';
import type { BuyerSwapRuntime } from './buyerswap.ts';

export interface ConversionRuntime {
  registry: RouteRegistry;
  provider: SimProvider;
  reader: ChainReader;
  reactor: string;
  usdt: string;
  chainId: number;
  minConfirmations: number;
  /** ledger asset credited by funding (the TEST asset while simulated) */
  creditAsset: string;
  /** custody address the buyer deposits USDT to */
  depositAddress: string;
  maxPerDayBuyAtomic: bigint;
  /** simulated payouts only: present when seller payout conversion is available */
  payout?: PayoutConversionConfig;
  simulated: boolean;
  /** present only when buyer-signed (client-side) conversion is enabled; the buyer's wallet signs every transaction */
  buyerSwap?: BuyerSwapRuntime;
}

/** A deterministic stand-in for "the buyer's own wallet" in simulation. A live design uses the wallet the buyer proved. */
export const simBuyerWallet = (buyerId: string): string => `0x${createHash('sha256').update(`sim-buyer-wallet:${buyerId}`).digest('hex').slice(0, 40)}`;

export function fundingConfigFor(rt: ConversionRuntime, asset: AssetRef, buyerId: string, limits?: { min: bigint; max: bigint }, wallet?: string): FundingConfig {
  const isUsdt = asset.symbol === 'USDT';
  return {
    // the wallet the buyer PROVED they control, when there is one; the stand-in only exists in simulation
    converter: rt.buyerSwap && !rt.simulated
      // a real runtime never falls back to a stand-in wallet: without a proven wallet the quote is refused upstream
      ? rt.buyerSwap.converterFor(isUsdt ? USDT_CELO : asset, { taker: wallet ?? '0x0000000000000000000000000000000000000000', depositAddress: rt.depositAddress })
      : rt.provider.fundingConverter(isUsdt ? USDT_CELO : asset, { taker: wallet ?? simBuyerWallet(buyerId), depositAddress: rt.depositAddress }),
    reader: rt.reader,
    usdt: rt.usdt,
    reactor: rt.reactor,
    chainId: rt.chainId,
    minConfirmations: rt.minConfirmations,
    limits: {
      minSellAtomic: limits?.min ?? 1n,
      maxSellAtomic: limits?.max ?? 10n ** 30n,
      maxPerDaySellAtomic: (limits?.max ?? 10n ** 30n) * 5n,
      maxOpenOps: 3,
    },
    creditAsset: rt.creditAsset,
    maxPerDayBuyAtomic: rt.maxPerDayBuyAtomic,
  };
}

export const routeLimits = (r: RouteView) => ({ min: r.minInputAtomic, max: r.maxInputAtomic });

export function fundingConfigForOp(rt: ConversionRuntime, op: FundingOp): FundingConfig {
  const asset: AssetRef = op.sellSymbol === 'USDT'
    ? USDT_CELO
    : { chainId: op.sellChainId ?? rt.chainId, address: op.sellAddress ?? '', symbol: op.sellSymbol, decimals: op.sellDecimals };
  return fundingConfigFor(rt, asset, op.buyerId, undefined, op.taker ?? undefined);
}

/** Re-examine every unfinished operation (any asset). Never fails an unseen transaction, never credits twice. */
export async function recoverAllFunding(db: Db, rt: ConversionRuntime, now: () => number = Date.now, o: { atStartup?: boolean } = {}): Promise<Array<{ id: string; from: string; to: string }>> {
  const out: Array<{ id: string; from: string; to: string }> = [];
  for (const r of query(db, "SELECT id, state FROM funding_ops WHERE state IN ('CONVERTING','VERIFYING','UNRESOLVED')")) {
    const op = getFundingOp(db, String(r.id))!;
    let after = await verifyAndCredit(db, fundingConfigForOp(rt, op), op.id, now);
    // a simulated chain does not survive a restart: park what it can no longer confirm
    if (o.atStartup && rt.simulated && ['CONVERTING', 'VERIFYING', 'UNRESOLVED'].includes(after.state)) after = parkSimulatedAfterRestart(db, op.id, now);
    if (after.state !== r.state) out.push({ id: after.id, from: String(r.state), to: after.state });
  }
  return out;
}
