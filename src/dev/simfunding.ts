// SIMULATED Textile conversion for marketplace funding. No network, no wallet, no money.
// It produces fake quotes and fake chain receipts that go through the SAME verification code as a live conversion
// (verifyConversion), so every funding rule is exercised. Anything it credits is labelled simulated and is credited in the
// TEST asset only.
import { toEventSelector } from 'viem';
import { TRANSFER_TOPIC } from '../funding.ts';
import type { ChainLog, ChainReader, ChainReceipt } from '../funding.ts';
import type { ConverterQuote, ExecuteResult, FundingConverter } from '../marketfunding.ts';
import { FundingOpError } from '../marketfunding.ts';

export const SIM_RECIPIENT = `0x${'0'.repeat(34)}51aa11`;
const OTHER_ADDRESS = `0x${'0'.repeat(34)}0b0b0b`;
const OTHER_TOKEN = `0x${'0'.repeat(34)}c0ffee`;
const FILL = toEventSelector('Fill(bytes32,address,address,uint256)');
const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

/** USDT per 1 cNGN is 1/RATE_CNGN_PER_USDT. Observed live rates were close to this; it is a simulation constant. */
export const SIM_CNGN_PER_USDT = 1364n;
export const SIM_FEE_BPS = 30n;
export const SIM_SLIPPAGE_BPS = 100n;

export const SIM_SCENARIOS = ['ok', 'reverted', 'uncertain', 'short', 'wrong_token', 'wrong_recipient', 'no_fill', 'slow', 'refused', 'quote_unavailable'] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

export interface SimFunding {
  converter: FundingConverter;
  reader: ChainReader;
  /** test hook: add confirmations */
  advance(blocks: number): void;
  /** test hook: make a pending/uncertain transaction appear on the fake chain as a good fill */
  landLate(txHash: string): void;
  receipts: Map<string, ChainReceipt>;
  executions: number;
}

