import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExecutionAuthorization } from '../src/authorization.ts';
import { executeDirectPayment } from '../src/executor.ts';
import type { ExecuteDeps } from '../src/executor.ts';
import { listPending } from '../src/history.ts';
import { BODY, OTHER, USDT, gateway, makeAuth, tempDir, testAccount, verifyDeps } from './support.ts';
import type { GatewayMode } from './support.ts';

const TAG = 'celo_b2fff2ac9413';

function setup(over: { mode?: GatewayMode; balance?: bigint; verify?: 'settled' | 'unknown' | 'not_settled' } = {}) {
  const account = testAccount();
  const dir = tempDir();
  const gw = gateway({ mode: over.mode ?? 'ok', payer: account.address });
  const balance = over.balance ?? 600_000n;
  const deps: ExecuteDeps = {
    account,
    body: BODY,
    receiptDir: dir,
    attributionTag: TAG,
    verify: verifyDeps(over.verify ?? 'settled', account.address),
    getBalance: async () => balance,
    fetchImpl: gw.fetchImpl,
  };
  return { account, dir, gw, deps, auth: makeAuth(account.address) };
}

const receipts = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json'));

test('happy path: paid, delivered, independently settled -> CONFIRMED receipt, journal cleared', async () => {
  const { gw, deps, auth, dir } = setup();
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  assert.equal(r.receipt.status, 'CONFIRMED');
  assert.equal(r.receipt.outcome.delivered, true);
  assert.equal(r.receipt.outcome.settled, true);
  assert.equal(r.receipt.payment.settlement.transferVerified, true);
  assert.equal(r.receipt.payment.amountAtomic, '5000');
  assert.equal(r.receipt.attribution.tag, TAG);
  assert.equal(r.receipt.attribution.tagged, false);
  assert.equal(gw.paidCount(), 1);
  assert.equal(listPending(dir).length, 0);
  assert.equal(receipts(dir).length, 1);
});

test('receipt contains no signature, key or claim-token fields', async () => {
  const { deps, auth } = setup();
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  const text = JSON.stringify(r.receipt).toLowerCase();
  for (const word of ['signature', 'privatekey', 'private_key', 'claimtoken', 'secret', 'mnemonic']) {
    assert.ok(!text.includes(word), `receipt must not contain "${word}"`);
  }
});

test('an object that was not minted by the planner is refused and nothing is requested', async () => {
  const { gw, deps, auth } = setup();
  const forged = { ...auth } as ExecutionAuthorization; // a copy is not a minted authorization
  const r = await executeDirectPayment(forged, deps);
  assert.deepEqual([r.kind, r.kind === 'not_sent' ? r.code : ''], ['not_sent', 'NOT_AUTHORIZED']);
  assert.equal(gw.calls.length, 0);
});

test('expired authorization is refused', async () => {
  const { gw, deps, account } = setup();
  const auth = makeAuth(account.address, { expiresAtMs: Date.now() - 1 });
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind === 'not_sent' && r.code, 'AUTHORIZATION_EXPIRED');
  assert.equal(gw.calls.length, 0);
});

test('a body that differs from the priced body is refused', async () => {
  const { gw, deps, auth } = setup();
  const r = await executeDirectPayment(auth, { ...deps, body: '{"query":"something else"}' });
  assert.equal(r.kind === 'not_sent' && r.code, 'BODY_MISMATCH');
  assert.equal(gw.calls.length, 0);
});

test('signing wallet must be the planned payer', async () => {
  const { gw, deps } = setup();
  const auth = makeAuth(OTHER);
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind === 'not_sent' && r.code, 'PAYER_MISMATCH');
  assert.equal(gw.calls.length, 0);
});

test('insufficient balance is refused before any request', async () => {
  const { gw, deps, auth } = setup({ balance: 1000n });
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind === 'not_sent' && r.code, 'INSUFFICIENT_BALANCE');
  assert.equal(gw.calls.length, 0);
});

test('challenge with a different recipient is refused BEFORE signing; nothing paid; no journal', async () => {
  const { gw, deps, auth, dir } = setup();
  const evil = gateway({ payTo: OTHER });
  const r = await executeDirectPayment(auth, { ...deps, fetchImpl: evil.fetchImpl });
  assert.equal(r.kind, 'not_sent');
  assert.equal(evil.paidCount(), 0);
  assert.equal(listPending(dir).length, 0);
  assert.equal(receipts(dir).length, 0);
  assert.equal(gw.calls.length, 0);
});

test('challenge asking for more than the authorized amount is refused before signing', async () => {
  const { deps, auth, dir } = setup();
  const pricey = gateway({ amount: '5001' });
  const r = await executeDirectPayment(auth, { ...deps, fetchImpl: pricey.fetchImpl });
  assert.equal(r.kind, 'not_sent');
  assert.equal(pricey.paidCount(), 0);
  assert.equal(listPending(dir).length, 0);
});

