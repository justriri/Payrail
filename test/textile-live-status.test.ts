// Live-route status and USDC availability. These use FAKE Textile responses shaped like the real ones (a ladder entry with no levels,
// preview answers such as no_makers_online): they test Payrail's interpretation, not Textile's liquidity, which only a live check can show.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuyConvert } from '../src/buyconvert.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { createAccount } from '../src/ledger.ts';
import { createOfficialCorridors, parseOfficialCorridors } from '../src/textiledocs.ts';
import type { OfficialCorridors } from '../src/textiledocs.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';

const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as const;
const A = {
  USDC: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', cNGN: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', wCOP: '0x8a1D45e102e886510e891d2Ec656a708991e2D76', wARS: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D',
  wBRL: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', IDRX: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22',
} as const;
type Pair = { sellToken: `0x${string}`; buyToken: `0x${string}`; minSellAmount: bigint; maxSellAmount: bigint; levels: Array<{ sellAmount: bigint; buyAmount: bigint }> };
const pair = (sym: keyof typeof A, o: { levels?: boolean; min?: bigint } = {}): Pair => {
  const min = o.min ?? 1_000_000n;
  return { sellToken: A[sym] as `0x${string}`, buyToken: USDT, minSellAmount: min, maxSellAmount: o.levels === false ? 0n : 5_000_000_000n, levels: o.levels === false ? [] : [{ sellAmount: min, buyAmount: 999_000n }, { sellAmount: min * 100n, buyAmount: 99_800_000n }] };
};

/** a controllable Textile: the ladder it publishes and how /rfq/preview answers per token */
function textile() {
  const state = { pairs: [] as Pair[], preview: new Map<string, 'ok' | 'no_makers_online' | 'error'>(), previews: 0 };
  const provider = createTextileRouteProvider({
    getLadder: async () => ({ asOf: '2026-10-21T00:00:00.000Z', pairs: state.pairs }),
    preview: (async (a: { sellToken: string; sellAmount: bigint }) => {
      state.previews++;
      const mode = state.preview.get(a.sellToken.toLowerCase()) ?? 'ok';
      if (mode === 'error') throw new Error('upstream timeout');
      if (mode === 'no_makers_online') return { kind: 'no_quote', reason: 'no_makers_online', requestId: 'r' };
      return { kind: 'preview', sellAmount: a.sellAmount, buyAmount: 998_000n, feeAmount: 1n, takerPays: a.sellAmount, rateRay: '1', availableSellAmount: undefined, requestId: 'r', rateRemaining: undefined };
    }) as never,
  });
  return { state, provider };
}
const official = (symbols: string[], addresses: string[] = []): (() => Promise<OfficialCorridors>) => async () => ({ symbols: new Set(symbols), addresses: new Set(addresses.map((a) => a.toLowerCase())), source: 'official-page', fetchedAt: '2026-10-21T00:00:00.000Z' });
function convert(t: ReturnType<typeof textile>, o: Partial<Parameters<typeof createBuyConvert>[0]> = {}) {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  return Object.assign(createBuyConvert({
    db, registry: new RouteRegistry(db, [t.provider]), provider: t.provider, buyerSwap: { converterFor: () => { throw new Error('unused'); }, prepare: async () => { throw new Error('unused'); } },
    reader: { blockNumber: async () => 0n, receipt: async () => null }, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 1, maxUsdtAtomic: 2_000_000n,
    officialCorridors: official(['cNGN', 'USDC', 'wARS', 'wBRL', 'IDRX']), now: () => 1_000_000, ...o,
  }), { db });
}
const status = async (bc: ReturnType<typeof createBuyConvert>, sym: string) => (await bc.currencies()).find((c) => c.symbol === sym)!;

