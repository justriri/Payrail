// GitHub-based ownership proof, through the real HTTP routes and modules. GitHub and the seller's deployed host are FAKES (an in-memory GitHub API and a
// scripted transport): nothing here reaches the network, and none of it proves anything about the real GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openDb } from '../src/db.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';
import { RateLimiter } from '../src/egress.ts';
import type { Resolver, Transport } from '../src/egress.ts';
import { GitHubError, openToken, parseRepoUrl, sealToken } from '../src/github.ts';
import type { GhRepo, GitHubApi } from '../src/github.ts';
import { createGitHubVerification } from '../src/githubproof.ts';
import type { MarketRuntime } from '../src/market.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';

const mk = generateMasterKey('k1');
const PROOF_PATH = '.well-known/payrail-verification.txt';
const HOST = 'api.sellerco.example';

/** an in-memory GitHub: users by authorization code, repositories with per-user permissions and files */
function fakeGitHub() {
  const state = {
    codes: new Map<string, { id: number; login: string }>(),
    repos: new Map<string, { id: number; defaultBranch: string; isPrivate: boolean; archived: boolean; perms: Record<string, { push: boolean; admin?: boolean }>; files: Map<string, string> }>(),
    down: false,
    calls: [] as string[],
    authorizeUrls: [] as string[],
  };
  const tokenUser = (t: string) => [...state.codes.values()].find((u) => `tok_${u.login}_0000000000` === t);
  const api: GitHubApi = {
    authorizeUrl(s) { const u = `https://github.com/login/oauth/authorize?client_id=test&state=${s}&allow_signup=false`; state.authorizeUrls.push(u); return u; },
    async exchangeCode(code) {
      const u = state.codes.get(code);
      if (!u) throw new GitHubError('BAD_CODE', 'GitHub did not accept the authorization code');
      return `tok_${u.login}_0000000000`;
    },
    async user(t) { const u = tokenUser(t); if (!u) throw new GitHubError('TOKEN_REJECTED', 'rejected'); return u; },
    async repo(t, owner, name): Promise<GhRepo | null> {
      state.calls.push(`repo ${owner}/${name}`);
      if (state.down) throw new GitHubError('UNAVAILABLE', 'GitHub could not be reached');
      const u = tokenUser(t);
      const r = state.repos.get(`${owner}/${name}`.toLowerCase());
      if (!u || !r || (r.isPrivate && !r.perms[u.login])) return null;
      const p = r.perms[u.login];
      return { id: r.id, fullName: `${owner}/${name}`, defaultBranch: r.defaultBranch, isPrivate: r.isPrivate, archived: r.archived, fork: false,
        permissions: { admin: Boolean(p?.admin), maintain: false, push: Boolean(p?.push), pull: true } };
    },
    async file(_t, owner, name, path) {
      if (state.down) throw new GitHubError('UNAVAILABLE', 'GitHub could not be reached');
      const r = state.repos.get(`${owner}/${name}`.toLowerCase());
      const c = r?.files.get(path);
      return c === undefined ? null : { content: c, sha: 'blobsha1234567890' };
    },
  };
  return { api, state };
}

