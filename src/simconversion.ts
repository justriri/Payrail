// SIMULATED multi-asset Textile provider (Stage 1). No network, no wallets, no money.
//
// Its route table is a snapshot of what Textile's public ladder and previews showed on 2026-10-14 (see
// docs/MULTI-CURRENCY-ARCHITECTURE.md): deep symmetric corridors, thin ones, a fundable-but-not-payable asset (wMXN)
// and a listed-but-empty one (G$). Prices are simulation constants, not live rates. Execution writes FAKE chain receipts
// that go through the same verification code as a live conversion.
import { toEventSelector } from 'viem';
import { TRANSFER_TOPIC } from './funding.ts';
import type { ChainLog, ChainReader, ChainReceipt } from './funding.ts';
import { USDT_CELO } from './conversion.ts';
import type { AssetRef, ConversionProvider, ConversionQuote, Direction, Route, UnavailableReason } from './conversion.ts';
import type { ExecuteResult, FundingConverter } from './marketfunding.ts';

const FILL = toEventSelector('Fill(bytes32,address,address,uint256)');
const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const OTHER = `0x${'0'.repeat(34)}0b0b0b`;
const OTHER_TOKEN = `0x${'0'.repeat(34)}c0ffee`;
const E6 = 1_000_000n;

interface SimAsset {
  ref: AssetRef;
  /** units of this asset per 1 USDT (simulation constant) */
  perUsdt: number;
  funding: { available: boolean; maxUsd: number; reason?: UnavailableReason };
  payout: { available: boolean; maxUsd: number; reason?: UnavailableReason };
  feeBps: number;
}
const A = (symbol: string, address: string, decimals: number): AssetRef => ({ chainId: 42220, address, symbol, decimals });

export const SIM_ASSETS: SimAsset[] = [
  { ref: A('cNGN', '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', 6), perUsdt: 1364, funding: { available: true, maxUsd: 70_000 }, payout: { available: true, maxUsd: 3_300 }, feeBps: 30 },
  { ref: A('wARS', '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', 18), perUsdt: 1611, funding: { available: true, maxUsd: 70_000 }, payout: { available: true, maxUsd: 3_900 }, feeBps: 10 },
  { ref: A('wBRL', '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', 18), perUsdt: 5.04, funding: { available: true, maxUsd: 70_000 }, payout: { available: true, maxUsd: 95_000 }, feeBps: 10 },
  { ref: A('USDC', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 6), perUsdt: 1.001, funding: { available: true, maxUsd: 2_400 }, payout: { available: true, maxUsd: 1_000 }, feeBps: 10 },
  { ref: A('USAT', '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', 6), perUsdt: 1, funding: { available: true, maxUsd: 95_000 }, payout: { available: true, maxUsd: 4_800 }, feeBps: 10 },
  { ref: A('wCOP', '0x8a1D45e102e886510e891d2Ec656a708991e2D76', 18), perUsdt: 3181, funding: { available: true, maxUsd: 95_000 }, payout: { available: true, maxUsd: 5_000 }, feeBps: 10 },
  { ref: A('CELO', '0x471EcE3750Da237f93B8E339c536989b8978a438', 18), perUsdt: 11.4, funding: { available: true, maxUsd: 69_000 }, payout: { available: true, maxUsd: 33 }, feeBps: 10 },
  { ref: A('WETH', '0xD221812de1BD094f35587EE8E174B07B6167D9Af', 18), perUsdt: 0.00041, funding: { available: true, maxUsd: 4_000 }, payout: { available: true, maxUsd: 55 }, feeBps: 10 },
  { ref: A('IDRX', '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', 2), perUsdt: 1789, funding: { available: true, maxUsd: 100_000 }, payout: { available: false, maxUsd: 2, reason: 'no_valid_quote' }, feeBps: 10 },
  { ref: A('wMXN', '0x337E7456B420bD3481e7FA61fA9850343d610d34', 18), perUsdt: 18.5, funding: { available: true, maxUsd: 200 }, payout: { available: false, maxUsd: 0, reason: 'no_makers_online' }, feeBps: 10 },
  { ref: A('G$', '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A', 18), perUsdt: 3181, funding: { available: false, maxUsd: 0, reason: 'no_levels' }, payout: { available: false, maxUsd: 0, reason: 'no_levels' }, feeBps: 10 },
];

export const SIM_FLOOR_USD = 1;
export const SIM_SLIPPAGE_BPS = 100n;
const pow10 = (n: number) => 10n ** BigInt(n);
const perMicro = (a: SimAsset) => BigInt(Math.round(a.perUsdt * 1e6)); // asset units per USDT, scaled 1e6