test('USDC regression: an EMPTY ladder entry is not proof of no liquidity; a usable price at the pair minimum makes the route Live', async () => {
  const t = textile();
  t.state.pairs = [pair('USDC', { levels: false, min: 998_881n }), pair('cNGN', { min: 1_360_000_000n })];
  const bc = convert(t);
  const c = await status(bc, 'USDC');
  assert.equal(c.status, 'live', 'Textile answers a price, so the route works whatever the ladder summary says');
  assert.equal(c.statusLabel, 'Live');
  assert.equal(c.available, true);
  assert.equal(c.minSell, '0.998881', 'the minimum comes from the pair, in USDC units (6 decimals)');
});

test('USDC regression: when Textile really has no makers, the reason is the REAL one and it is not Live', async () => {
  const t = textile();
  t.state.pairs = [pair('USDC', { levels: false, min: 998_881n })];
  t.state.preview.set(A.USDC.toLowerCase(), 'no_makers_online');
  const bc = convert(t);
  const c = await status(bc, 'USDC');
  assert.equal(c.status, 'temporarily_unavailable');
  assert.equal(c.available, false);
  assert.match(c.reason!, /no market makers are quoting this route right now/);
  assert.match(c.statusDetail, /no market makers/);
  assert.equal(c.minSell, null);
  assert.equal(c.textileLive, false);
  // an estimate is refused with the same reason, never quoted from a made-up rate
  await assert.rejects(bc.estimate({ buyerId: 'b', wallet: '0x00000000000000000000000000000000000000a1', symbol: 'USDC', targetAtomic: 5_000n }), (e: any) => e.code === 'UNSUPPORTED_CURRENCY' && /no market makers/.test(e.message));
});

test('USDC recovers by itself: when makers return, the next refresh shows Live with no code or configuration change', async () => {
  let clock = 1_000_000;
  const t = textile();
  t.state.pairs = [pair('USDC', { levels: false, min: 998_881n })];
  t.state.preview.set(A.USDC.toLowerCase(), 'no_makers_online');
  const bc = convert(t, { now: () => clock });
  assert.equal((await status(bc, 'USDC')).status, 'temporarily_unavailable');
  // Textile's makers come back: the ladder fills and previews answer
  t.state.preview.delete(A.USDC.toLowerCase());
  t.state.pairs = [pair('USDC', { min: 998_881n })];
  assert.equal((await status(bc, 'USDC')).status, 'temporarily_unavailable', 'inside the 30 s cache the old answer is kept');
  clock += 31_000;
  const c = await status(bc, 'USDC');
  assert.equal(c.status, 'live');
  assert.equal(c.available, true);
});

test('a stale ladder cannot make a dead route Live: levels listed but Textile answers no_makers_online', async () => {
  const t = textile();
  t.state.pairs = [pair('USDC', { min: 998_881n })];
  t.state.preview.set(A.USDC.toLowerCase(), 'no_makers_online');
  const c = await status(convert(t), 'USDC');
  assert.equal(c.status, 'temporarily_unavailable');
  assert.match(c.reason!, /no market makers/i);
  assert.equal(c.available, false);
});

test('a Textile outage or an unusable price is "temporarily unavailable" with the reason; it is never shown as Live', async () => {
  const t = textile();
  t.state.pairs = [pair('USDC', { min: 998_881n }), pair('wARS', { min: 1_600n * 10n ** 18n })];
  t.state.preview.set(A.USDC.toLowerCase(), 'error');
  const bc = convert(t);
  const c = await status(bc, 'USDC');
  assert.equal(c.status, 'temporarily_unavailable');
  assert.match(c.reason!, /no price/);
  assert.equal((await status(bc, 'wARS')).status, 'live', 'one route failing does not affect another');
});