async function start() {
  const db = openDb(':memory:');
  const gh = fakeGitHub();
  const host = { proof: undefined as string | undefined, endpointStatus: 200, endpointBody: '{"message":"hi","asOf":"2026-10-21T00:00:00Z"}', endpointType: 'application/json', dnsDown: false, calls: 0, asleep: 0 };
  const resolver: Resolver = async () => { if (host.dnsDown) throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); return [{ address: '93.184.216.34', family: 4 }]; };
  const transport: Transport = async (r) => {
    host.calls++;
    if (host.asleep > 0) { host.asleep--; return new Promise<never>(() => {}); } // a sleeping free host: the connection just hangs
    if (r.path === `/${PROOF_PATH}`) return host.proof === undefined ? { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') } : { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(host.proof) };
    return { status: host.endpointStatus, headers: { 'content-type': host.endpointType }, body: Buffer.from(host.endpointBody) };
  };
  const fetchOptions = { resolver, transport };
  const github = createGitHubVerification({ db, keys: [mk], api: gh.api, fetchOptions, wake: [100, 100, 100] });
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, github,
    execute: { call: { limiter: new RateLimiter(100, 100), fetchOptions } }, testCall: { limiter: new RateLimiter(100, 100), fetchOptions },
    domain: { txt: async () => [], fetchOptions },
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'gh-test', market, environment: 'production' });
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
  const raw = (path: string) => fetch(base + path, { redirect: 'manual' });
  return { db, gh, host, github, call, raw, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;

async function seller(h: H, login: string, githubId: number) {
  const w = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address, chainId: 42220 } });
  const c = await h.call('POST', '/seller/login/complete', { body: { wallet: w.address, nonce: s.body.nonce, signature: await w.signMessage({ message: s.body.message }) } });
  h.gh.state.codes.set(`code-${login}`, { id: githubId, login });
  return { token: c.body.token as string, id: c.body.accountId as string, wallet: w, login };
}
async function connect(h: H, s: Awaited<ReturnType<typeof seller>>) {
  const c = await h.call('POST', '/github/connect', { bearer: s.token });
  const state = new URL(c.body.url).searchParams.get('state')!;
  const back = await h.raw(`/api/market/github/callback?code=code-${s.login}&state=${state}`);
  return { state, back };
}
const draft = async (h: H, s: Awaited<ReturnType<typeof seller>>, url = `https://${HOST}/api/hello`) => {
  const r = await h.call('POST', '/seller/listings', { bearer: s.token, body: { name: 'GitHub API', endpointUrl: url, price: '0.02' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.listing as { id: string; challenge: { token: string; walletMessage: string } };
};
const addRepo = (h: H, full: string, o: { id: number; perms: Record<string, { push: boolean; admin?: boolean }>; file?: string; isPrivate?: boolean; archived?: boolean }) =>
  h.gh.state.repos.set(full.toLowerCase(), { id: o.id, defaultBranch: 'main', isPrivate: o.isPrivate ?? false, archived: o.archived ?? false, perms: o.perms, files: new Map(o.file === undefined ? [] : [[PROOF_PATH, o.file]]) });
const value = (l: { challenge: { token: string } }) => `payrail-verify=${l.challenge.token}`;
const REPO = 'https://github.com/alice/payrail-test-api';

test('repository URL parsing is strict: only https://github.com/owner/name; names, READMEs and other hosts prove nothing', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/alice/payrail-test-api'), { owner: 'alice', name: 'payrail-test-api' });
  assert.deepEqual(parseRepoUrl('https://github.com/alice/payrail-test-api.git/'), { owner: 'alice', name: 'payrail-test-api' });
  for (const bad of ['alice/payrail-test-api', 'http://github.com/alice/x', 'https://gitlab.com/alice/x', 'https://github.com.evil.example/alice/x', 'https://github.com/alice', 'https://github.com/alice/x/tree/main', 'https://github.com/alice/x?tab=readme', 'https://github.com/-bad/x', 'https://github.com/alice/..', 'https://user@github.com/alice/x', '@alice', '']) {
    assert.equal(parseRepoUrl(bad), undefined, bad);
  }
});

test('connect: the OAuth state is one-time, expiring and bound to the seller; no scopes; the token is sealed and never returned', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    const { state, back } = await connect(h, a);
    assert.equal(back.status, 302);
    assert.match(back.headers.get('location')!, /github=connected/);
    assert.ok(!/scope=/.test(h.gh.state.authorizeUrls[0]!), 'no scope is requested');
    const st = (await h.call('GET', '/github/status', { bearer: a.token })).body;
    assert.deepEqual({ configured: st.configured, connected: st.connected, login: st.login }, { configured: true, connected: true, login: 'alice' });
    assert.ok(!JSON.stringify(st).includes('tok_alice'), 'the status never carries the token');
    // sealed at rest: the stored value is not the token, and only the right account can open it
    const row = h.db.prepare('SELECT token_sealed FROM github_connections WHERE account_id = ?').get(a.id) as { token_sealed: string };
    assert.ok(!row.token_sealed.includes('tok_alice'));
    assert.equal(openToken([mk], a.id, row.token_sealed), 'tok_alice_0000000000');
    assert.equal(openToken([mk], 'someone-else', row.token_sealed), undefined);
    assert.equal(openToken([generateMasterKey('k1')], a.id, row.token_sealed), undefined, 'another master key cannot open it');
    assert.ok(sealToken(mk, 'x', 'y') !== sealToken(mk, 'x', 'y'), 'fresh iv each time');
    // the same state cannot be replayed, and an unknown or expired one is refused
    const replay = await h.raw(`/api/market/github/callback?code=code-alice&state=${state}`);
    assert.match(replay.headers.get('location')!, /github=expired/);
    assert.match((await h.raw('/api/market/github/callback?code=x&state=nope')).headers.get('location')!, /github=expired/);
    assert.match((await h.raw('/api/market/github/callback?error=access_denied')).headers.get('location')!, /github=denied/);
    const c2 = await h.call('POST', '/github/connect', { bearer: a.token });
    const s2 = new URL(c2.body.url).searchParams.get('state')!;
    h.db.prepare('UPDATE github_oauth_states SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    assert.match((await h.raw(`/api/market/github/callback?code=code-alice&state=${s2}`)).headers.get('location')!, /github=expired/);
    // a bearer is required to start and to read
    assert.equal((await h.call('POST', '/github/connect')).body.code, 'SESSION_INVALID');
    // disconnecting removes the stored token
    await h.call('POST', '/github/disconnect', { bearer: a.token });
    assert.equal((await h.call('GET', '/github/status', { bearer: a.token })).body.connected, false);
    assert.equal(Number((h.db.prepare('SELECT COUNT(*) AS n FROM github_connections').get() as { n: number | bigint }).n), 0);
  } finally { await h.close(); }
});

test('the state decides the seller: a code obtained by someone else cannot connect that GitHub account to another seller', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    const b = await seller(h, 'bob', 1002);
    const ca = await h.call('POST', '/github/connect', { bearer: a.token });
    const stateA = new URL(ca.body.url).searchParams.get('state')!;
    // bob's browser finishes with alice's state but bob's GitHub code: the connection lands on the account that STARTED the flow (alice), never on bob's session
    await h.raw(`/api/market/github/callback?code=code-bob&state=${stateA}`);
    assert.equal((await h.call('GET', '/github/status', { bearer: b.token })).body.connected, false);
  } finally { await h.close(); }
});

