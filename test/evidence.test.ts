import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildEvidencePack, renderEvidenceMarkdown } from '../src/evidence.ts';
import { executeDirectPayment, sha256Hex } from '../src/executor.ts';
import { BODY, PAY_TO, gateway, makeAuth, tempDir, testAccount, verifyDeps } from './support.ts';

const PAYER = '0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4';
const TX = '0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac';

// The exact shape of the real receipt written by the first live payment (schema before v1).
const legacy = {
  id: 'direct-2026-10-12T16-02-41-922Z',
  createdAt: '2026-10-12T16:02:41.922Z',
  flow: 'direct (no swap needed)',
  input: { token: 'USDT', amountAtomic: '5000', amount: '0.005' },
  service: { capability: 'x.posts.search', url: 'https://gateway.usebuy.ai/v1/social/x/posts/search' },
  payment: {
    network: 'celo',
    payer: PAYER,
    payTo: '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B',
    asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    amountAtomic: '5000',
    txHash: TX,
    settlement: { authorizationState: 'settled', transferVerified: true },
  },
  outcome: { httpStatus: 200, clientOutcome: 'confirmed', delivered: true, settled: true, responseSummary: 'JSON keys [capability, output]; 57656 bytes' },
};

test('evidence: the real legacy receipt becomes a proof entry; payTo and payer are kept distinct', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'a.json'), JSON.stringify(legacy));
  const p = buildEvidencePack(dir, new Date('2026-10-13T00:00:00Z'));
  assert.equal(p.payments.length, 1);
  const x = p.payments[0]!;
  assert.equal(x.payTo, '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B');
  assert.equal(x.payer, PAYER);
  assert.notEqual(x.payTo, x.payer);
  assert.equal(x.txHash, TX);
  assert.equal(x.explorerUrl, `https://celoscan.io/tx/${TX}`);
  assert.equal(x.transferVerified, true);
  assert.ok(x.notes.some((n) => n.includes('response body was not retained')), 'a missing body is stated, not hidden');
  assert.ok(x.notes.some((n) => n.includes('no attribution tag')));
  const roles = p.addresses.map((a) => a.role);
  assert.ok(roles.some((r) => r.startsWith('payTo')) && roles.some((r) => r.startsWith('payer')));
  assert.equal(p.services[0]!.service, 'x.posts.search');
  assert.equal(p.services[0]!.confirmed, 1);
});

test('evidence: unresolved payments and swaps are listed but never counted as proof', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'pending'), { recursive: true });
  mkdirSync(join(dir, 'swaps'), { recursive: true });
  writeFileSync(join(dir, 'pending', 'pending-x.json'), '{}');
  writeFileSync(join(dir, 'pending', 'swap-p9.json'), JSON.stringify({ planId: 'p9', state: 'UNCERTAIN', code: 'RECEIPT_TIMEOUT', route: {}, amounts: {}, steps: [] }));
  writeFileSync(join(dir, 'swaps', 'p1.json'), JSON.stringify({
    planId: 'p1', state: 'CONFIRMED', code: 'CONFIRMED', updatedAt: '2026-10-13T04:10:41Z',
    route: { sellSymbol: 'USDT', buySymbol: 'cNGN', provider: 'textile-fx-v2' }, amounts: { requestedSell: '1000000' },
    verification: { buyReceived: '1365928991', notes: [] }, quote: { textileStatus: 'filled' },
    steps: [{ kind: 'swap', hash: '0xab59', status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'] } }],
  }));
  const p = buildEvidencePack(dir);
  assert.equal(p.swaps.length, 1);
  assert.equal(p.swaps[0]!.transactions[0]!.attributionVerified, true);
  assert.equal(p.unresolved.length, 2);
  assert.ok(p.unresolved.some((u) => u.includes('p9')));
  const md = renderEvidenceMarkdown(p);
  assert.ok(md.includes('Unresolved (NOT counted as proof)'));
  assert.ok(md.includes('celo_b2fff2ac9413'));
});

