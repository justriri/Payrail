// Marketplace over HTTP: the real web server + real marketplace modules, fake network, test credits.
// LOCAL INTEGRATION: proves the API behaviour the browser uses. Not a live or on-chain test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { normalizeCatalog } from '../src/catalog.ts';
import { openDb } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import type { Resolver, Transport } from '../src/egress.ts';
import { TEST_CREDIT_CAP } from '../src/market.ts';
import type { MarketRuntime } from '../src/market.ts';
import { verifyLedger } from '../src/ledger.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { TRANSFER_TOPIC, fundingMessage } from '../src/funding.ts';
import type { ChainReader, ChainReceipt } from '../src/funding.ts';
import { createSimulatedRuntime } from '../src/websim.ts';

const SELLER_SECRET = 'sk_seller_http_secret_9876543210abcdef';
const mk = generateMasterKey('k1');

const buyCat = normalizeCatalog(
  {
    payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, tokens: [] },
    capabilities: [{ id: 'buy.search', title: 'Buy search', method: 'POST', url: 'https://gateway.usebuy.ai/v1/social/x/posts/search', available: true, platform: 'x', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } }],
  },
  Date.now(),
);

async function start(liveCfg?: MarketRuntime['live']) {
  const db = openDb(':memory:');
  seedDemo(db, mk);
  const demo = createDemoNetwork();
  // a fake third-party seller API that insists on its key
  let sellerCalls = 0;
  const sellerResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const sellerTransport: Transport = async (r) => {
    sellerCalls++;
    const ok = r.headers['x-api-key'] === SELLER_SECRET;
    return { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(ok ? { quote: 7, asOf: new Date().toISOString(), debug: `key=${r.headers['x-api-key']}` } : { error: 'bad key' })) };
  };
  const txtRecords = new Map<string, string>();
  const market: MarketRuntime = {
    db,
    keys: [mk],
    activeKey: mk,
    execute: {
      call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sellerResolver, transport: sellerTransport } },
      demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 150 } },
    },
    testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sellerResolver, transport: sellerTransport } },
    domain: { txt: async (name) => (txtRecords.has(name) ? [[txtRecords.get(name)!]] : []) },
    buyCatalog: async () => buyCat,
    ...(liveCfg ? { live: liveCfg } : {}),
  };
  const rt = createSimulatedRuntime({ scenario: 'ok', delayMs: 5 });
  const { server, token } = createWebServer(rt, { token: 'test-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, o: { body?: unknown; bearer?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      if (o.token !== null) headers['x-payrail-token'] = o.token ?? token;
    }
    const r = await fetch(base + '/api/market' + path, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(o.body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, base, token, call, txtRecords, sellerCalls: () => sellerCalls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;

async function buyer(h: H) {
  const b = await h.call('POST', '/buyer');
  assert.equal(b.status, 201);
  return b.body.token as string;
}
async function seller(h: H) {
  const w = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address } });
  const sig = await w.signMessage({ message: s.body.message });
  const c = await h.call('POST', '/seller/login/complete', { body: { wallet: w.address, nonce: s.body.nonce, signature: sig } });
  assert.equal(c.status, 200, c.text);
  return { w, token: c.body.token as string };
}

test('merged catalog: Payrail demo listings and Buy services side by side, with how each is paid', async () => {
  const h = await start();
  try {
    const r = await h.call('GET', '/catalog');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'test-credits');
    const items = r.body.items as any[];
    const payrail = items.filter((i) => i.source === 'payrail');
    const buy = items.filter((i) => i.source === 'buy');
    assert.equal(payrail.length, 2);
    assert.ok(payrail.every((i) => i.execution === 'payrail-gateway' && i.payOnlyForQualifying === true && i.demo === true && i.pricing.kind === 'fixed'));
    assert.equal(buy.length, 1);
    assert.equal(buy[0].execution, 'x402-direct');
    assert.equal(buy[0].pricing.kind, 'indicative');
    assert.equal(buy[0].payOnlyForQualifying, false);
    assert.equal(r.body.buy.available, true);
    const q = await h.call('GET', '/catalog?q=echo');
    assert.deepEqual((q.body.items as any[]).map((i) => i.title), ['Demo text echo']);
    // the existing Buy catalog route is untouched
    assert.equal((await fetch(h.base + '/api/catalog')).status, 200);
  } finally {
    await h.close();
  }
});

