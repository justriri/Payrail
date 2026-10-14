// Web interface tests: the real HTTP server + the real planner/orchestrator, over the SIMULATED runtime.
// These prove the user journey and its failure states through the actual API the browser uses. They do NOT
// prove anything about real money or the real chain (that is verified separately, live, with approval).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeCatalog } from '../src/catalog.ts';
import { boundsFor, createWebServer, describeOrder, exampleBody, friendlyProblem, resolveService } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/websim.ts';
import type { SimScenario } from '../src/websim.ts';

interface Harness {
  base: string;
  token: string;
  server: Server;
  get(path: string): Promise<{ status: number; body: any; headers: Headers }>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  wait(orderId: string, until?: string[]): Promise<any>;
  close(): Promise<void>;
}

async function start(scenario: SimScenario = 'ok', startingBalances?: Record<string, bigint>): Promise<Harness> {
  const rt = createSimulatedRuntime({ scenario, delayMs: 15, ...(startingBalances ? { startingBalances } : {}) });
  const { server, token } = createWebServer(rt, { token: 'test-token' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const h: Harness = {
    base,
    token,
    server,
    async get(path) {
      const r = await fetch(base + path);
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* html or text */ }
      return { status: r.status, body, headers: r.headers };
    },
    async post(path, body, headers = {}) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token, ...headers }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
    async wait(orderId, until = ['completed', 'stopped', 'uncertain', 'refused']) {
      for (let i = 0; i < 200; i++) {
        const r = await h.get(`/api/order/${orderId}`);
        if (r.status === 200 && until.includes(r.body.stage)) return r.body;
        await new Promise((x) => setTimeout(x, 25));
      }
      throw new Error('order did not finish');
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  return h;
}

const URL_OK = 'https://gateway.usebuy.ai/v1/social/x/posts/search';
const BODY = JSON.stringify({ query: 'celo agents', type: 'latest' });

// ------------------------------------------------------------------ pure helpers
test('resolveService: catalog URL or id resolves; everything else is refused with a plain reason', () => {
  const cat = normalizeCatalog(
    {
      payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, tokens: [] },
      capabilities: [{ id: 'a.b', title: 't', method: 'POST', url: URL_OK, available: true, platform: 'x', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } }],
    },
    Date.now(),
  );
  assert.equal(resolveService(URL_OK, cat).ok, true);
  assert.equal(resolveService(URL_OK + '/', cat).ok, true, 'trailing slash');
  assert.equal(resolveService(URL_OK + '?x=1#y', cat).ok, true, 'query/hash ignored for identification');
  assert.equal(resolveService('a.b', cat).ok, true, 'catalog id');
  const bad = (s: string) => { const r = resolveService(s, cat); return r.ok ? 'ok' : r.problem.code; };
  assert.equal(bad(''), 'EMPTY');
  assert.equal(bad('not a url'), 'NOT_A_URL');
  assert.equal(bad('http://gateway.usebuy.ai/v1/social/x/posts/search'), 'NOT_HTTPS');
  assert.equal(bad('https://evil.example/api'), 'UNSUPPORTED_SERVICE');
  assert.equal(bad('https://gateway.usebuy.ai/v1/other'), 'UNSUPPORTED_SERVICE');
  const evil = resolveService('https://evil.example/api', cat);
  assert.match(evil.ok ? '' : evil.problem.message, /not a supported payment gateway/);
});

test('exampleBody: required fields get placeholders, optional fields only when a safe default exists; never invalid empties', () => {
  const schema = {
    type: 'object', required: ['query'],
    properties: { query: { type: 'string', minLength: 1 }, type: { type: 'string', enum: ['top', 'latest'], default: 'top' }, cursor: { type: 'string', minLength: 1 } },
  };
  assert.deepEqual(JSON.parse(exampleBody(schema)), { query: 'example', type: 'top' });
  assert.equal(exampleBody(undefined), '{}');
});

