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

const root = mkdtempSync(join(tmpdir(), 'payrail-pricing-'));
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
type S = Awaited<ReturnType<typeof serve>>;
async function walletSeller(s: S) {
  const k = privateKeyToAccount(generatePrivateKey());
  const st = (await s.call('POST', '/seller/login/start', { body: { wallet: k.address } })).body;
  const c = (await s.call('POST', '/seller/login/complete', { body: { wallet: k.address, nonce: st.nonce, signature: await k.signMessage({ message: st.message }) } })).body;
  return { token: c.token as string, key: k };
}
const submit = (s: S, t: string, over: Record<string, unknown> = {}) =>
  s.call('POST', '/seller/listings', { bearer: t, body: { name: 'Token price', endpointUrl: 'https://api.priceco.example/v1/price', method: 'GET', price: '0.02', ...over } });
const count = (w: { market: MarketRuntime }, table: string) => Number((w.market.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);

test('seller currencies come from the backend (same registry as checkout): USDT plus only usable Textile routes, with status and reason', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const c = (await s.call('GET', '/pricing/currencies')).body;
    assert.equal(c.base, 'USDT');
    assert.equal(c.conversionEnabled, true);
    const sel = c.currencies.filter((x: any) => x.selectable).map((x: any) => x.symbol).sort();
    assert.deepEqual(sel, ['USDC', 'USDT', 'IDRX', 'cNGN', 'wARS', 'wBRL'].sort());
    const usat = c.currencies.find((x: any) => x.symbol === 'USAT');
    assert.equal(usat.selectable, false);
    assert.match(usat.reason, /official address book/);
    assert.ok(!c.currencies.some((x: any) => x.symbol === 'CWT'));
    const checkout = (await s.call('GET', '/buy/currencies')).body.currencies.filter((x: any) => x.available).map((x: any) => x.symbol).sort();
    assert.deepEqual(checkout, sel.filter((x: string) => x !== 'USDT'), 'sellers and buyers are offered the same set');
  } finally { await s.close(); }
});

test('price normalisation: the original price and currency are kept; USDT comes from a Textile rate; a quote source is stated', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const t = await walletSeller(s);
    const n = (await s.call('POST', '/pricing/normalize', { bearer: t.token, body: { currency: 'cNGN', amount: '50' } })).body;
    assert.equal(n.currency, 'cNGN');
    assert.equal(n.amount, '50');
    assert.ok(Number(n.usdt) > 0.03 && Number(n.usdt) < 0.05, `50 cNGN is about 0.037 USDT at the simulated 1364 rate, got ${n.usdt}`);
    assert.match(n.source, /Textile indicative preview/);
    assert.ok(n.limitations.some((l: string) => /INDICATIVE/.test(l)) && n.limitations.some((l: string) => /unused USDT/.test(l)));
    const usdt = (await s.call('POST', '/pricing/normalize', { bearer: t.token, body: { currency: 'USDT', amount: '0.02' } })).body;
    assert.equal(usdt.usdt, '0.02');
    assert.equal(usdt.rate, '1');
    // the page never decides the USDT figure: a client-supplied one is ignored
    const r = await submit(s, t.token, { price: '50', priceCurrency: 'cNGN', usdt: '999', priceAtomic: '999000000' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const l = r.body.listing;
    assert.equal(l.listed.currency, 'cNGN');
    assert.equal(l.listed.amount, '50');
    assert.equal(l.price.usd, n.usdt, 'buyers are billed the normalised USDT amount');
    assert.ok(l.listed.quotedAt && l.listed.rate && l.listed.source);
    const u = await submit(s, t.token, { name: 'Plain USDT', endpointUrl: 'https://api.priceco.example/v1/two', price: '0.02' });
    assert.equal(u.body.listing.listed, null);
    assert.equal(u.body.listing.price.usd, '0.02');
  } finally { await s.close(); }
});

test('a currency that cannot be converted reliably is refused with the reason, never reinterpreted as USDT', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const t = await walletSeller(s);
    for (const [cur, re] of [['USAT', /official address book/], ['CELO', /not enabled|gas|Unsupported/i], ['CWT', /no conversion route|cannot be used/i], ['G$', /cannot be used|not listed|Unsupported/i]] as const) {
      const r = await submit(s, t.token, { priceCurrency: cur, price: '1' });
      assert.equal(r.body.code, 'UNSUPPORTED_CURRENCY', cur);
      assert.match(r.body.message, re, cur);
    }
    for (const bad of ['', '0', '-1', 'abc', '1e9']) {
      assert.notEqual((await submit(s, t.token, { priceCurrency: 'cNGN', price: bad })).status, 201, `price ${JSON.stringify(bad)}`);
    }
    assert.equal(count(w, 'listings'), 0, 'nothing was created by a refused price');
  } finally { await s.close(); }
});