/** USDT atomic value of `inAtomic` of the asset (funding side, before fee). */
const usdtValueOf = (a: SimAsset, inAtomic: bigint) => (inAtomic * 10n ** 12n) / (perMicro(a) * pow10(a.ref.decimals));
/** asset atomic amount equal to `u` USDT atomic. */
const assetFromUsdt = (a: SimAsset, u: bigint) => (u * perMicro(a) * pow10(a.ref.decimals)) / 10n ** 12n;

export const SIM_PAYOUT_SCENARIOS = ['ok', 'reverted', 'short', 'wrong_token', 'wrong_recipient', 'delivery_missing', 'delivery_reverted', 'uncertain', 'refused', 'slow'] as const;
export const SIM_FUNDING_SCENARIOS = ['ok', 'reverted', 'short', 'wrong_token', 'wrong_recipient', 'no_fill', 'deposit_missing', 'deposit_short', 'uncertain', 'refused', 'slow', 'quote_unavailable'] as const;

export interface SimProviderOptions {
  reactor: string;
  now?: () => number;
  quoteTtlMs?: number;
  /** how many confirmations a normal fake receipt already has */
  confirmedDepth?: number;
  /** the fake chain gains a block on every head read (local demo, so 'slow' completes by re-checking) */
  autoAdvanceOnRead?: boolean;
}

export interface SimProvider extends ConversionProvider {
  reader: ChainReader;
  reactor: string;
  executions: { funding: number; payout: number };
  advance(blocks: number): void;
  landLate(txHash: string): void;
  receipts: Map<string, ChainReceipt>;
  assets: SimAsset[];
  /** buyer funding converter for one source asset (USDT -> passthrough) */
  fundingConverter(asset: AssetRef, o: { taker: string; depositAddress: string; mode?: 'simulated' }): FundingConverter;
  /** custody-bounded payout execution (simulated): swap in custody, then deliver to the verified address */
  executePayout(a: { quote: ConversionQuote; custody: string; deliveryAddress: string; scenario?: string }): Promise<
    | { kind: 'submitted'; conversionTx: string; deliveryTx: string | null }
    | { kind: 'failed'; code: string; message: string }
    | { kind: 'uncertain'; conversionTx: string; message: string }
  >;
  /** simulated retry of only the delivery leg after a swap that was verified */
  retryDelivery(a: { token: AssetRef; custody: string; deliveryAddress: string; amountAtomic: bigint }): { deliveryTx: string };
}

