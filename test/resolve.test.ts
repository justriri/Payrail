// The first live swap ended UNCERTAIN only because a lagging RPC node reported pre-swap balances right after
// the receipt. These tests reproduce that exact condition and the safe ways out of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetBySymbol } from '../src/assets.ts';
import { mintSwapAuthorization } from '../src/authorization.ts';
import { listPending } from '../src/history.ts';
import { MENTO_PROVIDER, MENTO_ROUTER, createMentoVenue } from '../src/mento.ts';
import type { ReadClient } from '../src/mento.ts';
import { resolveSwapRecord, runAmmSwap, runSwap } from '../src/swapexec.ts';
import type { SwapOutcome } from '../src/swapexec.ts';
import { loadSwapRecord } from '../src/swapjournal.ts';
import { tempDir } from './support.ts';
import { MockChain, NOW, PAYER, SELL, TAG, approveYes, harness, swapAuth } from './swapsupport.ts';
import { getAddress } from 'viem';

const finished = (o: SwapOutcome) => {
  assert.equal(o.kind, 'finished', o.kind === 'refused' ? `${o.code}: ${o.message}` : '');
  return o.kind === 'finished' ? o : (undefined as never);
};

const USDM = assetBySymbol('USDm')!;
const USDT = assetBySymbol('USDT')!;
const AMM_SELL = 1_015_267_685_224_275_700n;
const AMM_OUT = 1_016_308n;
const POOL = getAddress('0x0FEBa760d93423D127DE1B6ABECdB60E5253228D');

// ------------------------------------------------------------------ lag tolerance inside the pipeline
test('a node that lags for a few reads after the swap does not turn a good swap into UNCERTAIN', async () => {
  const chain = new MockChain({ staleReads: 3 });
  chain.tokenBalanceAt = undefined as never; // force the "re-read until it moves" path
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.equal(o.record.balances.sellAfter, '600000000');
});

test('with exact-block reads available, lag is irrelevant', async () => {
  const chain = new MockChain({ staleReads: 1_000 }); // would stay stale forever on "latest"
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
});

test('a node that NEVER catches up still ends UNCERTAIN (fail closed), with a precise reason', async () => {
  const chain = new MockChain({ staleReads: 1_000 });
  chain.tokenBalanceAt = undefined as never;
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'RECONCILIATION_MISMATCH');
  assert.equal(listPending(h.deps.receiptDir).length, 1);
});

