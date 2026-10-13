// Tests for src/chainread.ts: intermittent "not found", pruned receipts, unavailable endpoints, delayed receipts,
// genuinely missing transactions. Everything is faked; no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChainReads } from '../src/chainread.ts';
import type { ReadEndpoint, ReceiptShape } from '../src/chainread.ts';

const HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const BLOCK_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const receipt = (over: Partial<ReceiptShape> = {}): ReceiptShape => ({
  status: 'success',
  blockNumber: 79_963_003n,
  blockHash: BLOCK_HASH,
  transactionHash: HASH,
  ...over,
});

type Step = 'ok' | 'null' | 'err' | ReceiptShape;
const notFound = () => Object.assign(new Error('Transaction receipt could not be found'), { name: 'TransactionReceiptNotFoundError' });
const txNotFound = () => Object.assign(new Error('Transaction could not be found'), { name: 'TransactionNotFoundError' });

/** An endpoint whose receipt answers follow `receipts` (the last step repeats), and whose by-hash answer is `tx`. */
function endpoint(
  url: string,
  receipts: Step[],
  tx: 'present' | 'missing' | 'err' = 'present',
): ReadEndpoint & { receiptCalls: number } {
  const e = {
    url,
    receiptCalls: 0,
    async getTransactionReceipt() {
      const s = receipts[Math.min(e.receiptCalls, receipts.length - 1)]!;
      e.receiptCalls += 1;
      if (s === 'null') throw notFound();
      if (s === 'err') throw new Error('HTTP request failed: 503');
      return s === 'ok' ? receipt() : s;
    },
    async getTransaction() {
      if (tx === 'missing') throw txNotFound();
      if (tx === 'err') throw new Error('HTTP request failed: 503');
      return { hash: HASH, blockNumber: 79_963_003n, blockHash: BLOCK_HASH };
    },
  };
  return e as never;
}

const noSleep = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
};

test('intermittent "not found" on the primary is retried and the receipt is found (the real forno behaviour)', async () => {
  const s = noSleep();
  const primary = endpoint('primary', ['null', 'null', 'ok']);
  const reads = createChainReads([primary], { sleep: s.sleep });
  const r = await reads.lookupReceipt(HASH);
  assert.equal(r.kind, 'found');
  assert.equal(primary.receiptCalls, 3);
  assert.deepEqual(s.sleeps, [250, 500], 'bounded exponential backoff between rounds');
});

test('a primary that always prunes the receipt is covered by a fallback endpoint', async () => {
  const pruned = endpoint('forno', ['null']);
  const good = endpoint('ankr', ['ok']);
  const reads = createChainReads([pruned, good], { sleep: noSleep().sleep });
  const r = await reads.lookupReceipt(HASH);
  assert.equal(r.kind, 'found');
  assert.equal(r.kind === 'found' && r.endpoints[0], 'ankr');
});

test('an unavailable endpoint (errors) is skipped; the other endpoint answers', async () => {
  const down = endpoint('down', ['err'], 'err');
  const good = endpoint('good', ['ok']);
  const r = await createChainReads([down, good], { sleep: noSleep().sleep }).lookupReceipt(HASH);
  assert.equal(r.kind, 'found');
});

test('every endpoint erroring is an ERROR (the chain could not be read), never "not found" or "failed"', async () => {
  const a = endpoint('a', ['err'], 'err');
  const b = endpoint('b', ['err'], 'err');
  const r = await createChainReads([a, b], { sleep: noSleep().sleep }).lookupReceipt(HASH, { attempts: 3 });
  assert.equal(r.kind, 'error');
  assert.equal(a.receiptCalls, 3, 'bounded: exactly the allowed rounds');
});

test('transaction is in a block but NO endpoint has its receipt: receipt_unavailable (inconclusive), not failed, not found', async () => {
  const a = endpoint('a', ['null'], 'present');
  const b = endpoint('b', ['null'], 'present');
  const r = await createChainReads([a, b], { sleep: noSleep().sleep }).lookupReceipt(HASH, { attempts: 3 });
  assert.equal(r.kind, 'receipt_unavailable');
  assert.match(r.kind === 'receipt_unavailable' ? r.detail : '', /inconclusive, not a failure/);
});