test('buyer journey over HTTP: credits, a qualifying run is charged, a stale run is free, history and ledger agree', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    const cat = (await h.call('GET', '/catalog')).body.items as any[];
    const price = cat.find((i) => i.title.startsWith('Demo token price'));
    // no credits yet
    const none = await h.call('POST', '/execute', { bearer: bt, body: { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'ui-key-00001' } });
    assert.equal(none.status, 402);
    assert.equal(none.body.code, 'INSUFFICIENT_CREDITS');

    assert.equal((await h.call('POST', '/credits', { bearer: bt, body: { amount: '1' } })).status, 200);
    const good = await h.call('POST', '/execute', { bearer: bt, body: { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'ui-key-00002' } });
    assert.equal(good.status, 201);
    assert.equal(good.body.result.charged, true);
    assert.equal(good.body.result.body.id, 'eth');
    const stale = await h.call('POST', '/execute', { bearer: bt, body: { listingId: price.id, input: { id: 'eth', scenario: 'stale' }, idempotencyKey: 'ui-key-00003' } });
    assert.equal(stale.body.result.charged, false);
    assert.equal(stale.body.result.state, 'NOT_QUALIFIED');
    const hang = await h.call('POST', '/execute', { bearer: bt, body: { listingId: price.id, input: { id: 'eth', scenario: 'hang' }, idempotencyKey: 'ui-key-00004' } });
    assert.equal(hang.body.result.state, 'UNRESOLVED');
    const replay = await h.call('POST', '/execute', { bearer: bt, body: { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'ui-key-00002' } });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.result.replay, true);

    const me = await h.call('GET', '/me', { bearer: bt });
    assert.equal(me.body.available, '0.96'); // 1 - 0.02 charged - 0.02 held
    assert.equal(me.body.held, '0.02');
    const hist = await h.call('GET', '/executions', { bearer: bt });
    assert.deepEqual((hist.body.executions as any[]).map((e) => e.state).sort(), ['NOT_QUALIFIED', 'QUALIFIED', 'UNRESOLVED']);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('test-credit cap is enforced and labelled; bad amounts are refused', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    assert.equal((await h.call('POST', '/credits', { bearer: bt, body: { amount: '5' } })).status, 200);
    const over = await h.call('POST', '/credits', { bearer: bt, body: { amount: '0.01' } });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'TEST_CREDIT_CAP');
    for (const amount of ['-1', '0', 'abc', '1e9', '1.1234567']) assert.equal((await h.call('POST', '/credits', { bearer: bt, body: { amount } })).status, 400, amount);
    assert.equal(TEST_CREDIT_CAP, 5_000_000n);
  } finally {
    await h.close();
  }
});

