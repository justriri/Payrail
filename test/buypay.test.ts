// Buy AI purchases paid by the BUYER'S OWN wallet (x402 / EIP-3009), against a FAKE gateway and a FAKE chain.
// No network, no keys that matter, no money. The fake gateway enforces what the real one does: it answers 402 until a valid X-PAYMENT
// authorization signed by the payer arrives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { BuyPayError, createBuyPay } from '../src/buypay.ts';
import { openDb } from '../src/db.ts';
import { createAccount } from '../src/ledger.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

import { FAKE_TX as TX, PAY_TO, USDT, createFakeBuy, signAuthorization } from './fakebuy.ts';
import type { FakeBuyOptions } from './fakebuy.ts';

const NOW = 1_800_000_000_000;
function world(o: Partial<Omit<FakeBuyOptions, 'now'>> & { maxPerPayment?: bigint } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const fake = createFakeBuy({ ...o, now });
  const buy = createBuyPay({
    db, catalog: { get: async () => fake.catalog }, policy: DEFAULT_POLICY, verify: fake.verify, chainId: 42220, usdt: USDT, payTo: PAY_TO,
    maxPerPaymentAtomic: o.maxPerPayment ?? 100_000n, feeBps: 300, fetchImpl: fake.fetchImpl, now, sleep: async () => undefined, settleDelayMs: 0,
  });
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, now);
  const acct = privateKeyToAccount(generatePrivateKey());
  const sign = (td: any, signer: { signTypedData: (a: any) => Promise<Hex> } = acct) => signAuthorization(signer, td);
  return { db, buy, buyer, acct, sign, gateway: fake.gateway, tick: (ms: number) => (clock += ms), transfers: fake.transfers, settled: fake.settled };
}
const code = async (p: Promise<unknown>) => {
  try { await p; return 'no error'; } catch (e) { return e instanceof BuyPayError ? e.code : `other:${(e as Error).message}`; }
};

test('quote: the real price comes from the gateway challenge; the authorization is exactly buyer -> Buy payee, USDT, Celo; the 3% fee is DUE, not collected', async () => {
  const w = world();
  const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'celo' } });
  assert.equal(order.state, 'QUOTED');
  assert.equal(order.confirmed, false);
  assert.equal(order.amount, '0.005');
  assert.deepEqual(order.network, { name: 'celo', chainId: 42220, scheme: 'exact' });
  assert.equal(order.token.symbol, 'USDT');
  assert.equal(order.token.address.toLowerCase(), USDT.toLowerCase());
  assert.equal(order.payTo, PAY_TO);
  assert.equal(order.payer, w.acct.address);
  const td = order.typedData as any;
  assert.equal(td.primaryType, 'TransferWithAuthorization');
  assert.equal(td.domain.chainId, 42220);
  assert.equal(td.domain.verifyingContract.toLowerCase(), USDT.toLowerCase());
  assert.equal(td.message.to, PAY_TO);
  assert.equal(td.message.from, w.acct.address);
  assert.equal(td.message.value, '5000');
  assert.equal(td.message.validBefore, String(NOW / 1000 + 60));
  assert.equal(order.fee.percent, 3);
  assert.equal(order.fee.amountAtomic, '150');
  assert.equal(order.fee.state, 'not_collected');
  assert.match(order.fee.note, /NOT been collected/);
  assert.equal(w.gateway.paidRequests, 0, 'quoting sends nothing paid');
  assert.equal(w.gateway.unpaidRequests, 1);
});

