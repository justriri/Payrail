import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listPending } from '../src/history.ts';
import { runSwap } from '../src/swapexec.ts';
import type { SwapOutcome } from '../src/swapexec.ts';
import { loadSwapRecord } from '../src/swapjournal.ts';
import { tempDir } from './support.ts';
import {
  CLAIM, CNGN, CrashError, MockChain, NOW, OTHER, PAYER, SELL, TAG, USDT, approveNo, approveYes, goodQuote, harness, swapAuth,
} from './swapsupport.ts';
import type { ChainBehavior } from './swapsupport.ts';

const finished = (o: SwapOutcome) => {
  assert.equal(o.kind, 'finished', o.kind === 'refused' ? `${o.code}: ${o.message}` : '');
  return o.kind === 'finished' ? o : (undefined as never);
};
const refusedCode = (o: SwapOutcome) => (o.kind === 'refused' ? o.code : `finished:${o.state}`);

// ------------------------------------------------------------------ happy paths
test('happy path: approve then swap, both tagged, independently verified -> CONFIRMED', async () => {
  const dir = tempDir();
  const h = harness({ dir, allowance: 0n, statuses: ['quoted', 'submitted', 'filled'] });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve', 'swap'], 'exactly the approved sequence, in order');
  // every broadcast was the tagged calldata
  for (const b of h.chain.broadcasts) assert.ok(b.data.toLowerCase().endsWith('80218021802180218021802180218021'));
  assert.equal(o.record.steps.length, 2);
  assert.ok(o.record.steps.every((s) => s.status === 'mined' && s.hash && s.attribution?.verified === true));
  assert.equal(o.record.verification.fillEvent, true);
  assert.equal(o.record.quote.textileStatus, 'filled');
  // resolved: journal moved from pending to swaps/, and nothing pending remains
  assert.equal(listPending(dir).length, 0);
  assert.ok(existsSync(join(dir, 'swaps', 'plan-swap-1.json')));
  assert.equal(h.quotes.requested, 1);
});

test('approval not required when the allowance already covers it: swap only', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['swap']);
});

test('allowance reset: a partial allowance is zeroed first, then approved, then swapped', async () => {
  const h = harness({ dir: tempDir(), allowance: 1n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve_reset', 'approve', 'swap']);
});

test('the simulated bytes are exactly the bytes that are broadcast (tagged and untagged compared)', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL });
  await runSwap(swapAuth(), h.deps, { confirm: approveYes });
  const broadcast = h.chain.broadcasts[0]!.data.toLowerCase();
  assert.ok(h.chain.simulations.some((s) => s.tagged && s.data.toLowerCase() === broadcast), 'the tagged calldata was simulated');
  assert.ok(h.chain.simulations.some((s) => !s.tagged), 'the untagged calldata was simulated for comparison');
});

// ------------------------------------------------------------------ gates and refusals (nothing requested/sent)
test('no authorization / forged authorization / expired authorization -> refused, no quote requested', async () => {
  const h = harness({ dir: tempDir() });
  const forged = { ...swapAuth() };
  assert.equal(refusedCode(await runSwap(forged, h.deps, { confirm: approveYes })), 'NOT_AUTHORIZED');
  assert.equal(refusedCode(await runSwap(swapAuth({ expiresAtMs: NOW - 1 }), h.deps, { confirm: approveYes })), 'AUTHORIZATION_EXPIRED');
  assert.equal(refusedCode(await runSwap(swapAuth({ payer: OTHER }), h.deps, { confirm: approveYes })), 'PAYER_MISMATCH');
  assert.equal(h.quotes.requested, 0);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('insufficient token balance, insufficient gas and wrong chain are refused before any quote request', async () => {
  const poor = harness({ dir: tempDir() });
  poor.chain.balances.set(CNGN.address.toLowerCase(), 1n);
  assert.equal(refusedCode(await runSwap(swapAuth(), poor.deps, { confirm: approveYes })), 'INSUFFICIENT_BALANCE');

  const noGas = harness({ dir: tempDir() });
  noGas.chain.native = 0n;
  assert.equal(refusedCode(await runSwap(swapAuth(), noGas.deps, { confirm: approveYes })), 'INSUFFICIENT_GAS');

  const wrong = harness({ dir: tempDir() });
  wrong.chain.chain = 1;
  assert.equal(refusedCode(await runSwap(swapAuth(), wrong.deps, { confirm: approveYes })), 'CHAIN_MISMATCH');

  for (const h of [poor, noGas, wrong]) {
    assert.equal(h.quotes.requested, 0, 'a firm quote has side effects, so it is never requested when a precondition fails');
    assert.equal(h.chain.broadcasts.length, 0);
  }
});

test('the human declining sends nothing', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveNo }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'DECLINED');
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.chain.prepared, 0, 'nothing was even signed');
});