test('evidence: malformed files are warned about, not fatal; an empty folder renders cleanly', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  const p = buildEvidencePack(dir);
  assert.equal(p.warnings.length, 1);
  assert.ok(renderEvidenceMarkdown(buildEvidencePack(join(dir, 'missing'))).includes('(no payments recorded)'));
});

test('a new payment stores the exact response body and its sha256 in the receipt', async () => {
  const account = testAccount();
  const dir = tempDir();
  const gw = gateway({ payer: account.address });
  const r = await executeDirectPayment(makeAuth(account.address), {
    account, body: BODY, receiptDir: dir, attributionTag: 'celo_b2fff2ac9413',
    verify: verifyDeps('settled', account.address), getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl,
  });
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  const file = r.receipt.outcome.responseFile!;
  assert.ok(file.startsWith('responses/'));
  const stored = readFileSync(join(dir, file), 'utf8');
  assert.equal(sha256Hex(stored), r.receipt.outcome.responseSha256, 'the digest matches the stored bytes');
  assert.ok(stored.includes('x.posts.search'));
  assert.equal(r.receipt.payment.payTo, PAY_TO);
  assert.ok(r.receipt.attribution.reason.includes('organizers confirmed'));
  // and the evidence pack picks it up with the digest
  const pack = buildEvidencePack(dir);
  assert.equal(pack.payments[0]!.responseSha256, r.receipt.outcome.responseSha256);
  assert.ok(!pack.payments[0]!.notes.some((n) => n.includes('not retained')));
  assert.ok(existsSync(join(dir, file)));
});

test('journals that the filesystem reports as symlinks (OneDrive reparse points) are still read, and still block payments', async () => {
  const { symlinkSync } = await import('node:fs');
  const { assertNoPriorPayment, listPending } = await import('../src/history.ts');
  const dir = tempDir();
  mkdirSync(join(dir, 'pending'), { recursive: true });
  writeFileSync(join(dir, 'target.json'), '{}');
  try {
    symlinkSync(join(dir, 'target.json'), join(dir, 'pending', 'linked.json'));
  } catch {
    return; // this environment may not allow creating symlinks; nothing to test here
  }
  assert.deepEqual(listPending(dir), ['linked.json']);
  assert.throws(() => assertNoPriorPayment(dir, { again: true }), /PENDING|in flight|pending/i);
});