test('authorized repository + proof file committed + deployed host serves it + endpoint answers: ALL five checks pass and the listing proceeds without DNS or Render settings', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } } });
    const st = await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.proofFile.path, PROOF_PATH);
    assert.equal(st.body.proofFile.content, value(l));
    assert.match(st.body.proofFile.createUrl, /^https:\/\/github\.com\/alice\/payrail-test-api\/new\/main\?filename=.*payrail-verification\.txt&value=payrail-verify%3D/);
    // before anything is committed or served: nothing passes, nothing is verified
    const early = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(early.verified, false);
    assert.equal(early.listing.ownership.domain, false);
    // the seller commits the file; the deployment (built from the repo) serves it
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: `${value(l)}\n` });
    h.host.proof = value(l);
    const done = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(done.verified, true, JSON.stringify(done.checks));
    assert.deepEqual(done.checks.map((c: any) => [c.id, c.ok]), [['github_connected', true], ['repo_access', true], ['repo_file', true], ['deployed_file', true], ['endpoint_reachable', true]]);
    assert.equal(done.listing.ownership.domain, true);
    assert.equal(done.listing.ownership.domainMethod, 'github');
    assert.equal(done.listing.github.repo, 'alice/payrail-test-api');
    assert.ok(done.listing.github.verifiedAt);
    assert.ok(!JSON.stringify(done).includes('tok_alice'), 'no route returns the token');
    // with the wallet proof as well, the listing is verified (the existing publication rules still apply)
    const sig = await a.wallet.signMessage({ message: l.challenge.walletMessage });
    const w = (await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: a.token, body: { signature: sig } })).body;
    assert.equal(w.listing.status, 'verified');
    const row = h.db.prepare('SELECT domain_method FROM ownership_challenges WHERE listing_id = ?').get(l.id) as { domain_method: string };
    assert.equal(row.domain_method, 'github');
    const gp = h.db.prepare('SELECT repo_id, github_user_id, file_sha FROM listing_github_proofs WHERE listing_id = ?').get(l.id) as Record<string, unknown>;
    assert.equal(Number(gp.repo_id), 5001);
    assert.equal(Number(gp.github_user_id), 1001);
    assert.equal(gp.file_sha, 'blobsha1234567890');
  } finally { await h.close(); }
});

test('a PUBLIC repository owned by someone else never counts: no write access means the repository is refused, even if the proof file is in it', async () => {
  const h = await start();
  try {
    const mallory = await seller(h, 'mallory', 1003);
    await connect(h, mallory);
    const l = await draft(h, mallory);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) }); // alice's public repo, with a matching file
    const r = await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: mallory.token, body: { repoUrl: REPO } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NOT_OWNER');
    assert.match(r.body.message, /does not have write access/);
    assert.equal(Number((h.db.prepare('SELECT COUNT(*) AS n FROM listing_github_proofs').get() as { n: number | bigint }).n), 0);
    // checking without a started proof is refused too
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: mallory.token })).body.code, 'PROOF_MISSING');
  } finally { await h.close(); }
});

