import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { encodeLimitOrder, executeAbi } from '../src/reactor.ts';
import { buildSequence, parseDeadlineMs, validateFirmQuote } from '../src/swapquote.ts';
import type { QuotedSwap } from '../src/swapquote.ts';
import { toDataSuffix } from '@celo/attribution-tags';
import { BUY, CNGN, FEE, MAKER, NOW, OTHER, PAYER, SELL, TAG, USDT, goodOrder, goodQuote, swapAuth } from './swapsupport.ts';
import type { QuoteOver } from './swapsupport.ts';

const ctx = { nowMs: NOW, chainId: 42220, minRemainingMs: 20_000, maxFeeBps: 100 };
const check = (over: QuoteOver = {}, auth = swapAuth()) => validateFirmQuote(auth, goodQuote(over), ctx);
const rejects = (label: string, over: QuoteOver, fragment: string, auth = swapAuth()) => {
  const r = check(over, auth);
  assert.equal(r.ok, false, `${label}: must be rejected`);
  assert.ok(r.problems.some((p) => p.includes(fragment)), `${label}: expected a problem containing "${fragment}", got ${JSON.stringify(r.problems)}`);
};

// ------------------------------------------------------------------ valid
test('a well-formed quote that matches the authorization is accepted', () => {
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.decoded.order?.input.token, USDT.address);
  assert.equal(r.decoded.approveSpender, TEXTILE_REACTOR);
  assert.equal(r.decoded.approveAmount, SELL);
});

test('deadline parsing accepts ISO strings and epoch seconds/ms, rejects junk', () => {
  assert.equal(parseDeadlineMs('2026-10-12T00:00:00.000Z'), Date.parse('2026-10-12T00:00:00.000Z'));
  assert.equal(parseDeadlineMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(parseDeadlineMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(parseDeadlineMs('not a date'), undefined);
  assert.equal(parseDeadlineMs(undefined), undefined);
});

// ------------------------------------------------------------------ expiry
test('expired and nearly-expired quotes are rejected and flagged expired', () => {
  const gone = check({ expiresInMs: -1 });
  assert.equal(gone.ok, false);
  assert.equal(gone.expired, true);
  const soon = check({ expiresInMs: 5_000 });
  assert.equal(soon.ok, false);
  assert.equal(soon.expired, true);
});

test('a quote with no usable expiry is rejected', () => rejects('no expiry', { noExpiry: true }, 'expiresAt'));

// ------------------------------------------------------------------ identity: chain, tokens, reactor
test('wrong chain id on either transaction is rejected', () => {
  rejects('chain', { chainId: 1 }, 'chainId 1');
});
test('wrong approval token (not the sell token) is rejected', () => rejects('token', { approvalTo: USDT.address }, 'not the sell token'));
test('wrong reactor / swap recipient is rejected', () => {
  rejects('reactor', { reactor: OTHER, spender: OTHER, swapTo: OTHER }, 'verified Textile reactor');
  rejects('swapTo', { swapTo: OTHER }, 'not the verified Textile reactor');
});
test('a vault-routed quote (spender differs from the reactor) is rejected, not approved blindly', () => {
  rejects('spender', { spender: OTHER }, 'vault-routed');
});
test('a quote that omits `spender` is accepted as an ordinary quote (reactor is the spender) and noted', () => {
  const r = check({ spender: undefined });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.notes.some((n) => n.includes('did not state a spender')));
  // ...but only because the approval and swap targets still check out against the reactor
  rejects('omitted spender with a foreign swap target', { spender: undefined, swapTo: OTHER }, 'not the verified Textile reactor');
});
test('a quote bound to a different taker is rejected', () => rejects('taker', { taker: OTHER }, 'not the authorized wallet'));
test('bundled quotes (several orders) are rejected', () => rejects('bundle', { ordersCount: 2 }, 'bundles'));

// ------------------------------------------------------------------ amounts
test('input amount different from the authorized input is rejected', () => rejects('sellAmount', { sellAmount: SELL + 1n }, 'differs from the authorized input'));
test('takerPays above the authorized maximum is rejected', () => {
  rejects('pays', { takerPays: SELL + 1n }, 'exceeds');
});
test('output below the service price is rejected', () => rejects('buy', { buyAmount: 4_000n }, 'below the service price'));
test('output materially worse than the preview is rejected', () => {
  const auth = swapAuth({ minBuy: 1n });
  rejects('slippage', { buyAmount: BUY - 20_000n }, 'worse than the preview', auth);
});
test('an excessive fee is rejected', () => rejects('fee', { feeAmount: SELL / 10n }, 'bps of takerPays'));

// ------------------------------------------------------------------ transaction objects
test('non-zero transaction value is rejected', () => rejects('value', { value: '1' }, 'value'));
test('malformed approval calldata is rejected', () => {
  rejects('garbage approve', { approveData: '0xdeadbeef' }, 'approval calldata');
});
test('an approval that is not approve() is rejected', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [OTHER, SELL] });
  rejects('transfer', { approveData: data }, 'not approve');
});
test('unlimited or mismatched approval amounts are rejected', () => {
  rejects('unlimited', { approveAmount: 2n ** 256n - 1n }, 'no unlimited approvals');
  rejects('different', { approveAmount: SELL - 1n }, 'not exactly takerPays');
});
test('approval to a spender other than the quote spender is rejected', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, SELL] });
  rejects('spender', { approveData: data }, 'not the quote spender');
});
test('a swap that is not execute(SignedOrder) is rejected', () => {
  rejects('selector', { swapData: '0x12345678' + '00'.repeat(64) as `0x${string}` }, 'neither execute');
});
test('swap calldata carrying a different order than the quote is rejected', () => {
  const other = encodeLimitOrder(goodOrder({ nonce: 99n }));
  const data = encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [{ order: other, sig: '0x' }] });
  rejects('order', { swapData: data }, 'different order');
});
test('an order that delivers the wrong token, charges the wrong token or over-charges is rejected', () => {
  rejects('input token', { order: { input: { token: CNGN.address, amount: BUY, maxAmount: BUY } } }, 'expected buy token');
  rejects('input amount', { order: { input: { token: USDT.address, amount: BUY - 1n, maxAmount: BUY } } }, 'not the quoted buyAmount');
  rejects('output token', { order: { outputs: [{ token: USDT.address, amount: SELL - FEE, recipient: MAKER }] } }, 'not the sell token');
  rejects('overcharge', { order: { outputs: [{ token: CNGN.address, amount: SELL + 1n, recipient: MAKER }] } }, 'above takerPays');
});
test('order targeting another reactor, with a validation contract, expired, or swapper == taker is rejected', () => {
  rejects('reactor', { order: { reactor: OTHER } }, 'order targets reactor');
  rejects('validation', { order: { validationContract: OTHER } }, 'additional validation contract');
  rejects('deadline', { order: { deadline: BigInt(Math.floor(NOW / 1000) - 1) } }, 'deadline has passed');
  rejects('swapper', { order: { swapper: PAYER } }, 'swapper is the taker');
});

