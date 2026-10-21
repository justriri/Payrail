// CHECKOUT OF SELLER-LISTED APIs, through the real HTTP server and real modules. The chain, Textile and the seller API are FAKES
// (simulated Textile provider/chain, in-memory receipts, a scripted seller transport): nothing here is mainnet evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { createBuyConvert } from '../src/buyconvert.ts';
import { createCheckout } from '../src/checkout.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { RateLimiter } from '../src/egress.ts';
import type { Resolver, Transport } from '../src/egress.ts';
import { TRANSFER_TOPIC, fundingMessage } from '../src/funding.ts';
import type { ChainReader, ChainReceipt } from '../src/funding.ts';
import { balance, verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import { recoverExecutions } from '../src/execute.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';

const mk = generateMasterKey('k1');
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const SECRET = 'sk_checkout_test_secret_0123456789';
const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const NOW = Date.now();

type SellerMode = 'ok' | 'bad' | 'timeout';

async function start() {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const receipts = new Map<string, ChainReceipt>();
  const reader: ChainReader = { blockNumber: async () => 5_000n, receipt: async (h) => receipts.get(h.toLowerCase()) ?? null };
  const txt = new Map<string, string>();
  const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const seller = { mode: 'ok' as SellerMode, calls: 0 };
  const transport: Transport = async (r) => {
    seller.calls++;
    if (seller.mode === 'timeout') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
    const ok = r.headers['x-api-key'] === SECRET && seller.mode === 'ok';
    return { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(ok ? { quote: 7, asOf: new Date().toISOString(), secretAnswer: 'PAID-CONTENT' } : { error: 'bad key' })) };
  };
  const execute = { call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport } } };
  const sim = createSimProvider({ reactor: TEXTILE_REACTOR, now: () => NOW });
  const walletUsdt = new Map<string, bigint>();
  const live = { funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: DEP, minConfirmations: 5, maxDepositAtomic: 5_000_000n, reader }, payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: 1_000_000n }, payoutRequestsEnabled: true, payoutVerify: { reader, token: USDT, sourceAddress: DEP, minConfirmations: 5 } };
  const usdtBalance = async (w: string) => walletUsdt.get(w.toLowerCase()) ?? 0n;
  const textile = sim;
  const buyConvert = createBuyConvert({
    db, registry: new RouteRegistry(db, [textile]), provider: textile,
    buyerSwap: { converterFor: () => { throw new Error('unused'); }, prepare: async () => { throw new Error('unused'); } },
    reader: sim.reader, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 3, maxUsdtAtomic: 5_000_000n,
    allowUndocumented: new Set(), now: () => NOW,
  });
  const checkout = createCheckout({ db, keys: [mk], funding: live.funding, execute, convert: buyConvert, usdtBalance });
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, execute, testCall: execute.call,
    domain: { txt: async (name) => (txt.has(name) ? [[txt.get(name)!]] : []) },
    live, buyConvert, checkout,
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'co-test', market, environment: 'production' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, o: { body?: unknown; bearer?: string } = {}) => {
    const r = await fetch(base + '/api/market' + path, {
      method,
      headers: { ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(o.body ?? {}) } : {}),
    });
    return { status: r.status, body: JSON.parse(await r.text()) as any };
  };
  return { db, call, receipts, txt, seller, sim, walletUsdt, buyConvert, checkout, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;

async function buyer(h: H) {
  const k = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } });
  const c = await h.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: s.body.nonce, signature: await k.signMessage({ message: s.body.message }) } });
  const id = c.body.accountId as string;
  const reg = await h.call('POST', '/funding/wallet', { bearer: c.body.token, body: { wallet: k.address, signature: await k.signMessage({ message: fundingMessage(id, k.address) }) } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return { token: c.body.token as string, id, key: k };
}
async function listing(h: H, o: { price?: string; priceCurrency?: string; url?: string } = {}) {
  const w = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address, chainId: 42220 } });
  const c = await h.call('POST', '/seller/login/complete', { body: { wallet: w.address, nonce: s.body.nonce, signature: await w.signMessage({ message: s.body.message }) } });
  const st = c.body.token as string;
  const created = await h.call('POST', '/seller/listings', { bearer: st, body: { name: 'Checkout API', endpointUrl: o.url ?? 'https://api.sellerco.example/v1/quote', price: o.price ?? '0.5', ...(o.priceCurrency ? { priceCurrency: o.priceCurrency } : {}) } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const l = created.body.listing;
  await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: st, body: { signature: await w.signMessage({ message: l.challenge.walletMessage }) } });
  h.txt.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
  await h.call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: st, body: { method: 'dns_txt' } });
  await h.call('POST', `/seller/listing/${l.id}/credential`, { bearer: st, body: { label: 'key', headerName: 'X-Api-Key', value: SECRET } });
  const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: st, body: { input: {} } });
  const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, { bearer: st, body: { contract: sug.body.suggestion } });
  await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, { bearer: st });
  const pub = await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st });
  assert.equal(pub.body.listing?.status, 'published', JSON.stringify(pub.body));
  h.seller.calls = 0; // contract suggestion and testing called the seller API while the listing was being set up
  return { id: l.id as string, token: st, wallet: w, sellerId: c.body.accountId as string };
}
let n = 0x500;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
/** the buyer's wallet sends `amount` USDT to the deposit address (recorded on the fake chain) */
function sendDeposit(h: H, from: string, amount: bigint, o: { status?: 'success' | 'reverted'; to?: string } = {}) {
  const tx = hash();
  h.receipts.set(tx, { status: o.status ?? 'success', blockNumber: 4_990n, logs: o.status === 'reverted' ? [] : [{ address: USDT, topics: [TRANSFER_TOPIC, pad(from), pad(o.to ?? DEP)], data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 1 }] });
  return tx;
}
const usdtT = (a: bigint) => formatUnits(a, 6);
const count = (h: H, table: string, where = '1=1') => Number((h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number | bigint }).n);
const start1 = (h: H, b: Awaited<ReturnType<typeof buyer>>, listingId: string, extra: Record<string, unknown> = {}) =>
  h.call('POST', '/checkout/start', { bearer: b.token, body: { listingId, input: {}, ...extra } });


