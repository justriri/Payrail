// Local development of the GitHub verification: the callback address, its validation, the OAuth requests GitHub receives, and the guarantees that
// local settings never loosen production's. GitHub is a FAKE fetch here: nothing reaches the network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { validateDestination } from '../src/egress.ts';
import { GITHUB_CALLBACK_PATH, createGitHubApi, githubRedirectUri } from '../src/github.ts';
import { SetupError, setupMarket } from '../src/marketsetup.ts';
import type { SetupDeps } from '../src/marketsetup.ts';
import { createWebServer } from '../src/webapi.ts';

const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const dir = mkdtempSync(join(tmpdir(), 'payrail-ghlocal-'));
let n = 0;
const LOCAL = 'http://127.0.0.1:4402';
const CALLBACK = `${LOCAL}${GITHUB_CALLBACK_PATH}`;

function deps(env: Record<string, string | undefined>, over: Partial<SetupDeps> = {}): SetupDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    env: { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1', PAYRAIL_DEPOSIT_CONFIRMATIONS: '3', ...env },
    dbPath: join(dir, `g${++n}.db`), configuredChainId: 42220, attributionTag: 'celo_b2fff2ac9413', readChainId: async () => 42220,
    makeReader: () => ({ blockNumber: async () => 5_000n, receipt: async () => null }), readAllowance: async () => 0n,
    buyCatalog: async () => ({ services: [], stale: false }) as never, log: (l: string) => logs.push(l), ...over, logs,
  };
}
const GH = { PAYRAIL_GITHUB_CLIENT_ID: 'Iv1.localclientid', PAYRAIL_GITHUB_CLIENT_SECRET: 'local-secret-value-not-real', PAYRAIL_PUBLIC_URL: LOCAL };

test('the callback is the configured origin plus a fixed path, and the registered address is exactly what Payrail sends', () => {
  assert.equal(githubRedirectUri(LOCAL).redirectUri, 'http://127.0.0.1:4402/api/market/github/callback');
  assert.equal(githubRedirectUri(`${LOCAL}/`).redirectUri, CALLBACK, 'a trailing slash is tolerated');
  assert.equal(githubRedirectUri('http://[::1]:4402').redirectUri, 'http://[::1]:4402/api/market/github/callback');
  assert.equal(githubRedirectUri('https://payrail.example.com').redirectUri, 'https://payrail.example.com/api/market/github/callback');
  assert.equal(githubRedirectUri('https://payrail.example.com').local, false);
  assert.equal(githubRedirectUri(LOCAL).local, true);
});

test('http is accepted ONLY for a loopback address; everything else must be https, and nothing but an origin is allowed', () => {
  for (const bad of ['http://payrail.example.com', 'http://192.168.1.20:4402', 'http://10.0.0.5', 'ftp://127.0.0.1', 'payrail.example.com', '', 'http://127.0.0.1.evil.example']) {
    assert.throws(() => githubRedirectUri(bad), /PAYRAIL_PUBLIC_URL/, bad || '(empty)');
  }
  for (const bad of ['https://payrail.example.com/app', 'https://payrail.example.com/?x=1', 'https://payrail.example.com/#a', 'https://user:pw@payrail.example.com', `${LOCAL}/some/path`]) {
    assert.throws(() => githubRedirectUri(bad), /no path, query, fragment or credentials/, bad);
  }
  assert.match(githubRedirectUri('http://localhost:4402').warning!, /127\.0\.0\.1/, 'localhost works but is discouraged');
});

test('the OAuth requests carry that exact redirect_uri and NO scope; the client secret only travels in the server-side token exchange', async () => {
  const seen: Array<{ url: string; method: string; body?: any }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (String(url).startsWith('https://github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_abcdefghijklmnop' }), { status: 200 });
    return new Response(JSON.stringify({ id: 1001, login: 'alice' }), { status: 200 });
  }) as never;
  const api = createGitHubApi({ clientId: 'Iv1.localclientid', clientSecret: 'local-secret-value-not-real', redirectUri: CALLBACK, fetchImpl: f });
  const u = new URL(api.authorizeUrl('STATE123'));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(u.searchParams.get('client_id'), 'Iv1.localclientid');
  assert.equal(u.searchParams.get('state'), 'STATE123');
  assert.equal(u.searchParams.has('scope'), false);
  assert.ok(!u.toString().includes('local-secret-value-not-real'), 'the secret never appears in the browser address');
  const token = await api.exchangeCode('thecode');
  assert.equal(token, 'gho_abcdefghijklmnop');
  const ex = seen.find((s) => s.url.includes('access_token'))!;
  assert.equal(ex.method, 'POST');
  assert.equal(ex.body.redirect_uri, CALLBACK);
  assert.equal(ex.body.client_secret, 'local-secret-value-not-real');
  await api.user(token);
  assert.ok(seen.every((s) => s.url.startsWith('https://github.com/login/oauth/') || s.url.startsWith('https://api.github.com/')), 'only GitHub is ever contacted');
});

