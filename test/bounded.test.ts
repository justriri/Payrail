import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { boundedApprovalDecision, boundedConfirmers, boundedSwapDecision } from '../src/liveswap.ts';
import type { ConfirmBounds } from '../src/liveswap.ts';
import type { ApprovalSummary, SwapSummary } from '../src/swapexec.ts';
import { runSwap } from '../src/swapexec.ts';
import { tempDir } from './support.ts';
import { CNGN, OTHER, SELL, TAG, USDT, goodQuote, harness, swapAuth } from './swapsupport.ts';

const bounds: ConfirmBounds = {
  sellSymbol: 'cNGN',
  sellAsset: CNGN.address,
  maxSellAtomic: SELL,
  minReceiveAtomic: 1_000_000n,
  spender: TEXTILE_REACTOR,
  attributionTag: TAG,
  minSecondsRemaining: 10,
};

const approval = (over: Partial<ApprovalSummary> = {}): ApprovalSummary => ({
  planId: 'p',
  token: 'cNGN',
  spender: TEXTILE_REACTOR,
  amountAtomic: SELL.toString(),
  currentAllowanceAtomic: '0',
  steps: [{ kind: 'approve', to: CNGN.address }],
  reason: 'r',
  simulations: [{ step: 'approve', tagged: 'ok', untagged: 'ok', verdict: 'identical' }],
  gas: { estimatedCostWei: '1', nativeBalanceWei: '2' },
  attributionTag: TAG,
  digest: 'abc',
  ...over,
});

const swap = (over: Partial<SwapSummary> = {}): SwapSummary => ({
  planId: 'p',
  sell: 's',
  receive: 'r',
  fee: 'f',
  takerPays: SELL.toString(),
  buyAmount: '1026000',
  expiresAt: 'x',
  secondsRemaining: 40,
  steps: [{ kind: 'swap', to: TEXTILE_REACTOR }],
  approvalRequired: false,
  resetRequired: false,
  sequenceReason: 'r',
  simulations: [{ step: 'swap', tagged: 'ok', untagged: 'ok', verdict: 'identical' }],
  gas: { estimatedCostWei: '1', nativeBalanceWei: '2', basis: 'b' },
  attributionTag: TAG,
  digest: 'abc',
  ...over,
});

test('bounded approval: authorizes only the exact expected approve inside the bounds', () => {
  assert.equal(boundedApprovalDecision(approval(), bounds).approved, true);
  assert.equal(boundedApprovalDecision(approval({ steps: [{ kind: 'approve_reset', to: CNGN.address }, { kind: 'approve', to: CNGN.address }] }), bounds).approved, true);
});

test('bounded approval: declines anything unexpected', () => {
  const no = (o: Partial<ApprovalSummary>) => assert.equal(boundedApprovalDecision(approval(o), bounds).approved, false);
  no({ amountAtomic: (SELL + 1n).toString() }); // more than the bound
  no({ amountAtomic: (2n ** 256n - 1n).toString() }); // unlimited
  no({ spender: OTHER });
  no({ token: 'USDT' });
  no({ attributionTag: 'celo_000000000000' });
  no({ steps: [{ kind: 'swap', to: CNGN.address }] });
  no({ steps: [{ kind: 'approve', to: USDT.address }] });
  no({ steps: [] });
  no({ simulations: [{ step: 'approve', tagged: 'fail', untagged: 'ok', verdict: 'tagged_failed' }] });
  no({ simulations: [] });
});

test('bounded swap: authorizes only a single swap to the reactor inside the bounds', () => {
  assert.equal(boundedSwapDecision(swap(), bounds).approved, true);
});

test('bounded swap: declines every deviation', () => {
  const no = (o: Partial<SwapSummary>) => assert.equal(boundedSwapDecision(swap(o), bounds).approved, false);
  no({ takerPays: (SELL + 1n).toString() });
  no({ buyAmount: '999999' }); // below the minimum receive
  no({ buyAmount: 'abc' });
  no({ attributionTag: 'celo_000000000000' });
  no({ steps: [{ kind: 'approve', to: CNGN.address }, { kind: 'swap', to: TEXTILE_REACTOR }] });
  no({ steps: [{ kind: 'swap', to: OTHER }] });
  no({ simulations: [{ step: 'swap', tagged: 'fail', untagged: 'ok', verdict: 'tagged_failed' }] });
  no({ secondsRemaining: 3 });
});

test('end to end with the bounded confirmers: approves inside the bounds, sends nothing outside them', async () => {
  const lines: string[] = [];
  const inside = harness({ dir: tempDir(), allowance: 0n });
  inside.deps.approvalPhase = 'before-quote';
  const c = boundedConfirmers({ ...bounds, minReceiveAtomic: 1_000_000n }, (l) => lines.push(l));
  const ok = await runSwap(swapAuth(), inside.deps, { confirm: c.confirm, confirmApproval: c.confirmApproval });
  assert.equal(ok.kind === 'finished' && ok.state, 'CONFIRMED');
  assert.deepEqual(inside.chain.broadcasts.map((b) => b.kind), ['approve', 'swap']);

  // the same flow, but the quote delivers less than the bound the human set: the SWAP is declined
  const outside = harness({ dir: tempDir(), allowance: 0n, quote: goodQuote({ buyAmount: 900_000n, order: { input: { token: USDT.address, amount: 900_000n, maxAmount: 900_000n } } }) });
  outside.deps.approvalPhase = 'before-quote';
  const c2 = boundedConfirmers({ ...bounds, minReceiveAtomic: 1_000_000n }, () => undefined);
  const declined = await runSwap(swapAuth({ minBuy: 1n, expectedBuy: 900_000n }), outside.deps, { confirm: c2.confirm, confirmApproval: c2.confirmApproval });
  assert.equal(declined.kind === 'finished' && declined.record.code, 'DECLINED');
  assert.deepEqual(outside.chain.broadcasts.map((b) => b.kind), ['approve'], 'the swap was never sent');
  assert.ok(lines.some((l) => l.includes('AUTHORIZED')));
});
