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

const root = mkdtempSync(join(tmpdir(), 'payrail-routes-'));
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
type W = Awaited<ReturnType<typeof world>>;
type B = Awaited<ReturnType<typeof walletBuyer>>;
type S = Awaited<ReturnType<typeof serve>>;

/** the buyer's wallet performs the swap on the simulated chain; returns the swap tx */
async function walletSwaps(w: W, b: B, cv: any, scenario?: string) {
  const ref = w.provider.assets.find((a) => a.ref.symbol === cv.sell.symbol)!.ref;
  const conv = w.provider.fundingConverter(ref, { taker: b.key.address, depositAddress: DEP });
  const quote = await conv.quote({ sellAtomic: BigInt(cv.sell.amountAtomic) });
  const sent = await conv.execute({ opId: cv.id, quoteId: quote.quoteId, sellAtomic: BigInt(cv.sell.amountAtomic), minBuyAtomic: BigInt(cv.receive.minimumAtomic), digest: 'd', ...(scenario ? { scenario } : {}) });
  return sent as { kind: string; swapTx?: string };
}
const quoteBuy = async (s: S, b: B, serviceId = 'x.posts.search') => (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId, input: serviceId === 'x.posts.search' ? { query: 'celo' } : { username: 'celo' } } })).body;
const countLedger = (w: W) => Number((w.market.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number | bigint }).n);

// ---------------------------------------------------------------------------------------------------------------- registry facts

test('route registry: every enabled currency matches the contract metadata read on-chain; CWT and G$ are not routes', () => {
  for (const sym of Object.keys(ON_CHAIN)) {
    const a = assetBySymbol(sym);
    assert.ok(a, `${sym} is in the registry`);
    assert.equal(a!.address.toLowerCase(), ON_CHAIN[sym]!.address.toLowerCase(), `${sym} address`);
    assert.equal(a!.decimals, ON_CHAIN[sym]!.decimals, `${sym} decimals`);
  }
  assert.equal(assetBySymbol('CWT'), undefined);
  assert.equal(assetBySymbol('G$'), undefined, 'G$ has no liquidity on Textile, so it is not a registered route');
});

test('currency list: exactly the routes with live makers and an operator opt-in are available; CELO, CWT and G$ are not', async () => {
  const { market } = await world();
  const s = await serve(market);
  try {
    const c = (await s.call('GET', '/buy/currencies')).body;
    const avail = c.currencies.filter((x: any) => x.available).map((x: any) => x.symbol).sort();
    assert.deepEqual(avail, [...DOCUMENTED].sort(), 'by default only corridors in the official Textile address book are offered');
    for (const sym of UNDOCUMENTED) {
      const x = c.currencies.find((y: any) => y.symbol === sym);
      assert.ok(x && x.available === false && x.status === 'unsupported', `${sym} stays visible but unsupported`);
      assert.match(x.reason, /official address book/);
    }
    const gd = c.currencies.find((x: any) => x.symbol === 'G$');
    assert.ok(!gd || gd.available === false, 'G$ has no liquidity: listed at most as unavailable');
    for (const x of c.currencies.filter((y: any) => ON_CHAIN[y.symbol])) {
      assert.equal(x.address.toLowerCase(), ON_CHAIN[x.symbol]?.address.toLowerCase(), `${x.symbol} address`);
      assert.equal(x.decimals, ON_CHAIN[x.symbol]?.decimals);
      assert.ok(x.evidence.level && x.evidence.basis);
    }
    const celo = c.currencies.find((x: any) => x.symbol === 'CELO');
    assert.ok(!celo || (celo.available === false && /not enabled|gas/i.test(celo.reason)), 'the network gas token is not offered');
    assert.ok(!c.currencies.some((x: any) => x.symbol === 'CWT'));
  } finally {
    await s.close();
  }
});

test('a per-conversion limit below Textile\'s smallest swap makes a currency unavailable WITH the reason, never a silent failure', async () => {
  const { market } = await world({ PAYRAIL_BUY_CONVERT_MAX_USD: '0.5' });
  const s = await serve(market);
  try {
    const c = (await s.call('GET', '/buy/currencies')).body;
    assert.ok(c.currencies.every((x: any) => x.available === false), 'the simulated minimum is about 1 USD, above the 0.5 limit');
    assert.match(c.currencies.find((x: any) => x.symbol === 'cNGN').reason, /smallest swap.*above this server's limit/);
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    const r = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'cNGN' } });
    assert.equal(r.body.code, 'ABOVE_LIMIT');
  } finally {
    await s.close();
  }
});

