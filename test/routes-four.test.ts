// Every Textile currency route that Payrail offers for paying a Buy API: validated per currency, with the SAME production code.
// The chain, Textile and Buy are FAKES (the simulated Textile provider/chain and the fake gateway). Nothing here touches a network, a key or funds,
// and none of it counts as proof that a route works on mainnet.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetBySymbol } from '../src/assets.ts';
import { createBuyerSwapRuntime } from '../src/buyerswap.ts';
import { createBuyConvert } from '../src/buyconvert.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { setupMarket } from '../src/marketsetup.ts';
import type { MarketRuntime } from '../src/market.ts';
import { takerControlTypedData } from '../src/takerproof.ts';
import { createWebServer } from '../src/webapi.ts';
import { FAKE_TX, USDT, createFakeBuy, signAuthorization } from './fakebuy.ts';
import { MAKER, NOW, OTHER, PAYER, TAG, goodQuote } from './swapsupport.ts';

const root = mkdtempSync(join(tmpdir(), 'payrail-four-'));
let n = 0;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';

/** token metadata READ FROM THE CONTRACTS on Celo mainnet on 2026-10-16 (read-only); the registry must agree with it */
const ON_CHAIN: Record<string, { address: string; decimals: number }> = {
  cNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
  wARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18 },
  wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  USAT: { address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', decimals: 6 },
  IDRX: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', decimals: 2 },
  wCOP: { address: '0x8a1D45e102e886510e891d2Ec656a708991e2D76', decimals: 18 },
  WETH: { address: '0xD221812de1BD094f35587EE8E174B07B6167D9Af', decimals: 18 },
  wMXN: { address: '0x337E7456B420bD3481e7FA61fA9850343d610d34', decimals: 18 },
  CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
};
/** the routes the application enables (funding: X -> USDT). CELO is listed by Textile but deliberately kept off. */
/** corridors Textile's OFFICIAL address book lists for Celo (read 2026-10-17): cNGN, USDC, wARS, wBRL, IDRX (each against USDT) */
const DOCUMENTED = ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX'];
/** quoted by Textile's live API with makers, but NOT in the official Celo list: Unsupported unless the operator names them */
const UNDOCUMENTED = ['USAT', 'wCOP', 'WETH', 'wMXN'];
const ENABLED = [...DOCUMENTED, ...UNDOCUMENTED];
const envFor = (sym: string): Record<string, string> => (UNDOCUMENTED.includes(sym) ? { PAYRAIL_BUY_CONVERT_UNDOCUMENTED: UNDOCUMENTED.join(',') } : {});

async function serve(market: MarketRuntime) {
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'routes-test', market, environment: 'production' });
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