test('a minimum below the Textile pair minimum is never used: the swap size always respects the pair minimum in the token\'s units', async () => {
  const t = textile();
  t.state.pairs = [pair('USDC', { min: 998_881n })];
  const bc = convert(t);
  const buyerId = createAccount(bc.db, { kind: 'buyer', displayName: 'B' });
  const e = await bc.estimate({ buyerId, wallet: '0x00000000000000000000000000000000000000a1', symbol: 'USDC', targetAtomic: 5_000n });
  assert.ok(BigInt(e.conversion.sell.amountAtomic) >= 998_881n);
  assert.equal(e.conversion.sell.decimals, 6);
});

test('official list: parse the real page shape; the Celo corridors are read, other chains are not', () => {
  const html = '<p>Chain Live corridors BNB Smart Chain (56) cNGN ↔ USDT Ethereum (1) WETH ↔ USDT Celo (42220) cNGN ↔ USDT, USDC ↔ USDT, wARS ↔ USDT, wBRL ↔ USDT, IDRX ↔ USDT Polygon (137) TESOURO ↔ USDT BNB Smart Chain testnet (97) cNGN ↔ USDT, sandbox only</p><td>USDC</td><td>0xcebA9300f2b948710d2653dD7B07f33A8B32118C</td>';
  const p = parseOfficialCorridors(html)!;
  assert.deepEqual([...p.symbols].sort(), ['IDRX', 'USDC', 'cNGN', 'wARS', 'wBRL']);
  assert.ok(!p.symbols.has('WETH') && !p.symbols.has('TESOURO'));
  assert.ok(p.addresses.has('0xceba9300f2b948710d2653dd7b07f33a8b32118c'));
  assert.equal(parseOfficialCorridors('<html>maintenance</html>'), undefined, 'an unrecognised page changes nothing');
});

test('official list is fetched at runtime and cached; a failed fetch keeps the last good copy, then the snapshot; it never invents currencies', async () => {
  const page = 'Celo (42220) cNGN ↔ USDT, wCOP ↔ USDT Polygon (137) X ↔ USDT';
  let mode: 'ok' | 'down' = 'ok';
  let calls = 0;
  let clock = 0;
  const get = createOfficialCorridors({ now: () => clock, ttlMs: 1000, fetchImpl: (async () => { calls++; if (mode === 'down') throw new Error('offline'); return new Response(page, { status: 200 }); }) as never });
  const a = await get();
  assert.equal(a.source, 'official-page');
  assert.deepEqual([...a.symbols].sort(), ['cNGN', 'wCOP']);
  await get();
  assert.equal(calls, 1, 'cached');
  mode = 'down';
  clock += 5000;
  const b = await get();
  assert.equal(b.source, 'last-good-copy');
  assert.deepEqual([...b.symbols].sort(), ['cNGN', 'wCOP']);
  const cold = createOfficialCorridors({ fetchImpl: (async () => { throw new Error('offline'); }) as never });
  const c = await cold();
  assert.equal(c.source, 'built-in-snapshot');
  assert.deepEqual([...c.symbols].sort(), ['IDRX', 'USDC', 'cNGN', 'wARS', 'wBRL']);
});

test('a currency Textile adds to its OFFICIAL Celo list becomes Live automatically (wCOP here), as long as its token contract is known and listed; others stay Unsupported', async () => {
  const t = textile();
  t.state.pairs = [pair('cNGN', { min: 1_360_000_000n }), pair('wCOP', { min: 3_100n * 10n ** 18n })];
  const before = convert(t);
  assert.equal((await status(before, 'wCOP')).status, 'unsupported');
  assert.match((await status(before, 'wCOP')).reason!, /official address book/);
  const after = convert(t, { officialCorridors: official(['cNGN', 'wCOP'], [A.wCOP, A.cNGN]) });
  const c = await status(after, 'wCOP');
  assert.equal(c.status, 'live');
  assert.equal(c.available, true);
  // the official page names the symbol but NOT this contract address: not trusted
  const mismatch = convert(t, { officialCorridors: official(['cNGN', 'wCOP'], [A.cNGN]) });
  assert.equal((await status(mismatch, 'wCOP')).status, 'unsupported');
  // a quote alone never enables a currency that is not official
  const quoteOnly = convert(t, { officialCorridors: official(['cNGN']) });
  assert.equal((await status(quoteOnly, 'wCOP')).status, 'unsupported');
});