test('unknown, private and archived repositories, other hosts, and unconnected sellers are refused with clear reasons', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } } });
    // not connected
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } })).body.code, 'PROOF_MISSING');
    await connect(h, a);
    const start1 = (u: string) => h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: u } });
    assert.equal((await start1('https://github.com/alice/does-not-exist')).body.code, 'NOT_FOUND');
    assert.equal((await start1('https://gitlab.com/alice/x')).body.code, 'BAD_INPUT');
    assert.equal((await start1('alice')).body.code, 'BAD_INPUT');
    addRepo(h, 'alice/private-one', { id: 5002, perms: { alice: { push: true } }, isPrivate: true });
    assert.match((await start1('https://github.com/alice/private-one')).body.message, /Private repositories are not supported/);
    addRepo(h, 'alice/old', { id: 5003, perms: { alice: { push: true } }, archived: true });
    assert.match((await start1('https://github.com/alice/old')).body.message, /archived/);
    // another seller's listing cannot be used
    const b = await seller(h, 'bob', 1002);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: b.token, body: { repoUrl: REPO } })).status, 404);
  } finally { await h.close(); }
});

test('endpoint mismatch: the repository has the proof file, but the endpoint is a third-party host that does not serve it: NOT verified', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a, 'https://jsonplaceholder.typicode.com/todos/1');
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    h.host.proof = undefined; // the third party's host knows nothing about this listing
    const r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    const byId = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
    assert.equal(byId.repo_file.ok, true, 'the repository side is fine');
    assert.equal(byId.deployed_file.ok, false);
    assert.match(byId.deployed_file.detail, /HTTP 404|not built from the repository/);
    assert.equal(r.listing.ownership.domain, false);
    // serving a DIFFERENT value (for example another listing's token) is no better
    h.host.proof = 'payrail-verify=' + 'a'.repeat(48);
    const r2 = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r2.verified, false);
    assert.match(r2.checks.find((c: any) => c.id === 'deployed_file').detail, /does not contain this listing/);
  } finally { await h.close(); }
});

test('repository file missing or wrong, and a repository swapped for another under the same name, all fail', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    h.host.proof = value(l);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } } });
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    let r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.checks.find((c: any) => c.id === 'repo_file').ok, false);
    assert.match(r.checks.find((c: any) => c.id === 'repo_file').detail, /was not found/);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: 'payrail-verify=' + 'b'.repeat(48) });
    r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.match(r.checks.find((c: any) => c.id === 'repo_file').detail, /does not contain exactly this listing/);
    assert.equal(r.verified, false);
    // the repository is deleted and recreated by someone else under the same name (a new numeric id)
    addRepo(h, 'alice/payrail-test-api', { id: 9999, perms: { alice: { push: true } }, file: value(l) });
    r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'repo_access').detail, /replaced by a different one/);
    // write access removed after the fact
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: false } }, file: value(l) });
    r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'repo_access').detail, /write access/);
    assert.equal(r.listing.ownership.domain, false);
  } finally { await h.close(); }
});

test('a failing API blocks verification: wrong status, non-JSON, or an unreachable host', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    h.host.proof = value(l);
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    const check = async () => (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    h.host.endpointStatus = 500;
    let r = await check();
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'endpoint_reachable').detail, /HTTP 500/);
    h.host.endpointStatus = 200; h.host.endpointBody = '<html>not json</html>'; h.host.endpointType = 'text/html';
    r = await check();
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'endpoint_reachable').detail, /not with a JSON body/);
    h.host.endpointBody = '{"ok":true}'; h.host.endpointType = 'application/json'; h.host.dnsDown = true;
    r = await check();
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'deployed_file').detail, /did not answer in time/);
    assert.match(r.checks.find((c: any) => c.id === 'deployed_file').detail, /NOT a failed proof/);
    assert.equal(r.listing.ownership.domain, false);
    // once everything works again the SAME listing verifies
    h.host.dnsDown = false;
    r = await check();
    assert.equal(r.verified, true);
  } finally { await h.close(); }
});