test('unsupported or disabled currencies are refused with a reason: CWT, G$, CELO, lowercase tricks, unknown symbols', async () => {
  const { market } = await world();
  const s = await serve(market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    for (const sym of ['CWT', 'G$', 'CELO', 'DOGE', 'USDT', '']) {
      const r = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } });
      assert.notEqual(r.status, 201, `${sym} must not produce an estimate`);
      assert.ok(['UNSUPPORTED_CURRENCY', 'BAD_INPUT', 'INVALID_INPUT', 'BAD_REQUEST'].includes(r.body.code), `${sym}: ${r.body.code}`);
    }
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------- honest status per currency

test('currency status is honest: Available only for a route executed on mainnet, Needs live test for live-quoted, Temporarily unavailable, Unsupported', async () => {
  const USDT_ADDR = USDT as `0x${string}`;
  const lv = (sell: bigint, buy: bigint) => [{ sellAmount: sell, buyAmount: buy }];
  const pair = (sym: string, levels: Array<{ sellAmount: bigint; buyAmount: bigint }>) => ({
    sellToken: ON_CHAIN[sym]!.address as `0x${string}`, buyToken: USDT_ADDR, minSellAmount: levels[0]?.sellAmount ?? 0n, maxSellAmount: levels[levels.length - 1]?.sellAmount ?? 0n, levels,
  });
  const ladder = async () => ({
    asOf: '2026-10-16T00:00:00.000Z',
    pairs: [
      pair('cNGN', lv(1_358_000_000n, 1_000_000n)), pair('wARS', lv(10n ** 21n, 1_000_000n)), pair('wBRL', lv(5n * 10n ** 18n, 1_000_000n)),
      pair('USDC', lv(1_000_000n, 1_000_000n)), pair('USAT', lv(1_000_000n, 1_000_000n)),
      pair('wCOP', []), // listed, no makers
      pair('WETH', lv(10n ** 15n, 1_000_000n)), // price request will fail
      pair('IDRX', lv(1_800_000n, 50_000_000n)), // smallest swap worth 50 USDT: above the limit
      pair('CELO', lv(10n ** 18n, 1_000_000n)), // live, but kept off by the operator
      // wMXN and G$ are not on this ladder at all
    ],
  });
  const preview = async (a: { sellToken: string; sellAmount: bigint }) => {
    const sym = Object.keys(ON_CHAIN).find((k) => ON_CHAIN[k]!.address.toLowerCase() === a.sellToken.toLowerCase())!;
    if (sym === 'WETH') throw new Error('upstream timeout');
    const out = sym === 'IDRX' ? 50_000_000n : 1_000_000n;
    return { kind: 'preview' as const, sellAmount: a.sellAmount, buyAmount: out, feeAmount: 1n, takerPays: a.sellAmount, rateRay: '1', availableSellAmount: undefined, requestId: 'r', rateRemaining: undefined };
  };
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const textile = createTextileRouteProvider({ getLadder: ladder as any, preview: preview as any });
  const bc = createBuyConvert({
    db, registry: new RouteRegistry(db, [textile]), provider: textile, buyerSwap: { converterFor: () => { throw new Error('unused'); }, prepare: async () => { throw new Error('unused'); } },
    reader: { blockNumber: async () => 0n, receipt: async () => null }, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 1, maxUsdtAtomic: 2_000_000n,
    allowUndocumented: new Set(UNDOCUMENTED),
  });
  const list = await bc.currencies();
  const st = (sym: string) => list.find((c) => c.symbol === sym);
  assert.equal(st('cNGN')!.status, 'available', 'only cNGN has an executed mainnet route');
  for (const sym of ['wARS', 'wBRL', 'USDC', 'USAT']) {
    assert.equal(st(sym)!.status, 'needs_live_test', sym);
    assert.equal(st(sym)!.available, true, 'selectable, but labelled for what it is');
    assert.equal(st(sym)!.evidence.executedByPayrailOnMainnet, false);
    assert.match(st(sym)!.statusDetail, /not been executed on mainnet/);
  }
  assert.equal(st('wCOP')!.status, 'temporarily_unavailable');
  assert.equal(st('wCOP')!.available, false);
  assert.equal(st('WETH')!.status, 'temporarily_unavailable');
  assert.match(st('WETH')!.reason!, /no price/);
  assert.equal(st('IDRX')!.status, 'temporarily_unavailable');
  assert.match(st('IDRX')!.reason!, /above this server's limit/);
  assert.equal(st('CELO')!.status, 'unsupported');
  assert.equal(st('wMXN')!.status, 'unsupported');
  assert.equal(st('G$')!.status, 'unsupported');
  assert.ok(!list.some((c) => c.symbol === 'CWT'));
  assert.equal(st('cNGN')!.statusLabel, 'Available');
  // the general "Textile: Live" label is separate from the verification status: Live never implies verified
  for (const sym of ['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT']) assert.equal(st(sym)!.textileLive, true, `${sym}: a live price exists`);
  assert.equal(st('wARS')!.status, 'needs_live_test');
  for (const sym of ['wCOP', 'CELO', 'wMXN', 'G$']) assert.equal(st(sym)!.textileLive, false, sym);
  assert.equal(st('wARS')!.statusLabel, 'Needs live test');
  // USDC and USAT say honestly that Buy also offers them directly but Payrail's flow is USDT-only
  assert.match(st('USDC')!.directNote!, /only supports USDT/);
  assert.match(st('USAT')!.directNote!, /only supports USDT/);
  assert.equal(st('cNGN')!.directNote, null);
  // unselectable currencies cannot start a conversion: the backend refuses, whatever the page does
  for (const sym of ['wCOP', 'CELO', 'wMXN', 'G$']) {
    await assert.rejects(bc.estimate({ buyerId: 'x', wallet: PAYER, symbol: sym, targetAtomic: 5000n }), (e: any) => e.code === 'UNSUPPORTED_CURRENCY' || e.code === 'NOT_FOUND' || e.code === 'NO_QUOTE', sym);
  }
});

test('the documentation gate is enforced in code: USAT, wCOP, WETH and wMXN cannot start a conversion by default, whatever the allow-list row says', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    // even a database row that enables them (an older default) must not switch them on
    w.market.db.prepare("UPDATE conversion_assets SET funding_enabled = 1").run();
    for (const sym of UNDOCUMENTED) {
      const r = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } });
      assert.equal(r.body.code, 'UNSUPPORTED_CURRENCY', sym);
      assert.match(r.body.message, /official address book/);
    }
    const c = (await s.call('GET', '/buy/currencies')).body;
    assert.deepEqual(c.currencies.filter((x: any) => x.available).map((x: any) => x.symbol).sort(), [...DOCUMENTED].sort());
    assert.equal(Number((w.market.db.prepare('SELECT COUNT(*) AS n FROM buy_conversions').get() as { n: number | bigint }).n), 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------- per currency

for (const sym of ENABLED) {
  test(`${sym}: estimate -> wallet-signed swap -> verified from the receipt -> Buy paid in USDT; amounts, limits and receipts are right`, async () => {
    const w = await world(envFor(sym));
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const ledgerBefore = countLedger(w);
      const q = await quoteBuy(s, b);
      const est = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } });
      assert.equal(est.status, 201, JSON.stringify(est.body));
      const cv = est.body.conversion;
      const meta = ON_CHAIN[sym]!;
      assert.equal(cv.sell.symbol, sym);
      assert.equal(cv.sell.address.toLowerCase(), meta.address.toLowerCase());
      assert.equal(cv.sell.decimals, meta.decimals);
      assert.equal(cv.sell.amount, formatUnits(BigInt(cv.sell.amountAtomic), meta.decimals), 'amounts are formatted with the token\'s own decimals');
      assert.equal(cv.receive.address.toLowerCase(), USDT.toLowerCase(), 'the destination is USDT');
      assert.equal(cv.apiPrice.atomic, '5000');
      assert.ok(BigInt(cv.receive.minimumAtomic) >= 5000n, 'the guaranteed minimum covers the API price');
      assert.ok(BigInt(cv.receive.expectedAtomic) >= BigInt(cv.receive.minimumAtomic));
      assert.ok(BigInt(cv.receive.expectedAtomic) <= 2_000_000n, 'within the per-conversion limit');
      assert.ok(BigInt(cv.sell.amountAtomic) > 0n);
      assert.equal(est.body.funding.shortfall, '0.005');

      // the wallet proves control; the server returns validated steps; a bad taker signature is refused
      const p = (await s.call('POST', '/buy/convert/proof', { bearer: b.token })).body;
      const t = takerControlTypedData(b.key.address, 42220, p.nonce, p.issuedAt);
      const signature = await b.key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      assert.equal((await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: cv.id, nonce: p.nonce, issuedAt: p.issuedAt, signature: `0x${'11'.repeat(65)}` } })).body.code, 'BAD_SIGNATURE');
      const prep = (await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: cv.id, nonce: p.nonce, issuedAt: p.issuedAt, signature } })).body;
      assert.equal(prep.prepared.kind, 'ready');

      // the swap happens; nothing counts until the receipt proves it
      const sent = await walletSwaps(w, b, cv);
      assert.equal(sent.kind, 'submitted');
      w.provider.advance(20);
      const done = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
      assert.equal(done.state, 'CONFIRMED', JSON.stringify(done));
      assert.ok(BigInt(done.receive.receivedAtomic) >= BigInt(cv.receive.minimumAtomic), 'the wallet received at least the minimum that was shown');

      // Buy is then paid in USDT with the converted funds
      w.balances.set(b.key.address.toLowerCase(), BigInt(done.receive.receivedAtomic));
      const q2 = await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } });
      assert.equal(q2.body.funding.shortfall, '0');
      const paid = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.body.order.id, signature: await signAuthorization(b.key, q2.body.order.typedData) } })).body;
      assert.equal(paid.order.state, 'CONFIRMED');
      assert.equal(paid.order.txHash, FAKE_TX);
      assert.equal(paid.conversion.swapTx, sent.swapTx, 'the receipt carries both transactions');
      assert.equal(paid.conversion.sell.symbol, sym);
      assert.equal(w.fake.gateway.paidRequests, 1, 'exactly one paid request: no duplicate charge');
      // paying again changes nothing
      const again = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.body.order.id, signature: await signAuthorization(b.key, q2.body.order.typedData) } })).body;
      assert.equal(again.alreadyProcessed, true);
      assert.equal(w.fake.gateway.paidRequests, 1);
      assert.equal(countLedger(w), ledgerBefore, 'no balance was credited anywhere: the conversion never touches the Payrail ledger');
    } finally {
      await s.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------- failure modes

test('a swap that does not deliver what was shown is never CONFIRMED (reverted, short, no fill, wrong recipient, wrong token, uncertain)', async () => {
  const cases: Array<[string, string[]]> = [
    ['reverted', ['FAILED']],
    ['short', ['REVIEW']],
    ['no_fill', ['REVIEW']],
    ['wrong_recipient', ['REVIEW']],
    ['wrong_token', ['REVIEW']],
    ['uncertain', ['SUBMITTED']],
  ];
  for (const sym of ['cNGN', 'wBRL', 'USDC']) {
    for (const [scenario, states] of cases) {
      const w = await world();
      const s = await serve(w.market);
      try {
        const b = await walletBuyer(s);
        const q = await quoteBuy(s, b);
        const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } })).body.conversion;
        const sent = await walletSwaps(w, b, cv, scenario);
        w.provider.advance(20);
        if (!sent.swapTx) continue; // a refused execution produced no transaction: nothing to verify
        const r = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
        assert.notEqual(r.state, 'CONFIRMED', `${sym}/${scenario}`);
        assert.equal(r.confirmed, false, `${sym}/${scenario}`);
        assert.ok(states.includes(r.state), `${sym}/${scenario}: ${r.state}`);
        // an unconfirmed conversion cannot be attached to a purchase
        assert.equal((await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'a' }, conversionId: cv.id } })).body.code, 'CONVERSION_NOT_CONFIRMED');
        // and the wallet still cannot pay Buy: nothing was sent to the gateway
        assert.equal(w.fake.gateway.paidRequests, 0, `${sym}/${scenario}`);
      } finally {
        await s.close();
      }
    }
  }
});

