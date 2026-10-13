// Fixtures and mocks for the swap path. NOTHING here touches a network, a real key, or real funds.
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import { mintSwapAuthorization } from '../src/authorization.ts';
import type { SwapAuthorization } from '../src/authorization.ts';
import { TEXTILE_PREFERRED_FILLER, TEXTILE_REACTOR } from '../src/config.ts';
import { encodeLimitOrder, executeAbi, executeBatchAbi } from '../src/reactor.ts';
import type { DecodedLimitOrder } from '../src/reactor.ts';
import type { ChainReceipt, MinedTx, SimResult, SwapChain, SwapDeps, SwapTextile } from '../src/swapexec.ts';
import type { SequenceStep, QuotedSwap } from '../src/swapquote.ts';
import { secret } from '../src/textile.ts';
import type { FirmQuoteResult, RfqStatusName } from '../src/textile.ts';

export const TAG = 'celo_b2fff2ac9413';
export const NOW = 1_800_000_000_000;
export const PAYER: Address = getAddress('0x652c9023626d1a00ad0d130c9cdc5c5f3644d2a4');
export const MAKER: Address = getAddress('0x00000000000000000000000000000000000000b1');
export const OTHER: Address = getAddress('0x00000000000000000000000000000000000000aa');
export const CNGN = assetBySymbol('cNGN')!;
export const USDT = assetBySymbol('USDT')!;
export const CLAIM = 'SECRET-CLAIM-TOKEN-do-not-log';

export const SELL = 1_400_000_000n; // 1,400 cNGN (6 decimals)
export const BUY = 1_026_000n; // 1.026 USDT
export const FEE = 140_000n;
export const PRICE = 5_000n; // 0.005 USDT service price

export function swapAuth(over: Partial<{ planId: string; sell: bigint; maxPays: bigint; minBuy: bigint; expectedBuy: bigint; expiresAtMs: number; payer: Address; slippageBps: number }> = {}): SwapAuthorization {
  return mintSwapAuthorization({
    planId: over.planId ?? 'plan-swap-1',
    route: 'swap',
    serviceId: 'x.posts.search',
    payer: over.payer ?? PAYER,
    chainId: 42220,
    provider: 'textile-fx-v2',
    sell: {
      asset: CNGN.address,
      symbol: 'cNGN',
      decimals: 6,
      sellAmountAtomic: over.sell ?? SELL,
      maxTakerPaysAtomic: over.maxPays ?? over.sell ?? SELL,
    },
    buy: { asset: USDT.address, symbol: 'USDT', minBuyAtomic: over.minBuy ?? PRICE, expectedBuyAtomic: over.expectedBuy ?? BUY },
    slippageBps: over.slippageBps ?? 100,
    createdAtMs: NOW,
    expiresAtMs: over.expiresAtMs ?? NOW + 600_000,
    approvedBy: 'test',
  });
}

export function goodOrder(over: Partial<DecodedLimitOrder> = {}): DecodedLimitOrder {
  return {
    reactor: TEXTILE_REACTOR,
    swapper: MAKER,
    nonce: 1n,
    deadline: BigInt(Math.floor(NOW / 1000) + 300),
    // Real Textile orders restrict fills to the taker with the verified PreferredFillerValidation contract.
    validationContract: TEXTILE_PREFERRED_FILLER,
    validationData: encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256' }], [[PAYER], BigInt(Math.floor(NOW / 1000) + 60)]),
    input: { token: USDT.address, amount: BUY, maxAmount: BUY },
    outputs: [{ token: CNGN.address, amount: SELL - FEE, recipient: MAKER }],
    ...over,
  };
}

export interface QuoteOver {
  order?: Partial<DecodedLimitOrder>;
  orderBytes?: Hex;
  swapData?: Hex;
  approveData?: Hex;
  approvalTo?: Address;
  swapTo?: Address;
  spender?: Address | undefined;
  reactor?: Address;
  taker?: Address;
  sellAmount?: bigint;
  buyAmount?: bigint;
  feeAmount?: bigint;
  takerPays?: bigint;
  expiresInMs?: number;
  noExpiry?: boolean;
  chainId?: number;
  value?: string;
  ordersCount?: number;
  approveAmount?: bigint;
  /** 'executeBatch' (default, what the live API returns) or the single-order 'execute'. */
  swapKind?: 'execute' | 'executeBatch';
}