export function createSimProvider(o: SimProviderOptions): SimProvider {
  const now = o.now ?? Date.now;
  const depth = BigInt(o.confirmedDepth ?? 12);
  const receipts = new Map<string, ChainReceipt>();
  const pending = new Map<string, () => ChainReceipt>();
  let head = 100_000n;
  let seq = 0;
  const hash = (tag: string) => `0x${(++seq).toString(16).padStart(8, '0')}${tag.repeat(28).slice(0, 56)}`;
  const reader: ChainReader = { blockNumber: async () => { if (o.autoAdvanceOnRead) head += 1n; return head; }, receipt: async (h) => receipts.get(h.toLowerCase()) ?? null };

  const fill = (filler: string): ChainLog => ({ address: o.reactor, topics: [FILL, pad('0x' + 'ab'.repeat(32)).slice(0, 66), pad(filler), pad(OTHER)], data: word(1n), logIndex: 0 });
  const transfer = (token: string, from: string, to: string, amount: bigint, logIndex = 1): ChainLog => ({ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount), logIndex });
  const bySymbol = (sym: string) => SIM_ASSETS.find((a) => a.ref.symbol === sym);
  const byRef = (r: AssetRef) => SIM_ASSETS.find((a) => a.ref.address.toLowerCase() === r.address.toLowerCase());

  const self: SimProvider = {
    id: 'textile-rfq (SIMULATED)',
    simulated: true,
    reader,
    reactor: o.reactor,
    executions: { funding: 0, payout: 0 },
    receipts,
    assets: SIM_ASSETS,
    advance: (n) => { head += BigInt(n); },
    landLate: (h) => {
      const mk = pending.get(h.toLowerCase());
      if (!mk) throw new Error('no pending simulated transaction');
      receipts.set(h.toLowerCase(), mk());
    },

    async discoverRoutes(direction: Direction): Promise<Route[]> {
      return SIM_ASSETS.map((a) => {
        const side = direction === 'funding' ? a.funding : a.payout;
        const floorAsset = assetFromUsdt(a, SIM_FLOOR_USD * Number(E6) > 0 ? BigInt(SIM_FLOOR_USD) * E6 : 1n);
        const maxAsset = assetFromUsdt(a, BigInt(Math.round(side.maxUsd)) * E6);
        const from = direction === 'funding' ? a.ref : USDT_CELO;
        const to = direction === 'funding' ? USDT_CELO : a.ref;
        return {
          provider: self.id,
          direction,
          from,
          to,
          available: side.available,
          ...(side.reason ? { unavailableReason: side.reason } : {}),
          minInputAtomic: direction === 'funding' ? floorAsset : BigInt(SIM_FLOOR_USD) * E6,
          maxInputAtomic: direction === 'funding' ? maxAsset : BigInt(Math.round(side.maxUsd)) * E6,
          discoveredAt: now(),
        };
      });
    },

    async quote({ direction, from, to, inputAtomic, scenario }): Promise<ConversionQuote> {
      if (scenario === 'quote_unavailable') throw new Error('Textile did not return a quote (simulated)');
      const a = byRef(direction === 'funding' ? from : to);
      if (!a) throw new Error('this asset is not listed by the provider');
      const side = direction === 'funding' ? a.funding : a.payout;
      if (!side.available) throw new Error(`no route: ${side.reason ?? 'unavailable'}`);
      const usdtIn = direction === 'funding' ? usdtValueOf(a, inputAtomic) : inputAtomic;
      if (usdtIn < BigInt(SIM_FLOOR_USD) * E6) throw new Error('below the provider minimum (about $1 of notional)');
      if (usdtIn > BigInt(Math.round(side.maxUsd)) * E6) throw new Error(`above the indicative depth for this route (about $${side.maxUsd})`);
      const bps = BigInt(a.feeBps);
      let expected: bigint;
      let fee: bigint;
      if (direction === 'funding') {
        fee = (inputAtomic * bps) / 10_000n;
        expected = usdtValueOf(a, inputAtomic - fee);
      } else {
        const gross = assetFromUsdt(a, inputAtomic);
        fee = (gross * bps) / 10_000n;
        expected = gross - fee;
      }
      const min = expected - (expected * SIM_SLIPPAGE_BPS) / 10_000n;
      return {
        id: `simq_${++seq}_${now()}`,
        provider: self.id,
        direction,
        from,
        to,
        inputAtomic,
        expectedOutputAtomic: expected,
        minOutputAtomic: min,
        feeAtomic: fee,
        rate: `1 USDT = ${a.perUsdt} ${a.ref.symbol}`,
        expiresAtMs: now() + (o.quoteTtlMs ?? 60_000),
        notes: ['SIMULATED quote: prices are simulation constants; nothing real is converted or sent.'],
      };
    },

    fundingConverter(asset, { taker, depositAddress }): FundingConverter {
      const isUsdt = asset.symbol === 'USDT';
      const a = isUsdt ? undefined : byRef(asset);
      if (!isUsdt && !a) throw new Error('unknown asset');
      return {
        mode: 'simulated',
        sellSymbol: asset.symbol,
        buySymbol: 'USDT',
        sellDecimals: asset.decimals,
        sellChainId: asset.chainId,
        sellAddress: asset.address,
        passthrough: isUsdt,
        recipient: taker,
        depositAddress,
        async quote({ sellAtomic, scenario }) {
          if (isUsdt) {
            return { quoteId: `simq_${++seq}_${now()}`, provider: 'none (already USDT)', rate: '1 USDT = 1 USDT', feeAtomic: 0n, expectedBuyAtomic: sellAtomic, minBuyAtomic: sellAtomic, expiresAtMs: now() + (o.quoteTtlMs ?? 60_000), notes: ['No conversion needed: only the deposit to the marketplace is verified.'] };
          }
          const q = await self.quote({ direction: 'funding', from: asset, to: USDT_CELO, inputAtomic: sellAtomic, ...(scenario ? { scenario } : {}) });
          return { quoteId: q.id, provider: q.provider, rate: q.rate, feeAtomic: q.feeAtomic, expectedBuyAtomic: q.expectedOutputAtomic, minBuyAtomic: q.minOutputAtomic, expiresAtMs: q.expiresAtMs, notes: q.notes };
        },
        async execute({ sellAtomic, minBuyAtomic, scenario }): Promise<ExecuteResult> {
          self.executions.funding += 1;
          const sc = scenario ?? 'ok';
          if (sc === 'refused') return { kind: 'failed', code: 'QUOTE_REFUSED', message: 'the maker declined to fill (simulated)' };
          const expected = isUsdt ? sellAtomic : usdtValueOf(a!, sellAtomic - (sellAtomic * BigInt(a!.feeBps)) / 10_000n);
          const confirmed = head - depth;
          const base = { blockNumber: sc === 'slow' ? head : confirmed };
          const swapTx = isUsdt ? null : hash('5a');
          const depositTx = hash('d0');
          const approveTx = hash('a5');
          if (swapTx) {
            const swapAmount = sc === 'short' ? minBuyAtomic - 1n : expected;
            const logs: ChainLog[] =
              sc === 'wrong_token' ? [fill(taker), transfer(OTHER_TOKEN, OTHER, taker, expected)]
                : sc === 'wrong_recipient' ? [fill(taker), transfer(USDT_CELO.address, OTHER, OTHER, expected)]
                  : sc === 'no_fill' ? [transfer(USDT_CELO.address, OTHER, taker, expected)]
                    : sc === 'reverted' ? []
                      : [fill(taker), transfer(USDT_CELO.address, OTHER, taker, swapAmount)];
            const mk = (): ChainReceipt => ({ status: sc === 'reverted' ? 'reverted' : 'success', ...base, logs });
            if (sc === 'uncertain') {
              pending.set(swapTx.toLowerCase(), () => ({ status: 'success', blockNumber: head, logs: [fill(taker), transfer(USDT_CELO.address, OTHER, taker, expected)] }));
              const dep = hash('d0');
              pending.set(dep.toLowerCase(), () => ({ status: 'success', blockNumber: head, logs: [transfer(USDT_CELO.address, taker, depositAddress, expected)] }));
              return { kind: 'uncertain', swapTx, approveTxs: [approveTx], message: 'the transaction was sent but no confirmation was received (simulated)' };
            }
            receipts.set(swapTx.toLowerCase(), mk());
            if (sc === 'reverted' || sc === 'wrong_token' || sc === 'wrong_recipient' || sc === 'no_fill' || sc === 'short') {
              // the deposit is never attempted when the conversion is not good
              return { kind: 'submitted', swapTx, approveTxs: [approveTx] };
            }
          }
          if (sc === 'deposit_missing') return { kind: 'submitted', swapTx, approveTxs: [approveTx] };
          const depAmount = sc === 'deposit_short' ? expected / 2n : expected;
          receipts.set(depositTx.toLowerCase(), { status: 'success', ...base, logs: [transfer(USDT_CELO.address, taker, depositAddress, depAmount)] });
          return { kind: 'submitted', swapTx, approveTxs: [approveTx], depositTx };
        },
      };
    },

    async executePayout({ quote, custody, deliveryAddress, scenario }) {
      self.executions.payout += 1;
      const sc = scenario ?? 'ok';
      if (sc === 'refused') return { kind: 'failed', code: 'QUOTE_REFUSED', message: 'the maker declined to fill (simulated)' };
      const a = byRef(quote.to);
      if (!a) return { kind: 'failed', code: 'UNKNOWN_ASSET', message: 'the target asset is not known to the provider' };
      const token = quote.to.address;
      const received = sc === 'short' ? quote.minOutputAtomic - 1n : quote.expectedOutputAtomic;
      const base = { blockNumber: sc === 'slow' ? head : head - depth };
      const conversionTx = hash('5b');
      const deliveryTx = hash('d1');
      if (sc === 'reverted') {
        receipts.set(conversionTx.toLowerCase(), { status: 'reverted', ...base, logs: [] });
        return { kind: 'submitted', conversionTx, deliveryTx: null };
      }
      if (sc === 'uncertain') {
        pending.set(conversionTx.toLowerCase(), () => ({ status: 'success', blockNumber: head, logs: [fill(custody), transfer(token, OTHER, custody, quote.expectedOutputAtomic)] }));
        return { kind: 'uncertain', conversionTx, message: 'the swap was sent but no confirmation was received (simulated)' };
      }
      const logs: ChainLog[] =
        sc === 'wrong_token' ? [fill(custody), transfer(OTHER_TOKEN, OTHER, custody, received)] : [fill(custody), transfer(token, OTHER, custody, received)];
      receipts.set(conversionTx.toLowerCase(), { status: 'success', ...base, logs });
      if (sc === 'delivery_missing') return { kind: 'submitted', conversionTx, deliveryTx: null };
      if (sc === 'delivery_reverted') {
        receipts.set(deliveryTx.toLowerCase(), { status: 'reverted', ...base, logs: [] });
        return { kind: 'submitted', conversionTx, deliveryTx };
      }
      const to = sc === 'wrong_recipient' ? OTHER : deliveryAddress;
      receipts.set(deliveryTx.toLowerCase(), { status: 'success', ...base, logs: [transfer(token, custody, to, received)] });
      return { kind: 'submitted', conversionTx, deliveryTx };
    },

    retryDelivery({ token, custody, deliveryAddress, amountAtomic }) {
      const deliveryTx = hash('d2');
      receipts.set(deliveryTx.toLowerCase(), { status: 'success', blockNumber: head - depth, logs: [transfer(token.address, custody, deliveryAddress, amountAtomic)] });
      return { deliveryTx };
    },
  };
  void bySymbol;
  return self;
}