// ------------------------------------------------------------------ resolving from the chain
async function uncertainRun() {
  const dir = tempDir();
  const chain = new MockChain({ staleReads: 1_000 });
  chain.tokenBalanceAt = undefined as never;
  const h = harness({ dir, chainObj: chain, allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  // the node has now caught up: restore exact-block reads
  chain.staleReads = 0;
  chain.tokenBalanceAt = MockChain.prototype.tokenBalanceAt;
  return { dir, chain, h };
}

test('resolve: an UNCERTAIN swap whose chain evidence is complete becomes CONFIRMED and unblocks everything', async () => {
  const { dir, chain } = await uncertainRun();
  assert.equal(listPending(dir).length, 1);
  const r = await resolveSwapRecord({
    dir, planId: 'plan-swap-1', payer: PAYER, chain,
    verifyAttribution: async () => ({ codes: [TAG], schemaId: 0 }), attributionTag: TAG,
  });
  assert.equal(r.resolved, true, r.notes.join('; '));
  assert.equal(r.state, 'CONFIRMED');
  assert.equal(r.record.code, 'CONFIRMED_BY_REVERIFICATION');
  assert.equal(listPending(dir).length, 0, 'the pending journal is cleared');
  assert.equal(loadSwapRecord(dir, 'plan-swap-1')!.state, 'CONFIRMED');
  assert.ok(r.record.steps.every((s) => s.attribution?.verified === true));
});

test('resolve: it does NOT promote when the evidence is missing or inconsistent', async () => {
  const mk = async () => uncertainRun();
  const args = (u: Awaited<ReturnType<typeof mk>>, over: Record<string, unknown> = {}) => ({
    dir: u.dir, planId: 'plan-swap-1', payer: PAYER, chain: u.chain,
    verifyAttribution: async () => ({ codes: [TAG], schemaId: 0 }), attributionTag: TAG, ...over,
  });

  // (a) no exact-block balance reads
  const a = await mk();
  (a.chain as { tokenBalanceAt?: unknown }).tokenBalanceAt = undefined;
  const ra = await resolveSwapRecord(args(a) as never);
  assert.equal(ra.resolved, false);
  assert.ok(ra.notes[0]!.includes('exact block'));

  // (b) the wallet's balance does not equal the logged transfers
  const b = await mk();
  b.chain.balances.set(USDT.address.toLowerCase(), (b.chain.balances.get(USDT.address.toLowerCase()) ?? 0n) + 7n);
  const rb = await resolveSwapRecord(args(b) as never);
  assert.equal(rb.resolved, false);
  assert.ok(rb.notes[0]!.includes('do not equal the logged transfers'));
  assert.equal(rb.state, 'UNCERTAIN');

  // (c) the swap hit an unexpected contract
  const c = await mk();
  const rc = await resolveSwapRecord(args(c, { expectSwapTarget: '0x00000000000000000000000000000000000000aa' }) as never);
  assert.equal(rc.resolved, false);
  assert.ok(rc.notes[0]!.includes('not the expected'));

  // (d) attribution is reported as it is, not assumed (the swap still reconciles)
  const d = await mk();
  const rd = await resolveSwapRecord(args(d, { verifyAttribution: async () => null }) as never);
  assert.equal(rd.state, 'CONFIRMED');
  assert.ok(rd.record.steps.every((s) => s.attribution?.verified === false));
});

test('resolve: a reverted transaction resolves to FAILED; a missing receipt stays UNCERTAIN; resolved records are left alone', async () => {
  const u = await uncertainRun();
  const missing = await resolveSwapRecord({
    dir: u.dir, planId: 'plan-swap-1', payer: PAYER, chain: { ...u.chain, getReceipt: async () => undefined } as never,
    verifyAttribution: async () => null, attributionTag: TAG,
  });
  assert.equal(missing.resolved, false);
  assert.equal(missing.state, 'UNCERTAIN');
  assert.ok(listPending(u.dir).length === 1);

  const reverted = await resolveSwapRecord({
    dir: u.dir, planId: 'plan-swap-1', payer: PAYER,
    chain: { ...u.chain, getReceipt: async () => ({ status: 'reverted', blockNumber: 3n, gasUsed: 1n, transfers: [], fills: [] }), getTransaction: u.chain.getTransaction.bind(u.chain) } as never,
    verifyAttribution: async () => null, attributionTag: TAG,
  });
  assert.equal(reverted.state, 'FAILED');
  assert.equal(listPending(u.dir).length, 0);

  const again = await resolveSwapRecord({ dir: u.dir, planId: 'plan-swap-1', payer: PAYER, chain: u.chain, verifyAttribution: async () => null, attributionTag: TAG });
  assert.equal(again.resolved, false);
  assert.deepEqual(again.notes, ['already resolved']);
});

test('resolve: an unknown plan is an error, not a silent success', async () => {
  await assert.rejects(resolveSwapRecord({ dir: tempDir(), planId: 'nope', payer: PAYER, chain: new MockChain(), verifyAttribution: async () => null, attributionTag: TAG }), /no swap record/);
});

// ------------------------------------------------------------------ the AMM pipeline has the same lag tolerance
test('AMM swap with a lagging node: confirmed once the read catches up; exact-block resolve works for it too', async () => {
  const chain = new MockChain({
    effect: { sellToken: USDM.address, sellAmount: AMM_SELL, buyToken: USDT.address, buyAmount: AMM_OUT, counterparty: POOL, fill: false },
    staleReads: 2,
  });
  chain.tokenBalanceAt = undefined as never;
  chain.balances.set(USDM.address.toLowerCase(), AMM_SELL);
  chain.balances.set(USDT.address.toLowerCase(), 624_915n);
  chain.allowances.set(`${USDM.address}:${MENTO_ROUTER}`.toLowerCase(), AMM_SELL);
  const h = harness({ dir: tempDir(), chainObj: chain });
  const client: ReadClient = { async readContract() { return [AMM_SELL, AMM_OUT] as readonly bigint[]; } };
  const auth = mintSwapAuthorization({
    planId: 'amm-lag', route: 'swap', serviceId: 'convert:USDm->USDT', payer: PAYER, chainId: 42220, provider: MENTO_PROVIDER,
    sell: { asset: USDM.address, symbol: 'USDm', decimals: 18, sellAmountAtomic: AMM_SELL, maxTakerPaysAtomic: AMM_SELL },
    buy: { asset: USDT.address, symbol: 'USDT', minBuyAtomic: 1_000_000n, expectedBuyAtomic: AMM_OUT },
    slippageBps: 100, createdAtMs: NOW, expiresAtMs: NOW + 600_000, approvedBy: 'test',
  });
  const o = finished(await runAmmSwap(auth, createMentoVenue(client), h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.equal(o.record.balances.buyAfter, (624_915n + AMM_OUT).toString());
});