test('quote refuses unsafe or unsupported requirements before the wallet is ever asked to sign', async () => {
  const q = (w: ReturnType<typeof world>, id = 'x.posts.search', input: unknown = { query: 'x' }) => w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: id, input });
  assert.equal(await code(q(world({ offers: 'usdc-only' }))), 'NO_USDT_OFFER');
  assert.equal(await code(q(world({ offers: 'wrong-payto' }))), 'CHALLENGE_REJECTED');
  assert.equal(await code(q(world({ offers: 'wrong-network' }))), 'CHALLENGE_REJECTED');
  assert.equal(await code(q(world({ price: '999999', maxPerPayment: 100_000n }))), 'PRICE_ABOVE_LIMIT');
  const w = world();
  assert.equal(await code(q(w, 'no.such.api')), 'NOT_FOUND');
  assert.equal(await code(q(w, 'down.api')), 'SERVICE_UNAVAILABLE');
  assert.equal(await code(q(w, 'x.posts.search', { wrong: 1 })), 'INVALID_INPUT');
  assert.equal(await code(q(w, 'x.posts.search', [1, 2])), 'INVALID_INPUT');
  assert.equal(w.gateway.paidRequests, 0);
  assert.equal(Number(w.db.prepare('SELECT COUNT(*) AS n FROM buy_orders').get()!.n), 0, 'no order exists for any refused quote');
});

test('pay: a valid signature makes exactly ONE paid request; the order is CONFIRMED only after independent on-chain verification', async () => {
  const w = world();
  const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'celo' } });
  const sig = await w.sign(order.typedData);
  const done = (await w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: sig })).order;
  assert.equal(done.state, 'CONFIRMED');
  assert.equal(done.confirmed, true);
  assert.equal(done.txHash, TX);
  assert.equal(done.txUrl, `https://celoscan.io/tx/${TX}`);
  assert.equal(done.settlement?.transferVerified, true);
  assert.equal(done.settlement?.authorization, 'settled');
  assert.match(done.response?.body ?? '', /"posts":\[\{"id":1,"text":"hello from the fake gateway"\}\]/);
  assert.match(done.response?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(w.gateway.paidRequests, 1);
  assert.equal(w.gateway.lastAuth?.from, w.acct.address, 'the buyer wallet is the payer');
  assert.equal(w.gateway.lastAuth?.to, PAY_TO);
  // fee accounting is honest
  assert.equal(done.fee.state, 'not_collected');
  assert.deepEqual(w.buy.summary(), { confirmedOrders: 1, paidToBuyAtomic: '5000', feeDueAtomic: '150', feeCollectedAtomic: '0' });
  // paying again never re-sends: the stored state is reported
  const again = await w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: sig });
  assert.equal(again.alreadyProcessed, true);
  assert.equal(w.gateway.paidRequests, 1, 'a second pay call did not send a second paid request');
  // the events trail is append-only and tells the story
  assert.deepEqual(w.buy.events(w.buyer, order.id).map((e) => (e as any).state), ['QUOTED', 'SUBMITTED', 'CONFIRMED']);
});

test('pay refuses a signature that is not the buyer\'s, or not over this exact authorization; nothing is sent and the order stays signable', async () => {
  const w = world();
  const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'celo' } });
  const stranger = privateKeyToAccount(generatePrivateKey());
  assert.equal(await code(w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: await w.sign(order.typedData, stranger) })), 'BAD_SIGNATURE');
  // a signature over a tampered authorization (different payee) is refused too
  const tampered = JSON.parse(JSON.stringify(order.typedData));
  tampered.message.to = '0x00000000000000000000000000000000000000ee';
  assert.equal(await code(w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: await w.sign(tampered) })), 'BAD_SIGNATURE');
  const tamperedValue = JSON.parse(JSON.stringify(order.typedData));
  tamperedValue.message.value = '1';
  assert.equal(await code(w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: await w.sign(tamperedValue) })), 'BAD_SIGNATURE');
  assert.equal(await code(w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: '0x1234' })), 'BAD_SIGNATURE');
  assert.equal(w.gateway.paidRequests, 0);
  assert.equal(w.buy.order(w.buyer, order.id).state, 'QUOTED');
  // someone else's order cannot be paid by another account
  const other = createAccount(w.db, { kind: 'buyer', displayName: 'X' }, () => NOW);
  assert.equal(await code(w.buy.pay({ buyerId: other, orderId: order.id, signature: await w.sign(order.typedData) })), 'NOT_OWNER');
  // the real signature still works afterwards
  assert.equal((await w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: await w.sign(order.typedData) })).order.state, 'CONFIRMED');
});

test('an expired quote is never submitted', async () => {
  const w = world();
  const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'celo' } });
  const sig = await w.sign(order.typedData);
  w.tick(70_000);
  assert.equal(await code(w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: sig })), 'QUOTE_EXPIRED');
  assert.equal(w.gateway.paidRequests, 0);
  assert.equal(w.buy.order(w.buyer, order.id).state, 'EXPIRED');
});