test('describeOrder: every state has an honest headline and a safe next action', () => {
  const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'm', conversion: undefined, payment: undefined, ...over }) as never;
  assert.equal(describeOrder(rec('COMPLETED'), undefined).stage, 'completed');
  const unc = describeOrder(rec('UNCERTAIN'), undefined);
  assert.equal(unc.stage, 'uncertain');
  assert.match(unc.nextAction, /DO NOT pay again/);
  assert.equal(unc.canResume, false);
  const stoppedConverted = describeOrder(rec('STOPPED', { conversion: { state: 'CONFIRMED' } }), undefined);
  assert.equal(stoppedConverted.canResume, true);
  assert.match(stoppedConverted.headline, /Converted, but the service was not paid/);
  const stoppedPlain = describeOrder(rec('STOPPED'), undefined);
  assert.equal(stoppedPlain.canResume, false);
  assert.match(stoppedPlain.headline, /Nothing was paid/);
  assert.equal(describeOrder(undefined, { status: 'finished', refused: { code: 'X', message: 'why' } }).stage, 'refused');
  assert.match(friendlyProblem('NO_ROUTE', 'raw').message, /No live conversion route/);
  assert.equal(friendlyProblem('SOMETHING_NEW', 'raw text').message, 'raw text');
  assert.equal(boundsFor({ payment: { funding: null, payment: null } } as never, 100, 5n), undefined);
});

// ------------------------------------------------------------------ the journey through the real HTTP API
test('status: simulated mode, wallet, balances, limits; the page is served with the token and a strict CSP', async () => {
  const h = await start();
  try {
    const s = await h.get('/api/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.mode, 'simulated');
    assert.equal(s.body.signing, true);
    assert.ok(s.body.balances.some((b: any) => b.symbol === 'cNGN' && b.amount === '1365.928991'));
    assert.equal(s.body.limits.perPaymentUsd, '$0.01');

    const page = await h.get('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /name="payrail-token" content="test-token"/);
    assert.match(page.body, /name="payrail-mode" content="simulated"/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal((await h.get('/app.js')).status, 200);
    assert.equal((await h.get('/..%2Fpackage.json')).status, 404);
    assert.equal((await h.get('/src/webapi.ts')).status, 404);
  } finally {
    await h.close();
  }
});

test('the frontend writes untrusted text only with textContent (no innerHTML / eval)', () => {
  const js = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js));
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  assert.ok(!/\sstyle=/.test(html), 'no inline styles (CSP)');
  assert.ok(!/private key|seed phrase|mnemonic/i.test(html.replace(/never asks for your private key/i, '')), 'the UI never asks for a key');
});

test('inspect (auto): holds USDT -> direct plan with funding options, numbers, and an approval digest', async () => {
  const h = await start();
  try {
    const r = await h.post('/api/inspect', { url: URL_OK, body: BODY });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = r.body;
    assert.equal(v.route, 'direct');
    assert.equal(v.status, 'READY');
    assert.equal(v.canApprove, true);
    assert.equal(v.price.symbol, 'USDT');
    assert.equal(v.price.amount, '0.005');
    assert.equal(v.payTo, '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B');
    assert.equal(v.conversion, null);
    const symbols = v.fundingOptions.map((o: any) => `${o.symbol}:${o.kind}:${o.selected}`);
    assert.ok(symbols.includes('USDT:direct:true'), symbols.join(','));
    assert.ok(symbols.includes('cNGN:convert:false'), symbols.join(','));
    assert.match(v.terms.digest, /^[0-9a-f]{64}$/);
  } finally {
    await h.close();
  }
});

test('inspect (pay with cNGN): shows the conversion rate, fee, expected output, limits and max spend', async () => {
  const h = await start();
  try {
    const r = await h.post('/api/inspect', { url: URL_OK, body: BODY, source: 'cNGN' });
    const v = r.body;
    assert.equal(r.status, 200, JSON.stringify(v));
    assert.equal(v.route, 'swap');
    assert.equal(v.canApprove, true);
    assert.equal(v.conversion.sellSymbol, 'cNGN');
    assert.equal(v.conversion.receiveSymbol, 'USDT');
    assert.equal(v.conversion.sell, '1363.578');
    assert.equal(v.conversion.receive, '0.998869');
    assert.match(v.conversion.rate, /1 cNGN ≈ 0\.0007325 USDT/);
    assert.match(v.conversion.fee, /cNGN$/);
    assert.equal(v.conversion.isPreview, true);
    assert.equal(v.conversion.keptAfterPaying, '0.993869 USDT');
    assert.ok(v.costs.gasCelo, 'gas estimate is shown');
    assert.equal(v.approval.required, true, 'swaps need approval by policy');
    // hard bounds the user approves: a little above the quoted sell, never above the balance
    assert.equal(BigInt(v.terms.maxSellAtomic) > 1_363_578_000n, true);
    assert.equal(BigInt(v.terms.maxSellAtomic) <= 1_365_928_991n, true);
    assert.equal(BigInt(v.terms.minReceiveAtomic) >= 5_000n, true);
    assert.equal(v.steps.length, 2);
  } finally {
    await h.close();
  }
});

test('inspect: unsupported services, bad input and unaffordable choices give clear, specific messages', async () => {
  const h = await start('ok', { cNGN: 100_000_000n, USDT: 0n });
  try {
    const bad = await h.post('/api/inspect', { url: 'https://evil.example/pay' });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.problems[0].code, 'UNSUPPORTED_SERVICE');

    const notJson = await h.post('/api/inspect', { url: URL_OK, body: '{nope' });
    assert.equal(notJson.body.problems[0].code, 'BAD_JSON');

    // only 100 cNGN held: below the corridor minimum, and no USDT -> blocked with a reason, nothing to approve
    const poor = await h.post('/api/inspect', { url: URL_OK, body: BODY });
    assert.equal(poor.status, 200);
    assert.equal(poor.body.status, 'BLOCKED');
    assert.equal(poor.body.canApprove, false);
    assert.ok(poor.body.problems.length > 0);

    const wrongSource = await h.post('/api/inspect', { url: URL_OK, body: BODY, source: 'DOGE' });
    assert.equal(wrongSource.body.problems.some((p: any) => p.code === 'SOURCE_NOT_SUPPORTED'), true);

    const missing = await h.post('/api/inspect', {});
    assert.equal(missing.status, 400);
  } finally {
    await h.close();
  }
});

