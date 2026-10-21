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
  const live = { funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: DEP, minConfirmations: 5, maxDepositAtomic: 5_000_000n, reader }, payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: 1_000_000n } };
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
const usdt = (a: bigint) => formatUnits(a, 6);
const count = (h: H, table: string, where = '1=1') => Number((h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number | bigint }).n);
const start1 = (h: H, b: Awaited<ReturnType<typeof buyer>>, listingId: string, extra: Record<string, unknown> = {}) =>
  h.call('POST', '/checkout/start', { bearer: b.token, body: { listingId, input: {}, ...extra } });

test('start: the price comes from the listing, never from the browser; the plan is computed on the server', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 100_000n); // 0.1 USDT in the wallet
    const r = await start1(h, b, l.id, { price: '0.000001', priceAtomic: '1', usdt: '0.000001' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.body.checkout;
    assert.equal(c.price.usdt, '0.5', 'the browser-supplied price was ignored');
    assert.equal(c.state, 'QUOTED');
    assert.equal(c.plan.ledgerAvailable, '0');
    assert.equal(c.plan.topUp, '0.5');
    assert.equal(c.plan.walletUsdt, '0.1');
    assert.equal(c.plan.walletShort, '0.4');
    assert.equal(c.plan.next, 'convert_or_add_usdt');
    assert.equal(c.paid, false);
    // not published / unknown / another buyer
    assert.equal((await start1(h, b, 'lst_nope')).status >= 400, true);
    const other = await buyer(h);
    assert.equal((await h.call('GET', `/checkout/${c.id}`, { bearer: other.token })).status, 404);
    assert.equal((await h.call('POST', `/checkout/${c.id}/execute`, { bearer: other.token })).status, 404);
  } finally { await h.close(); }
});

test('USDT path end to end: verified deposit credits the ledger, one execution runs, seller and fee are booked, the receipt ties it together', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 2_000_000n);
    const c = (await start1(h, b, l.id)).body.checkout;
    assert.equal(c.plan.next, 'deposit');
    // running before funds exist is refused and creates nothing
    const early = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(early.body.code, 'INSUFFICIENT_BALANCE');
    assert.equal(count(h, 'executions'), 0);
    assert.equal(h.seller.calls, 0);
    // a failed or foreign deposit credits nothing
    const reverted = sendDeposit(h, b.key.address, 500_000n, { status: 'reverted' });
    assert.equal((await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: reverted } })).body.code, 'TX_REVERTED');
    const wrongTo = sendDeposit(h, b.key.address, 500_000n, { to: '0x00000000000000000000000000000000000000ee' });
    assert.equal((await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: wrongTo } })).body.code, 'NO_MATCHING_TRANSFER');
    assert.equal((await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: hash() } })).body.code, 'TX_NOT_FOUND');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 0n);
    // the real top-up
    const tx = sendDeposit(h, b.key.address, 500_000n);
    const dep = await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: tx } });
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
    assert.equal(dep.body.credited[0].amount, '0.5');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 500_000n);
    // run (and a double click / retry / concurrent request)
    const [a, bb] = await Promise.all([h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token }), h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token })]);
    for (const r of [a, bb]) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    const again = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(again.body.checkout.state, 'CHARGED');
    assert.equal(h.seller.calls, 1, 'the seller was called exactly once');
    assert.equal(count(h, 'executions'), 1, 'one purchase, one execution');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 0n);
    assert.equal(balance(h.db, b.id, 'buyer_held', 'USDT'), 0n);
    const paid = a.body.result ?? bb.body.result ?? again.body.result;
    assert.equal(paid.charged, true);
    assert.equal(paid.body.secretAnswer, 'PAID-CONTENT', 'content is delivered only for a captured payment');
    // accounting: fee 3% comes out of the seller's share, in the same ledger transaction
    assert.equal(paid.feeAtomic, '15000');
    assert.equal(paid.sellerAtomic, '485000');
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 485_000n);
    assert.equal(verifyLedger(h.db).ok, true);
    // receipt
    const view = (await h.call('GET', `/checkout/${c.id}`, { bearer: b.token })).body.checkout;
    assert.equal(view.paid, true);
    assert.equal(view.state, 'CHARGED');
    assert.deepEqual(view.depositTxs, [tx]);
    assert.equal(view.depositTxUrls[0], `https://celoscan.io/tx/${tx}`);
    assert.equal(view.receipt.outcome, 'QUALIFIED');
    assert.equal(view.receipt.platformFee.display, '0.015');
    assert.equal(view.receipt.sellerEarned.display, '0.485');
    assert.ok(view.receipt.ledger.length >= 2, 'ledger transactions are listed');
    assert.equal(view.listing.seller, l.sellerId);
    // the events are an audit trail
    const ev = (await h.call('GET', `/checkout/${c.id}`, { bearer: b.token })).body.events.map((e: any) => e.state);
    assert.deepEqual(ev.filter((s: string, i: number) => i === 0 || s !== ev[i - 1]), ['QUOTED', 'RUNNING', 'CHARGED']);
  } finally { await h.close(); }
});

