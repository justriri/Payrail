// The Buy purchase flow over HTTP, through the PRODUCTION startup code (setupMarket) with a fake gateway and a fake chain.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createDevMarket } from '../src/dev/devmarket.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { setupMarket } from '../src/marketsetup.ts';
import type { MarketRuntime } from '../src/market.ts';
import { createWebServer } from '../src/webapi.ts';
import { FAKE_TX, PAY_TO, USDT, createFakeBuy, signAuthorization } from './fakebuy.ts';

const root = mkdtempSync(join(tmpdir(), 'payrail-buyroutes-'));
let n = 0;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';

async function serve(market: MarketRuntime, environment: 'production' | 'development' = 'production') {
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'buy-test', market, environment });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, o: { body?: unknown; bearer?: string } = {}) => {
    const r = await fetch(base + '/api/market' + path, {
      method,
      headers: { ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(o.body ?? {}) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
async function production(opts: { buy: boolean; mode?: Parameters<typeof createFakeBuy>[0]['mode'] }) {
  const fake = createFakeBuy({ now: Date.now, ...(opts.mode ? { mode: opts.mode } : {}) });
  const market = (await setupMarket({
    env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1', ...(opts.buy ? { PAYRAIL_BUY_PAYMENTS: '1', PAYRAIL_BUY_MAX_USD: '0.05' } : {}) },
    dbPath: join(root, `p${++n}.db`),
    configuredChainId: 42220,
    attributionTag: 'celo_b2fff2ac9413',
    readChainId: async () => 42220,
    makeReader: () => ({ blockNumber: async () => 5_000n, receipt: async () => null }),
    readAllowance: async () => 0n,
    buyCatalog: async () => fake.catalog,
    buyVerify: fake.verify,
    buyPolicy: DEFAULT_POLICY,
    buyFetch: fake.fetchImpl,
    buySettleDelayMs: 0,
    log: () => undefined,
  }))!;
  return { market, fake };
}
async function walletBuyer(s: Awaited<ReturnType<typeof serve>>) {
  const k = privateKeyToAccount(generatePrivateKey());
  const st = (await s.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } })).body;
  const c = (await s.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: st.nonce, signature: await k.signMessage({ message: st.message }) } })).body;
  return { token: c.token as string, key: k };
}

test('the catalogue comes from Buy; the service page shows the real payment facts; payments are explicit about the fee', async () => {
  const { market } = await production({ buy: true });
  const s = await serve(market);
  try {
    const cat = (await s.call('GET', '/catalog')).body;
    const buyItems = (cat.items as any[]).filter((i) => i.source === 'buy');
    assert.equal(buyItems.length, 3, 'every service the Buy catalogue lists is shown (the fake lists three)');
    assert.ok(buyItems.every((i) => i.execution === 'x402-direct' && i.origin === 'buy-gateway' && /Buy AI/.test(i.seller) && typeof i.platform === 'string'));
    assert.deepEqual((cat.items as any[]).filter((i) => i.source === 'payrail'), [], 'no local or seeded listing is mixed in');
    const d = (await s.call('GET', '/buy/service/x.posts.search')).body;
    assert.equal(d.service.title, 'X posts search');
    assert.equal(d.service.method, 'POST');
    assert.equal(d.service.host, 'gateway.usebuy.ai');
    assert.deepEqual(d.service.inputSchema.required, ['query']);
    assert.equal(d.service.price.indicative, true);
    assert.equal(d.payment.enabled, true);
    assert.deepEqual(d.payment.network, { name: 'celo', chainId: 42220 });
    assert.equal(d.payment.token.address.toLowerCase(), USDT.toLowerCase());
    assert.equal(d.payment.payTo, PAY_TO);
    assert.equal(d.payment.maxPerPayment, '0.05');
    assert.equal(d.fee.percent, 3);
    assert.equal(d.fee.state, 'not_collected');
    assert.equal(d.source.url, 'https://gateway.usebuy.ai/v1/catalog');
    assert.equal((await s.call('GET', '/buy/service/nope.nope')).status, 404);
    assert.equal(((await s.call('GET', '/config')).body as any).features.buyPayments, true);
  } finally {
    await s.close();
  }
});