test('the browser journey, convert then pay: approve -> converting -> paid -> response shown -> balances changed', async () => {
  const h = await start();
  try {
    const before = (await h.get('/api/status')).body.balances.find((b: any) => b.symbol === 'cNGN').amount;
    const insp = (await h.post('/api/inspect', { url: URL_OK, body: BODY, source: 'cNGN' })).body;
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest, maxSellAtomic: insp.terms.maxSellAtomic, minReceiveAtomic: insp.terms.minReceiveAtomic });
    assert.equal(ap.status, 202, JSON.stringify(ap.body));
    const done = await h.wait(ap.body.orderId);
    assert.equal(done.stage, 'completed', JSON.stringify(done));
    assert.equal(done.mode, 'simulated');
    assert.equal(done.conversion.state, 'CONFIRMED');
    assert.equal(done.conversion.txs.length, 2, 'approve + swap');
    assert.equal(done.payment.status, 'CONFIRMED');
    assert.equal(done.payment.delivered, true);
    assert.equal(done.hasResponse, true);

    const resp = await h.get(`/api/order/${ap.body.orderId}/response`);
    assert.equal(resp.status, 200);
    assert.match(resp.body.text, /"simulated": true/);
    assert.equal(resp.body.truncated, false);

    const after = (await h.get('/api/status')).body.balances.find((b: any) => b.symbol === 'cNGN').amount;
    assert.notEqual(after, before, 'the conversion changed the cNGN balance');

    // single-use: the same plan cannot be approved twice
    const again = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest, maxSellAtomic: insp.terms.maxSellAtomic, minReceiveAtomic: insp.terms.minReceiveAtomic });
    assert.equal(again.status, 409);
    assert.equal(again.body.problems[0].code, 'PLAN_USED');
  } finally {
    await h.close();
  }
});

test('the browser journey, direct pay: no conversion, response delivered', async () => {
  const h = await start();
  try {
    const insp = (await h.post('/api/inspect', { url: URL_OK, body: BODY })).body;
    assert.equal(insp.route, 'direct');
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest });
    assert.equal(ap.status, 202, JSON.stringify(ap.body));
    const done = await h.wait(ap.body.orderId);
    assert.equal(done.stage, 'completed');
    assert.equal(done.conversion, null);
    assert.equal(done.hasResponse, true);
  } finally {
    await h.close();
  }
});

