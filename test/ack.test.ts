// Acknowledgement notes: additive, strictly gated, and never able to excuse an uncertain or paid order.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acknowledgementRefusal, readAcknowledgements, writeAcknowledgement } from '../src/ack.ts';
import { buildEvidencePack, renderEvidenceMarkdown } from '../src/evidence.ts';
import type { OrderRecord } from '../src/orderstore.ts';
import { tempDir } from './support.ts';

const PAYER = '0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4';
const order = (over: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    schemaVersion: 1, orderId: 'ord-stopped', state: 'STOPPED', code: 'CONVERSION_FAILED', message: 'm',
    createdAt: '2026-10-14T00:45:00Z', updatedAt: '2026-10-14T00:46:00Z',
    service: { id: 'x.posts.search', title: 't', url: 'u', provider: 'buy-gateway' }, payer: PAYER, bodyHash: 'h',
    approved: { asset: '0xA', symbol: 'USDT', payTo: '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B', amountAtomic: '5000', route: 'swap', totalMicroUsd: undefined, conversionProvider: 'textile-fx-v2' },
    approvedBy: 'human:web', steps: [{ kind: 'convert', state: 'failed', ref: 'swap-x' }, { kind: 'pay', state: 'pending' }],
    conversion: { provider: 'textile-fx-v2', swapPlanId: 'swap-x', state: 'FAILED', txHashes: ['0x' + 'aa'.repeat(32)] },
    needsAttention: true, ...over,
  }) as OrderRecord;
const facts = (ok = true) => [{ id: 'F1', statement: 'the approval was mined', evidence: 'tx 0xaa..', verified: ok }];
const ackBody = (ok = true) => ({ acknowledgedAt: '2026-10-14T01:30:00Z', acknowledgedBy: 'human:owner', note: 'approval mined; stale read; no swap; reused later', facts: facts(ok) });

function fixture(rec: OrderRecord) {
  const dir = tempDir();
  mkdirSync(join(dir, 'orders'), { recursive: true });
  writeFileSync(join(dir, 'orders', `${rec.orderId}.json`), JSON.stringify(rec));
  return dir;
}

test('eligibility: only a STOPPED, flagged order with no payment record can be acknowledged', () => {
  assert.equal(acknowledgementRefusal(order()), undefined);
  assert.match(acknowledgementRefusal(order({ state: 'UNCERTAIN' }))!, /not STOPPED/);
  assert.match(acknowledgementRefusal(order({ state: 'COMPLETED' }))!, /not STOPPED/);
  assert.match(acknowledgementRefusal(order({ payment: { route: 'converted', status: 'IN_DOUBT', receiptFile: undefined, receiptId: undefined, txHash: undefined } }))!, /payment record/);
  assert.match(acknowledgementRefusal(order({ needsAttention: false }))!, /nothing to acknowledge/);
});

test('writing: needs every fact verified and a note, never overwrites, and does not touch the order file', () => {
  const rec = order();
  const dir = fixture(rec);
  const before = readFileSync(join(dir, 'orders', 'ord-stopped.json'), 'utf8');
  assert.throws(() => writeAcknowledgement(dir, rec, ackBody(false)), /did not verify/);
  assert.throws(() => writeAcknowledgement(dir, rec, { ...ackBody(), facts: [] }), /at least one verified fact/);
  assert.throws(() => writeAcknowledgement(dir, rec, { ...ackBody(), note: '  ' }), /needs a note/);
  assert.throws(() => writeAcknowledgement(dir, order({ state: 'UNCERTAIN' }), ackBody()), /cannot acknowledge/);

  const a = writeAcknowledgement(dir, rec, ackBody());
  assert.equal(a.orderId, 'ord-stopped');
  assert.throws(() => writeAcknowledgement(dir, rec, ackBody()), /EEXIST|exists/i, 'a second write never overwrites');
  assert.equal(readFileSync(join(dir, 'orders', 'ord-stopped.json'), 'utf8'), before, 'the order record is byte-identical');
  assert.equal(readAcknowledgements(dir).acks.size, 1);
});

test('evidence: an acknowledged order is shown WITH its note and verified facts, and is no longer unresolved; its flag is not hidden', () => {
  const rec = order();
  const dir = fixture(rec);
  assert.equal(buildEvidencePack(dir).unresolved.length, 1, 'before: unresolved');
  writeAcknowledgement(dir, rec, ackBody());
  const p = buildEvidencePack(dir);
  assert.deepEqual(p.unresolved, []);
  assert.deepEqual(p.warnings, []);
  const o = p.orders[0]!;
  assert.equal(o.needsAttention, true, 'the order record still says needs attention');
  assert.match(o.acknowledged!.note, /stale read/);
  const md = renderEvidenceMarkdown(p);
  assert.match(md, /\*\*Acknowledged\*\*/);
  assert.match(md, /Verified:_ the approval was mined/);
});

test('evidence: an acknowledgement for an UNCERTAIN or paid order, or with unverified facts, is IGNORED with a warning', () => {
  for (const [label, rec, ack] of [
    ['uncertain', order({ orderId: 'u1', state: 'UNCERTAIN', code: 'PAYMENT_IN_DOUBT' }), ackBody()],
    ['paid', order({ orderId: 'p1', payment: { route: 'converted', status: 'CONFIRMED', receiptFile: 'r', receiptId: 'r', txHash: '0x1' } }), ackBody()],
    ['unverified', order({ orderId: 'v1' }), ackBody(false)],
  ] as const) {
    const dir = fixture(rec);
    mkdirSync(join(dir, 'acknowledgements'), { recursive: true });
    writeFileSync(join(dir, 'acknowledgements', `${rec.orderId}.json`), JSON.stringify({ schemaVersion: 1, orderId: rec.orderId, ...ack }));
    const p = buildEvidencePack(dir);
    assert.ok(p.warnings.some((w) => /acknowledgement for order .* is ignored/.test(w)), label);
    if (label !== 'paid') assert.equal(p.unresolved.length, 1, `${label}: still unresolved`);
    assert.equal(p.orders[0]!.acknowledged, undefined, label);
  }
});