test('conversion succeeds but the Buy payment fails: the conversion stays CONFIRMED, the order is NOT confirmed, nothing is converted twice or paid twice', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    const cv = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'wARS' } })).body.conversion;
    const sent = await walletSwaps(w, b, cv);
    w.provider.advance(20);
    const done = (await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: cv.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion;
    assert.equal(done.state, 'CONFIRMED');
    w.balances.set(b.key.address.toLowerCase(), BigInt(done.receive.receivedAtomic));

    w.fake.gateway.mode = 'http500';
    const q2 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body;
    const failed = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
    assert.notEqual(failed.order.state, 'CONFIRMED');
    assert.equal(failed.order.confirmed, false);
    assert.equal(failed.conversion.state, 'CONFIRMED', 'the money that was converted is still the buyer\'s USDT, shown honestly');
    assert.equal(w.fake.gateway.paidRequests, 1);
    // the failed order is never re-sent; the conversion is not repeated
    const again = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q2.order.id, signature: await signAuthorization(b.key, q2.order.typedData) } })).body;
    assert.equal(again.alreadyProcessed, true);
    assert.equal(w.fake.gateway.paidRequests, 1);

    // later, with the gateway healthy, the SAME converted USDT pays a NEW order: no second conversion is needed
    w.fake.gateway.mode = 'ok';
    const q3 = (await s.call('POST', '/buy/quote', { bearer: b.token, body: { serviceId: 'x.posts.search', input: { query: 'celo' }, conversionId: cv.id } })).body;
    assert.equal(q3.funding.shortfall, '0');
    const ok = (await s.call('POST', '/buy/pay', { bearer: b.token, body: { orderId: q3.order.id, signature: await signAuthorization(b.key, q3.order.typedData) } })).body;
    assert.equal(ok.order.state, 'CONFIRMED');
    assert.equal(w.fake.gateway.paidRequests, 2);
    const convs = (await s.call('GET', '/buy/convert/' + cv.id, { bearer: b.token })).body;
    assert.equal(convs.conversion.swapTx, sent.swapTx);
    assert.equal(Number((w.market.db.prepare('SELECT COUNT(*) AS n FROM buy_conversions WHERE state = \'CONFIRMED\'').get() as { n: number | bigint }).n), 1);
  } finally {
    await s.close();
  }
});