async function world(extraEnv: Record<string, string> = {}) {
  const fake = createFakeBuy({ now: Date.now });
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR, now: () => NOW });
  const balances = new Map<string, bigint>();
  // sell-token and native balances (default: plenty); tests lower them to prove the refusals
  const tokenBalances = new Map<string, bigint>();
  const celoBalances = new Map<string, bigint>();
  const buyerSwap = {
    converterFor: () => { throw new Error('not used'); },
    prepare: async ({ op }: any) => ({ kind: 'ready' as const, quoteId: 'rfq_fake', expiresAtMs: Date.now() + 40_000, steps: [{ kind: 'approve' as const, to: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f' as `0x${string}`, data: '0x095ea7b3' as `0x${string}` }, { kind: 'swap' as const, to: TEXTILE_REACTOR as `0x${string}`, data: '0x0d7a16c3' as `0x${string}` }], takerPays: op.sellAtomic.toString(), buyAmount: op.expectedAtomic.toString(), feeAmount: '1', notes: [] }),
  };
  const market = (await setupMarket({
    env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1', PAYRAIL_BUY_PAYMENTS: '1', PAYRAIL_BUY_MAX_USD: '0.05', PAYRAIL_BUY_CONVERSION: '1', ...extraEnv },
    dbPath: join(root, `r${++n}.db`),
    configuredChainId: 42220,
    attributionTag: 'celo_b2fff2ac9413',
    readChainId: async () => 42220,
    makeReader: () => provider.reader,
    readAllowance: async () => 0n,
    readUsdtBalance: async (w) => balances.get(w.toLowerCase()) ?? 0n,
    readTokenBalance: async (t, w) => tokenBalances.get(`${t}:${w}`.toLowerCase()) ?? 10n ** 40n,
    readNativeBalance: async (w) => celoBalances.get(w.toLowerCase()) ?? 10n ** 18n,
    buyCatalog: async () => fake.catalog,
    buyVerify: fake.verify,
    buyPolicy: DEFAULT_POLICY,
    buyFetch: fake.fetchImpl,
    buySettleDelayMs: 0,
    buyConvertOverride: { provider, buyerSwap },
    officialCorridors: async () => ({ symbols: new Set(['cNGN', 'USDC', 'wARS', 'wBRL', 'IDRX']), addresses: new Set<string>(), source: 'built-in-snapshot' as const, fetchedAt: '2026-10-17T00:00:00.000Z' }),
    log: () => undefined,
  }))!;
  return { market, fake, provider, balances, tokenBalances, celoBalances };
}
async function walletBuyer(s: Awaited<ReturnType<typeof serve>>) {
  const k = privateKeyToAccount(generatePrivateKey());
  const st = (await s.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } })).body;
  const c = (await s.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: st.nonce, signature: await k.signMessage({ message: st.message }) } })).body;
  return { token: c.token as string, key: k };
}
// ---------------------------------------------------------------------------------------------------------------------------------
// ROUTE-SPECIFIC checks for the four routes that have never been executed on mainnet by Payrail: wARS, wBRL, USDC, IDRX.
// Everything here runs the REAL project code against a SIMULATED Textile and chain. It proves the code path, not that Textile will fill.
const FOUR = ['wARS', 'wBRL', 'USDC', 'IDRX'] as const;
/** facts read from Textile's official address book and the token contracts (2026-10-17) and its live ladder (2026-10-21) */
const FACTS: Record<string, { address: string; decimals: number; minSellUnits: number }> = {
  wARS: { address: ON_CHAIN.wARS!.address, decimals: 18, minSellUnits: 1600 },
  wBRL: { address: ON_CHAIN.wBRL!.address, decimals: 18, minSellUnits: 5 },
  USDC: { address: ON_CHAIN.USDC!.address, decimals: 6, minSellUnits: 0.99 },
  IDRX: { address: ON_CHAIN.IDRX!.address, decimals: 2, minSellUnits: 17000 },
};
type S = Awaited<ReturnType<typeof serve>>;
const quoteBuy = async (s: S, b: Awaited<ReturnType<typeof walletBuyer>>) => (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' } } })).body;
async function walletSwaps(w: Awaited<ReturnType<typeof world>>, b: Awaited<ReturnType<typeof walletBuyer>>, cv: any, scenario?: string) {
  const ref = w.provider.assets.find((a) => a.ref.symbol === cv.sell.symbol)!.ref;
  const conv = w.provider.fundingConverter(ref, { taker: b.key.address, depositAddress: DEP });
  const q = await conv.quote({ sellAtomic: BigInt(cv.sell.amountAtomic) });
  return (await conv.execute({ opId: cv.id, quoteId: q.quoteId, sellAtomic: BigInt(cv.sell.amountAtomic), minBuyAtomic: BigInt(cv.receive.minimumAtomic), digest: 'd', ...(scenario ? { scenario } : {}) })) as { kind: string; swapTx?: string };
}

for (const sym of FOUR) {
  const f = FACTS[sym]!;

  test(`${sym}: token, network, decimals and direction are exactly what the official list and the contract say; USDT is the output`, async () => {
    const w = await world();
    const s = await serve(w.market);
    try {
      const c = (await s.call('GET', '/buy/currencies')).body.currencies.find((x: any) => x.symbol === sym);
      assert.equal(c.address.toLowerCase(), f.address.toLowerCase());
      assert.equal(c.decimals, f.decimals);
      assert.equal(c.route, `${sym} -> USDT on Textile (Celo)`);
      assert.equal(c.status, 'simulated', 'the SIMULATED test provider is never labelled Live');
      assert.equal(c.statusLabel, 'Simulated');
      assert.equal(c.evidence.executedByPayrailOnMainnet, false, `${sym} must not claim a mainnet execution it never had`);
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      const est = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body;
      assert.equal(est.conversion.sell.address.toLowerCase(), f.address.toLowerCase());
      assert.equal(est.conversion.sell.decimals, f.decimals);
      assert.equal(est.conversion.receive.address.toLowerCase(), USDT.toLowerCase());
      assert.equal(est.conversion.network.chainId, 42220);
    } finally { await s.close(); }
  });

  test(`${sym}: minimum swap is honoured in the token's own units; a swap larger than the API price says what stays in the wallet`, async () => {
    const w = await world();
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      const est = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body;
      const sold = Number(est.conversion.sell.amount);
      assert.ok(sold >= f.minSellUnits * 0.99, `${sym}: sells ${sold}, the corridor minimum is about ${f.minSellUnits}`);
      assert.ok(Number(est.limits.minSell) > 0 && sold >= Number(est.limits.minSell));
      assert.ok(Number(est.conversion.receive.expected) > 0.5 && Number(est.conversion.apiPrice.amount) === 0.005, 'the swap converts far more than the 0.005 API price');
      assert.ok(Number(est.conversion.leftoverAtLeast) > 0.9, 'the unused USDT is stated');
      assert.match(est.conversion.conversionFee.note, /Payrail adds no conversion charge/);
    } finally { await s.close(); }
  });

  test(`${sym}: failed, short, misdirected and uncertain swaps are never confirmed and never reach the Buy payment`, async () => {
    for (const scenario of ['reverted', 'short', 'wrong_recipient', 'wrong_token', 'no_fill']) {
      const w = await world();
      const s = await serve(w.market);
      try {
        const b = await walletBuyer(s);
        const q = await quoteBuy(s, b);
        const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body.conversion;
        const sent = await walletSwaps(w, b, cv, scenario);
        w.provider.advance(20);
        const r = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
        assert.notEqual(r.state, 'CONFIRMED', `${sym}/${scenario}`);
        assert.equal(r.confirmed, false);
        assert.equal((await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' }, conversionId: cv.id } })).body.code, 'CONVERSION_NOT_CONFIRMED', scenario);
        assert.equal(w.fake.gateway.paidRequests, 0);
      } finally { await s.close(); }
    }
  });

  test(`${sym}: reconciliation: a swap that was sent but not yet visible stays SUBMITTED (not failed), then confirms when it lands; it is never confirmed twice`, async () => {
    const w = await world();
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body.conversion;
      const sent = await walletSwaps(w, b, cv, 'uncertain');
      assert.equal(sent.kind, 'uncertain');
      const first = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
      assert.equal(first.state, 'SUBMITTED', 'no receipt yet: neither confirmed nor failed');
      assert.equal(first.confirmed, false);
      assert.equal((await s.call('POST', '/buy/convert/' + cv.id + '/recheck', { bearer: b.token })).body.conversion.state, 'SUBMITTED');
      w.provider.landLate(sent.swapTx!);
      w.provider.advance(20);
      const re = (await s.call('POST', `/buy/convert/${cv.id}/recheck`, { bearer: b.token })).body.conversion;
      assert.equal(re.state, 'CONFIRMED');
      assert.equal(re.swapTx, sent.swapTx);
      const again = (await s.call('POST', `/buy/convert/${cv.id}/recheck`, { bearer: b.token })).body.conversion;
      assert.equal(again.state, 'CONFIRMED');
      assert.equal(Number((w.market.db.prepare("SELECT COUNT(*) AS n FROM buy_conversions WHERE state = 'CONFIRMED'").get() as { n: number | bigint }).n), 1);
    } finally { await s.close(); }
  });

  test(`${sym}: an expired estimate is refused before signing; insufficient sell balance is refused; the conversion cap is enforced`, async () => {
    const w = await world();
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      // insufficient funds of the sell currency
      w.tokenBalances.set(`${f.address}:${b.key.address}`.toLowerCase(), 1n);
      const poor = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } });
      assert.equal(poor.body.code, 'INSUFFICIENT_FUNDS');
      w.tokenBalances.delete(`${f.address}:${b.key.address}`.toLowerCase());
      // expired estimate: the stored quote lifetime has passed
      const est = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body.conversion;
      w.market.db.prepare('UPDATE buy_conversions SET quote_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), est.id);
      const p = (await s.call('POST', '/buy/convert/proof', { bearer: b.token })).body;
      const t = takerControlTypedData(b.key.address, 42220, p.nonce, p.issuedAt);
      const signature = await b.key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      const prep = await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: est.id, nonce: p.nonce, issuedAt: p.issuedAt, signature } });
      assert.equal(prep.body.code, 'QUOTE_STALE');
      assert.match(prep.body.message, /Nothing was sent or charged/);
    } finally { await s.close(); }
    // a per-conversion limit below Textile's smallest swap makes the route unavailable with the reason
    const capped = await world({ PAYRAIL_BUY_CONVERT_MAX_USD: '0.5' });
    const s2 = await serve(capped.market);
    try {
      const c = (await s2.call('GET', '/buy/currencies')).body.currencies.find((x: any) => x.symbol === sym);
      assert.equal(c.available, false);
      assert.match(c.reason, /above this server's limit/);
    } finally { await s2.close(); }
  });

  test(`${sym}: conversion succeeds, then the Buy payment fails: the conversion stays confirmed, the order is not confirmed, nothing is paid or converted twice`, async () => {
    const w = await world();
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body.conversion;
      const sent = await walletSwaps(w, b, cv);
      w.provider.advance(20);
      const done = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
      assert.equal(done.state, 'CONFIRMED');
      w.balances.set(b.key.address.toLowerCase(), BigInt(done.receive.receivedAtomic));
      w.fake.gateway.mode = 'http500';
      const q2 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body;
      const failed = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
      assert.equal(failed.order.confirmed, false);
      assert.equal(failed.conversion.state, 'CONFIRMED');
      assert.equal(failed.conversion.swapTx, sent.swapTx);
      assert.equal(w.fake.gateway.paidRequests, 1);
      const retry = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
      assert.equal(retry.alreadyProcessed, true);
      assert.equal(w.fake.gateway.paidRequests, 1);
    } finally { await s.close(); }
  });
}

test('existing cNGN flow is untouched by the four-route work: it still estimates, converts, verifies and pays', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } })).body.conversion;
    const sent = await walletSwaps(w, b, cv);
    w.provider.advance(20);
    const done = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
    assert.equal(done.state, 'CONFIRMED');
    w.balances.set(b.key.address.toLowerCase(), BigInt(done.receive.receivedAtomic));
    const q2 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body;
    const paid = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
    assert.equal(paid.order.state, 'CONFIRMED');
    assert.equal(paid.conversion.swapTx, sent.swapTx);
  } finally { await s.close(); }
});

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