test('buy over HTTP: quote -> the buyer wallet signs -> pay -> CONFIRMED with a real receipt; other accounts cannot see it', async () => {
  const { market, fake } = await production({ buy: true });
  const s = await serve(market);
  try {
    assert.equal((await s.call('POST', '/buy/quote', { body: { serviceId: 'x.posts.search', input: { query: 'celo' } } })).body.code, 'SESSION_INVALID');
    const b = await walletBuyer(s);
    assert.equal((await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { wrong: true } } })).body.code, 'INVALID_INPUT');
    const q = await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' } } });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    const order = q.body.order;
    assert.equal(order.state, 'QUOTED');
    assert.equal(order.payer, b.key.address, 'the signed-in wallet is the payer');
    assert.equal(order.typedData.message.to, PAY_TO);
    assert.equal(fake.gateway.paidRequests, 0);
    // signing alone changes nothing; a wrong signature is refused
    const bad = await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: order.id, signature: `0x${'11'.repeat(65)}` } });
    assert.equal(bad.body.code, 'BAD_SIGNATURE');
    const paid = await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: order.id, signature: await signAuthorization(b.key, order.typedData) } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.order.state, 'CONFIRMED');
    assert.equal(paid.body.order.confirmed, true);
    assert.equal(paid.body.order.txHash, FAKE_TX);
    assert.equal(paid.body.order.txUrl, `https://celoscan.io/tx/${FAKE_TX}`);
    assert.equal(paid.body.order.fee.state, 'not_collected');
    assert.match(paid.body.order.response.body, /hello from the fake gateway/);
    assert.equal(fake.gateway.paidRequests, 1);
    // paying twice reports, never re-sends
    const again = await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: order.id, signature: await signAuthorization(b.key, order.typedData) } });
    assert.equal(again.body.alreadyProcessed, true);
    assert.equal(fake.gateway.paidRequests, 1);
    // history, receipt events, privacy
    const list = (await s.call('GET', '/buy/orders', { bearer: b.token })).body.orders as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].response, null, 'the list does not carry response bodies');
    const one = (await s.call('GET', `/buy/order/${order.id}`, { bearer: b.token })).body;
    assert.deepEqual(one.events.map((e: any) => e.state), ['QUOTED', 'SUBMITTED', 'CONFIRMED']);
    const other = await walletBuyer(s);
    assert.equal((await s.call('GET', `/buy/order/${order.id}`, { bearer: other.token })).status, 404);
    assert.equal((await s.call('POST', '/buy/pay', { bearer: other.token, body: { orderId: order.id, signature: await signAuthorization(other.key, order.typedData) } })).body.code, 'NOT_OWNER');
  } finally {
    await s.close();
  }
});

test('a gateway failure is reported honestly over HTTP and is never a success', async () => {
  const { market, fake } = await production({ buy: true, mode: 'http500' });
  const s = await serve(market);
  try {
    const b = await walletBuyer(s);
    const order = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'instagram.profile', input: { username: 'celo' } } })).body.order;
    const paid = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: order.id, signature: await signAuthorization(b.key, order.typedData) } })).body;
    assert.equal(paid.order.state, 'UNRESOLVED');
    assert.equal(paid.order.confirmed, false);
    assert.equal(fake.gateway.paidRequests, 1);
    const re = (await s.call('POST', `/buy/order/${order.id}/recheck`, { bearer: b.token })).body;
    assert.equal(re.order.state, 'UNRESOLVED');
    assert.equal(fake.gateway.paidRequests, 1, 'a recheck only reads the chain');
  } finally {
    await s.close();
  }
});

test('Buy payments are OFF unless the operator enables them; development never has them', async () => {
  const { market } = await production({ buy: false });
  const s = await serve(market);
  try {
    const d = (await s.call('GET', '/buy/service/x.posts.search')).body;
    assert.equal(d.payment.enabled, false, 'the page can say payments are not enabled');
    const b = await walletBuyer(s);
    assert.equal((await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body.code, 'BUY_PAYMENTS_DISABLED');
    assert.equal(((await s.call('GET', '/config')).body as any).features.buyPayments, false);
  } finally {
    await s.close();
  }
  const dev = createDevMarket({ dbPath: join(root, 'data', 'dev', 'x.db'), devRoot: join(root, 'data', 'dev'), keyFile: join(root, 'data', 'dev', 'x.key') });
  const sd = await serve(dev.market, 'development');
  try {
    const b = (await sd.call('POST', '/buyer')).body;
    assert.equal((await sd.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body.code, 'NOT_AVAILABLE');
    const svc = await sd.call('GET', '/buy/service/x.posts.search');
    assert.equal(svc.body.payment.enabled, false);
  } finally {
    await sd.close();
  }
});

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