// ------------------------------------------------------------------ sequence + attribution
const q = (): QuotedSwap => goodQuote();

test('sufficient allowance -> swap only (approval not required)', () => {
  const s = buildSequence({ auth: swapAuth(), quote: q(), currentAllowance: SELL, tag: TAG });
  assert.deepEqual(s.steps.map((x) => x.kind), ['swap']);
  assert.equal(s.approvalRequired, false);
});

test('no allowance -> approve then swap', () => {
  const s = buildSequence({ auth: swapAuth(), quote: q(), currentAllowance: 0n, tag: TAG });
  assert.deepEqual(s.steps.map((x) => x.kind), ['approve', 'swap']);
  assert.equal(s.approvalRequired, true);
  assert.equal(s.resetRequired, false);
});

test('partial non-zero allowance -> reset to zero, approve, then swap (token reset behaviour unknown => safe)', () => {
  const s = buildSequence({ auth: swapAuth(), quote: q(), currentAllowance: 1n, tag: TAG });
  assert.deepEqual(s.steps.map((x) => x.kind), ['approve_reset', 'approve', 'swap']);
  assert.equal(s.resetRequired, true);
});

test('every step is tagged exactly once at the end and the suffix is the ONLY difference', () => {
  const s = buildSequence({ auth: swapAuth(), quote: q(), currentAllowance: 1n, tag: TAG });
  const suffix = toDataSuffix(TAG);
  for (const step of s.steps) {
    assert.ok(step.taggedData.toLowerCase().endsWith(suffix.slice(2).toLowerCase()));
    assert.equal(step.taggedData.slice(0, step.taggedData.length - (suffix.length - 2)).toLowerCase(), step.data.toLowerCase());
    assert.notEqual(step.taggedData, step.data);
  }
});