test('a genuinely missing transaction (nobody knows it) is not_found, after bounded retries on every endpoint', async () => {
  const a = endpoint('a', ['null'], 'missing');
  const b = endpoint('b', ['null'], 'missing');
  const r = await createChainReads([a, b], { sleep: noSleep().sleep }).lookupReceipt(HASH, { attempts: 4 });
  assert.equal(r.kind, 'not_found');
  assert.equal(a.receiptCalls, 4);
  assert.equal(b.receiptCalls, 4);
});

test('a delayed receipt (not mined for the first rounds) is found once it appears', async () => {
  const s = noSleep();
  const a = endpoint('a', ['null', 'null', 'null', 'ok'], 'missing');
  const r = await createChainReads([a], { sleep: s.sleep }).lookupReceipt(HASH, { attempts: 6 });
  assert.equal(r.kind, 'found');
  assert.equal(s.sleeps.length, 3);
});

test('a receipt for a DIFFERENT transaction is never accepted', async () => {
  const wrong = endpoint('wrong', [receipt({ transactionHash: ('0x' + '11'.repeat(32)) as `0x${string}` })], 'missing');
  const r = await createChainReads([wrong], { sleep: noSleep().sleep }).lookupReceipt(HASH, { attempts: 2 });
  assert.notEqual(r.kind, 'found');
  assert.equal(r.kind, 'error');
});

test('endpoints that disagree (status) are a CONFLICT: inconclusive, never confirmed', async () => {
  const a = endpoint('a', ['ok']);
  const b = endpoint('b', [receipt({ status: 'reverted' })]);
  const r = await createChainReads([a, b], { sleep: noSleep().sleep }).lookupReceipt(HASH, { minAgreement: 2 });
  assert.equal(r.kind, 'conflict');
});

test('a receipt that does not match the block the transaction was included in is a CONFLICT', async () => {
  const e = endpoint('a', [receipt({ blockNumber: 5n, blockHash: ('0x' + '22'.repeat(32)) as `0x${string}` })], 'present');
  const r = await createChainReads([e], { sleep: noSleep().sleep }).lookupReceipt(HASH);
  assert.equal(r.kind, 'conflict');
});

test('minAgreement 2: one endpoint alone is insufficient; two agreeing endpoints are found', async () => {
  const solo = createChainReads([endpoint('a', ['ok']), endpoint('b', ['null'])], { sleep: noSleep().sleep });
  const one = await solo.lookupReceipt(HASH, { minAgreement: 2, attempts: 2 });
  assert.equal(one.kind, 'insufficient_agreement');
  assert.equal(one.kind === 'insufficient_agreement' && one.agreed, 1);

  const both = createChainReads([endpoint('a', ['ok']), endpoint('b', ['ok'])], { sleep: noSleep().sleep });
  const two = await both.lookupReceipt(HASH, { minAgreement: 2 });
  assert.equal(two.kind, 'found');
  assert.equal(two.kind === 'found' && two.endpoints.length, 2);
});

test('lookupTransaction: found / not_found / error are distinguished', async () => {
  const s = noSleep();
  assert.equal((await createChainReads([endpoint('a', ['null'], 'present')], { sleep: s.sleep }).lookupTransaction(HASH)).kind, 'found');
  assert.equal((await createChainReads([endpoint('a', ['null'], 'missing')], { sleep: s.sleep }).lookupTransaction(HASH, { attempts: 2 })).kind, 'not_found');
  assert.equal((await createChainReads([endpoint('a', ['null'], 'err')], { sleep: s.sleep }).lookupTransaction(HASH, { attempts: 2 })).kind, 'error');
});

test('backoff is capped and attempts are bounded', async () => {
  const s = noSleep();
  const a = endpoint('a', ['null'], 'missing');
  await createChainReads([a], { sleep: s.sleep }).lookupReceipt(HASH, { attempts: 8, backoffMs: 500, maxBackoffMs: 1500 });
  assert.deepEqual(s.sleeps, [500, 1000, 1500, 1500, 1500, 1500, 1500]);
  assert.equal(a.receiptCalls, 8);
});