export function goodQuote(over: QuoteOver = {}): QuotedSwap {
  const takerPays = over.takerPays ?? SELL;
  const order = over.orderBytes ?? encodeLimitOrder(goodOrder(over.order));
  // Textile's real quotes put the single order through executeBatch (selector 0x0d7a16c3), not execute().
  const swapData =
    over.swapData ??
    (over.swapKind === 'execute'
      ? encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [{ order, sig: '0x1234' }] })
      : encodeFunctionData({ abi: executeBatchAbi, functionName: 'executeBatch', args: [[{ order, sig: '0x1234' }]] }));
  const approveData =
    over.approveData ??
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEXTILE_REACTOR, over.approveAmount ?? takerPays] });
  const chainId = over.chainId ?? 42220;
  return {
    kind: 'quoted',
    spender: 'spender' in over ? over.spender : TEXTILE_REACTOR,
    encodedOrder: order,
    ordersCount: over.ordersCount ?? 1,
    claimToken: secret(CLAIM),
    id: 'rfq_test_1',
    idField: 'rfqId',
    status: 'quoted',
    sellAmount: over.sellAmount ?? SELL,
    buyAmount: over.buyAmount ?? BUY,
    feeAmount: over.feeAmount ?? FEE,
    takerPays,
    reactor: over.reactor ?? TEXTILE_REACTOR,
    taker: over.taker ?? PAYER,
    approval: { to: over.approvalTo ?? CNGN.address, data: approveData, value: over.value ?? '0', chainId },
    swap: { to: over.swapTo ?? TEXTILE_REACTOR, data: swapData, value: over.value ?? '0', chainId },
    deadlines: over.noExpiry ? {} : { expiresAt: new Date(NOW + (over.expiresInMs ?? 45_000)).toISOString() },
    hasClaimToken: true,
    topLevelKeys: [],
    quoteKeys: [],
    notes: [],
    requestId: undefined,
  };
}

// ------------------------------------------------------------------ mock chain

export interface ChainBehavior {
  /** What happens when a step is broadcast. */
  broadcast?: (step: SequenceStep, n: number) => 'ok' | 'throw';
  /** What the receipt looks like for a step once broadcast. */
  receipt?: (step: SequenceStep, n: number) => 'success' | 'reverted' | 'missing';
  /** Override simulation. */
  simulate?: (data: Hex, to: Address, tagged: boolean) => SimResult;
  /** Make the mined tx differ from what was signed. */
  mismatchMined?: boolean;
  /** Make the swap's on-chain effects wrong. */
  badEffects?: boolean;
  /** Approval mines but does not raise the allowance. */
  approveIneffective?: boolean;
  /** Called after each successful broadcast (used to advance the clock). */
  onBroadcast?: (step: SequenceStep) => void;
  /** An unrelated extra debit of the sell token that happens during the swap (reconciliation should catch it). */
  extraDebit?: bigint;
  /** After the swap executes, this many balance reads still return the pre-swap state (a lagging RPC node). */
  staleReads?: number;
  /** Replace the default (Textile cNGN->USDT) swap effect, e.g. for an AMM swap. */
  effect?: { sellToken: Address; sellAmount: bigint; buyToken: Address; buyAmount: bigint; counterparty: Address; fill: boolean };
}