import { approvePayout, markSent, payoutSummary } from '../src/payouts.ts';

/** one qualifying purchase of a 0.5 USDT listing by a fresh buyer: the seller earns 0.485 and the platform books 0.015 */
async function sale(h: H, l: Awaited<ReturnType<typeof listing>>) {
  const b = await buyer(h);
  h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
  const c = (await start1(h, b, l.id)).body.checkout;
  await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: sendDeposit(h, b.key.address, 500_000n) } });
  const run = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
  assert.equal(run.body.checkout.state, 'CHARGED', JSON.stringify(run.body));
  return { b, c };
}
const key = () => `pk-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;
const req = (h: H, token: string, over: Record<string, unknown> = {}, dest?: string) =>
  h.call('POST', '/seller/payouts', { bearer: token, body: { amount: '0.2', confirm: true, confirmDestination: dest, requestKey: key(), ...over } });
const info = async (h: H, token: string) => (await h.call('GET', '/seller/payouts', { bearer: token })).body;

test('accounting: earned = seller share only; the 3% platform fee is booked once and is never withdrawable; the books are consistent', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    await sale(h, l);
    const s = (await info(h, l.token)).summary;
    assert.equal(s.earned, '0.97');
    assert.equal(s.platformFees, '0.03');
    assert.equal(s.available, '0.97');
    assert.equal(s.pending, '0');
    assert.equal(s.held, '0');
    assert.equal(s.paidOut, '0');
    assert.equal(s.consistent, true);
    assert.equal(balance(h.db, 'platform', 'platform_fee', 'USDT'), 30_000n, 'the fee sits in the platform account, exactly once per sale');
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 970_000n);
    // the fee can never be requested: only the seller's 0.97 is available
    const dest = l.wallet.address;
    assert.equal((await req(h, l.token, { amount: '1' }, dest)).body.code, 'INSUFFICIENT_EARNINGS');
    assert.equal(verifyLedger(h.db).ok, true);
    assert.ok(Object.keys(s.meaning).length === 6, 'every figure is explained to the seller');
  } finally { await h.close(); }
});

test('held funds (unknown outcome) are shown as held, are not earned, and cannot be withdrawn', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l); // 0.485 earned
    const b = await buyer(h);
    h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
    const c = (await start1(h, b, l.id)).body.checkout;
    await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: sendDeposit(h, b.key.address, 500_000n) } });
    h.seller.mode = 'timeout';
    assert.equal((await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token })).body.checkout.state, 'UNRESOLVED');
    const s = (await info(h, l.token)).summary;
    assert.equal(s.earned, '0.485');
    assert.equal(s.held, '0.485', 'the seller share of the unresolved request');
    assert.equal(s.available, '0.485');
    assert.equal(s.consistent, true);
    assert.equal((await req(h, l.token, { amount: '0.9' }, l.wallet.address)).body.code, 'INSUFFICIENT_EARNINGS');
  } finally { await h.close(); }
});

test('a request needs explicit confirmation, the exact verified destination and a key; the server validates amount and balance, not the browser', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const dest = l.wallet.address;
    assert.equal((await req(h, l.token, { confirm: false }, dest)).body.code, 'NOT_CONFIRMED');
    assert.equal((await req(h, l.token, { confirm: undefined }, dest)).body.code, 'NOT_CONFIRMED');
    assert.equal((await req(h, l.token, {}, '0x00000000000000000000000000000000000000ee')).body.code, 'WRONG_DESTINATION');
    assert.equal((await h.call('POST', '/seller/payouts', { bearer: l.token, body: { amount: '0.2', confirm: true, confirmDestination: dest } })).status >= 400, true, 'a key is required');
    assert.equal((await req(h, l.token, { amount: '0.001' }, dest)).body.code, 'BAD_AMOUNT');
    assert.equal((await req(h, l.token, { amount: '0' }, dest)).status >= 400, true);
    assert.equal((await req(h, l.token, { amount: '-1' }, dest)).status >= 400, true);
    assert.equal((await req(h, l.token, { amount: '5' }, dest)).body.code, 'OVER_LIMIT');
    assert.equal((await req(h, l.token, { amount: '0.4851' }, dest)).body.code, 'INSUFFICIENT_EARNINGS');
    // a buyer session is not a seller
    const b = await buyer(h);
    assert.equal((await req(h, b.token, {}, dest)).status >= 400, true);
    assert.equal(count(h, 'payouts'), 0, 'every refusal left no payout and reserved nothing');
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 485_000n);
    // the real request
    const ok = await req(h, l.token, { amount: '0.2' }, dest.toUpperCase().replace('0X', '0x'));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.payout.state, 'requested');
    assert.equal(ok.body.payout.destination, dest.toLowerCase());
    assert.equal(ok.body.summary.available, '0.285');
    assert.equal(ok.body.summary.pending, '0.2');
    assert.equal(ok.body.summary.consistent, true);
    assert.match(ok.body.payout.label, /waiting for operator approval/);
    assert.equal(ok.body.payout.paid, false);
  } finally { await h.close(); }
});

test('idempotent and race-proof: the same key never reserves twice; concurrent requests cannot withdraw more than is available; open payouts are capped', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const dest = l.wallet.address;
    const k = key();
    const a = await req(h, l.token, { amount: '0.1', requestKey: k }, dest);
    const again = await req(h, l.token, { amount: '0.1', requestKey: k }, dest);
    assert.equal(a.status, 201);
    assert.equal(again.body.payout.id, a.body.payout.id, 'a double click returns the same payout');
    assert.equal(count(h, 'payouts'), 1);
    assert.equal(balance(h.db, l.sellerId, 'payout_pending', 'USDT'), 100_000n, 'reserved once');
    assert.equal((await req(h, l.token, { amount: '0.2', requestKey: k }, dest)).body.code, 'KEY_REUSED');
    // two simultaneous requests for most of what is left: exactly one can win
    const rest = await Promise.all([req(h, l.token, { amount: '0.3' }, dest), req(h, l.token, { amount: '0.3' }, dest)]);
    assert.deepEqual(rest.map((r) => r.status).sort(), [201, 409]);
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 85_000n);
    assert.equal(balance(h.db, l.sellerId, 'payout_pending', 'USDT'), 400_000n);
    assert.equal(verifyLedger(h.db).ok, true);
    // the open-payout cap
    const third = await req(h, l.token, { amount: '0.02' }, dest);
    assert.equal(third.status, 201);
    assert.equal((await req(h, l.token, { amount: '0.02' }, dest)).body.code, 'TOO_MANY_OPEN');
  } finally { await h.close(); }
});

test('the seller cannot see or cancel another seller\'s payouts; only a merely REQUESTED payout can be cancelled by the seller, and it returns to available', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const other = await listing(h, { url: 'https://api.otherco.example/v1/quote' });
    const p = (await req(h, l.token, { amount: '0.2' }, l.wallet.address)).body.payout;
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/cancel`, { bearer: other.token })).status, 404);
    assert.equal((await info(h, other.token)).payouts.length, 0);
    const c = await h.call('POST', `/seller/payouts/${p.id}/cancel`, { bearer: l.token });
    assert.equal(c.body.payout.state, 'cancelled');
    assert.equal(c.body.summary.available, '0.485');
    assert.equal(c.body.summary.pending, '0');
    // an approved payout may already be on its way: the seller cannot pull it back
    const p2 = (await req(h, l.token, { amount: '0.2' }, l.wallet.address)).body.payout;
    approvePayout(h.db, p2.id, 'operator');
    const refused = await h.call('POST', `/seller/payouts/${p2.id}/cancel`, { bearer: l.token });
    assert.equal(refused.body.code, 'WRONG_STATE');
    assert.equal(balance(h.db, l.sellerId, 'payout_pending', 'USDT'), 200_000n);
  } finally { await h.close(); }
});