// ------------------------------------------------------------------ bad quotes
test('invalid quote (wrong reactor) is rejected with nothing signed', async () => {
  const h = harness({ dir: tempDir(), quote: goodQuote({ reactor: OTHER, spender: OTHER, swapTo: OTHER }) });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'QUOTE_INVALID');
  assert.equal(h.chain.prepared, 0);
});

test('expired quote -> EXPIRED, nothing signed', async () => {
  const h = harness({ dir: tempDir(), quote: goodQuote({ expiresInMs: 3_000 }) });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'EXPIRED');
  assert.equal(h.chain.prepared, 0);
});

test('no_quote and a failed quote request leave nothing in flight', async () => {
  const none = harness({ dir: tempDir(), quote: { kind: 'no_quote', reason: 'no_makers_online', requestId: undefined } });
  assert.equal(finished(await runSwap(swapAuth(), none.deps, { confirm: approveYes })).record.code, 'NO_QUOTE');
  const boom = harness({ dir: tempDir(), quote: new Error('ECONNRESET') });
  const o = finished(await runSwap(swapAuth(), boom.deps, { confirm: approveYes }));
  assert.equal(o.record.code, 'QUOTE_REQUEST_ERROR');
  assert.equal(boom.chain.prepared, 0);
});

// ------------------------------------------------------------------ simulation and attribution
test('tagged simulation failure stops everything and does NOT strip the tag to proceed', async () => {
  const h = harness({
    dir: tempDir(),
    allowance: SELL,
    chain: { simulate: (_d, _t, tagged) => (tagged ? { ok: false, error: 'execution reverted' } : { ok: true, returnData: '0x01', gas: 1n }) },
  });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'TAGGED_SIMULATION_FAILED');
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.chain.prepared, 0, 'no untagged fallback was ever prepared');
});

test('a tag that changes the simulated outcome is treated as incompatible', async () => {
  const h = harness({
    dir: tempDir(),
    allowance: SELL,
    chain: { simulate: (_d, _t, tagged) => ({ ok: true, returnData: tagged ? '0x02' : '0x01', gas: 1n }) },
  });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.record.code, 'TAG_CHANGES_BEHAVIOR');
  assert.equal(h.chain.broadcasts.length, 0);
});

test('post-approval swap simulation failure: approval remains, swap is never sent, residual allowance is reported', async () => {
  let swapSims = 0;
  const h = harness({
    dir: tempDir(),
    allowance: 0n,
    chain: {
      simulate: (data, _to, tagged) => {
        // approvals simulate fine; the swap (long calldata) fails once the allowance exists
        if (data.length > 600 && tagged) swapSims += 1;
        return data.length > 600 && tagged ? { ok: false, error: 'execution reverted: order' } : { ok: true, returnData: '0x01', gas: 1n };
      },
    },
  });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'TAGGED_SIMULATION_FAILED');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve'], 'only the approval went out');
  assert.equal(o.record.residualAllowance, SELL.toString());
  assert.ok(swapSims >= 1);
});

test('attribution is only claimed when verifyTx supports it', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, attribution: 'none' });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED', 'the swap itself succeeded');
  assert.equal(o.record.steps[0]!.attribution?.verified, false);
  assert.equal(o.record.steps[0]!.attribution?.codes, null);
});

// ------------------------------------------------------------------ lifecycle / uncertainty
test('quote expiring between approval and swap -> EXPIRED, swap never sent, approval remains', async () => {
  const chain = new MockChain();
  const h = harness({ dir: tempDir(), chainObj: chain, allowance: 0n });
  chain.behavior = { onBroadcast: (s) => { if (s.kind === 'approve') h.clock.now += 60_000; } };
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'EXPIRED');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve']);
  assert.equal(o.record.residualAllowance, SELL.toString());
});

test('approval that mines but does not raise the allowance stops before the swap', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n, chain: { approveIneffective: true } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.record.code, 'APPROVAL_INEFFECTIVE');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve']);
});

test('approval reverted -> FAILED, swap never sent', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n, chain: { receipt: (s) => (s.kind === 'approve' ? 'reverted' : 'success') } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.record.code, 'APPROVAL_REVERTED');
  assert.deepEqual(h.chain.broadcasts.map((b) => b.kind), ['approve']);
});