export class MockChain implements SwapChain {
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  native = 500_000_000_000_000_000n;
  gas = 25_000_000_000n;
  chain = 42220;
  broadcasts: Array<{ kind: string; hash: Hex; data: Hex }> = [];
  simulations: Array<{ to: Address; tagged: boolean; data: Hex }> = [];
  prepared = 0;
  private txs = new Map<string, { step: SequenceStep; n: number; hash: Hex; sent: boolean }>();
  private receipts = new Map<string, ChainReceipt | undefined>();
  behavior: ChainBehavior;
  /** Set in a test to enable the optional read-only allowance-override simulation. */
  simulateWithAllowance?: SwapChain['simulateWithAllowance'];
  constructor(behavior: ChainBehavior = {}) {
    this.behavior = behavior;
    this.balances.set(CNGN.address.toLowerCase(), 2_000_000_000n);
    this.balances.set(USDT.address.toLowerCase(), 600_000n);
  }
  setAllowance(v: bigint) {
    this.allowances.set(`${CNGN.address}:${TEXTILE_REACTOR}`.toLowerCase(), v);
  }
  async chainId() {
    return this.chain;
  }
  /** Balances as they were just before the swap executed (what a lagging node would still report). */
  preSwap: Map<string, bigint> | undefined;
  /** After a swap, this many `tokenBalance` reads return the PRE-swap state (a load-balanced node that lags). */
  staleReads = 0;
  async tokenBalance(token: Address) {
    if (this.preSwap && this.staleReads > 0) {
      this.staleReads -= 1;
      return this.preSwap.get(token.toLowerCase()) ?? 0n;
    }
    return this.balances.get(token.toLowerCase()) ?? 0n;
  }
  async allowanceAt(token: Address, _owner: Address, spender: Address, _block: bigint) {
    return this.allowances.get(`${token}:${spender}`.toLowerCase()) ?? 0n;
  }
  async nativeBalanceAt(_owner: Address, _block: bigint) {
    return this.native;
  }
  /** Exact-block read: the pre-swap state before the swap block, the real state from it onwards. */
  async tokenBalanceAt(token: Address, _owner: Address, blockNumber: bigint) {
    if (this.preSwap && blockNumber < 3n) return this.preSwap.get(token.toLowerCase()) ?? 0n;
    return this.balances.get(token.toLowerCase()) ?? 0n;
  }
  async allowance(token: Address, _o: Address, spender: Address) {
    return this.allowances.get(`${token}:${spender}`.toLowerCase()) ?? 0n;
  }
  async nativeBalance() {
    return this.native;
  }
  async gasPrice() {
    return this.gas;
  }
  async simulate(call: { from: Address; to: Address; data: Hex }): Promise<SimResult> {
    // a tagged call is any whose data ends with the ERC-8021 marker
    const tagged = call.data.toLowerCase().endsWith('80218021802180218021802180218021');
    this.simulations.push({ to: call.to, tagged, data: call.data });
    if (this.behavior.simulate) return this.behavior.simulate(call.data, call.to, tagged);
    return { ok: true, returnData: '0x01', gas: 60_000n };
  }
  async prepare(step: SequenceStep) {
    this.prepared += 1;
    const n = this.prepared;
    const hash = (`0x${n.toString(16).padStart(64, '0')}`) as Hex;
    this.txs.set(hash, { step, n, hash, sent: false });
    return {
      hash,
      nonce: 100 + n,
      broadcast: async () => {
        const mode = this.behavior.broadcast?.(step, n) ?? 'ok';
        if (mode === 'throw') throw new Error('socket hang up');
        this.broadcasts.push({ kind: step.kind, hash, data: step.taggedData });
        this.txs.get(hash)!.sent = true;
        this.applyEffects(step, hash, n);
        this.behavior.onBroadcast?.(step);
        return hash;
      },
    };
  }
  private applyEffects(step: SequenceStep, hash: Hex, n: number) {
    const rcpt = this.behavior.receipt?.(step, n) ?? 'success';
    if (rcpt === 'missing') {
      this.receipts.set(hash, undefined);
      return;
    }
    if (rcpt === 'reverted') {
      this.receipts.set(hash, { status: 'reverted', blockNumber: 1n, gasUsed: 50_000n, effectiveGasPrice: 30_000_000_000n, transfers: [], fills: [] });
      return;
    }
    if (step.kind === 'approve' || step.kind === 'approve_reset') {
      if (!this.behavior.approveIneffective) {
        const d = decodeFunctionData({ abi: erc20Abi, data: step.data });
        const [spender, amount] = d.args as readonly [Address, bigint];
        this.allowances.set(`${step.to}:${spender}`.toLowerCase(), amount);
      }
      this.receipts.set(hash, { status: 'success', blockNumber: 2n, gasUsed: 56_000n, effectiveGasPrice: 30_000_000_000n, transfers: [], fills: [] });
      return;
    }
    // swap
    this.preSwap = new Map(this.balances);
    {
      const sellTok = (this.behavior.effect ? this.behavior.effect.sellToken : CNGN.address).toLowerCase();
      const spent = this.behavior.effect ? this.behavior.effect.sellAmount : SELL;
      for (const [k, v] of this.allowances) if (k.startsWith(sellTok + ':')) this.allowances.set(k, v > spent ? v - spent : 0n);
    }
    if (this.behavior.staleReads !== undefined) this.staleReads = this.behavior.staleReads;
    if (this.behavior.effect) {
      const e = this.behavior.effect;
      const bad2 = this.behavior.badEffects === true;
      const got = bad2 ? 1n : e.buyAmount;
      const sk = e.sellToken.toLowerCase();
      const bk = e.buyToken.toLowerCase();
      this.balances.set(sk, (this.balances.get(sk) ?? 0n) - e.sellAmount - (this.behavior.extraDebit ?? 0n));
      this.balances.set(bk, (this.balances.get(bk) ?? 0n) + got);
      this.receipts.set(hash, {
        status: 'success',
        blockNumber: 3n,
        gasUsed: 220_000n,
        effectiveGasPrice: 30_000_000_000n,
        transfers: [
          { token: e.sellToken, from: PAYER, to: e.counterparty, value: e.sellAmount },
          { token: e.buyToken, from: e.counterparty, to: PAYER, value: got },
        ],
        fills: e.fill ? [{ reactor: TEXTILE_REACTOR, filler: PAYER, swapper: e.counterparty }] : [],
      });
      return;
    }
    const bad = this.behavior.badEffects === true;
    const received = bad ? 1n : BUY;
    this.balances.set(USDT.address.toLowerCase(), (this.balances.get(USDT.address.toLowerCase()) ?? 0n) + received);
    this.balances.set(CNGN.address.toLowerCase(), (this.balances.get(CNGN.address.toLowerCase()) ?? 0n) - SELL - (this.behavior.extraDebit ?? 0n));
    this.receipts.set(hash, {
      status: 'success',
      blockNumber: 3n,
      gasUsed: 300_000n,
      effectiveGasPrice: 30_000_000_000n,
      transfers: [
        { token: CNGN.address, from: PAYER, to: MAKER, value: SELL - FEE },
        { token: CNGN.address, from: PAYER, to: OTHER, value: FEE },
        { token: USDT.address, from: MAKER, to: PAYER, value: received },
      ],
      fills: bad ? [] : [{ reactor: TEXTILE_REACTOR, filler: PAYER, swapper: MAKER }],
    });
  }
  async getReceipt(hash: Hex) {
    return this.receipts.get(hash);
  }
  async getTransaction(hash: Hex): Promise<MinedTx | undefined> {
    const t = this.txs.get(hash);
    if (!t || !t.sent) return undefined;
    const input = this.behavior.mismatchMined ? ((t.step.taggedData.slice(0, -2) + '00') as Hex) : t.step.taggedData;
    return { from: PAYER, to: t.step.to, input, value: 0n };
  }
}

