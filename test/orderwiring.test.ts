// Tests for the wiring scripts/order.ts uses: runner selection, confirmation gates, independent conversion
// verification and the converted-funds wait. Everything is faked: nothing is signed or sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import { mintSwapAuthorization } from '../src/authorization.ts';
import type { SwapAuthorization } from '../src/authorization.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { MENTO_PROVIDER, MENTO_ROUTER } from '../src/mento.ts';
import {
  SPENDER_BY_PROVIDER, TEXTILE_PROVIDER, WiringError, buildSwapRunners, createConversionVerifier, createFundsAwaiter, makeConfirmersFactory,
} from '../src/orderwiring.ts';
import type { ChainReader, Confirmers } from '../src/orderwiring.ts';
import type { SwapGates, SwapOutcome, SwapSummary } from '../src/swapexec.ts';
import type { SwapRecord } from '../src/swapjournal.ts';
import { NOW, PAYER, TAG, swapAuth } from './swapsupport.ts';

const USDT = assetBySymbol('USDT')!;
const CNGN = assetBySymbol('cNGN')!;

const quietTerminal = (): Confirmers => ({
  async confirm() {
    return { approved: false };
  },
  async confirmApproval() {
    return { approved: false };
  },
});

function mentoAuth(): SwapAuthorization {
  const usdm = assetBySymbol('USDm')!;
  return mintSwapAuthorization({
    planId: 'plan-mento', route: 'swap', serviceId: 'x.posts.search', payer: PAYER, chainId: 42220, provider: MENTO_PROVIDER,
    sell: { asset: usdm.address, symbol: 'USDm', decimals: 18, sellAmountAtomic: 1_015_267_685_224_275_700n, maxTakerPaysAtomic: 1_015_267_685_224_275_700n },
    buy: { asset: USDT.address, symbol: 'USDT', minBuyAtomic: 1_000_000n, expectedBuyAtomic: 1_016_319n },
    slippageBps: 100, createdAtMs: NOW, expiresAtMs: NOW + 600_000, approvedBy: 'test',
  });
}

const finished = (state: 'CONFIRMED'): SwapOutcome => ({ kind: 'finished', state, record: {} as SwapRecord });

// ------------------------------------------------------------------ confirmation gates
test('confirmers: --auto-confirm without explicit numeric limits is refused; non-interactive without --auto is refused', () => {
  const base = { attributionTag: TAG, line: () => undefined, terminal: quietTerminal };
  const noLimits = makeConfirmersFactory({ ...base, auto: true, isTTY: false });
  assert.throws(() => noLimits(TEXTILE_REACTOR, 'USDT', 'cNGN'), WiringError);
  const half = makeConfirmersFactory({ ...base, auto: true, maxSell: '1', isTTY: false });
  assert.throws(() => half(TEXTILE_REACTOR, 'USDT', 'cNGN'), /explicit numeric limits/);
  const bad = makeConfirmersFactory({ ...base, auto: true, maxSell: 'abc', minReceive: '1', isTTY: false });
  assert.throws(() => bad(TEXTILE_REACTOR, 'USDT', 'cNGN'), WiringError);
  const unknown = makeConfirmersFactory({ ...base, auto: true, maxSell: '1', minReceive: '1', isTTY: false });
  assert.throws(() => unknown(TEXTILE_REACTOR, 'USDT', 'NOPE'), /unknown asset/);
  const headless = makeConfirmersFactory({ ...base, auto: false, isTTY: false });
  assert.throws(() => headless(TEXTILE_REACTOR, 'USDT', 'cNGN'), /interactive terminal/);
});