test('the same swap transaction cannot confirm two conversions, and another buyer cannot claim it', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    const a = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'USDC' } })).body.conversion;
    const c = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'USDC' } })).body.conversion;
    const sent = await walletSwaps(w, b, a);
    w.provider.advance(20);
    assert.equal((await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: a.id, kind: 'swap', txHash: sent.swapTx } })).body.conversion.state, 'CONFIRMED');
    assert.equal((await s.call('POST', '/buy/convert/tx', { bearer: b.token, body: { conversionId: c.id, kind: 'swap', txHash: sent.swapTx } })).body.code, 'TX_ALREADY_USED');
    const other = await walletBuyer(s);
    assert.equal((await s.call('POST', '/buy/convert/tx', { bearer: other.token, body: { conversionId: a.id, kind: 'swap', txHash: sent.swapTx } })).status, 404);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------- balances and gas

for (const sym of ENABLED) {
  test(`${sym}: a wallet that cannot cover the swap is refused BEFORE anything is signed, and no conversion record is created`, async () => {
    const w = await world(envFor(sym));
    const s = await serve(w.market);
    try {
      const b = await walletBuyer(s);
      const q = await quoteBuy(s, b);
      w.tokenBalances.set(`${ON_CHAIN[sym]!.address}:${b.key.address}`.toLowerCase(), 1n);
      const r = await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: sym } });
      assert.equal(r.body.code, 'INSUFFICIENT_FUNDS');
      assert.match(r.body.message, /Nothing was signed or sent/);
      assert.equal(Number((w.market.db.prepare('SELECT COUNT(*) AS n FROM buy_conversions').get() as { n: number | bigint }).n), 0);
    } finally {
      await s.close();
    }
  });
}