export function createSimFunding(o: { usdt: string; reactor: string; quoteTtlMs?: number; now?: () => number; recipient?: string; confirmedDepth?: number; cngnBalanceAtomic?: bigint; /** the chain gains a block on every status check (used by the local demo so 'slow' completes) */ autoAdvanceOnRead?: boolean }): SimFunding {
  const now = o.now ?? Date.now;
  const recipient = o.recipient ?? SIM_RECIPIENT;
  const receipts = new Map<string, ChainReceipt>();
  const pendingBuy = new Map<string, bigint>();
  let head = 10_000n;
  let seq = 0;
  const autoAdvance = o.autoAdvanceOnRead === true;
  let cngn = o.cngnBalanceAtomic;
  const depth = BigInt(o.confirmedDepth ?? 12);
  const sim: SimFunding = { converter: undefined as never, reader: undefined as never, receipts, executions: 0, advance: (n) => { head += BigInt(n); }, landLate: () => undefined };

  const reader: ChainReader = {
    async blockNumber() {
      if (autoAdvance) head += 1n;
      return head;
    },
    async receipt(hash) {
      return receipts.get(hash.toLowerCase()) ?? null;
    },
  };

  const fillLog = (filler: string): ChainLog => ({ address: o.reactor, topics: [FILL, pad('0x' + 'ab'.repeat(32)).slice(0, 66), pad(filler), pad(OTHER_ADDRESS)], data: word(1n), logIndex: 0 });
  const transferLog = (token: string, to: string, amount: bigint, logIndex = 1): ChainLog => ({ address: token, topics: [TRANSFER_TOPIC, pad(OTHER_ADDRESS), pad(to)], data: word(amount), logIndex });

  const converter: FundingConverter = {
    mode: 'simulated',
    sellSymbol: 'cNGN',
    buySymbol: 'USDT',
    recipient,
    async quote({ sellAtomic, scenario }) {
      if (scenario === 'quote_unavailable') throw new Error('Textile did not return a quote (simulated)');
      if (cngn !== undefined && sellAtomic > cngn) throw new Error('insufficient cNGN balance (simulated wallet)');
      const afterFee = sellAtomic - (sellAtomic * SIM_FEE_BPS) / 10_000n;
      const expected = afterFee / SIM_CNGN_PER_USDT;
      const min = expected - (expected * SIM_SLIPPAGE_BPS) / 10_000n;
      const q: ConverterQuote = {
        quoteId: `simq_${++seq}_${now()}`,
        provider: 'textile-fx-v2 (SIMULATED)',
        rate: `1 USDT = ${SIM_CNGN_PER_USDT} cNGN`,
        feeAtomic: (sellAtomic * SIM_FEE_BPS) / 10_000n,
        expectedBuyAtomic: expected,
        minBuyAtomic: min,
        expiresAtMs: now() + (o.quoteTtlMs ?? 60_000),
        notes: ['SIMULATED quote: no real conversion will take place and no real USDT will be received.'],
      };
      return q;
    },
    async execute({ sellAtomic, minBuyAtomic, scenario }): Promise<ExecuteResult> {
      sim.executions += 1;
      const sc = (scenario ?? 'ok') as SimScenario;
      if (sc === 'refused') return { kind: 'failed', code: 'QUOTE_REFUSED', message: 'the maker declined to fill (simulated)' };
      const afterFee = sellAtomic - (sellAtomic * SIM_FEE_BPS) / 10_000n;
      const expected = afterFee / SIM_CNGN_PER_USDT;
      const hash = `0x${(++seq).toString(16).padStart(8, '0')}${'5a'.repeat(28)}`;
      const approveTx = `0x${(++seq).toString(16).padStart(8, '0')}${'a5'.repeat(28)}`;
      // already-confirmed by default; the 'slow' scenario is mined at the head and needs the chain to advance
      const base = { blockNumber: sc === 'slow' ? head : head - depth };
      if (cngn !== undefined && !['reverted', 'refused', 'uncertain'].includes(sc)) cngn -= sellAtomic;
      switch (sc) {
        case 'ok':
          receipts.set(hash, { status: 'success', ...base, logs: [fillLog(recipient), transferLog(o.usdt, recipient, expected)] });
          break;
        case 'slow':
          receipts.set(hash, { status: 'success', ...base, logs: [fillLog(recipient), transferLog(o.usdt, recipient, expected)] });
          // confirmations arrive when the chain advances (tests call advance(); the local demo advances on each status check)
          break;
        case 'reverted':
          receipts.set(hash, { status: 'reverted', ...base, logs: [] });
          break;
        case 'short':
          receipts.set(hash, { status: 'success', ...base, logs: [fillLog(recipient), transferLog(o.usdt, recipient, minBuyAtomic - 1n)] });
          break;
        case 'wrong_token':
          receipts.set(hash, { status: 'success', ...base, logs: [fillLog(recipient), transferLog(OTHER_TOKEN, recipient, expected)] });
          break;
        case 'wrong_recipient':
          receipts.set(hash, { status: 'success', ...base, logs: [fillLog(recipient), transferLog(o.usdt, OTHER_ADDRESS, expected)] });
          break;
        case 'no_fill':
          receipts.set(hash, { status: 'success', ...base, logs: [transferLog(o.usdt, recipient, expected)] });
          break;
        case 'uncertain':
          pendingBuy.set(hash, expected);
          return { kind: 'uncertain', swapTx: hash, approveTxs: [approveTx], message: 'the transaction was sent but no confirmation was received (simulated)' };
        default:
          break;
      }
      return { kind: 'submitted', swapTx: hash, approveTxs: [approveTx] };
    },
  };
  sim.converter = converter;
  sim.reader = reader;
  sim.landLate = (hash) => {
    const expected = pendingBuy.get(hash.toLowerCase()) ?? pendingBuy.get(hash);
    if (expected === undefined) throw new FundingOpError('NOT_FOUND', 'no pending simulated transaction');
    receipts.set(hash.toLowerCase(), { status: 'success', blockNumber: head, logs: [fillLog(recipient), transferLog(o.usdt, recipient, expected)] });
  };
  return sim;
}