test('confirmers: interactive mode returns the terminal confirmers; auto mode returns BOUNDED ones for the venue spender', async () => {
  let terminalUsed = 0;
  const interactive = makeConfirmersFactory({ attributionTag: TAG, line: () => undefined, auto: false, isTTY: true, terminal: () => (terminalUsed++, quietTerminal()) });
  interactive(TEXTILE_REACTOR, 'USDT', 'cNGN');
  assert.equal(terminalUsed, 1);

  const log: string[] = [];
  const auto = makeConfirmersFactory({ attributionTag: TAG, line: (s) => log.push(s), auto: true, maxSell: '1', minReceive: '1350', isTTY: false, terminal: quietTerminal });
  const c = auto(TEXTILE_REACTOR, 'USDT', 'cNGN');
  const summary = (over: Partial<SwapSummary> = {}): SwapSummary => ({
    sell: '', receive: '', fee: '', expiresAt: '', secondsRemaining: 40, sequenceReason: '',
    steps: [{ kind: 'swap', to: TEXTILE_REACTOR, taggedData: '0x', untaggedData: '0x' } as never],
    simulations: [{ step: 'swap', tagged: 'ok', untagged: 'ok', verdict: 'identical' }],
    gas: { estimatedCostWei: '1', nativeBalanceWei: '2' } as never, attributionTag: TAG, digest: 'abc', takerPays: '1000000', buyAmount: '1365928991',
    ...over,
  } as SwapSummary);
  assert.equal((await c.confirm(summary())).approved, true, 'inside the bounds');
  assert.equal((await c.confirm(summary({ takerPays: '1000001' }))).approved, false, 'debits more than --max-sell');
  assert.equal((await c.confirm(summary({ buyAmount: '1349000000' }))).approved, false, 'delivers less than --min-receive');
  assert.equal((await c.confirm(summary({ steps: [{ kind: 'swap', to: MENTO_ROUTER } as never] }))).approved, false, 'wrong spender/contract');
  assert.equal((await c.confirm(summary({ attributionTag: 'celo_other' }))).approved, false, 'wrong tag');
  assert.ok(log.some((l) => /DECLINED/.test(l)));
});

// ------------------------------------------------------------------ runners
test('runners: one per venue, each with its own spender, refusing an authorization minted for another venue', async () => {
  const seen: Array<{ runner: string; auth: string; spender: Address; sell: string; buy: string }> = [];
  const gatesBySpender: SwapGates = { confirm: async () => ({ approved: false }) };
  const runners = buildSwapRunners({
    makeSwapDeps: () => ({ marker: 'deps' }) as never,
    makeMentoVenue: () => ({ marker: 'venue' }),
    runTextile: async (auth, _deps, gates) => {
      assert.equal(gates.confirm, gatesBySpender.confirm);
      seen.push({ runner: 'textile', auth: auth.planId, spender: TEXTILE_REACTOR, sell: auth.sell.symbol, buy: auth.buy.symbol });
      return finished('CONFIRMED');
    },
    runMento: async (auth, venue, _deps, _gates) => {
      assert.deepEqual(venue, { marker: 'venue' });
      seen.push({ runner: 'mento', auth: auth.planId, spender: MENTO_ROUTER, sell: auth.sell.symbol, buy: auth.buy.symbol });
      return finished('CONFIRMED');
    },
    confirmersFor: (spender, sell, buy) => {
      seen.push({ runner: 'confirmers', auth: '', spender, sell, buy });
      return gatesBySpender as Confirmers;
    },
  });
  assert.deepEqual(Object.keys(runners).sort(), [MENTO_PROVIDER, TEXTILE_PROVIDER].sort());
  assert.equal(SPENDER_BY_PROVIDER[TEXTILE_PROVIDER], TEXTILE_REACTOR);
  assert.equal(SPENDER_BY_PROVIDER[MENTO_PROVIDER], MENTO_ROUTER);

  await runners[TEXTILE_PROVIDER]!(swapAuth());
  await runners[MENTO_PROVIDER]!(mentoAuth());
  const conf = seen.filter((s) => s.runner === 'confirmers');
  assert.deepEqual(conf.map((c) => [c.spender, c.sell, c.buy]), [
    [TEXTILE_REACTOR, 'cNGN', 'USDT'],
    [MENTO_ROUTER, 'USDm', 'USDT'],
  ]);
  assert.deepEqual(seen.filter((s) => s.runner !== 'confirmers').map((s) => s.runner), ['textile', 'mento']);

  // an authorization for the other venue is refused before any executor is called
  await assert.rejects(() => runners[MENTO_PROVIDER]!(swapAuth()), WiringError);
  await assert.rejects(() => runners[TEXTILE_PROVIDER]!(mentoAuth()), WiringError);
});

// ------------------------------------------------------------------ independent conversion verification
function reader(over: Partial<ChainReader> = {}): ChainReader {
  return {
    getReceipt: async () => undefined,
    latestBlock: async () => 100n,
    balanceAt: async () => 0n,
    balanceForPlanner: async () => 0n,
    ...over,
  };
}
const swapRec = (over: Partial<SwapRecord> = {}): SwapRecord =>
  ({
    planId: 's1',
    route: { sellSymbol: 'cNGN', sellAsset: CNGN.address, buySymbol: 'USDT', buyAsset: USDT.address, provider: 'x' },
    amounts: { requestedSell: '1', minBuy: '5000' },
    steps: [
      { kind: 'approve', hash: '0x' + '01'.repeat(32) },
      { kind: 'swap', hash: '0x' + '02'.repeat(32) },
    ],
    verification: { buyReceived: '1026000' },
    ...over,
  }) as unknown as SwapRecord;