test('startup: local settings enable the flow and print the exact callback to register; partial or invalid settings never half-enable it', async () => {
  const d = deps(GH);
  const rt = (await setupMarket(d))!;
  assert.ok(rt.github, 'GitHub verification is on');
  assert.match(d.logs.join('\n'), /GITHUB VERIFICATION ENABLED[^\n]*LOCAL DEVELOPMENT callback to register in the GitHub OAuth App: http:\/\/127\.0\.0\.1:4402\/api\/market\/github\/callback/);
  assert.ok(!d.logs.join('\n').includes('local-secret-value-not-real'), 'the secret is never logged');
  // a production address is labelled as such
  const p = deps({ ...GH, PAYRAIL_PUBLIC_URL: 'https://payrail.example.com' });
  assert.ok((await setupMarket(p))!.github);
  assert.match(p.logs.join('\n'), /Public callback to register[^\n]*https:\/\/payrail\.example\.com\/api\/market\/github\/callback/);
  // nothing set: off, silently (DNS and the well-known file are unaffected)
  const none = deps({});
  assert.equal((await setupMarket(none))!.github, undefined);
  // partially set: off, with an explanation
  const part = deps({ PAYRAIL_GITHUB_CLIENT_ID: 'x', PAYRAIL_PUBLIC_URL: LOCAL });
  assert.equal((await setupMarket(part))!.github, undefined);
  assert.match(part.logs.join('\n'), /GitHub verification is OFF: set all of/);
  // invalid public address: the server refuses to start instead of sending sellers to an unsafe callback
  await assert.rejects(() => setupMarket(deps({ ...GH, PAYRAIL_PUBLIC_URL: 'http://payrail.example.com' })), (e: unknown) => e instanceof SetupError && /must be https/.test(e.message));
  await assert.rejects(() => setupMarket(deps({ ...GH, PAYRAIL_PUBLIC_URL: 'https://payrail.example.com/x' })), (e: unknown) => e instanceof SetupError && /no path/.test(e.message));
});

test('end to end on the local address: connect -> GitHub returns to 127.0.0.1:4402/... -> the seller is connected; the state is enforced and the secret stays server-side', async () => {
  const exchanged: Array<{ redirect_uri: string; client_id: string; code: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://github.com/login/oauth/access_token')) {
      const b = JSON.parse(String(init?.body));
      exchanged.push({ redirect_uri: b.redirect_uri, client_id: b.client_id, code: b.code });
      return new Response(JSON.stringify(b.code === 'good-code' ? { access_token: 'gho_localtoken0123456789' } : { error: 'bad_verification_code' }), { status: 200 });
    }
    if (u === 'https://api.github.com/user') return new Response(JSON.stringify({ id: 1001, login: 'alice' }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as never;
  const rt = (await setupMarket(deps(GH, { githubFetch: f })))!;
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'ghl', market: rt, environment: 'production' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, bearer?: string) => (await fetch(base + '/api/market' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    const w = privateKeyToAccount(generatePrivateKey());
    const st = await post('/seller/login/start', { wallet: w.address, chainId: 42220 });
    const c = await post('/seller/login/complete', { wallet: w.address, nonce: st.nonce, signature: await w.signMessage({ message: st.message }) });
    const conn = await post('/github/connect', {}, c.token);
    const auth = new URL(conn.url);
    assert.equal(auth.searchParams.get('redirect_uri'), CALLBACK, 'the address GitHub will return to is the local one');
    assert.equal(auth.searchParams.has('scope'), false);
    assert.ok(!conn.url.includes('local-secret-value-not-real'));
    const state = auth.searchParams.get('state')!;
    // an unknown state is refused and nothing is exchanged
    const forged = await fetch(`${base}/api/market/github/callback?code=good-code&state=forged`, { redirect: 'manual' });
    assert.match(forged.headers.get('location')!, /github=expired/);
    assert.equal(exchanged.length, 0, 'no code is exchanged for an unknown state');
    // the genuine return
    const back = await fetch(`${base}/api/market/github/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/market.html?github=connected#/seller', 'the browser is sent back to the same local server');
    assert.deepEqual(exchanged, [{ redirect_uri: CALLBACK, client_id: 'Iv1.localclientid', code: 'good-code' }]);
    const status = await (await fetch(base + '/api/market/github/status', { headers: { authorization: `Bearer ${c.token}` } })).json() as any;
    assert.equal(status.login, 'alice');
    assert.ok(!JSON.stringify(status).includes('gho_localtoken'));
    // the state cannot be replayed
    const replay = await fetch(`${base}/api/market/github/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    assert.match(replay.headers.get('location')!, /github=expired/);
    assert.equal(exchanged.length, 1);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('a LOCAL test API cannot be listed (by design): loopback and IP addresses stay blocked, so the endpoint must be a public https host such as Render', () => {
  for (const url of ['http://127.0.0.1:3000/api/hello', 'https://127.0.0.1/api/hello', 'https://localhost/api/hello', 'https://127.0.0.1:3000/api/hello', 'https://192.168.1.10/api/hello']) {
    assert.throws(() => validateDestination(url), /./, url);
  }
  assert.doesNotThrow(() => validateDestination('https://payrail-test-apipayrail-test-api.onrender.com/api/hello'));
});

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } });
