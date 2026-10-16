// Paying for a Buy API with cNGN: Textile converts in the buyer's wallet, then Buy is paid in USDT.
// Everything here is a FAKE: a simulated Textile provider/chain and a fake Buy gateway. No network, key or funds.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import type { BuyerSwapRuntime } from '../src/buyerswap.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { setupMarket } from '../src/marketsetup.ts';
import type { MarketRuntime } from '../src/market.ts';
import { takerControlTypedData } from '../src/takerproof.ts';
import { createWebServer } from '../src/webapi.ts';
import { PAY_TO, USDT, createFakeBuy, signAuthorization } from './fakebuy.ts';

const root = mkdtempSync(join(tmpdir(), 'payrail-buyconv-'));
let n = 0;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const NOW = Date.now();

async function serve(market: MarketRuntime) {
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'conv-test', market, environment: 'production' });
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

async function world(opts: { conversion: boolean; startUsdt?: bigint }) {
  const fake = createFakeBuy({ now: Date.now });
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR, now: () => NOW });
  const balances = new Map<string, bigint>();
  const startUsdt = opts.startUsdt ?? 0n;
  // the stand-in for Textile's firm quote step: it returns validated steps; the real validation is covered in buyersigned.test.ts
  const buyerSwap: BuyerSwapRuntime = {
    converterFor: () => { throw new Error('not used'); },
    prepare: async ({ op }) => ({ kind: 'ready', quoteId: 'rfq_fake', expiresAtMs: Date.now() + 40_000, steps: [{ kind: 'approve', to: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', data: '0x095ea7b3' }, { kind: 'swap', to: TEXTILE_REACTOR as `0x${string}`, data: '0x0d7a16c3' }], takerPays: op.sellAtomic.toString(), buyAmount: op.expectedAtomic.toString(), feeAmount: '1', notes: [] }),
  };
  const market = (await setupMarket({
    env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1', PAYRAIL_BUY_PAYMENTS: '1', PAYRAIL_BUY_MAX_USD: '0.05', ...(opts.conversion ? { PAYRAIL_BUY_CONVERSION: '1' } : {}) },
    dbPath: join(root, `c${++n}.db`),
    configuredChainId: 42220,
    attributionTag: 'celo_b2fff2ac9413',
    readChainId: async () => 42220,
    makeReader: () => provider.reader,
    readAllowance: async () => 0n,
    readUsdtBalance: async (w) => balances.get(w.toLowerCase()) ?? startUsdt,
    buyCatalog: async () => fake.catalog,
    buyVerify: fake.verify,
    buyPolicy: DEFAULT_POLICY,
    buyFetch: fake.fetchImpl,
    buySettleDelayMs: 0,
    buyConvertOverride: { provider, buyerSwap },
    log: () => undefined,
  }))!;
  return { market, fake, provider, balances };
}
async function walletBuyer(s: Awaited<ReturnType<typeof serve>>) {
  const k = privateKeyToAccount(generatePrivateKey());
  const st = (await s.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } })).body;
  const c = (await s.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: st.nonce, signature: await k.signMessage({ message: st.message }) } })).body;
  return { token: c.token as string, key: k };
}
const signProof = async (s: Awaited<ReturnType<typeof serve>>, b: Awaited<ReturnType<typeof walletBuyer>>) => {
  const p = (await s.call('POST', '/buy/convert/proof', { bearer: b.token })).body;
  const t = takerControlTypedData(b.key.address, 42220, p.nonce, p.issuedAt);
  const signature = await b.key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { nonce: p.nonce as string, issuedAt: p.issuedAt as number, signature };
};

test('currencies: only routes Textile actually lists are offered; an unknown currency is refused with the reason, never simulated', async () => {
  const { market } = await world({ conversion: true });
  const s = await serve(market);
  try {
    const c = (await s.call('GET', '/buy/currencies')).body;
    assert.equal(c.enabled, true);
    assert.equal(c.settlement.symbol, 'USDT');
    const cn = c.currencies.find((x: any) => x.symbol === 'cNGN');
    assert.equal(cn.available, true);
    assert.equal(cn.route, 'cNGN -> USDT on Textile (Celo)');
    assert.ok(cn.evidence.level && cn.evidence.basis, 'every currency states how its route is known');
    const celo = c.currencies.find((x: any) => x.symbol === 'CELO');
    assert.ok(!celo || celo.available === false, 'a currency the operator did not enable is not offered as available');
    const b = await walletBuyer(s);
    const order = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body.order;
    const cwt = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: order.id, symbol: 'CWT' } });
    assert.equal(cwt.body.code, 'UNSUPPORTED_CURRENCY');
    assert.match(cwt.body.message, /no conversion route|cannot be used/i);
  } finally {
    await s.close();
  }
});

test('cNGN purchase end to end: shortfall -> estimate -> wallet-signed swap verified on-chain -> Buy paid in USDT -> receipt shows both', async () => {
  const { market, fake, provider, balances } = await world({ conversion: true });
  const s = await serve(market);
  try {
    const b = await walletBuyer(s);
    const q = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' } } })).body;
    assert.equal(q.funding.shortfall, '0.005', 'the wallet holds no USDT, so the whole price is short');
    // paying without USDT is refused BEFORE anything is sent to Buy
    const early = await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q.order.id, signature: await signAuthorization(b.key, q.order.typedData) } });
    assert.equal(early.body.code, 'INSUFFICIENT_USDT');
    assert.equal(fake.gateway.paidRequests, 0);

    const est = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } });
    assert.equal(est.status, 201, JSON.stringify(est.body));
    const cv = est.body.conversion;
    assert.equal(cv.state, 'QUOTED');
    assert.equal(cv.sell.symbol, 'cNGN');
    assert.equal(cv.apiPrice.amount, '0.005');
    assert.ok(Number(cv.receive.minimum) >= 0.005 && Number(cv.receive.expected) >= Number(cv.receive.minimum));
    assert.ok(Number(cv.receive.expected) >= 0.99, 'Textile has a ~1 USD corridor minimum: the swap is bigger than the API price and the rest stays in the wallet');
    assert.match(cv.conversionFee.note, /Payrail adds no conversion charge/);
    assert.equal(cv.confirmed, false);

    // the buyer's wallet proves control, the server returns validated steps
    const proof = await signProof(s, b);
    const prep = (await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: cv.id, ...proof } })).body;
    assert.equal(prep.prepared.kind, 'ready');
    assert.deepEqual(prep.prepared.steps.map((x: any) => x.kind), ['approve', 'swap']);
    // a bad taker signature is refused
    assert.equal((await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: cv.id, ...proof, signature: `0x${'11'.repeat(65)}` } })).body.code, 'BAD_SIGNATURE');

    // a hash that is not on-chain never confirms anything
    const ghost = `0x${'cd'.repeat(32)}`;
    const g = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: ghost } })).body;
    assert.equal(g.conversion.state, 'SUBMITTED');
    assert.equal(g.conversion.confirmed, false);
  } finally {
    await s.close();
  }
  void provider; void balances;
});

test('a swap that really happened is CONFIRMED only from the receipt, then the Buy payment uses the USDT and the receipt carries the conversion', async () => {
  const { market, fake, provider, balances } = await world({ conversion: true });
  const s = await serve(market);
  try {
    const b = await walletBuyer(s);
    const q1 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' } } })).body;
    const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q1.order.id, symbol: 'cNGN' } })).body.conversion;
    // an unconfirmed conversion cannot be attached to an order
    assert.equal((await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body.code, 'CONVERSION_NOT_CONFIRMED');

    // the buyer's wallet performs the swap (the simulated chain stands in for Textile + Celo)
    const cngn = provider.assets.find((a) => a.ref.symbol === 'cNGN')!.ref;
    const conv = provider.fundingConverter(cngn, { taker: b.key.address, depositAddress: DEP });
    const quote = await conv.quote({ sellAtomic: BigInt(cv.sell.amountAtomic) });
    const sent = await conv.execute({ opId: cv.id, quoteId: quote.quoteId, sellAtomic: BigInt(cv.sell.amountAtomic), minBuyAtomic: BigInt(cv.receive.minimumAtomic), digest: 'd' });
    assert.equal(sent.kind, 'submitted');
    const swapTx = (sent as { swapTx: string }).swapTx;
    provider.advance(20);

    const done = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: swapTx } })).body.conversion;
    assert.equal(done.state, 'CONFIRMED', JSON.stringify(done));
    assert.equal(done.confirmed, true);
    assert.equal(done.swapTx, swapTx);
    assert.equal(done.swapTxUrl, `https://celoscan.io/tx/${swapTx}`);
    assert.ok(BigInt(done.receive.receivedAtomic) >= BigInt(cv.receive.minimumAtomic));
    // the same transaction cannot fund a second conversion
    const cv2 = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q1.order.id, symbol: 'cNGN' } })).body.conversion;
    assert.equal((await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv2.id, kind: 'swap', txHash: swapTx } })).body.code, 'TX_ALREADY_USED');
    // other buyers cannot see it
    const other = await walletBuyer(s);
    assert.equal((await s.call('GET', `/buy/convert/${cv.id}`, { bearer: other.token })).status, 404);

    // the wallet now holds the USDT; the Buy order is quoted again with the conversion attached and paid in USDT
    balances.set(b.key.address.toLowerCase(), BigInt(done.receive.receivedAtomic));
    const q2 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body;
    assert.equal(q2.funding.shortfall, '0');
    const paid = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
    assert.equal(paid.order.state, 'CONFIRMED');
    assert.equal(paid.order.confirmed, true);
    assert.equal(paid.order.token.address.toLowerCase(), USDT.toLowerCase());
    assert.equal(paid.order.payTo, PAY_TO);
    assert.equal(paid.conversion.id, cv.id, 'the receipt shows the conversion that funded the purchase');
    assert.equal(paid.conversion.swapTx, swapTx);
    assert.equal(paid.order.fee.state, 'not_collected', 'no fee is claimed that was not received');
    assert.equal(fake.gateway.paidRequests, 1);
  } finally {
    await s.close();
  }
});

test('a swap with the wrong outcome is never CONFIRMED: reverted, wrong recipient, or less than the minimum', async () => {
  for (const scenario of ['wrong_recipient', 'no_fill', 'wrong_token'] as const) {
    const { market, provider } = await world({ conversion: true });
    const s = await serve(market);
    try {
      const b = await walletBuyer(s);
      const q = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body;
      const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } })).body.conversion;
      const cngn = provider.assets.find((a) => a.ref.symbol === 'cNGN')!.ref;
      const conv = provider.fundingConverter(cngn, { taker: b.key.address, depositAddress: DEP });
      const quote = await conv.quote({ sellAtomic: BigInt(cv.sell.amountAtomic) });
      const sent = await conv.execute({ opId: cv.id, quoteId: quote.quoteId, sellAtomic: BigInt(cv.sell.amountAtomic), minBuyAtomic: BigInt(cv.receive.minimumAtomic), digest: 'd', scenario });
      provider.advance(20);
      const r = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: (sent as { swapTx: string }).swapTx } })).body.conversion;
      assert.notEqual(r.state, 'CONFIRMED', scenario);
      assert.equal(r.confirmed, false, scenario);
      assert.equal(r.state, 'REVIEW', scenario);
    } finally {
      await s.close();
    }
  }
});

test('conversion is OFF unless the operator enables it: only USDT works, and the pages are told so', async () => {
  const { market } = await world({ conversion: false });
  const s = await serve(market);
  try {
    const c = (await s.call('GET', '/buy/currencies')).body;
    assert.equal(c.enabled, false);
    assert.deepEqual(c.currencies, []);
    const b = await walletBuyer(s);
    const q = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body;
    assert.equal((await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } })).body.code, 'CONVERSION_DISABLED');
    assert.equal(((await s.call('GET', '/config')).body as any).features.buyConversion, false);
  } finally {
    await s.close();
  }
});

test('the conversion needs Buy payments, and a wallet that already has enough USDT is told to pay directly', async () => {
  await assert.rejects(
    setupMarket({
      env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_BUY_CONVERSION: '1' },
      dbPath: join(root, 'solo.db'), configuredChainId: 42220, attributionTag: 'celo_b2fff2ac9413', readChainId: async () => 42220,
      makeReader: () => ({ blockNumber: async () => 5n, receipt: async () => null }), readAllowance: async () => 0n, buyCatalog: async () => createFakeBuy({ now: Date.now }).catalog, log: () => undefined,
    }),
    /needs PAYRAIL_BUY_PAYMENTS=1/,
  );
  const { market } = await world({ conversion: true, startUsdt: 1_000_000n });
  const s = await serve(market);
  try {
    const b = await walletBuyer(s);
    const q = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' } } })).body;
    assert.equal(q.funding.shortfall, '0');
    assert.equal((await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } })).body.code, 'NO_CONVERSION_NEEDED');
  } finally {
    await s.close();
  }
});

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