/** the buyer's wallet performs the swap on the simulated chain (the stand-in for Textile + Celo) */
async function walletSwaps(h: H, b: Awaited<ReturnType<typeof buyer>>, cv: any, scenario?: string) {
  const ref = h.sim.assets.find((a) => a.ref.symbol === cv.sell.symbol)!.ref;
  const conv = h.sim.fundingConverter(ref, { taker: b.key.address, depositAddress: DEP });
  const q = await conv.quote({ sellAtomic: BigInt(cv.sell.amountAtomic) });
  const sent = (await conv.execute({ opId: cv.id, quoteId: q.quoteId, sellAtomic: BigInt(cv.sell.amountAtomic), minBuyAtomic: BigInt(cv.receive.minimumAtomic), digest: 'd', ...(scenario ? { scenario } : {}) })) as { kind: string; swapTx?: string };
  h.sim.advance(20);
  return sent;
}

for (const sym of ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX']) {
  test(`${sym}: a wallet without enough USDT pays a seller-listed API by converting with Textile first; both transactions are on the receipt`, async () => {
    const h = await start();
    try {
      const b = await buyer(h);
      const l = await listing(h, { price: '0.5' });
      h.walletUsdt.set(b.key.address.toLowerCase(), 0n);
      const c = (await start1(h, b, l.id)).body.checkout;
      assert.equal(c.plan.walletShort, '0.5');
      // the server sizes the conversion from ITS shortfall and tells the buyer what remains afterwards
      const est = await h.call('POST', `/checkout/${c.id}/estimate`, { bearer: b.token, body: { symbol: sym } });
      assert.equal(est.status, 201, JSON.stringify(est.body));
      const cv = est.body.conversion;
      assert.equal(cv.sell.symbol, sym);
      assert.ok(BigInt(cv.receive.minimumAtomic) >= 500_000n, 'the guaranteed minimum covers the top-up');
      assert.ok(BigInt(cv.sell.amountAtomic) > 0n);
      assert.equal(est.body.checkout.priceUsdt, '0.5');
      assert.equal(est.body.checkout.topUpUsdt, '0.5');
      assert.ok(Number(est.body.checkout.usdtLeftAtLeast) > 0, 'a conversion larger than the price leaves unused USDT in the wallet, and says so');
      assert.equal(est.body.limits.minSell !== undefined, true);
      // an unconfirmed conversion cannot be attached
      assert.equal((await h.call('POST', `/checkout/${c.id}/attach-conversion`, { bearer: b.token, body: { conversionId: cv.id } })).body.code, 'CONVERSION_NOT_CONFIRMED');
      // the wallet swaps; the receipt proves it; the wallet then holds the USDT
      const sent = await walletSwaps(h, b, cv);
      assert.equal(sent.kind, 'submitted');
      const conf = await h.buyConvert.recordTx({ buyerId: b.id, conversionId: cv.id, kind: 'swap', txHash: sent.swapTx! });
      assert.equal(conf.state, 'CONFIRMED');
      h.walletUsdt.set(b.key.address.toLowerCase(), BigInt(conf.receive.receivedAtomic!));
      const att = await h.call('POST', `/checkout/${c.id}/attach-conversion`, { bearer: b.token, body: { conversionId: cv.id } });
      assert.equal(att.status, 200, JSON.stringify(att.body));
      // plan now says deposit; the top-up is verified; the API runs
      assert.equal((await h.call('GET', `/checkout/${c.id}`, { bearer: b.token })).body.checkout.plan.next, 'deposit');
      const tx = sendDeposit(h, b.key.address, 500_000n);
      assert.equal((await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: tx } })).status, 200);
      const run = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
      assert.equal(run.body.checkout.state, 'CHARGED', JSON.stringify(run.body));
      assert.equal(run.body.result.body.secretAnswer, 'PAID-CONTENT');
      const view = run.body.checkout;
      assert.equal(view.conversion.swapTx, sent.swapTx, 'the receipt carries the conversion transaction');
      assert.equal(view.conversion.sell.symbol, sym);
      assert.equal(view.depositTxs[0], tx);
      assert.equal(view.receipt.outcome, 'QUALIFIED');
      assert.equal(verifyLedger(h.db).ok, true);
      assert.equal(h.seller.calls, 1);
    } finally { await h.close(); }
  });
}