test('access control: POST needs the page token, accounts are kept apart, roles are enforced', async () => {
  const h = await start();
  try {
    assert.equal((await h.call('POST', '/buyer', { token: null })).status, 403);
    assert.equal((await h.call('POST', '/buyer', { token: 'wrong' })).status, 403);
    assert.equal((await h.call('GET', '/me')).status, 401);
    assert.equal((await h.call('GET', '/me', { bearer: 'x'.repeat(30) })).status, 401);
    const bt = await buyer(h);
    const st = (await seller(h)).token;
    assert.equal((await h.call('GET', '/seller/listings', { bearer: bt })).status, 403, 'a buyer is not a seller');
    assert.equal((await h.call('POST', '/execute', { bearer: st, body: { listingId: 'x', input: {}, idempotencyKey: 'abcdefgh' } })).status, 403, 'a seller is not a buyer');
    // another buyer cannot read my execution
    const cat = (await h.call('GET', '/catalog')).body.items as any[];
    await h.call('POST', '/credits', { bearer: bt, body: { amount: '1' } });
    const e = await h.call('POST', '/execute', { bearer: bt, body: { listingId: cat[0].id, input: { id: 'eth', text: 'hi' }, idempotencyKey: 'ui-key-iso-01' } });
    const other = await buyer(h);
    assert.equal((await h.call('GET', `/execution/${e.body.result.executionId}`, { bearer: other })).status, 404);
    assert.equal((await h.call('GET', `/execution/${e.body.result.executionId}`, { bearer: bt })).status, 200);
    // unknown routes and cross-origin posts
    assert.equal((await h.call('GET', '/nope')).status, 404);
    const xo = await fetch(h.base + '/api/market/buyer', { method: 'POST', headers: { 'x-payrail-token': h.token, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(xo.status, 403);
  } finally {
    await h.close();
  }
});

test('seller journey over HTTP: list, prove ownership, store credential, test, contract, publish, get paid per qualifying response', async () => {
  const h = await start();
  try {
    const { w, token: st } = await seller(h);
    const created = await h.call('POST', '/seller/listings', { bearer: st, body: { name: 'Quote API', description: 'quotes', endpointUrl: 'https://api.sellerco.example/v1/quote', method: 'GET', price: '0.10' } });
    assert.equal(created.status, 201, created.text);
    const l = created.body.listing;
    assert.equal(l.status, 'draft');

    // tests / contract / publish are blocked until ownership is verified
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/test`, { bearer: st, body: { input: {} } })).body.report.failure.code, 'LISTING_NOT_VERIFIED');
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st })).status, 409);
    assert.equal(h.sellerCalls(), 0, 'nothing reached the seller before verification');

    // ownership: wallet signature then DNS record
    const sig = await w.signMessage({ message: l.challenge.walletMessage });
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: st, body: { signature: sig } })).status, 200);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: st, body: { method: 'dns_txt' } })).status, 422, 'record not published yet');
    h.txtRecords.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
    const verified = await h.call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: st, body: { method: 'dns_txt' } });
    assert.equal(verified.body.listing.status, 'verified');

    // credential: write-only
    const cred = await h.call('POST', `/seller/listing/${l.id}/credential`, { bearer: st, body: { label: 'key', headerName: 'X-Api-Key', value: SELLER_SECRET } });
    assert.equal(cred.status, 201);
    assert.ok(!cred.text.includes(SELLER_SECRET));

    // test run: the seller's API echoes the key in a field -> it must come back redacted
    const test1 = await h.call('POST', `/seller/listing/${l.id}/test`, { bearer: st, body: { input: {} } });
    assert.equal(test1.body.report.httpStatus, 200);
    assert.ok(!test1.text.includes(SELLER_SECRET), 'credential redacted from the test report');

    // contract: suggest, propose, approve, publish
    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: st, body: { input: {} } });
    assert.equal(sug.status, 200, sug.text);
    assert.ok(!sug.text.includes(SELLER_SECRET));
    const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, { bearer: st, body: { contract: sug.body.suggestion } });
    assert.equal(prop.status, 201, prop.text);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st })).status, 400, 'proposed is not approved');
    assert.equal((await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, { bearer: st })).status, 200);
    const pub = await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st });
    assert.equal(pub.body.listing.status, 'published');

    // a buyer now uses it; the key reaches the seller only server-side
    const bt = await buyer(h);
    await h.call('POST', '/credits', { bearer: bt, body: { amount: '1' } });
    const pubView = await h.call('GET', `/listing/${l.id}`);
    assert.ok(!pubView.text.includes(SELLER_SECRET) && !pubView.text.includes('endpointUrl'), 'public listing view leaks neither credentials nor the raw endpoint');
    const run = await h.call('POST', '/execute', { bearer: bt, body: { listingId: l.id, input: {}, idempotencyKey: 'ui-key-seller-1' } });
    assert.equal(run.status, 201, run.text);
    assert.equal(run.body.result.charged, true);
    assert.ok(!run.text.includes(SELLER_SECRET), 'the buyer never sees the seller credential, even if the API echoes it');

    const earn = await h.call('GET', '/seller/earnings', { bearer: st });
    assert.equal(earn.body.earnings, '0.097'); // 0.10 minus 3%
    const mine = await h.call('GET', '/seller/listings', { bearer: st });
    assert.ok(!mine.text.includes(SELLER_SECRET));
    assert.equal(mine.body.listings[0].credentials[0].status, 'active');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });

    // another seller cannot see or touch it
    const other = (await seller(h)).token;
    assert.equal((await h.call('GET', `/seller/listing/${l.id}`, { bearer: other })).status, 404);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/unpublish`, { bearer: other })).status, 404);
    assert.equal((await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, { bearer: other })).status, 403);
  } finally {
    await h.close();
  }
});