test('swap reverted on-chain -> FAILED (resolved, not pending)', async () => {
  const dir = tempDir();
  const h = harness({ dir, allowance: SELL, chain: { receipt: () => 'reverted' } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'SWAP_REVERTED');
  assert.equal(listPending(dir).length, 0);
});

test('network failure while broadcasting the swap -> UNCERTAIN, never auto-retried, blocks everything', async () => {
  const dir = tempDir();
  const h = harness({ dir, allowance: SELL, chain: { broadcast: () => 'throw' } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'BROADCAST_UNCERTAIN');
  assert.equal(h.chain.prepared, 1, 'exactly one transaction was ever prepared');
  assert.ok(o.record.steps[0]!.hash, 'the hash was journaled before broadcast');
  assert.equal(listPending(dir).length, 1, 'uncertain outcomes keep the pending journal');

  // a different plan is blocked, and the same plan cannot be re-run
  const again = harness({ dir, allowance: SELL });
  const other = swapAuth();
  assert.equal(refusedCode(await runSwap(other, again.deps, { confirm: approveYes })), 'ALREADY_EXECUTED');
  assert.equal(again.chain.broadcasts.length, 0);
  assert.equal(again.quotes.requested, 0);
});

test('receipt timeout -> UNCERTAIN (the transaction may still confirm)', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, chain: { receipt: () => 'missing' }, limits: { receiptTimeoutMs: 3_000, pollMs: 1_000 } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'RECEIPT_TIMEOUT');
});

test('mined transaction that differs from what was signed -> UNCERTAIN', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, chain: { mismatchMined: true } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'MINED_TX_MISMATCH');
});

test('a successful swap transaction with wrong effects is UNCERTAIN, not CONFIRMED', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, chain: { badEffects: true } });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'UNCERTAIN');
  assert.equal(o.record.code, 'VERIFICATION_MISMATCH');
});

test('Textile status failed/expired does not override on-chain evidence; the reason is recorded', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, statuses: ['failed'] });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(o.record.quote.textileStatus, 'failed');
  assert.ok(o.record.quote.textileStatusNote?.includes('failed'));
});

// ------------------------------------------------------------------ crashes (the process dies mid-run)
async function crashRun(dir: string, firstKind: 'approve' | 'swap') {
  const chain = new MockChain({ receipt: () => 'missing' });
  const h = harness({ dir, chainObj: chain, allowance: firstKind === 'approve' ? 0n : SELL });
  let crash = false;
  h.deps.sleep = async () => {
    crash = true;
    throw new CrashError('simulated process crash');
  };
  await assert.rejects(runSwap(swapAuth(), h.deps, { confirm: approveYes }), (e) => e instanceof CrashError);
  assert.ok(crash);
  return { chain, h };
}

test('crash right after the APPROVAL was submitted: journal holds the hash, a re-run cannot re-approve', async () => {
  const dir = tempDir();
  const { chain } = await crashRun(dir, 'approve');
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['approve']);
  const rec = loadSwapRecord(dir, 'plan-swap-1')!;
  assert.equal(rec.state, 'SUBMITTED');
  assert.equal(rec.steps[0]!.kind, 'approve');
  assert.ok(rec.steps[0]!.hash);
  assert.equal(rec.fundsMayHaveMoved, false);

  const rerun = harness({ dir, allowance: 0n });
  const o = await runSwap(swapAuth(), rerun.deps, { confirm: approveYes });
  assert.equal(refusedCode(o), 'ALREADY_EXECUTED');
  assert.equal(rerun.chain.broadcasts.length, 0, 'no duplicate approval');
});

test('crash right after the SWAP was submitted: journal marks funds as possibly moved, no duplicate swap', async () => {
  const dir = tempDir();
  const { chain } = await crashRun(dir, 'swap');
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['swap']);
  const rec = loadSwapRecord(dir, 'plan-swap-1')!;
  assert.equal(rec.state, 'SUBMITTED');
  assert.equal(rec.fundsMayHaveMoved, true);
  assert.equal(listPending(dir).length, 1);

  // a brand-new plan is blocked until a human resolves the pending swap
  const rerun = harness({ dir, allowance: SELL });
  const o2 = await runSwap(swapAuth({ planId: 'plan-swap-2' }), rerun.deps, { confirm: approveYes });
  assert.equal(refusedCode(o2), 'PENDING_UNRESOLVED');
  assert.equal(rerun.chain.broadcasts.length, 0);
  assert.equal(rerun.quotes.requested, 0, 'no new firm quote is requested while a swap is unresolved');

  // and the same plan cannot be re-run
  const same = harness({ dir, allowance: SELL });
  assert.equal(refusedCode(await runSwap(swapAuth(), same.deps, { confirm: approveYes })), 'ALREADY_EXECUTED');
});