test('an invalid tag makes sequence construction fail (the tag is never silently dropped)', () => {
  assert.throws(() => buildSequence({ auth: swapAuth(), quote: q(), currentAllowance: 0n, tag: 'BAD TAG' }));
});

// ------------------------------------------------------------------ the swap function (found on the first live quote)
import { executeBatchAbi as batchAbi } from '../src/reactor.ts';
import { EXECUTE_BATCH_SELECTOR } from '../src/reactor.ts';

test('the live API returns a ONE-ORDER executeBatch (selector 0x0d7a16c3): accepted', () => {
  assert.equal(EXECUTE_BATCH_SELECTOR.toLowerCase(), '0x0d7a16c3');
  const q = goodQuote();
  assert.equal(q.swap.data.slice(0, 10).toLowerCase(), '0x0d7a16c3', 'the default fixture mirrors the real quote');
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('a single-order execute() is still accepted', () => {
  assert.equal(check({ swapKind: 'execute' }).ok, true);
});

test('an executeBatch with several orders, or with a different order than the quote, is rejected', () => {
  const order = encodeLimitOrder(goodOrder());
  const other = encodeLimitOrder(goodOrder({ nonce: 99n }));
  const two = encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch', args: [[{ order, sig: '0x12' }, { order: other, sig: '0x12' }]] });
  rejects('two orders', { swapData: two }, 'only a single-order swap');
  const swapped = encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch', args: [[{ order: other, sig: '0x12' }]] });
  rejects('different order', { swapData: swapped }, 'different order');
  const empty = encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch', args: [[]] });
  rejects('empty batch', { swapData: empty }, 'only a single-order swap');
});

test('callback variants and unknown selectors are still rejected', () => {
  // executeWithCallback(tuple,bytes) 0x0d335884 and executeBatchWithCallback 0x13fb72c7 are NOT accepted
  rejects('executeWithCallback', { swapData: ('0x0d335884' + '00'.repeat(96)) as `0x${string}` }, 'neither execute');
  rejects('executeBatchWithCallback', { swapData: ('0x13fb72c7' + '00'.repeat(96)) as `0x${string}` }, 'neither execute');
});

// ------------------------------------------------------------------ order validation callback (found on the second live quote)
import { encodeAbiParameters as encAbi } from 'viem';
import { TEXTILE_PREFERRED_FILLER as PREFERRED } from '../src/config.ts';

const pf = (fillers: string[], untilSec: number) =>
  encAbi([{ type: 'address[]' }, { type: 'uint256' }], [fillers as `0x${string}`[], BigInt(untilSec)]);
const nowSec = Math.floor(NOW / 1000);

test('the real order shape (PreferredFillerValidation naming this wallet) is accepted and noted', () => {
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.notes.some((n) => n.includes('PreferredFillerValidation')));
});

test('PreferredFillerValidation naming only OTHER fillers, while exclusive, is rejected (our fill would revert)', () => {
  rejects('not preferred', { order: { validationData: pf([OTHER], nowSec + 60) } }, 'exclusive to other fillers');
});

test('once exclusivity has lapsed anyone may fill, so the order is acceptable', () => {
  const r = check({ order: { validationData: pf([OTHER], nowSec - 1) } });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('malformed or out-of-range validation data is rejected', () => {
  rejects('garbage', { order: { validationData: '0x1234' } }, 'could not be decoded');
  rejects('empty list', { order: { validationData: pf([], nowSec + 60) } }, 'expected 1..10');
  rejects('too many', { order: { validationData: pf(Array.from({ length: 11 }, () => OTHER), nowSec + 60) } }, 'expected 1..10');
});

test('any validation contract other than the verified PreferredFillerValidation is rejected', () => {
  rejects('unknown validator', { order: { validationContract: OTHER, validationData: pf([PAYER], nowSec + 60) } }, 'not the verified PreferredFillerValidation');
  assert.equal(PREFERRED.toLowerCase(), '0x10b9eba3a175df418a35cb8329a527691ee258c5');
});