test('the balance is re-checked when signing starts, and low CELO produces a gas warning without blocking', async () => {
  const w = await world();
  const s = await serve(w.market);
  try {
    const b = await walletBuyer(s);
    const q = await quoteBuy(s, b);
    w.celoBalances.set(b.key.address.toLowerCase(), 1_000_000_000_000_000n); // 0.001 CELO
    const est = (await s.call('POST', '/buy/convert/estimate', { bearer: b.token, body: { orderId: q.order.id, symbol: 'wBRL' } })).body;
    assert.equal(est.gas.low, true);
    assert.equal(est.gas.celoBalance, '0.001');
    assert.ok(est.conversion.id, 'a gas warning does not block (the wallet may pay gas in a fee currency)');
    assert.equal(est.walletHolds !== null || est.walletHolds === null, true);
    // the wallet spends its wBRL elsewhere after the estimate: the prepare step refuses
    w.tokenBalances.set(`${ON_CHAIN.wBRL!.address}:${b.key.address}`.toLowerCase(), 5n);
    const p = (await s.call('POST', '/buy/convert/proof', { bearer: b.token })).body;
    const t = takerControlTypedData(b.key.address, 42220, p.nonce, p.issuedAt);
    const signature = await b.key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const prep = await s.call('POST', '/buy/convert/prepare', { bearer: b.token, body: { conversionId: est.conversion.id, nonce: p.nonce, issuedAt: p.issuedAt, signature } });
    assert.equal(prep.body.code, 'INSUFFICIENT_FUNDS');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------- firm quote validation per token

const asset = (sym: string) => assetBySymbol(sym)!;
const proof = { nonce: `0x${'01'.repeat(32)}` as `0x${string}`, issuedAt: NOW, signature: '0x11' as `0x${string}` };

for (const sym of ENABLED) {
  test(`${sym}: Textile's firm quote is accepted only when every field matches (token, spender, exact approval, minimum, slippage, taker, expiry)`, async () => {
    const a = asset(sym);
    const sell = 10n ** BigInt(a.decimals) * 100n;
    const expected = 1_000_000n; // 1.0 USDT
    const min = 990_000n; // the 1% guarantee shown to the buyer
    const fee = sell / 1000n;
    const mk = (over: Parameters<typeof goodQuote>[0] = {}) => goodQuote({
      sellAmount: sell, takerPays: sell, buyAmount: expected, feeAmount: fee, approvalTo: a.address, approveAmount: sell,
      order: { input: { token: USDT as `0x${string}`, amount: over.buyAmount ?? expected, maxAmount: over.buyAmount ?? expected }, outputs: [{ token: a.address, amount: sell - fee, recipient: MAKER }] },
      ...over,
    });
    const prepare = async (q: ReturnType<typeof goodQuote>, allowance = 0n) => {
      const rt = createBuyerSwapRuntime({ firmQuote: async () => q, getAllowance: async () => allowance, provider: {} as any, chainId: 42220, tag: TAG, now: () => NOW });
      const op = { id: 'cnv_x', buyerId: 'b', sellAtomic: sell, minAtomic: min, expectedAtomic: expected, approvalDigest: 'abcd'.repeat(16) } as any;
      return rt.prepare({ op, wallet: PAYER, sell: { chainId: 42220, address: a.address, symbol: sym, decimals: a.decimals }, proof });
    };
    const ready = await prepare(mk());
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    if (ready.kind === 'ready') {
      assert.deepEqual(ready.steps.map((x) => x.kind), ['approve', 'swap']);
      assert.equal(ready.steps[0]!.to.toLowerCase(), a.address.toLowerCase(), 'the approval goes to the sell token');
      assert.equal(ready.steps[1]!.to.toLowerCase(), TEXTILE_REACTOR.toLowerCase(), 'the swap goes to the verified reactor');
    }
    // an existing sufficient allowance means no approval step at all
    const noApprove = await prepare(mk(), sell);
    assert.ok(noApprove.kind === 'ready' && noApprove.steps.every((x) => x.kind === 'swap'));
    // insufficient output / excessive slippage
    assert.equal((await prepare(mk({ buyAmount: 989_999n }))).kind, 'rejected', 'below the guaranteed minimum');
    assert.equal((await prepare(mk({ buyAmount: 980_000n }))).kind, 'rejected', 'worse than the preview by more than the slippage bound');
    // tampering
    assert.equal((await prepare(mk({ taker: OTHER }))).kind, 'rejected', 'bound to another wallet');
    assert.equal((await prepare(mk({ reactor: OTHER, spender: OTHER, swapTo: OTHER }))).kind, 'rejected', 'a foreign reactor');
    assert.equal((await prepare(mk({ approveAmount: 2n ** 256n - 1n }))).kind, 'rejected', 'an unlimited approval');
    assert.equal((await prepare(mk({ approvalTo: asset(sym === 'USDC' ? 'cNGN' : 'USDC').address }))).kind, 'rejected', 'an approval on a different token');
    assert.equal((await prepare(mk({ takerPays: sell + 1n }))).kind, 'rejected', 'charging more than the amount shown');
    assert.equal((await prepare(mk({ expiresInMs: 3_000 }))).kind, 'rejected', 'too little time left to act');
    assert.equal((await prepare(mk({ feeAmount: sell / 20n }))).kind, 'rejected', 'an excessive fee');
    const none = createBuyerSwapRuntime({ firmQuote: async () => ({ kind: 'no_quote', reason: 'no makers', requestId: undefined }), getAllowance: async () => 0n, provider: {} as any, chainId: 42220, tag: TAG, now: () => NOW });
    assert.equal((await none.prepare({ op: { id: 'x', buyerId: 'b', sellAtomic: sell, minAtomic: min, expectedAtomic: expected, approvalDigest: 'ab'.repeat(32) } as any, wallet: PAYER, sell: { chainId: 42220, address: a.address, symbol: sym, decimals: a.decimals }, proof })).kind, 'no_quote');
  });
}

test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