// ------------------------------------------------------------------ concurrency + secrets
test('two simultaneous runs of the same plan: exactly one proceeds, the other is refused', async () => {
  const dir = tempDir();
  const slow = (): ReturnType<typeof harness> => {
    const h = harness({ dir, allowance: SELL });
    const base = h.deps.sleep;
    h.deps.sleep = async (ms) => {
      await new Promise((r) => setTimeout(r, 30));
      return base(ms);
    };
    const orig = h.deps.chain.getReceipt.bind(h.deps.chain);
    let n = 0;
    h.deps.chain.getReceipt = async (hash) => {
      n += 1;
      return n < 3 ? undefined : orig(hash);
    };
    return h;
  };
  const a = slow();
  const b = slow();
  const [ra, rb] = await Promise.all([
    runSwap(swapAuth(), a.deps, { confirm: approveYes }),
    runSwap(swapAuth(), b.deps, { confirm: approveYes }),
  ]);
  const outcomes = [ra, rb];
  assert.equal(outcomes.filter((o) => o.kind === 'finished').length, 1, JSON.stringify(outcomes.map((o) => (o.kind === 'refused' ? o.code : o.state))));
  assert.equal(outcomes.filter((o) => o.kind === 'refused').length, 1);
  assert.equal(a.chain.broadcasts.length + b.chain.broadcasts.length, 1, 'one swap in total');
  assert.equal(a.quotes.requested + b.quotes.requested, 1, 'one firm quote in total');
});

test('the claim token never appears in the journal, the receipt or the logs', async () => {
  const dir = tempDir();
  const h = harness({ dir, allowance: 0n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  const files = ['swaps'].flatMap((d) => readdirSync(join(dir, d)).map((f) => readFileSync(join(dir, d, f), 'utf8')));
  for (const text of [...files, JSON.stringify(o.record), h.logs.join('\n')]) {
    assert.ok(!text.includes(CLAIM), 'claim token leaked');
    assert.ok(!/signature|privatekey|private_key/i.test(text), 'secret-looking field in a record');
  }
});

test('constants used by the fixtures are consistent', () => {
  assert.equal(PAYER.toLowerCase(), '0x652c9023626d1a00ad0d130c9cdc5c5f3644d2a4');
  assert.equal(USDT.decimals, 6);
  assert.equal(TAG, 'celo_b2fff2ac9413');
  void ({} as ChainBehavior);
});

// ------------------------------------------------------------------ abandoned quotes, exact-block reads, deadlines
test('a declined swap releases the abandoned quote with the venue and records it', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveNo }));
  assert.equal(o.record.code, 'DECLINED');
  assert.deepEqual(h.quotes.cancelled, ['rfq_test_1']);
  assert.match(o.record.quote.textileStatusNote ?? '', /released with the venue/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('an invalid quote is released too; a failing cancel is swallowed and noted, never changes the outcome', async () => {
  const h = harness({ dir: tempDir(), quote: goodQuote({ reactor: OTHER, spender: OTHER, swapTo: OTHER }), cancelFails: true });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'QUOTE_INVALID');
  assert.deepEqual(h.quotes.cancelled, ['rfq_test_1']);
  assert.match(o.record.quote.textileStatusNote ?? '', /could not release the abandoned quote: venue unreachable/);
});

test('a quote is NOT cancelled once the swap was sent', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL, statuses: ['quoted', 'submitted', 'filled'] });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.deepEqual(h.quotes.cancelled, []);
});

test('exact-block reads: a swap consumes the exact allowance, so the recorded residual is 0, and native gas is recorded', async () => {
  const h = harness({ dir: tempDir(), allowance: 0n, statuses: ['quoted', 'submitted', 'filled'] });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(o.record.residualAllowance, '0');
  assert.equal(o.record.balances.nativeAfter, h.chain.native.toString());
});

test('a swap that does not consume the allowance reports the leftover allowance', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL * 3n });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.equal(o.record.residualAllowance, (SELL * 2n).toString());
});

test('the quote deadlines are recorded in the journal', async () => {
  const h = harness({ dir: tempDir(), allowance: SELL });
  const o = finished(await runSwap(swapAuth(), h.deps, { confirm: approveNo }));
  assert.ok(o.record.quote.deadlines?.expiresAt, 'expiresAt recorded');
});