test('an API that asks for credentials (a JSON 401) is still reachable; a non-JSON 401 is not', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    h.host.proof = value(l);
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    h.host.endpointStatus = 401; h.host.endpointBody = '<html>login</html>'; h.host.endpointType = 'text/html';
    let r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    h.host.endpointBody = '{"error":"missing key"}'; h.host.endpointType = 'application/json';
    r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, true);
    assert.match(r.checks.find((c: any) => c.id === 'endpoint_reachable').detail, /asks for credentials/);
  } finally { await h.close(); }
});

test('a GitHub outage is reported as temporary, not as a failed proof; and one seller cannot take a host another seller already verified', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    h.host.proof = value(l);
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    h.gh.state.down = true;
    const r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'repo_access').detail, /temporary or authorization problem: this is not a failed proof/);
    h.gh.state.down = false;
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body.verified, true);
    await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: a.token, body: { signature: await a.wallet.signMessage({ message: l.challenge.walletMessage }) } });
    // bob lists the same host with his own repository: the host is taken
    const b = await seller(h, 'bob', 1002);
    await connect(h, b);
    const l2 = await draft(h, b, `https://${HOST}/api/other`);
    addRepo(h, 'bob/clone', { id: 6001, perms: { bob: { push: true } }, file: value(l2) });
    await h.call('POST', `/seller/listing/${l2.id}/github-start`, { bearer: b.token, body: { repoUrl: 'https://github.com/bob/clone' } });
    h.host.proof = value(l2);
    const rb = await h.call('POST', `/seller/listing/${l2.id}/github-check`, { bearer: b.token });
    assert.equal(rb.body.code, 'HOST_CLAIMED');
  } finally { await h.close(); }
});

test('not configured: the routes say so plainly, and DNS and the well-known file are untouched', async () => {
  const db = openDb(':memory:');
  const market: MarketRuntime = { db, keys: [mk], activeKey: mk, execute: {}, testCall: {}, domain: {} };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'gh-test2', market, environment: 'production' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string) => {
    const r = await fetch(base + '/api/market' + path, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const w = privateKeyToAccount(generatePrivateKey());
    const s = await call('POST', '/seller/login/start').catch(() => undefined);
    void s;
    const st = (await fetch(base + '/api/market/seller/login/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token }, body: JSON.stringify({ wallet: w.address, chainId: 42220 }) }).then((r) => r.json())) as any;
    const c = (await fetch(base + '/api/market/seller/login/complete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token }, body: JSON.stringify({ wallet: w.address, nonce: st.nonce, signature: await w.signMessage({ message: st.message }) }) }).then((r) => r.json())) as any;
    const status = await call('GET', '/github/status', c.token);
    assert.equal(status.body.configured, false);
    assert.equal((await call('POST', '/github/connect', c.token)).body.code, 'NOT_CONFIGURED');
    // the callback route does not exist without GitHub configured
    assert.notEqual((await fetch(base + '/api/market/github/callback?code=a&state=b', { redirect: 'manual' })).status, 302);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('cold start: a sleeping host that wakes within the retries passes; the probe waits longer instead of failing at once', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    h.host.proof = value(l);
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    h.host.asleep = 2; // the first two attempts hang, the third is answered
    const r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, true, JSON.stringify(r.checks));
  } finally { await h.close(); }
});

test('a host that never wakes is a temporary timeout (not a failed proof), never verified; and a wrong proof is NOT retried', async () => {
  const h = await start();
  try {
    const a = await seller(h, 'alice', 1001);
    await connect(h, a);
    const l = await draft(h, a);
    addRepo(h, 'alice/payrail-test-api', { id: 5001, perms: { alice: { push: true } }, file: value(l) });
    h.host.proof = value(l);
    await h.call('POST', `/seller/listing/${l.id}/github-start`, { bearer: a.token, body: { repoUrl: REPO } });
    h.host.asleep = 100;
    let r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    const d = r.checks.find((c: any) => c.id === 'deployed_file').detail as string;
    assert.match(d, /did not answer in time/);
    assert.match(d, /tried 3 times/);
    assert.match(d, /NOT a failed proof/);
    assert.equal(r.listing.ownership.domain, false);
    // a host that answers with the wrong content is judged at once: one request, no waiting
    h.host.asleep = 0; h.host.proof = 'payrail-verify=' + '0'.repeat(48); h.host.calls = 0;
    r = (await h.call('POST', `/seller/listing/${l.id}/github-check`, { bearer: a.token })).body;
    assert.equal(r.verified, false);
    assert.match(r.checks.find((c: any) => c.id === 'deployed_file').detail, /does not contain|different|not the/i);
  } finally { await h.close(); }
});