test('conversion verifier: established only by a SUCCESSFUL swap tx that credited the buy asset to the wallet', async () => {
  const credit = (to: string, value: bigint, token = USDT.address) => [{ token, from: '0x00000000000000000000000000000000000000aa', to, value }];
  const ok = createConversionVerifier(reader({ getReceipt: async () => ({ status: 'success', blockNumber: 9n, transfers: credit(PAYER, 1_026_000n) }) }), PAYER);
  assert.equal((await ok(swapRec())).established, true);

  const reverted = createConversionVerifier(reader({ getReceipt: async () => ({ status: 'reverted', blockNumber: 9n, transfers: [] }) }), PAYER);
  assert.equal((await reverted(swapRec())).established, false);

  const missing = createConversionVerifier(reader(), PAYER);
  assert.match((await missing(swapRec())).detail, /not found on-chain/);

  const short = createConversionVerifier(reader({ getReceipt: async () => ({ status: 'success', blockNumber: 9n, transfers: credit(PAYER, 10n) }) }), PAYER);
  assert.equal((await short(swapRec())).established, false);

  const otherWallet = createConversionVerifier(reader({ getReceipt: async () => ({ status: 'success', blockNumber: 9n, transfers: credit('0x00000000000000000000000000000000000000bb', 1_026_000n) }) }), PAYER);
  assert.equal((await otherWallet(swapRec())).established, false);

  const wrongToken = createConversionVerifier(reader({ getReceipt: async () => ({ status: 'success', blockNumber: 9n, transfers: credit(PAYER, 1_026_000n, CNGN.address) }) }), PAYER);
  assert.equal((await wrongToken(swapRec())).established, false);

  const noHash = createConversionVerifier(reader(), PAYER);
  assert.equal((await noHash(swapRec({ steps: [] }))).established, false);
});

// ------------------------------------------------------------------ converted-funds wait
test('funds awaiter: waits (bounded) until BOTH the exact-block read and the planner view show the funds', async () => {
  let call = 0;
  const reads: bigint[] = [];
  const sleeps: number[] = [];
  const aw = createFundsAwaiter(
    reader({
      latestBlock: async () => 100n,
      getReceipt: async () => ({ status: 'success', blockNumber: 105n, transfers: [] }),
      balanceAt: async (_a, _o, block) => {
        reads.push(block);
        call += 1;
        return call >= 3 ? 1_026_000n : 0n; // the node catches up on the 3rd read
      },
      balanceForPlanner: async () => (call >= 4 ? 1_026_000n : 0n), // the planner's reader is later still
    }),
    { sleep: async (ms) => void sleeps.push(ms), attempts: 6, delayMs: 10 },
  );
  const r = await aw({ asset: USDT.address, owner: PAYER, minAtomic: 5_000n, txHashes: ['0x' + '02'.repeat(32)] });
  assert.equal(r.ok, true, r.detail);
  assert.ok(reads.every((b) => b === 105n), 'reads are anchored at max(latest block, swap block)');
  assert.ok(sleeps.length >= 2 && sleeps.length <= 5, `slept ${sleeps.length} times`);
});