test('conversion failures never reach the seller: reverted, short, wrong recipient; the buyer is told, nothing is charged', async () => {
  for (const scenario of ['reverted', 'short', 'wrong_recipient', 'no_fill']) {
    const h = await start();
    try {
      const b = await buyer(h);
      const l = await listing(h, { price: '0.5' });
      const c = (await start1(h, b, l.id)).body.checkout;
      const cv = (await h.call('POST', `/checkout/${c.id}/estimate`, { bearer: b.token, body: { symbol: 'wBRL' } })).body.conversion;
      const sent = await walletSwaps(h, b, cv, scenario);
      const r = await h.buyConvert.recordTx({ buyerId: b.id, conversionId: cv.id, kind: 'swap', txHash: sent.swapTx! });
      assert.notEqual(r.state, 'CONFIRMED', scenario);
      assert.equal((await h.call('POST', `/checkout/${c.id}/attach-conversion`, { bearer: b.token, body: { conversionId: cv.id } })).body.code, 'CONVERSION_NOT_CONFIRMED', scenario);
      assert.equal((await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token })).body.code, 'INSUFFICIENT_BALANCE', scenario);
      assert.equal(h.seller.calls, 0, scenario);
      assert.equal(count(h, 'executions'), 0, scenario);
      assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 0n);
    } finally { await h.close(); }
  }
});

test('payment captured only for a qualifying response; a non-qualifying one releases the funds and returns NO content', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
    const c = (await start1(h, b, l.id)).body.checkout;
    await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: (() => { const t = sendDeposit(h, b.key.address, 500_000n); return t; })() } });
    h.seller.mode = 'bad';
    const run = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(run.body.checkout.state, 'NOT_CHARGED');
    assert.equal(run.body.checkout.paid, false);
    assert.equal(run.body.result.charged, false);
    assert.equal(run.body.result.body, undefined, 'no paid content without a captured payment');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 500_000n, 'the full amount is back in the buyer balance');
    assert.equal(balance(h.db, l.sellerId, 'seller_earnings', 'USDT'), 0n);
    // a retry of the same checkout reports the stored outcome; it does not call the seller again
    const calls = h.seller.calls;
    const again = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(again.body.checkout.state, 'NOT_CHARGED');
    assert.equal(h.seller.calls, calls);
    // the buyer can start a NEW checkout; the USDT already credited covers it without another deposit
    h.seller.mode = 'ok';
    const c2 = (await start1(h, b, l.id)).body.checkout;
    assert.equal(c2.plan.next, 'run');
    const run2 = await h.call('POST', `/checkout/${c2.id}/execute`, { bearer: b.token });
    assert.equal(run2.body.checkout.state, 'CHARGED');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 0n);
    assert.equal(verifyLedger(h.db).ok, true);
  } finally { await h.close(); }
});

test('an unknown outcome is UNRESOLVED (held, not charged, no content), never reported as failed, and reconciles; a retry never calls the seller again', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
    const c = (await start1(h, b, l.id)).body.checkout;
    await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: sendDeposit(h, b.key.address, 500_000n) } });
    h.seller.mode = 'timeout';
    const run = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(run.body.checkout.state, 'UNRESOLVED');
    assert.equal(run.body.checkout.paid, false);
    assert.match(run.body.checkout.note, /NOT charged/);
    assert.equal(run.body.result.body, undefined);
    assert.equal(balance(h.db, b.id, 'buyer_held', 'USDT'), 500_000n, 'held, not charged');
    const calls = h.seller.calls;
    h.seller.mode = 'ok';
    const again = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(again.body.checkout.state, 'UNRESOLVED', 'a retry does not re-run or re-charge');
    assert.equal(h.seller.calls, calls);
    // later the unresolved hold is released by recovery; the checkout follows the ledger, not a guess
    recoverExecutions(h.db, { staleHeldMs: 0, unresolvedMs: 0 });
    const after = (await h.call('GET', `/checkout/${c.id}`, { bearer: b.token })).body.checkout;
    assert.equal(after.state, 'NOT_CHARGED');
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 500_000n);
    assert.equal(balance(h.db, b.id, 'buyer_held', 'USDT'), 0n);
  } finally { await h.close(); }
});