test('the marketplace page is served with the token and the static allow-list still blocks everything else', async () => {
  const h = await start();
  try {
    const page = await fetch(h.base + '/market.html');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes('TEST CREDITS ONLY'));
    assert.ok(html.includes('content="test-token"'));
    assert.ok(!html.includes('__PAYRAIL_TOKEN__'));
    assert.equal((await fetch(h.base + '/market.js')).status, 200);
    assert.equal((await fetch(h.base + '/package.json')).status, 404);
    assert.equal((await fetch(h.base + '/..%2fsrc%2fvault.ts')).status, 404);
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ phase 2 over HTTP

test('agents over HTTP: owner creates a capped key; the agent runs without the page token; caps, allow-list and revocation hold', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    await h.call('POST', '/credits', { bearer: bt, body: { amount: '1' } });
    const cat = (await h.call('GET', '/catalog')).body.items as any[];
    const price = cat.find((i) => i.title.startsWith('Demo token price'));
    const echo = cat.find((i) => i.title === 'Demo text echo');
    const created = await h.call('POST', '/agents', { bearer: bt, body: { name: 'bot-one', perRequestCap: '0.03', dailyCap: '0.05', allowedListings: [price.id] } });
    assert.equal(created.status, 201, created.text);
    const key = created.body.key as string;
    const agentId = created.body.agent.id as string;

    // the agent calls with ONLY its key: no page token, no Origin
    const raw = async (path: string, body: unknown, bearer: string) => {
      const r = await fetch(h.base + '/api/market' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const ok = await raw('/agent/execute', { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'agent-http-01' }, key);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.result.charged, true);
    assert.equal((await raw('/agent/execute', { listingId: echo.id, input: { text: 'x' }, idempotencyKey: 'agent-http-02' }, key)).body.code, 'LISTING_NOT_ALLOWED');
    assert.equal((await raw('/agent/execute', { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'agent-http-03' }, key)).status, 201);
    assert.equal((await raw('/agent/execute', { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'agent-http-04' }, key)).body.code, 'DAILY_CAP');
    // an agent key cannot act as a buyer, and a made-up key is refused
    assert.equal((await h.call('GET', '/me', { bearer: key })).status, 401);
    assert.equal((await raw('/agent/execute', { listingId: price.id, input: {}, idempotencyKey: 'agent-http-05' }, 'pra_' + 'z'.repeat(43))).status, 401);
    // a cross-site browser request cannot use the token-free agent route
    const xo = await fetch(h.base + '/api/market/agent/execute', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', authorization: `Bearer ${key}` }, body: '{}' });
    assert.equal(xo.status, 403);

    const listed = await h.call('GET', '/agents', { bearer: bt });
    assert.equal(listed.body.agents[0].spentLast24h, '0.04');
    assert.ok(!listed.text.includes(key));
    assert.equal((await h.call('POST', `/agents/${agentId}/revoke`, { bearer: bt })).body.agent.status, 'revoked');
    assert.equal((await raw('/agent/execute', { listingId: price.id, input: { id: 'eth' }, idempotencyKey: 'agent-http-06' }, key)).status, 401);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('real-funds routes are closed in test mode and say why', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    assert.equal((await h.call('GET', '/funding', { bearer: bt })).body.enabled, false);
    const w = privateKeyToAccount(generatePrivateKey());
    const r = await h.call('POST', '/funding/wallet', { bearer: bt, body: { wallet: w.address, signature: '0x00' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'LIVE_DISABLED');
    const st = (await seller(h)).token;
    assert.equal((await h.call('POST', '/seller/payouts', { bearer: st, body: { amount: '1' } })).body.code, 'LIVE_DISABLED');
    const l = await h.call('POST', '/seller/listings', { bearer: st, body: { name: 'Real listing', endpointUrl: 'https://api.x.example/v1', price: '1', live: true } });
    assert.equal(l.body.code, 'LIVE_DISABLED');
  } finally {
    await h.close();
  }
});

test('real-funds mode over HTTP (fake chain): register wallet, confirm a deposit, spend it; payout request reserves earnings', async () => {
  const TOKEN = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
  const DEP = '0x00000000000000000000000000000000000dEaD1';
  const receipts = new Map<string, ChainReceipt>();
  const reader: ChainReader = { blockNumber: async () => 5_000n, receipt: async (hash) => receipts.get(hash.toLowerCase()) ?? null };
  const h = await start({
    funding: { chainId: 42220, token: TOKEN, asset: 'USDT', depositAddress: DEP, minConfirmations: 5, maxDepositAtomic: 10_000_000n, reader },
    payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: 10_000_000n },
  });
  try {
    const bt = await buyer(h);
    const w = privateKeyToAccount(generatePrivateKey());
    const buyerId = (await h.call('GET', '/me', { bearer: bt })).body.accountId as string;
    const info = await h.call('GET', '/funding', { bearer: bt });
    assert.equal(info.body.enabled, true);
    assert.equal(info.body.depositAddress, DEP);
    const reg = await h.call('POST', '/funding/wallet', { bearer: bt, body: { wallet: w.address, signature: await w.signMessage({ message: fundingMessage(buyerId, w.address) }) } });
    assert.equal(reg.status, 201, reg.text);

    const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
    const hash = `0x${'ab'.repeat(32)}`;
    receipts.set(hash, { status: 'success', blockNumber: 4_990n, logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC, pad(w.address), pad(DEP)], data: `0x${(1_000_000n).toString(16).padStart(64, '0')}`, logIndex: 2 }] });
    const c = await h.call('POST', '/funding/confirm', { bearer: bt, body: { txHash: hash } });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.body.credited[0].amount, '1');
    assert.equal((await h.call('POST', '/funding/confirm', { bearer: bt, body: { txHash: hash } })).body.credited[0].alreadyCredited, true);
    const me = await h.call('GET', '/me', { bearer: bt });
    assert.equal(me.body.live.available, '1');
    assert.equal(me.body.available, '0', 'test credits are separate');

    // a seller prices a real listing; the buyer pays real (ledger) USDT only for a qualifying answer
    const { w: sw, token: st } = await seller(h);
    const created = await h.call('POST', '/seller/listings', { bearer: st, body: { name: 'Real quote API', endpointUrl: 'https://api.sellerco.example/v1/quote', price: '0.5', live: true } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.listing.price.asset, 'USDT');
    const l = created.body.listing;
    await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: st, body: { signature: await sw.signMessage({ message: l.challenge.walletMessage }) } });
    h.txtRecords.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
    await h.call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: st, body: { method: 'dns_txt' } });
    await h.call('POST', `/seller/listing/${l.id}/credential`, { bearer: st, body: { label: 'key', headerName: 'X-Api-Key', value: SELLER_SECRET } });
    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: st, body: { input: {} } });
    const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, { bearer: st, body: { contract: sug.body.suggestion } });
    await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, { bearer: st });
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st })).body.listing.status, 'published');

    const run = await h.call('POST', '/execute', { bearer: bt, body: { listingId: l.id, input: {}, idempotencyKey: 'live-key-0001' } });
    assert.equal(run.body.result.charged, true, run.text);
    assert.equal(run.body.result.asset, 'USDT');
    assert.equal((await h.call('GET', '/me', { bearer: bt })).body.live.available, '0.5');

    const sme = await h.call('GET', '/me', { bearer: st });
    assert.equal(sme.body.live.earnings, '0.485');
    const pay = await h.call('POST', '/seller/payouts', { bearer: st, body: { amount: '0.4' } });
    assert.equal(pay.status, 201, pay.text);
    assert.equal(pay.body.payout.destination, sw.address.toLowerCase());
    assert.equal((await h.call('GET', '/me', { bearer: st })).body.live.earnings, '0.085');
    assert.equal((await h.call('POST', '/seller/payouts', { bearer: st, body: { amount: '0.4' } })).body.code, 'INSUFFICIENT_EARNINGS');
    assert.equal((await h.call('POST', `/seller/payouts/${pay.body.payout.id}/cancel`, { bearer: st })).body.payout.state, 'cancelled');
    assert.equal((await h.call('GET', '/me', { bearer: st })).body.live.earnings, '0.485');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});