test('with Textile conversion off only USDT pricing exists; a Textile outage blocks a converted price with the reason', async () => {
  const off = await world({ PAYRAIL_BUY_CONVERSION: '0' });
  const s0 = await serve(off.market);
  try {
    const t = await walletSeller(s0);
    const c = (await s0.call('GET', '/pricing/currencies')).body;
    assert.equal(c.conversionEnabled, false);
    assert.deepEqual(c.currencies.map((x: any) => x.symbol), ['USDT']);
    const r = await submit(s0, t.token, { priceCurrency: 'cNGN', price: '50' });
    assert.equal(r.body.code, 'UNSUPPORTED_CURRENCY');
    assert.match(r.body.message, /Price in USDT/);
    assert.equal((await submit(s0, t.token, { price: '0.02' })).status, 201);
  } finally { await s0.close(); }
  const on = await world();
  const s1 = await serve(on.market);
  try {
    const t = await walletSeller(s1);
    await s1.call('GET', '/pricing/currencies'); // warm the currency cache while Textile answers
    (on.provider as any).quote = async () => { throw new Error('Textile did not return a quote'); };
    const r = await submit(s1, t.token, { priceCurrency: 'wBRL', price: '1' });
    assert.equal(r.body.code, 'PRICE_UNAVAILABLE', JSON.stringify(r.body));
    assert.match(r.body.message, /cannot be converted reliably/);
    assert.equal(count(on, 'listings'), 0);
  } finally { await s1.close(); }
});

test('a price derived from a stale Textile quote cannot be published until it is re-checked', async () => {
  const { openDb } = await import('../src/db.ts');
  const { publishReadiness, getListing, submitListing, PRICE_QUOTE_MAX_AGE_MS } = await import('../src/seller.ts');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, kind, display_name, created_at, wallet_address) VALUES ('seller_x', 'seller', 's', ?, ?)").run(new Date(NOW).toISOString(), '0x00000000000000000000000000000000000000a1');
  const { listing } = submitListing(db, 'seller_x', { name: 'Priced in cNGN', endpointUrl: 'https://api.priceco.example/x', priceAtomic: 37_000n, asset: 'USDT', listed: { currency: 'cNGN', decimals: 6, amountAtomic: 50_000_000n, rate: '0.00073', quotedAt: new Date(NOW).toISOString(), source: 'Textile indicative preview' } }, () => NOW);
  const fresh = publishReadiness(db, getListing(db, listing.id)!, () => NOW + 1000);
  assert.ok(!fresh.missing.some((m) => m.code === 'PRICE_STALE'));
  const stale = publishReadiness(db, getListing(db, listing.id)!, () => NOW + PRICE_QUOTE_MAX_AGE_MS + 1000);
  const m = stale.missing.find((x) => x.code === 'PRICE_STALE');
  assert.ok(m && /50 cNGN/.test(m.message) && /fresh Textile quote/.test(m.message));
  assert.equal(stale.ready, false);
});

test('GET /buy/currencies (the landing page data): carries checkedAt, the rules for the three lists, and an explicit error instead of hiding the section when the status cannot be read', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const ok = (await s.call('GET', '/buy/currencies')).body;
    assert.equal(ok.ok, true);
    assert.equal(ok.enabled, true);
    assert.ok(ok.checkedAt && !Number.isNaN(Date.parse(ok.checkedAt)));
    assert.ok(ok.rules.conversion && ok.rules.pricing && /USDT/.test(ok.rules.settlement));
    assert.ok(Array.isArray(ok.currencies) && ok.currencies.length >= 5);
    for (const c of ok.currencies) assert.ok(['live', 'simulated', 'temporarily_unavailable', 'unsupported'].includes(c.status), `${c.symbol}: ${c.status}`);
    assert.ok(ok.officialList && Array.isArray(ok.officialList.symbols));
    (w.market.buyConvert as { currencies: () => Promise<unknown> }).currencies = async () => { throw new Error('boom'); };
    const bad = (await s.call('GET', '/buy/currencies')).body;
    assert.equal(bad.ok, true);
    assert.equal(bad.enabled, true);
    assert.match(bad.error, /could not be read just now/);
    assert.deepEqual(bad.currencies, []);
  } finally { await s.close(); }
});

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