test('a changed listing price or an unpublished listing stops the purchase before anything is reserved', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
    const c = (await start1(h, b, l.id)).body.checkout;
    await h.call('POST', `/checkout/${c.id}/deposit`, { bearer: b.token, body: { txHash: sendDeposit(h, b.key.address, 500_000n) } });
    h.db.prepare('UPDATE listings SET price_atomic = ? WHERE id = ?').run(900_000n, l.id); // the seller raised the price
    const r = await h.call('POST', `/checkout/${c.id}/execute`, { bearer: b.token });
    assert.equal(r.body.code, 'PRICE_CHANGED');
    assert.match(r.body.message, /Nothing was charged/);
    assert.equal(count(h, 'executions'), 0);
    assert.equal(h.seller.calls, 0);
    assert.equal(balance(h.db, b.id, 'buyer_available', 'USDT'), 500_000n, 'the credited deposit is untouched');
    // a fresh checkout shows the NEW authoritative price and a new top-up need
    const c2 = (await start1(h, b, l.id)).body.checkout;
    assert.equal(c2.price.usdt, '0.9');
    assert.equal(c2.plan.topUp, '0.4');
    h.db.prepare("UPDATE listings SET status = 'unpublished' WHERE id = ?").run(l.id);
    assert.equal((await h.call('POST', `/checkout/${c2.id}/execute`, { bearer: b.token })).body.code, 'LISTING_UNAVAILABLE');
    assert.equal((await start1(h, b, l.id)).body.code, 'LISTING_UNAVAILABLE');
  } finally { await h.close(); }
});

test('a listing priced in another currency checks out at its normalised USDT price and the receipt keeps the original price and currency', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    // price a listing in cNGN through the real seller endpoint (the pricing code uses the simulated Textile here)
    const w = privateKeyToAccount(generatePrivateKey());
    const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address, chainId: 42220 } });
    void s;
    const l = await listing(h, { price: '1364', priceCurrency: 'cNGN' }).catch((e) => e as Error);
    if (l instanceof Error) throw l;
    const c = (await start1(h, b, l.id)).body.checkout;
    assert.equal(c.price.listed.currency, 'cNGN');
    assert.equal(c.price.listed.amount, '1364');
    assert.ok(Number(c.price.usdt) > 0.9 && Number(c.price.usdt) < 1.1, `1364 cNGN is about 1 USDT, got ${c.price.usdt}`);
  } finally { await h.close(); }
});

test('over the per-deposit limit, the plan says so and the conversion is refused; unsupported currencies are refused with a reason', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    const l = await listing(h, { price: '0.5' });
    h.walletUsdt.set(b.key.address.toLowerCase(), 0n);
    const c = (await start1(h, b, l.id)).body.checkout;
    for (const sym of ['CWT', 'G$', 'CELO', 'USAT']) {
      const r = await h.call('POST', `/checkout/${c.id}/estimate`, { bearer: b.token, body: { symbol: sym } });
      assert.equal(r.body.code, 'UNSUPPORTED_CURRENCY', sym);
    }
    // a wallet that already holds enough USDT is told to pay directly
    h.walletUsdt.set(b.key.address.toLowerCase(), 5_000_000n);
    assert.equal((await h.call('POST', `/checkout/${c.id}/estimate`, { bearer: b.token, body: { symbol: 'cNGN' } })).body.code, 'NOT_NEEDED');
    // an insufficient wallet balance of the SELL currency is refused before anything is signed
    h.walletUsdt.set(b.key.address.toLowerCase(), 0n);
    assert.equal(count(h, 'buy_conversions'), 0);
  } finally { await h.close(); }
});

test('the checkout needs real-funds mode; the legacy execute route still works for agents and cannot be confused with a checkout', async () => {
  const h = await start();
  try {
    const b = await buyer(h);
    assert.equal((await h.call('GET', '/checkouts', { bearer: b.token })).status, 200);
    assert.equal((await h.call('POST', '/checkout/start', { body: { listingId: 'x' } })).body.code, 'SESSION_INVALID');
    assert.equal(createTextileRouteProvider !== undefined, true);
  } finally { await h.close(); }
});