test('approval is bound to what the user saw: changed price asks again; a quote outside the approved limits is refused', async () => {
  const h = await start('price_rises');
  try {
    const insp = (await h.post('/api/inspect', { url: URL_OK, body: BODY })).body;
    assert.equal(insp.price.amount, '0.005');
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest });
    assert.equal(ap.status, 409);
    assert.equal(ap.body.problems[0].code, 'TERMS_CHANGED');
    assert.equal(ap.body.replan.price.amount, '0.009', 'the user is shown the new price before anything runs');
    // approving the NEW terms works
    const ap2 = await h.post('/api/approve', { planId: ap.body.replan.planId, termsDigest: ap.body.replan.terms.digest });
    assert.equal(ap2.status, 202, JSON.stringify(ap2.body));
    assert.equal((await h.wait(ap2.body.orderId)).stage, 'completed');
  } finally {
    await h.close();
  }
  const h2 = await start();
  try {
    const insp = (await h2.post('/api/inspect', { url: URL_OK, body: BODY, source: 'cNGN' })).body;
    // pretend the user approved a limit far below the real sell amount
    const tooLow = await h2.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest, maxSellAtomic: '1000000', minReceiveAtomic: insp.terms.minReceiveAtomic });
    assert.equal(tooLow.status, 409);
    assert.equal(tooLow.body.problems[0].code, 'QUOTE_MOVED');
    const noBounds = await h2.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest });
    assert.equal(noBounds.status, 400, 'a conversion cannot be approved without the limits the user reviewed');
  } finally {
    await h2.close();
  }
});

test('failure: the conversion is declined -> stopped, nothing paid, no response, clear wording', async () => {
  const h = await start('swap_fails');
  try {
    const insp = (await h.post('/api/inspect', { url: URL_OK, body: BODY, source: 'cNGN' })).body;
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest, maxSellAtomic: insp.terms.maxSellAtomic, minReceiveAtomic: insp.terms.minReceiveAtomic });
    const done = await h.wait(ap.body.orderId);
    assert.equal(done.stage, 'stopped');
    assert.match(done.headline, /Nothing was paid/);
    assert.equal(done.payment, null);
    assert.equal(done.hasResponse, false);
    assert.equal(done.canResume, false);
    assert.equal((await h.get(`/api/order/${ap.body.orderId}/response`)).status, 404);
  } finally {
    await h.close();
  }
});