test('no user-facing status asks for a test run, and CELO (the gas token) is still never offered', async () => {
  const t = textile();
  t.state.pairs = [pair('cNGN', { min: 1_360_000_000n }), pair('USDC', { levels: false, min: 998_881n })];
  t.state.preview.set(A.USDC.toLowerCase(), 'no_makers_online');
  const list = await convert(t).currencies();
  for (const c of list) assert.doesNotMatch(`${c.statusLabel} ${c.statusDetail} ${c.reason ?? ''}`, /needs? (a )?(live )?test|test run|first real conversion/i, c.symbol);
  const celo = list.find((c) => c.symbol === 'CELO');
  assert.ok(!celo || celo.available === false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// "wBRL cannot be used for pricing right now (Unsupported): this asset is not listed by the provider."
// Root cause: when Textile could not be reached while the routes were read, the registry swallowed the error and reported EVERY asset as "not
// listed by the provider" (Unsupported). An outage is temporary and says nothing about what Textile lists.
import { getLadder } from '../src/textile.ts';

const dead = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN api.textilecredit.com'), { code: 'EAI_AGAIN' }); };
function outage() {
  const provider = createTextileRouteProvider({ getLadder: dead as never, preview: dead as never });
  const db = openDb(':memory:');
  seedConversionAssets(db);
  return createBuyConvert({
    db, registry: new RouteRegistry(db, [provider]), provider, buyerSwap: { converterFor: () => { throw new Error('unused'); }, prepare: async () => { throw new Error('unused'); } },
    reader: { blockNumber: async () => 0n, receipt: async () => null }, usdt: USDT, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: 1, maxUsdtAtomic: 2_000_000n,
    officialCorridors: official(['cNGN', 'USDC', 'wARS', 'wBRL', 'IDRX'], Object.values(A)), now: () => 1_000_000,
  });
}

test('root cause of the wBRL message: a Textile outage is Temporarily unavailable, never Unsupported / not listed by the provider', async () => {
  const bc = outage();
  const list = await bc.currencies();
  for (const sym of ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX']) {
    const c = list.find((x) => x.symbol === sym)!;
    assert.equal(c.status, 'temporarily_unavailable', sym);
    assert.match(c.reason!, /Textile could not be reached/, sym);
    assert.doesNotMatch(`${c.reason} ${c.statusDetail}`, /not listed by the provider/, sym);
    assert.equal(c.available, false);
  }
});

test('seller pricing during an outage is a TEMPORARY error (try again), not "cannot be used"', async () => {
  const bc = outage();
  await assert.rejects(bc.normalizePrice({ symbol: 'wBRL', amountAtomic: 10n ** 18n }), (e: any) => e.code === 'PRICE_UNAVAILABLE' && /cannot be converted reliably right now/.test(e.message) && /Try again shortly/.test(e.message) && !/Unsupported/.test(e.message));
});

test('an official Textile corridor missing from the price ladder at this moment is Temporarily unavailable; a non-official one stays Unsupported', async () => {
  const t = textile();
  t.state.pairs = [pair('cNGN', { min: 1_360_000_000n })]; // wBRL and wCOP have no ladder entry right now
  const bc = convert(t, { officialCorridors: official(['cNGN', 'wBRL', 'USDC'], [A.cNGN, '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0']) });
  const wbrl = await status(bc, 'wBRL');
  assert.equal(wbrl.status, 'temporarily_unavailable');
  assert.match(wbrl.reason!, /official Textile corridor on Celo/);
  assert.doesNotMatch(wbrl.reason!, /not listed by the provider/);
  assert.equal((await status(bc, 'wCOP')).status, 'unsupported');
  await assert.rejects(bc.normalizePrice({ symbol: 'wBRL', amountAtomic: 10n ** 18n }), (e: any) => e.code === 'PRICE_UNAVAILABLE');
});

test('a short outage does not hide every route: the last good ladder is used for 15 minutes, then an outage is reported as an outage', async () => {
  let clock = 1_000_000;
  let down = false;
  const pairs = [pair('cNGN', { min: 1_360_000_000n }), pair('USDC', { min: 998_881n })];
  const provider = createTextileRouteProvider({
    now: () => clock,
    getLadder: (async () => { if (down) throw new Error('EAI_AGAIN'); return { asOf: 'x', pairs }; }) as never,
    preview: (async (a: { sellAmount: bigint }) => { if (down) throw new Error('EAI_AGAIN'); return { kind: 'preview', sellAmount: a.sellAmount, buyAmount: 998_000n, feeAmount: 1n, takerPays: a.sellAmount, rateRay: '1', availableSellAmount: undefined, requestId: 'r', rateRemaining: undefined }; }) as never,
  });
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const reg = new RouteRegistry(db, [provider]);
  assert.equal((await reg.find('funding', 'cNGN'))!.available, true);
  down = true;
  clock += 60_000;
  const r = (await reg.find('funding', 'cNGN'))!;
  assert.equal(r.available, true, 'known from the last good ladder; the buyer-facing list still needs a live price');
  assert.notEqual(r.unavailableReason, 'not_on_ladder');
  clock += 16 * 60_000;
  const gone = (await reg.find('funding', 'cNGN'))!;
  assert.equal(gone.available, false);
  assert.equal(gone.unavailableReason, 'provider_error');
});

test('Textile reads are retried on transient failures (DNS blip, reset, 429 and 5xx) and a definite answer is not', async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; if (calls < 3) throw new TypeError('fetch failed'); return new Response(JSON.stringify({ data: { chainId: 42220, asOf: 'now', pairs: [] } }), { status: 200 }); }) as never;
    const l = await getLadder(42220);
    assert.equal(calls, 3);
    assert.deepEqual(l.pairs, []);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 404 }); }) as never;
    await assert.rejects(getLadder(42220), /HTTP 404/);
    assert.equal(calls, 1, 'a 404 is final: no retry');
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 503 }); }) as never;
    await assert.rejects(getLadder(42220), /HTTP 503/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('conversion list, seller pricing list and settlement are different things: pricing needs a usable rate, so it follows the conversion list; settlement is always USDT', async () => {
  const t = textile();
  t.state.pairs = [pair('cNGN', { min: 1_360_000_000n }), pair('wBRL', { min: 5n * 10n ** 18n }), pair('wARS', { min: 1_600n * 10n ** 18n }), pair('USDC', { min: 998_881n }), pair('IDRX', { min: 1_790_000n })];
  const bc = convert(t);
  const pricing = (await bc.pricingCurrencies()).filter((c) => c.selectable).map((c) => c.symbol).sort();
  const conversion = (await bc.currencies()).filter((c) => c.available).map((c) => c.symbol).sort();
  assert.deepEqual(pricing, ['IDRX', 'USDC', 'cNGN', 'wARS', 'wBRL'], 'every confirmed corridor can be used to price an API');
  assert.deepEqual(pricing, conversion);
  for (const [sym, amt] of [['cNGN', 50_000_000n], ['wBRL', 10n ** 18n], ['wARS', 100n * 10n ** 18n], ['USDC', 1_000_000n], ['IDRX', 100_000n]] as const) {
    const n = await bc.normalizePrice({ symbol: sym, amountAtomic: amt });
    assert.equal(n.currency, sym);
    assert.ok(n.usdtAtomic > 0n, sym);
    assert.equal(n.status, 'live');
  }
  assert.ok(!conversion.includes('USDT'), 'USDT is the settlement currency, not a conversion source');
});