// ------------------------------------------------------------------ textile mock + deps

export class CrashError extends Error {}

export interface Harness {
  deps: SwapDeps;
  chain: MockChain;
  quotes: { requested: number; cancelled: string[] };
  logs: string[];
  clock: { now: number };
}

export function harness(opts: {
  dir: string;
  quote?: FirmQuoteResult | (() => FirmQuoteResult) | Error;
  chain?: ChainBehavior;
  statuses?: RfqStatusName[];
  attribution?: 'ok' | 'none';
  allowance?: bigint;
  crashOnSleep?: boolean;
  limits?: Partial<SwapDeps['limits']>;
  chainObj?: MockChain;
  /** Make the venue's cancel endpoint fail. */
  cancelFails?: boolean;
}): Harness {
  const chain = opts.chainObj ?? new MockChain(opts.chain);
  if (opts.chain && opts.chainObj) chain.behavior = opts.chain;
  if (opts.allowance !== undefined) chain.setAllowance(opts.allowance);
  const quotes = { requested: 0, cancelled: [] as string[] };
  const logs: string[] = [];
  const clock = { now: NOW };
  const statuses = [...(opts.statuses ?? ['filled'])];
  const textile: SwapTextile = {
    async firmQuote() {
      quotes.requested += 1;
      const q = opts.quote ?? goodQuote();
      if (q instanceof Error) throw q;
      return typeof q === 'function' ? q() : q;
    },
    async cancel(id: string) {
      quotes.cancelled.push(id);
      if (opts.cancelFails) throw new Error('venue unreachable');
    },
    async status() {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return {
        status: s,
        txHash: undefined,
        filledAt: undefined,
        failReason: s === 'failed' ? 'not_landed' : undefined,
        lateFillCorrectionClosed: false,
        sellAmount: undefined,
        buyAmount: undefined,
        feeAmount: undefined,
      };
    },
  };
  const deps: SwapDeps = {
    now: () => clock.now,
    async sleep(ms) {
      if (opts.crashOnSleep) throw new CrashError('simulated process crash');
      clock.now += ms;
    },
    chain,
    textile,
    takerProof: async () => ({ nonce: ('0x' + '11'.repeat(32)) as Hex, issuedAt: clock.now, signature: '0xdeadbeef' as Hex }),
    verifyAttribution: async () => (opts.attribution === 'none' ? null : { codes: [TAG], schemaId: 0 }),
    signer: PAYER,
    receiptDir: opts.dir,
    attributionTag: TAG,
    lock: { staleAfterMs: 60_000 },
    limits: { receiptTimeoutMs: 30_000, pollMs: 1_000, statusPolls: 3, ...(opts.limits ?? {}) },
    log: (l) => logs.push(l),
  };
  return { deps, chain, quotes, logs, clock };
}

export const approveYes = async () => ({ approved: true, approvedBy: 'human:test' });
export const approveNo = async () => ({ approved: false });