test('uncertain payment: the UI is told NOT to pay again, no response is shown, and a status check keeps it uncertain', async () => {
  const h = await start('payment_uncertain');
  try {
    const insp = (await h.post('/api/inspect', { url: URL_OK, body: BODY })).body;
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest });
    const done = await h.wait(ap.body.orderId);
    assert.equal(done.stage, 'uncertain');
    assert.match(done.nextAction, /DO NOT pay again/);
    assert.equal(done.hasResponse, false);
    assert.equal(done.canResume, false);
    assert.equal((await h.get(`/api/order/${ap.body.orderId}/response`)).status, 404);
    const checked = await h.post(`/api/order/${ap.body.orderId}/check`, {});
    assert.equal(checked.status, 200);
    assert.equal(checked.body.stage, 'uncertain', 'a status check never turns uncertainty into success');
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ local-only server security
test('security: wrong Host, cross-site Origin, missing/wrong token and oversize bodies are refused', async () => {
  const h = await start();
  try {
    const noToken = await fetch(h.base + '/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: URL_OK }) });
    assert.equal(noToken.status, 403);
    const wrongToken = await h.post('/api/inspect', { url: URL_OK }, { 'x-payrail-token': 'nope' });
    assert.equal(wrongToken.status, 403);
    const crossSite = await h.post('/api/inspect', { url: URL_OK }, { origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.problems[0].code, 'BAD_ORIGIN');

    const port = new URL(h.base).port;
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port: Number(port), path: '/api/status', headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    assert.equal(status, 421, 'DNS-rebinding style Host header is refused');

    const big = await fetch(h.base + '/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': h.token }, body: JSON.stringify({ url: URL_OK, body: 'x'.repeat(100_000) }) }).catch(() => undefined);
    assert.ok(big === undefined || big.status === 400, 'oversize body is rejected');
    // no secret-like fields anywhere in the status answer
    const s = JSON.stringify((await h.get('/api/status')).body);
    assert.ok(!/privateKey|PRIVATE_KEY|mnemonic|seed/i.test(s));
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ browsing the catalog
test('catalog: the list returns normalized services with a policy verdict; filters, search and paging work', async () => {
  const h = await start();
  try {
    const all = await h.get('/api/catalog');
    assert.equal(all.status, 200);
    assert.equal(all.body.ok, true);
    assert.equal(all.body.source, 'buy-gateway');
    assert.equal(all.body.total, 4);
    assert.equal(all.body.matched, 4);
    assert.deepEqual(all.body.platforms.map((p: any) => p.platform).sort(), ['flights', 'instagram', 'reddit', 'x']);
    const byId = Object.fromEntries(all.body.items.map((i: any) => [i.id, i]));
    assert.equal(byId['x.posts.search'].verdict.autoPay, true);
    assert.equal(byId['x.posts.search'].verdict.withinLimit, true);
    assert.equal(byId['x.posts.search'].price.usd, '0.005');
    assert.equal(byId['x.posts.search'].price.variable, false, 'a single listed price is not "variable"');
    assert.equal(byId['instagram.profile'].verdict.autoPay, false, 'listed and affordable, but needs approval each time');
    assert.equal(byId['flights.search'].verdict.withinLimit, false, 'above the per-payment limit');
    assert.equal(byId['reddit.posts.search'].available, false);
    assert.equal(byId['x.posts.search'].url, URL_OK, 'the card can hand its URL straight to inspect');

    const avail = await h.get('/api/catalog?available=1');
    assert.equal(avail.body.matched, 3);
    const within = await h.get('/api/catalog?within=1&available=1');
    assert.deepEqual(within.body.items.map((i: any) => i.id).sort(), ['instagram.profile', 'x.posts.search']);
    const plat = await h.get('/api/catalog?platform=flights');
    assert.deepEqual(plat.body.items.map((i: any) => i.id), ['flights.search']);
    const q = await h.get('/api/catalog?q=instagram');
    assert.deepEqual(q.body.items.map((i: any) => i.id), ['instagram.profile']);
    const none = await h.get('/api/catalog?q=zzzz-nothing');
    assert.equal(none.body.matched, 0);
    assert.deepEqual(none.body.items, []);
    const page = await h.get('/api/catalog?limit=2&offset=2');
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.matched, 4);
    assert.equal((await h.get('/api/catalog?limit=999999')).body.limit, 200, 'page size is capped');
  } finally {
    await h.close();
  }
});

test('catalog: a failing catalog is a clear error (502), a cached copy is flagged stale, and the rest of the app still works', async () => {
  const base = createSimulatedRuntime({ delayMs: 5 });
  let mode: 'ok' | 'stale' | 'down' = 'down';
  const rt = {
    ...base,
    catalog: async () => {
      if (mode === 'down') throw new Error('catalog HTTP 500');
      const c = await base.catalog();
      return mode === 'stale' ? { ...c, stale: true } : c;
    },
  };
  const { server, token } = createWebServer(rt, { token: 'test-token' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  void token;
  try {
    const down = await fetch(url + '/api/catalog');
    const d: any = await down.json();
    assert.equal(down.status, 502);
    assert.equal(d.ok, false);
    assert.equal(d.problems[0].code, 'CATALOG_UNAVAILABLE');
    assert.match(d.problems[0].message, /could not be loaded/);
    assert.equal((await fetch(url + '/api/status')).status, 200, 'wallet and status are unaffected');

    mode = 'stale';
    const stale: any = await (await fetch(url + '/api/catalog')).json();
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.items.length, 4);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('catalog UI: the page has the browse card with search, filters, loading/empty/error/retry states and a "use this service" action', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  const js = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
  for (const id of ['browse-card', 'q', 'platform', 'f-available', 'f-within', 'browse-status', 'browse-error', 'browse-list', 'browse-more', 'browse-retry']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  assert.match(js, /\/api\/catalog\?/);
  assert.match(js, /Loading services/);
  assert.match(js, /No services match your filters/);
  assert.match(js, /may be out of date/);
  assert.match(js, /Use this service/);
  assert.match(js, /Above your per-payment limit/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(js), 'service text is never parsed as HTML');
  assert.match(js, /loadCatalog\(true\);/, 'the catalog loads when the page opens');
});

test('catalog -> purchase: a card hands its URL to inspect, and the existing approve/pay flow completes (simulated)', async () => {
  const h = await start();
  try {
    const card = (await h.get('/api/catalog?q=x.posts')).body.items[0];
    const insp = (await h.post('/api/inspect', { url: card.url })).body; // exactly what the card's button does
    assert.equal(insp.service.id, card.id);
    assert.equal(insp.canApprove, true);
    const ap = await h.post('/api/approve', { planId: insp.planId, termsDigest: insp.terms.digest });
    assert.equal(ap.status, 202);
    assert.equal((await h.wait(ap.body.orderId)).stage, 'completed');
  } finally {
    await h.close();
  }
});