test('NEVER paid without confirmation: sent but not on-chain stays pending (not returned, not retried); a wrong transfer does not confirm; a revert returns the funds; the real transfer confirms exactly once', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const dest = l.wallet.address.toLowerCase();
    const p = (await req(h, l.token, { amount: '0.2' }, l.wallet.address)).body.payout;
    approvePayout(h.db, p.id, 'operator');
    const tx = hash();
    markSent(h.db, p.id, tx, 'operator'); // the operator signed and recorded it BEFORE broadcasting
    // 1. the chain does not show it yet: the seller sees "sent, not paid"; nothing is returned or re-requested
    let v = await info(h, l.token);
    assert.equal(v.payouts[0].state, 'sent');
    assert.equal(v.payouts[0].paid, false);
    assert.match(v.payouts[0].label, /NOT paid yet/);
    assert.equal(v.summary.pending, '0.2');
    assert.equal(v.summary.paidOut, '0');
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 285_000n, 'funds are not released while the outcome is unknown');
    // 2. a transfer of the WRONG amount, or to the wrong address, is not confirmation
    h.receipts.set(tx, { status: 'success', blockNumber: 4_990n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(DEP), pad(dest)], data: `0x${(199_999n).toString(16).padStart(64, '0')}`, logIndex: 1 }] });
    v = await info(h, l.token);
    assert.equal(v.payouts[0].state, 'sent');
    h.receipts.set(tx, { status: 'success', blockNumber: 4_990n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(DEP), pad('0x00000000000000000000000000000000000000ee')], data: `0x${(200_000n).toString(16).padStart(64, '0')}`, logIndex: 1 }] });
    assert.equal((await info(h, l.token)).payouts[0].state, 'sent');
    // 3. not enough confirmations yet
    h.receipts.set(tx, { status: 'success', blockNumber: 4_999n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(DEP), pad(dest)], data: `0x${(200_000n).toString(16).padStart(64, '0')}`, logIndex: 1 }] });
    assert.equal((await info(h, l.token)).payouts[0].state, 'sent');
    // 4. the genuine transfer, confirmed
    h.receipts.set(tx, { status: 'success', blockNumber: 4_990n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(DEP), pad(dest)], data: `0x${(200_000n).toString(16).padStart(64, '0')}`, logIndex: 1 }] });
    v = await info(h, l.token);
    assert.equal(v.payouts[0].state, 'confirmed');
    assert.equal(v.payouts[0].paid, true);
    assert.equal(v.payouts[0].txHash, tx);
    assert.equal(v.payouts[0].txUrl, `https://celoscan.io/tx/${tx}`);
    assert.equal(v.summary.paidOut, '0.2');
    assert.equal(v.summary.pending, '0');
    assert.equal(v.summary.available, '0.285');
    assert.equal(v.summary.consistent, true);
    // asking again changes nothing (confirmed exactly once)
    await info(h, l.token);
    assert.equal(count(h, 'ledger_transactions', "kind = 'payout_confirm'"), 1);
    assert.equal(verifyLedger(h.db).ok, true);
    assert.equal(payoutSummary(h.db, l.sellerId).paidOut, 200_000n);
  } finally { await h.close(); }
});

