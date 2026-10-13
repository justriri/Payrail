// Tests for the approval-before-quote flow, balance/gas reconciliation and the pre-approval simulation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { listPending } from '../src/history.ts';
import { runSwap } from '../src/swapexec.ts';
import type { ApprovalSummary, SwapOutcome, SwapSummary } from '../src/swapexec.ts';
import { tempDir } from './support.ts';
import { MockChain, SELL, approveNo, approveYes, goodQuote, harness, swapAuth } from './swapsupport.ts';

const finished = (o: SwapOutcome) => {
  assert.equal(o.kind, 'finished', o.kind === 'refused' ? `${o.code}: ${o.message}` : '');
  return o.kind === 'finished' ? o : (undefined as never);
};

// ------------------------------------------------------------------ approval BEFORE the quote
test('before-quote: the approval is sent and verified BEFORE any firm quote is requested', async () => {
  const log: string[] = [];
  const chain = new MockChain({ onBroadcast: (s) => log.push(`broadcast:${s.kind}`) });
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: 0n, quote: () => (log.push('quote'), goodQuote()) });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.deepEqual(log, ['broadcast:approve', 'quote', 'broadcast:swap']);
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve', 'swap']);
});

test('before-quote: the two confirmations are separate and each sees its own transactions', async () => {
  const seen: { approval?: ApprovalSummary; swap?: SwapSummary } = {};
  const h = harness({ dir: tempDir(), allowance: 0n });
  h.deps.approvalPhase = 'before-quote';
  await runSwap(swapAuth(), h.deps, {
    confirmApproval: async (s) => ((seen.approval = s), { approved: true, approvedBy: 'human:a' }),
    confirm: async (s) => ((seen.swap = s), { approved: true, approvedBy: 'human:s' }),
  });
  assert.deepEqual(seen.approval?.steps.map((s) => s.kind), ['approve']);
  assert.deepEqual(seen.swap?.steps.map((s) => s.kind), ['swap'], 'by the time of the swap confirmation the approval is already done');
  assert.notEqual(seen.approval?.digest, seen.swap?.digest);
  assert.equal(seen.approval?.amountAtomic, SELL.toString(), 'exactly the sell amount, never unlimited');
});

test('before-quote: declining the approval sends nothing and requests no quote', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes, confirmApproval: approveNo }));
  assert.equal(o.record.code, 'DECLINED');
  assert.equal(h.chain.prepared, 0);
  assert.equal(h.quotes.requested, 0);
});

test('before-quote: an approval is never sent without an approval confirmation callback', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.record.code, 'APPROVAL_CONFIRMATION_REQUIRED');
  assert.equal(h.chain.prepared, 0);
  assert.equal(h.quotes.requested, 0);
});

test('before-quote: with a sufficient allowance there is no approval prompt at all', async () => {
  let prompted = false;
  const h = harness({ dir: tempDir(), allowance: SELL });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes, confirmApproval: async () => ((prompted = true), { approved: true }) }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(prompted, false);
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['swap']);
});

test('before-quote: a reverted or ineffective approval means NO quote is ever requested', async () => {
  const reverted = harness({ dir: tempDir(), allowance: 0n, chain: { receipt: () => 'reverted' } });
  reverted.deps.approvalPhase = 'before-quote';
  const a = finished(await runSwap(swapAuth(), reverted.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(a.record.code, 'APPROVAL_REVERTED');
  assert.equal(reverted.quotes.requested, 0);

  const ineffective = harness({ dir: tempDir(), allowance: 0n, chain: { approveIneffective: true } });
  ineffective.deps.approvalPhase = 'before-quote';
  const b = finished(await runSwap(swapAuth(), ineffective.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(b.record.code, 'APPROVAL_INEFFECTIVE');
  assert.equal(ineffective.quotes.requested, 0);
});

test('before-quote: a failing tagged approval simulation sends nothing and requests no quote', async () => {
  const h = harness({
    dir: tempDir(),
    allowance: 0n,
    chain: { simulate: (_d, _t, tagged) => (tagged ? { ok: false, error: 'execution reverted' } : { ok: true, returnData: '0x01', gas: 1n }) },
  });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'TAGGED_SIMULATION_FAILED');
  assert.equal(h.chain.prepared, 0);
  assert.equal(h.quotes.requested, 0);
});

test('before-quote: if the quote then turns out invalid, only a harmless standing allowance remains', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n, quote: goodQuote({ spender: '0x00000000000000000000000000000000000000aa' as Address }) });
  h.deps.approvalPhase = 'before-quote';
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'QUOTE_INVALID');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve'], 'no swap');
  assert.equal(o.record.residualAllowance, SELL.toString());
  assert.equal(listPending(h.deps.receiptDir).length, 0, 'resolved, not pending');
});

// ------------------------------------------------------------------ reconciliation
test('balances are reconciled against logged transfers and recorded before/after', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(o.record.balances.sellBefore, '2000000000');
  assert.equal(o.record.balances.sellAfter, '600000000');
  assert.equal(o.record.balances.buyBefore, '600000');
  assert.equal(o.record.balances.buyAfter, '1626000');
  assert.ok(o.record.verification.notes.some((n) => n.startsWith('reconciliation:')));
});

test('an unexplained balance change makes the result UNCERTAIN even though the transaction succeeded', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, chain: { extraDebit: 5n } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'RECONCILIATION_MISMATCH');
  assert.equal(listPending(h.deps.receiptDir).length, 1);
});

test('gas used and its cost are recorded from the receipts', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(o.record.gas.usedUnits, (56_000n + 300_000n).toString());
  assert.equal(o.record.gas.costWei, ((56_000n + 300_000n) * 30_000_000_000n).toString());
});

// ------------------------------------------------------------------ pre-approval simulation of the swap
test('with allowance-override support the tagged swap is simulated BEFORE any approval is sent', async () => {
  const chain = new MockChain();
  chain.simulateWithAllowance = async () => ({ ok: true, returnData: '0x01', gas: 280_000n });
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.ok(o.record.simulations.some((s) => s.step.includes('pre-approval') && s.verdict === 'identical'));
});

test('a tagged swap that fails the pre-approval simulation stops BEFORE the approval is spent', async () => {
  const chain = new MockChain();
  chain.simulateWithAllowance = async (call) => {
    const tagged = call.data.toLowerCase().endsWith('80218021802180218021802180218021');
    return tagged ? { ok: false, error: 'execution reverted' } : { ok: true, returnData: '0x01', gas: 1n };
  };
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'TAGGED_SIMULATION_FAILED');
  assert.equal(h.chain.broadcasts.length, 0, 'not even the approval was sent');
});

test('when the override is unsupported the swap simulation is deferred (and still enforced after approval)', async () => {
  const chain = new MockChain();
  chain.simulateWithAllowance = async () => ({ unsupported: true });
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.ok(o.record.simulations.some((s) => s.verdict === 'deferred_until_allowance_exists'));
  assert.ok(o.record.simulations.some((s) => s.step === 'swap (post-approval)' && s.verdict === 'identical'));
});

// ------------------------------------------------------------------ quote shape tolerance
test('an ordinary quote that omits `spender` completes end to end, with the omission recorded', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, quote: goodQuote({ spender: undefined }) });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.ok(o.record.verification.notes.some((n) => n.includes('did not state a spender')));
});