test('failures are never reported as success and never resent', async () => {
  // the gateway rejects the authorization (402): FAILED, nothing charged
  let w = world({ mode: 'http402' });
  let q = (await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } })).order;
  let r = (await w.buy.pay({ buyerId: w.buyer, orderId: q.id, signature: await w.sign(q.typedData) })).order;
  assert.equal(r.state, 'FAILED');
  assert.equal(r.confirmed, false);
  assert.match(r.failure ?? '', /nothing was charged/);

  // a 500 after the authorization: not settled yet and the window is open -> UNRESOLVED; recheck later; never resent
  w = world({ mode: 'http500' });
  q = (await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } })).order;
  r = (await w.buy.pay({ buyerId: w.buyer, orderId: q.id, signature: await w.sign(q.typedData) })).order;
  assert.equal(r.state, 'UNRESOLVED');
  assert.equal(r.confirmed, false);
  assert.equal(w.gateway.paidRequests, 1);
  const still = await w.buy.recheck({ buyerId: w.buyer, orderId: q.id });
  assert.equal(still.state, 'UNRESOLVED');
  assert.equal(w.gateway.paidRequests, 1, 'recheck reads the chain only');
  w.tick(120_000); // the authorization window has passed unused
  assert.equal((await w.buy.recheck({ buyerId: w.buyer, orderId: q.id })).state, 'FAILED');

  // a transport error after sending: same treatment
  w = world({ mode: 'throw' });
  q = (await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } })).order;
  r = (await w.buy.pay({ buyerId: w.buyer, orderId: q.id, signature: await w.sign(q.typedData) })).order;
  assert.equal(r.state, 'UNRESOLVED');
  assert.match(r.failure ?? '', /no usable answer/);

  // the gateway says 200 but there is NO on-chain evidence: REVIEW, never CONFIRMED
  w = world({ mode: 'ok_unsettled' });
  q = (await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } })).order;
  r = (await w.buy.pay({ buyerId: w.buyer, orderId: q.id, signature: await w.sign(q.typedData) })).order;
  assert.equal(r.state, 'REVIEW');
  assert.equal(r.confirmed, false);
  assert.deepEqual(w.buy.summary(), { confirmedOrders: 0, paidToBuyAtomic: '0', feeDueAtomic: '0', feeCollectedAtomic: '0' });

  // the gateway's payment response says failed even with HTTP 200: not a success
  w = world({ mode: 'ok_failed_flag' });
  q = (await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } })).order;
  r = (await w.buy.pay({ buyerId: w.buyer, orderId: q.id, signature: await w.sign(q.typedData) })).order;
  assert.notEqual(r.state, 'CONFIRMED');
});

test('a settlement that does not match the order cannot confirm it: wrong amount or wrong payee on-chain means REVIEW, never paid', async () => {
  for (const chain of ['wrong-amount', 'wrong-payee'] as const) {
    const w = world({ chain });
    const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } });
    const r = (await w.buy.pay({ buyerId: w.buyer, orderId: order.id, signature: await w.sign(order.typedData) })).order;
    assert.equal(r.state, 'REVIEW', chain);
    assert.equal(r.confirmed, false);
    assert.equal(r.settlement?.transferVerified, false);
    assert.equal(w.buy.summary().confirmedOrders, 0);
  }
});

test('interrupted submissions are UNRESOLVED after a restart and are never resent', async () => {
  const w = world();
  const { order } = await w.buy.quote({ buyerId: w.buyer, wallet: w.acct.address, serviceId: 'x.posts.search', input: { query: 'a' } });
  w.db.prepare("UPDATE buy_orders SET state = 'SUBMITTED', updated_at = ? WHERE id = ?").run(new Date(NOW - 10 * 60_000).toISOString(), order.id);
  assert.equal(w.buy.recoverInterrupted(), 1);
  assert.equal(w.buy.order(w.buyer, order.id).state, 'UNRESOLVED');
  assert.equal(w.gateway.paidRequests, 0);
});