// ------------------------------------------------------------------ orders in evidence and history
function orderFixture(over: { swapTx?: string; payTx?: string } = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, 'swaps'), { recursive: true });
  mkdirSync(join(dir, 'orders'), { recursive: true });
  const SWAP_TX = '0x' + 'a1'.repeat(32);
  const APPROVE_TX = '0x' + 'a2'.repeat(32);
  const PAY_TX = '0x' + 'b1'.repeat(32);
  writeFileSync(join(dir, 'swaps', 'swap-1.json'), JSON.stringify({
    planId: 'swap-1', state: 'CONFIRMED', code: 'CONFIRMED', createdAt: '2026-10-13T05:00:00Z', updatedAt: '2026-10-13T05:00:10Z',
    route: { sellSymbol: 'cNGN', buySymbol: 'USDT', provider: 'textile-fx-v2' }, amounts: { requestedSell: '1400000000' },
    steps: [
      { kind: 'approve', to: '0xT', hash: APPROVE_TX, status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'] } },
      { kind: 'swap', to: '0xR', hash: SWAP_TX, status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'] } },
    ],
    verification: { buyReceived: '1026000', notes: [] },
  }));
  writeFileSync(join(dir, 'pay.json'), JSON.stringify({
    ...legacy, id: 'direct-conv', schemaVersion: 1, status: 'CONFIRMED', planId: 'plan-pay', orderId: 'order-1',
    createdAt: '2026-10-13T05:01:00Z', conversion: { provider: 'textile-fx-v2', swapPlanId: 'swap-1' },
    payment: { ...legacy.payment, txHash: PAY_TX },
    outcome: { ...legacy.outcome, responseSha256: 'cd'.repeat(32), responseFile: 'responses/direct-conv.body' },
  }));
  writeFileSync(join(dir, 'orders', 'order-1.json'), JSON.stringify({
    schemaVersion: 1, orderId: 'order-1', state: 'COMPLETED', code: 'COMPLETED', message: 'ok',
    createdAt: '2026-10-13T04:59:00Z', updatedAt: '2026-10-13T05:01:05Z',
    service: { id: 'x.posts.search', title: 't', url: 'u', provider: 'buy-gateway' }, payer: PAYER, bodyHash: 'h', planDigest: 'ab'.repeat(32),
    approved: { asset: '0xA', symbol: 'USDT', payTo: '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B', amountAtomic: '5000', route: 'swap', conversionProvider: 'textile-fx-v2' },
    approvedBy: 'human:test',
    steps: [{ kind: 'convert', state: 'done', ref: 'swap-1' }, { kind: 'pay', state: 'done' }],
    conversion: { provider: 'textile-fx-v2', swapPlanId: 'swap-1', state: 'CONFIRMED', txHashes: [over.swapTx ?? SWAP_TX, APPROVE_TX], sellSymbol: 'cNGN', sellAmountAtomic: '1400000000', buySymbol: 'USDT', receivedAtomic: '1026000' },
    payment: { route: 'converted', receiptFile: 'pay.json', receiptId: 'direct-conv', txHash: over.payTx ?? PAY_TX, status: 'CONFIRMED',
      delivery: { delivered: true, httpStatus: 200, responseSha256: 'cd'.repeat(32), responseFile: 'responses/direct-conv.body', responseSummary: 's' } },
    needsAttention: false,
  }));
  return { dir, SWAP_TX, APPROVE_TX, PAY_TX };
}

test('evidence: a conversion and its payment are ONE order, each transaction still in the ledger and cross-checked', () => {
  const { dir, SWAP_TX, APPROVE_TX, PAY_TX } = orderFixture();
  const p = buildEvidencePack(dir, new Date('2026-10-13T06:00:00Z'));
  assert.equal(p.orders.length, 1);
  const o = p.orders[0]!;
  assert.equal(o.route, 'converted');
  assert.equal(o.state, 'COMPLETED');
  assert.equal(o.payment?.delivered, true);
  assert.equal(o.payment?.responseSha256, 'cd'.repeat(32));
  assert.deepEqual(o.conversion?.txHashes, [SWAP_TX, APPROVE_TX]);
  // the individual records are still there, tagged with the order
  const hashes = p.transactions.map((t) => t.hash);
  for (const h of [SWAP_TX, APPROVE_TX, PAY_TX]) assert.ok(hashes.includes(h), h);
  assert.equal(o.ledger.length, 3);
  assert.ok(p.transactions.filter((t) => t.orderId === 'order-1').length === 3);
  assert.ok(o.consistency.some((c) => /conversion tx hashes match swap record swap-1/.test(c)));
  assert.ok(o.consistency.some((c) => /payment tx matches receipt direct-conv/.test(c)));
  assert.equal(p.warnings.length, 0);
  const md = renderEvidenceMarkdown(p);
  assert.match(md, /### Order order-1: COMPLETED/);
  assert.match(md, /Route taken:\*\* converted/);
  assert.match(md, /part of order `order-1`/);
});

test('evidence: an order whose tx hashes disagree with the swap journal or receipt is flagged, not trusted', () => {
  const { dir } = orderFixture({ swapTx: '0x' + 'ee'.repeat(32), payTx: '0x' + 'ff'.repeat(32) });
  const p = buildEvidencePack(dir, new Date('2026-10-13T06:00:00Z'));
  assert.ok(p.warnings.some((w) => /conversion tx hashes do not match/.test(w)));
  assert.ok(p.warnings.some((w) => /payment tx hash differs/.test(w)));
});

test('history: order items are listed and their payment/swap items point back to the order', async () => {
  const { dir } = orderFixture();
  const { listActivity } = await import('../src/activity.ts');
  const { items, warnings } = listActivity(dir);
  assert.deepEqual(warnings, []);
  const order = items.find((i) => i.kind === 'order')!;
  assert.equal(order.id, 'order-1');
  assert.match(order.summary, /convert cNGN -> USDT, then pay/);
  assert.equal(items.find((i) => i.kind === 'payment')!.orderId, 'order-1');
  assert.equal(items.find((i) => i.kind === 'swap')!.orderId, 'order-1');
  assert.equal(order.unresolved, false);
});

// ------------------------------------------------------------------ phase 3: the order must agree with its receipt
test('evidence: an order whose payment status or delivery claims disagree with the receipt is flagged', () => {
  const { dir } = orderFixture();
  // the receipt says UNCERTAIN / not delivered / a different response hash, the order still claims CONFIRMED
  const f = join(dir, 'pay.json');
  const r = JSON.parse(readFileSync(f, 'utf8'));
  r.status = 'UNCERTAIN';
  r.outcome = { ...r.outcome, delivered: false, responseSha256: 'ee'.repeat(32) };
  writeFileSync(f, JSON.stringify(r));
  const p = buildEvidencePack(dir, new Date('2026-10-13T06:00:00Z'));
  assert.ok(p.warnings.some((w) => /payment status CONFIRMED differs from receipt/.test(w)));
  assert.ok(p.warnings.some((w) => /delivery flag differs/.test(w)));
  assert.ok(p.warnings.some((w) => /response sha256 differs/.test(w)));
});

test('evidence: a payment resolved from the chain is annotated and no longer listed as unresolved', () => {
  const { dir } = orderFixture();
  const f = join(dir, 'pay.json');
  const r = JSON.parse(readFileSync(f, 'utf8'));
  r.status = 'UNCERTAIN';
  writeFileSync(f, JSON.stringify(r));
  const before = buildEvidencePack(dir, new Date('2026-10-13T06:00:00Z'));
  assert.ok(before.unresolved.some((u) => /direct-conv is UNCERTAIN/.test(u)));
  mkdirSync(join(dir, 'resolutions'), { recursive: true });
  writeFileSync(join(dir, 'resolutions', 'direct-conv.json'), JSON.stringify({ receiptId: 'direct-conv', outcome: 'SETTLED' }));
  const after = buildEvidencePack(dir, new Date('2026-10-13T06:00:00Z'));
  assert.ok(!after.unresolved.some((u) => /direct-conv is UNCERTAIN/.test(u)));
  assert.ok(after.payments[0]!.notes.some((n) => /RESOLVED from the chain.*SETTLED/.test(n)));
});

test('evidence: the ERC-8004 registration appears in the ledger as a tagged real transaction; an unconfirmed one is listed as unresolved', () => {
  const { dir } = orderFixture();
  mkdirSync(join(dir, 'registrations'), { recursive: true });
  const rec = {
    schemaVersion: 1, state: 'CONFIRMED', createdAt: '2026-10-13T16:30:00Z', registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    owner: PAYER, txHash: '0x' + 'f6'.repeat(32), attributionTag: 'celo_b2fff2ac9413', blockNumber: '80032609', agentId: '9906',
    verifiedOwner: PAYER, tokenUriMatches: true, attributionCodes: ['celo_b2fff2ac9413'],
  };
  writeFileSync(join(dir, 'registrations', 'agent-registration.json'), JSON.stringify(rec));
  const p = buildEvidencePack(dir, new Date('2026-10-13T20:00:00Z'));
  const t = p.transactions.find((x) => x.kind === 'erc8004 registration')!;
  assert.ok(t, 'registration is in the ledger');
  assert.match(t.purpose, /agent ID 9906/);
  assert.equal(t.attribution.journalVerified, true);
  assert.equal(p.unresolved.length, 0);

  writeFileSync(join(dir, 'registrations', 'agent-registration.json'), JSON.stringify({ ...rec, state: 'UNCERTAIN' }));
  const q = buildEvidencePack(dir, new Date('2026-10-13T20:00:00Z'));
  assert.ok(q.unresolved.some((u) => /ERC-8004 registration is UNCERTAIN/.test(u)));
});