test('funds awaiter: gives up after the bounded number of attempts and says what it saw', async () => {
  let sleeps = 0;
  const aw = createFundsAwaiter(reader({ balanceAt: async () => 0n, balanceForPlanner: async () => 0n }), {
    sleep: async () => void (sleeps += 1),
    attempts: 4,
    delayMs: 1,
  });
  const r = await aw({ asset: USDT.address, owner: PAYER, minAtomic: 5_000n, txHashes: [] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /attempt 4\/4/);
  assert.equal(sleeps, 3);
  // a reader that throws is also bounded and reported, never an exception
  const boom = createFundsAwaiter(reader({ latestBlock: async () => { throw new Error('rpc down'); } }), { sleep: async () => undefined, attempts: 2, delayMs: 1 });
  const b = await boom({ asset: USDT.address, owner: PAYER, minAtomic: 1n, txHashes: [] });
  assert.equal(b.ok, false);
  assert.match(b.detail, /rpc down/);
});

// ------------------------------------------------------------------ phase 3: lookup failures are not "not found"
test('chain reader: only a definitive "no such receipt" is absence; any other failure is thrown, never mistaken for it', async () => {
  const { createChainReader } = await import('../src/orderwiring.ts');
  const named = (name: string) => Object.assign(new Error(name), { name });
  const clientWith = (err: Error) =>
    createChainReader(
      {
        getTransactionReceipt: async () => {
          throw err;
        },
        getBlockNumber: async () => 1n,
        readContract: async () => 0n,
      } as never,
      async () => 0n,
    );
  assert.equal(await clientWith(named('TransactionReceiptNotFoundError')).getReceipt('0x' + '01'.repeat(32)), undefined);
  await assert.rejects(() => clientWith(new Error('fetch failed: socket hang up')).getReceipt('0x' + '01'.repeat(32)), /socket hang up/);
});

test('conversion verifier: an unreadable chain is RETRYABLE (not "not established"); a swap sent by another account is not established', async () => {
  const boom = createConversionVerifier(
    reader({ getReceipt: async () => { throw new Error('rpc timeout'); } }),
    PAYER,
  );
  const a = await boom(swapRec());
  assert.equal(a.established, false);
  assert.equal(a.retryable, true);
  assert.match(a.detail, /rpc timeout/);

  const other = '0x00000000000000000000000000000000000000cc';
  const sent = createConversionVerifier(
    reader({
      getReceipt: async () => ({
        status: 'success',
        blockNumber: 9n,
        from: other,
        transfers: [{ token: USDT.address, from: '0x00000000000000000000000000000000000000aa', to: PAYER, value: 1_026_000n }],
      }),
    }),
    PAYER,
  );
  const b = await sent(swapRec());
  assert.equal(b.established, false);
  assert.equal(b.retryable, undefined);
  assert.match(b.detail, /not by the wallet/);

  const mine = createConversionVerifier(
    reader({
      getReceipt: async () => ({
        status: 'success',
        blockNumber: 9n,
        from: PAYER,
        transfers: [{ token: USDT.address, from: '0x00000000000000000000000000000000000000aa', to: PAYER, value: 1_026_000n }],
      }),
    }),
    PAYER,
  );
  assert.equal((await mine(swapRec())).established, true);
});

// ------------------------------------------------------------------ chain reader over the resilient lookup
test('chain reader with resilient lookups: inconclusive outcomes THROW (retryable), only not_found is absence', async () => {
  const { createChainReader } = await import('../src/orderwiring.ts');
  const mk = (kind: string) =>
    createChainReader(
      { getTransactionReceipt: async () => { throw new Error('unused'); }, getBlockNumber: async () => 1n, readContract: async () => 0n } as never,
      async () => 0n,
      {
        endpoints: [],
        lookupTransaction: async () => ({ kind: 'not_found', attempts: 1, detail: 'x' }),
        lookupReceipt: async () => {
          if (kind === 'found') {
            return { kind: 'found', endpoints: ['a'], attempts: 1, receipt: { status: 'success', blockNumber: 9n, blockHash: '0x1', transactionHash: '0x2', from: PAYER, logs: [] } };
          }
          if (kind === 'not_found') return { kind: 'not_found', attempts: 5, detail: 'nobody knows it' };
          if (kind === 'insufficient_agreement') return { kind: 'insufficient_agreement', agreed: 1, needed: 2, attempts: 5, receipt: {} };
          return { kind, detail: `${kind} detail`, attempts: 5 };
        },
      } as never,
    );
  const found = await mk('found').getReceipt('0x' + '01'.repeat(32));
  assert.equal(found?.status, 'success');
  assert.equal(found?.blockNumber, 9n);
  assert.equal(await mk('not_found').getReceipt('0x' + '01'.repeat(32)), undefined);
  for (const k of ['receipt_unavailable', 'conflict', 'error', 'insufficient_agreement']) {
    await assert.rejects(() => mk(k).getReceipt('0x' + '01'.repeat(32)), /inconclusive/, k);
  }
});

test('conversion verifier + resilient reader: a pruned receipt is RETRYABLE, never "not established"', async () => {
  const { createChainReader } = await import('../src/orderwiring.ts');
  const reader = createChainReader(
    { getTransactionReceipt: async () => { throw new Error('unused'); }, getBlockNumber: async () => 1n, readContract: async () => 0n } as never,
    async () => 0n,
    {
      endpoints: [],
      lookupTransaction: async () => ({ kind: 'found' }),
      lookupReceipt: async () => ({ kind: 'receipt_unavailable', blockNumber: 79_963_003n, attempts: 5, detail: 'pruned on the nodes asked' }),
    } as never,
  );
  const v = await createConversionVerifier(reader, PAYER)(swapRec());
  assert.equal(v.established, false);
  assert.equal(v.retryable, true);
});