test('if the journal cannot be written the payment is NOT sent (fail closed)', async () => {
  const { gw, deps, auth, dir } = setup();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pending'), 'a file where the journal directory should be');
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'not_sent');
  assert.equal(gw.paidCount(), 0, 'no paid request may leave the machine without a journal');
});

test('service says 200 but settlement cannot be confirmed -> UNCERTAIN, never CONFIRMED', async () => {
  const { deps, auth, dir } = setup({ verify: 'unknown' });
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  assert.equal(r.receipt.status, 'UNCERTAIN');
  assert.equal(r.receipt.retryAllowed, false);
  assert.equal(listPending(dir).length, 1, 'uncertain payments keep the journal');
});

test('server 500 after payment -> UNCERTAIN and a second attempt is blocked (no duplicate payment)', async () => {
  const { gw, deps, auth, dir } = setup({ mode: 'server_error', verify: 'unknown' });
  const first = await executeDirectPayment(auth, deps);
  assert.equal(first.kind, 'completed');
  if (first.kind === 'completed') assert.equal(first.receipt.status, 'UNCERTAIN');
  assert.equal(gw.paidCount(), 1);

  const second = await executeDirectPayment(auth, { ...deps, again: true });
  assert.equal(second.kind === 'not_sent' && second.code, 'PENDING_PAYMENT');
  assert.equal(gw.paidCount(), 1, 'the second attempt must not send a payment, even with --again');
  assert.equal(listPending(dir).length, 1);
});

test('network failure after sending -> in_doubt, journal kept, retry blocked', async () => {
  const { gw, deps, auth, dir } = setup({ mode: 'network_error' });
  const first = await executeDirectPayment(auth, deps);
  assert.equal(first.kind, 'in_doubt');
  assert.equal(gw.paidCount(), 1);
  assert.equal(listPending(dir).length, 1);

  const second = await executeDirectPayment(auth, { ...deps, again: true });
  assert.equal(second.kind === 'not_sent' && second.code, 'PENDING_PAYMENT');
  assert.equal(gw.paidCount(), 1);
});

test('payment sent but the service answers 402 again -> in_doubt, never re-signed', async () => {
  const { gw, deps, auth, dir } = setup({ mode: 'repeat_402' });
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'in_doubt');
  assert.equal(gw.paidCount(), 1, 'exactly one authorization may be sent');
  assert.equal(listPending(dir).length, 1);
});

test('proven not settled (authorization expired unused) -> REJECTED, retry allowed, journal cleared', async () => {
  const { deps, auth, dir } = setup({ mode: 'server_error', verify: 'not_settled' });
  const r = await executeDirectPayment(auth, deps);
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  assert.equal(r.receipt.status, 'REJECTED');
  assert.equal(r.receipt.retryAllowed, true);
  assert.equal(listPending(dir).length, 0);
});

test('duplicate guard: a prior receipt blocks, --again allows, a pending journal always blocks', async () => {
  const { gw, deps, auth, dir } = setup();
  const first = await executeDirectPayment(auth, deps);
  assert.equal(first.kind, 'completed');
  assert.equal(gw.paidCount(), 1);

  const blocked = await executeDirectPayment(makeAuth(auth.payer), deps);
  assert.equal(blocked.kind === 'not_sent' && blocked.code, 'PRIOR_RECEIPT');
  assert.equal(gw.paidCount(), 1);

  // ensure a different timestamp-based receipt id for the deliberate second payment
  await new Promise((r) => setTimeout(r, 5));
  const again = await executeDirectPayment(makeAuth(auth.payer), { ...deps, again: true });
  assert.equal(again.kind, 'completed');
  assert.equal(gw.paidCount(), 2);

  mkdirSync(join(dir, 'pending'), { recursive: true });
  writeFileSync(join(dir, 'pending', 'pending-x.json'), '{}');
  const pending = await executeDirectPayment(makeAuth(auth.payer), { ...deps, again: true });
  assert.equal(pending.kind === 'not_sent' && pending.code, 'PENDING_PAYMENT');
  assert.equal(gw.paidCount(), 2);
  assert.ok(existsSync(join(dir, 'pending', 'pending-x.json')));
  void readFileSync;
  void USDT;
});

test('service that never asks for payment is not paid', async () => {
  const { account, deps, auth } = setup();
  const free = gateway({ mode: 'no_challenge', payer: account.address });
  const r = await executeDirectPayment(auth, { ...deps, fetchImpl: free.fetchImpl });
  assert.equal(r.kind === 'not_sent' && r.code, 'NO_PAYMENT_REQUIRED');
  assert.equal(free.paidCount(), 0);
});