test('a payout transfer that REVERTED on-chain is failed and the funds return to available; they can then be requested again', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const p = (await req(h, l.token, { amount: '0.3' }, l.wallet.address)).body.payout;
    approvePayout(h.db, p.id, 'operator');
    const tx = hash();
    markSent(h.db, p.id, tx, 'operator');
    h.receipts.set(tx, { status: 'reverted', blockNumber: 4_990n, logs: [] });
    const v = await info(h, l.token);
    assert.equal(v.payouts[0].state, 'failed');
    assert.equal(v.payouts[0].paid, false);
    assert.equal(v.summary.available, '0.485');
    assert.equal(v.summary.pending, '0');
    assert.equal(v.summary.paidOut, '0');
    assert.equal(v.summary.consistent, true);
    assert.equal((await req(h, l.token, { amount: '0.3' }, l.wallet.address)).status, 201);
  } finally { await h.close(); }
});

test('payout requests can be switched off by the operator, and the web server has no route that sends funds or marks a payout paid', async () => {
  const h = await start();
  try {
    const l = await listing(h);
    await sale(h, l);
    const p = (await req(h, l.token, { amount: '0.2' }, l.wallet.address)).body.payout;
    for (const path of ['approve', 'send', 'confirm', 'mark-paid', 'complete']) {
      const r = await h.call('POST', `/seller/payouts/${p.id}/${path}`, { bearer: l.token, body: { txHash: hash() } });
      assert.ok(r.status >= 400, `${path} must not exist: ${r.status}`);
    }
    assert.equal((await info(h, l.token)).payouts[0].state, 'requested');
    assert.equal((await info(h, l.token)).payouts[0].paid, false);
  } finally { await h.close(); }
});
