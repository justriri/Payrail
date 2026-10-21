// Seller onboarding, ownership verification, contracts, gateway and tester. Wallet keys here are throwaway test keys;
// the network is faked (resolver + transport), so no packets leave this process and no funds exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openDb, query } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import {
  ContractError, approveContract, currentContract, evaluate, hashContract, inferContract, listContracts, parseContractBody, proposeContract,
} from '../src/contracts.ts';
import type { ContractBody } from '../src/contracts.ts';
import { EgressError, RateLimiter } from '../src/egress.ts';
import type { EgressRequest, Resolver, Transport } from '../src/egress.ts';
import { GatewayError, callUpstream } from '../src/gateway.ts';
import {
  SellerError, authenticate, checkDomainProof, completeLogin, logout, proofValue, publishListing, startLogin, submitListing, submitWalletProof, getListing, challengeFor,
} from '../src/seller.ts';
import { runTest } from '../src/tester.ts';
import { generateMasterKey, putCredential } from '../src/vault.ts';

const T0 = 1_800_000_000_000;
const SECRET = 'sk_fixture_seller_secret_0123456789abcdef';
const PUBLIC = '93.184.216.34';
const resolver: Resolver = async () => [{ address: PUBLIC, family: 4 }];
const mk = generateMasterKey('k1');

type Acct = ReturnType<typeof privateKeyToAccount>;
const newWallet = (): Acct => privateKeyToAccount(generatePrivateKey());

async function signIn(db: Db, w: Acct, now = () => T0) {
  const { message, nonce } = startLogin(db, w.address, now);
  const signature = await w.signMessage({ message });
  return completeLogin(db, { wallet: w.address, nonce, signature, displayName: 'Seller' }, now);
}
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

async function sellerWithListing(db: Db, w: Acct = newWallet(), url = 'https://api.priceco.example/v1/price') {
  const s = await signIn(db, w);
  const { listing, challenge } = submitListing(db, s.accountId, { name: 'Token price', endpointUrl: url, priceAtomic: 10_000n, asset: 'USDT' }, () => T0);
  return { w, s, listing, challenge };
}
async function verify(db: Db, w: Acct, sellerId: string, listingId: string) {
  const ch = challengeFor(db, listingId)!;
  await submitWalletProof(db, sellerId, listingId, await w.signMessage({ message: ch.walletMessage }), () => T0);
  return checkDomainProof(db, sellerId, listingId, 'dns_txt', { txt: async () => [[ch.dnsRecord.value]] }, () => T0);
}
const GOOD: unknown = {
  schema: 1,
  success: { statuses: [200], contentType: 'application/json', maxLatencyMs: 2000, fields: [{ path: 'price', type: 'number', min: 0 }, { path: 'asOf', type: 'string' }], freshness: { path: 'asOf', maxAgeSeconds: 60, format: 'iso' } },
};
const upstream = (body: unknown, extra: Partial<{ status: number; headers: Record<string, string> }> = {}): Transport => async () => ({
  status: extra.status ?? 200,
  headers: extra.headers ?? { 'content-type': 'application/json' },
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

// ------------------------------------------------------------------ sign-in

test('sign-in: a valid signature creates the seller once; the nonce is single-use; wrong signer, expiry and logout are enforced', async () => {
  const db = openDb(':memory:');
  const w = newWallet();
  const s1 = await signIn(db, w);
  assert.equal(authenticate(db, s1.token, () => T0), s1.accountId);
  const s2 = await signIn(db, w);
  assert.equal(s2.accountId, s1.accountId, 'same wallet -> same account');
  assert.notEqual(s2.token, s1.token);
  assert.equal(query(db, "SELECT token_hash FROM sessions WHERE token_hash = ?", s1.token).length, 0, 'only a hash of the token is stored');

  const { message, nonce } = startLogin(db, w.address, () => T0);
  const sig = await w.signMessage({ message });
  await completeLogin(db, { wallet: w.address, nonce, signature: sig }, () => T0);
  assert.equal(await code(completeLogin(db, { wallet: w.address, nonce, signature: sig }, () => T0)), 'NONCE_INVALID');

  const other = newWallet();
  const r = startLogin(db, w.address, () => T0);
  assert.equal(await code(completeLogin(db, { wallet: w.address, nonce: r.nonce, signature: await other.signMessage({ message: r.message }) }, () => T0)), 'BAD_SIGNATURE');
  const e = startLogin(db, w.address, () => T0);
  assert.equal(await code(completeLogin(db, { wallet: w.address, nonce: e.nonce, signature: await w.signMessage({ message: e.message }) }, () => T0 + 6 * 60_000)), 'NONCE_INVALID');
  assert.equal(await code(() => authenticate(db, s1.token, () => T0 + 13 * 3_600_000)), 'SESSION_INVALID');
  logout(db, s2.token, () => T0);
  assert.equal(await code(() => authenticate(db, s2.token, () => T0)), 'SESSION_INVALID');
  assert.equal(await code(() => authenticate(db, 'nonsense', () => T0)), 'SESSION_INVALID');
});

// ------------------------------------------------------------------ listing submission

test('listing submission validates the endpoint with the same rules the gateway enforces', async () => {
  const db = openDb(':memory:');
  const s = await signIn(db, newWallet());
  const base = { name: 'Token price', priceAtomic: 10_000n, asset: 'USDT' };
  for (const url of ['http://api.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://api.example.com:8443/x', 'https://u:p@api.example.com/x', 'https://api.example.com/x?key=1', 'https://intranet/x', 'nope']) {
    assert.equal(await code(() => submitListing(db, s.accountId, { ...base, endpointUrl: url })), 'BAD_INPUT', url);
  }
  assert.equal(await code(() => submitListing(db, s.accountId, { ...base, endpointUrl: 'https://api.example.com/x', priceAtomic: 0n })), 'BAD_INPUT');
  assert.equal(await code(() => submitListing(db, s.accountId, { ...base, name: 'x', endpointUrl: 'https://api.example.com/x' })), 'BAD_INPUT');
  const ok = submitListing(db, s.accountId, { ...base, endpointUrl: 'https://api.example.com/v1/x' });
  assert.equal(ok.listing.status, 'draft');
  assert.equal(ok.listing.host, 'api.example.com');
  assert.equal(ok.challenge.dnsRecord.name, '_payrail-challenge.api.example.com');
  assert.equal(ok.challenge.dnsRecord.value, proofValue(ok.challenge.token));
  assert.equal(ok.challenge.wellKnown.url, 'https://api.example.com/.well-known/payrail-verification.txt');
});

// ------------------------------------------------------------------ ownership

test('ownership needs BOTH the wallet signature and a domain proof; either alone leaves the listing a draft', async () => {
  const db = openDb(':memory:');
  const { w, s, listing, challenge } = await sellerWithListing(db);
  // wallet only
  const afterWallet = await submitWalletProof(db, s.accountId, listing.id, await w.signMessage({ message: challenge.walletMessage }), () => T0);
  assert.equal(afterWallet.walletVerified, true);
  assert.equal(getListing(db, listing.id)!.status, 'draft', 'a signature alone is not API ownership');
  // domain proof completes it
  const done = await checkDomainProof(db, s.accountId, listing.id, 'dns_txt', { txt: async () => [['unrelated'], [challenge.dnsRecord.value]] }, () => T0);
  assert.equal(done.domainVerified, true);
  assert.equal(getListing(db, listing.id)!.status, 'verified');
  assert.notEqual(getListing(db, listing.id)!.verifiedAt, null);

  // domain only, other order, on a second listing
  const second = submitListing(db, s.accountId, { name: 'Second API', endpointUrl: 'https://api.other.example/v1', priceAtomic: 1n, asset: 'USDT' }, () => T0);
  await checkDomainProof(db, s.accountId, second.listing.id, 'dns_txt', { txt: async () => [[second.challenge.dnsRecord.value]] }, () => T0);
  assert.equal(getListing(db, second.listing.id)!.status, 'draft');
});

test('ownership: wrong or missing proofs are refused with a clear code', async () => {
  const db = openDb(':memory:');
  const { w, s, listing, challenge } = await sellerWithListing(db);
  const other = newWallet();
  assert.equal(await code(submitWalletProof(db, s.accountId, listing.id, await other.signMessage({ message: challenge.walletMessage }), () => T0)), 'BAD_SIGNATURE');
  assert.equal(await code(submitWalletProof(db, s.accountId, listing.id, await w.signMessage({ message: 'a different message' }), () => T0)), 'BAD_SIGNATURE');
  assert.equal(await code(submitWalletProof(db, s.accountId, listing.id, 'garbage', () => T0)), 'BAD_SIGNATURE');
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'dns_txt', { txt: async () => [['payrail-verify=wrongtoken']] })), 'DOMAIN_PROOF_FAILED');
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'dns_txt', { txt: async () => { throw new Error('ENOTFOUND'); } })), 'DOMAIN_PROOF_FAILED');
  assert.equal(getListing(db, listing.id)!.status, 'draft');
});

test('ownership via the well-known file goes through the SSRF-safe fetch, and a wrong body or status fails', async () => {
  const db = openDb(':memory:');
  const { w, s, listing, challenge } = await sellerWithListing(db);
  await submitWalletProof(db, s.accountId, listing.id, await w.signMessage({ message: challenge.walletMessage }), () => T0);
  let seen: EgressRequest | undefined;
  const wk = (body: string, status = 200): { fetchOptions: { resolver: Resolver; transport: Transport } } => ({
    fetchOptions: { resolver, transport: async (r) => ((seen = r), { status, headers: {}, body: Buffer.from(body) }) },
  });
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', wk('nope'))), 'DOMAIN_PROOF_FAILED');
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', wk(challenge.wellKnown.content, 404))), 'DOMAIN_PROOF_FAILED');
  // a host that resolves to a private address cannot be "verified" through the file route
  const priv: Resolver = async () => [{ address: '10.0.0.7', family: 4 }];
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', { fetchOptions: { resolver: priv, transport: upstream('x') } })), 'DOMAIN_PROOF_FAILED');
  const done = await checkDomainProof(db, s.accountId, listing.id, 'well_known', wk(`${challenge.wellKnown.content}\n`));
  assert.equal(done.domainMethod, 'well_known');
  assert.equal(seen!.path, '/.well-known/payrail-verification.txt');
  assert.equal(seen!.ip, PUBLIC);
  assert.equal(getListing(db, listing.id)!.status, 'verified');
});

test('only the owning seller can act on a listing; a verified host cannot be claimed by another seller', async () => {
  const db = openDb(':memory:');
  const a = await sellerWithListing(db);
  await verify(db, a.w, a.s.accountId, a.listing.id);
  const b = await signIn(db, newWallet());
  assert.equal(await code(checkDomainProof(db, b.accountId, a.listing.id, 'dns_txt', { txt: async () => [[a.challenge.dnsRecord.value]] })), 'NOT_OWNER');
  assert.equal(await code(() => publishListing(db, b.accountId, a.listing.id)), 'NOT_OWNER');

  const bw = newWallet();
  const bs = await signIn(db, bw);
  const bl = submitListing(db, bs.accountId, { name: 'Squatter', endpointUrl: 'https://api.priceco.example/v2/other', priceAtomic: 5n, asset: 'USDT' }, () => T0);
  await submitWalletProof(db, bs.accountId, bl.listing.id, await bw.signMessage({ message: bl.challenge.walletMessage }), () => T0);
  assert.equal(await code(checkDomainProof(db, bs.accountId, bl.listing.id, 'dns_txt', { txt: async () => [[bl.challenge.dnsRecord.value]] })), 'HOST_CLAIMED');
  assert.equal(getListing(db, bl.listing.id)!.status, 'draft');
});

// ------------------------------------------------------------------ contracts

test('contract body parsing is strict', () => {
  assert.doesNotThrow(() => parseContractBody(GOOD));
  const mutate = (f: (b: any) => void) => {
    const b = JSON.parse(JSON.stringify(GOOD));
    f(b);
    return b;
  };
  const bads = [
    mutate((b) => (b.extra = 1)),
    mutate((b) => (b.schema = 2)),
    mutate((b) => (b.success.statuses = [500])),
    mutate((b) => (b.success.statuses = [])),
    mutate((b) => (b.success.contentType = 'text/html')),
    mutate((b) => (b.success.maxLatencyMs = 5)),
    mutate((b) => (b.success.fields = [])),
    mutate((b) => (b.success.fields[0].path = '__proto__.x')),
    mutate((b) => (b.success.fields[0].path = 'a..b')),
    mutate((b) => (b.success.fields[0].type = 'date')),
    mutate((b) => (b.success.fields[1].min = 1)),
    mutate((b) => (b.success.fields[0].min = 9, (b.success.fields[0].max = 1))),
    mutate((b) => b.success.fields.push({ path: 'price', type: 'number' })),
    mutate((b) => (b.success.freshness.format = 'rfc')),
    mutate((b) => (b.success.freshness.maxAgeSeconds = 0)),
    'string',
    null,
  ];
  for (const b of bads) assert.throws(() => parseContractBody(b), ContractError);
});

test('evaluate: each rule is enforced and every failure is explained', () => {
  const c = parseContractBody(GOOD) as ContractBody;
  const fresh = new Date(T0 - 10_000).toISOString();
  const r = (o: Partial<{ status: number; contentType: string; json: unknown; elapsedMs: number }>) => evaluate(c, { status: 200, contentType: 'application/json; charset=utf-8', json: { price: 1.5, asOf: fresh }, elapsedMs: 100, ...o }, T0);
  assert.equal(r({}).qualified, true);
  assert.equal(r({ status: 500 }).qualified, false);
  assert.equal(r({ status: 204 }).qualified, false);
  assert.equal(r({ contentType: 'text/html' }).qualified, false);
  assert.equal(r({ elapsedMs: 2500 }).qualified, false);
  assert.equal(r({ json: undefined }).qualified, false);
  assert.equal(r({ json: [1, 2] }).qualified, false);
  assert.equal(r({ json: { asOf: fresh } }).qualified, false, 'missing field');
  assert.equal(r({ json: { price: '1.5', asOf: fresh } }).qualified, false, 'wrong type');
  assert.equal(r({ json: { price: -1, asOf: fresh } }).qualified, false, 'below min');
  assert.equal(r({ json: { price: Number.NaN, asOf: fresh } }).qualified, false);
  const stale = r({ json: { price: 1, asOf: new Date(T0 - 120_000).toISOString() } });
  assert.equal(stale.qualified, false);
  assert.match(stale.reasons.join(), /freshness/);
  assert.equal(r({ json: { price: 1, asOf: new Date(T0 + 3_600_000).toISOString() } }).qualified, false, 'a timestamp from the future is not fresh');
  assert.equal(r({ json: { price: 1, asOf: 'yesterday' } }).qualified, false);
  // prototype-chain tricks do not satisfy a field
  const inherited = Object.create({ price: 1, asOf: fresh });
  assert.equal(r({ json: inherited }).qualified, false);
  // several failures are all reported
  assert.ok(r({ status: 500, elapsedMs: 9999 }).reasons.length >= 2);
});

test('contract versions: proposed -> approved; a new approval supersedes; identical content is idempotent; content is immutable', async () => {
  const db = openDb(':memory:');
  const { w, s, listing } = await sellerWithListing(db);
  assert.equal(await code(() => proposeContract(db, listing.id, s.accountId, GOOD)), 'LISTING_NOT_VERIFIED', 'no contracts before ownership is proven');
  await verify(db, w, s.accountId, listing.id);

  const v1 = proposeContract(db, listing.id, s.accountId, GOOD, () => T0);
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'proposed');
  assert.equal(v1.bodyHash, hashContract(parseContractBody(GOOD)));
  assert.equal(proposeContract(db, listing.id, s.accountId, GOOD).id, v1.id, 'same content -> same version');
  assert.equal(currentContract(db, listing.id), undefined);

  assert.equal(approveContract(db, v1.id, s.accountId, () => T0).status, 'approved');
  assert.equal(approveContract(db, v1.id, s.accountId).status, 'approved', 'idempotent');
  const changed = JSON.parse(JSON.stringify(GOOD));
  changed.success.freshness.maxAgeSeconds = 30;
  const v2 = proposeContract(db, listing.id, s.accountId, changed, () => T0);
  assert.equal(v2.version, 2);
  assert.equal(currentContract(db, listing.id)!.id, v1.id, 'a proposal changes nothing until approved');
  approveContract(db, v2.id, s.accountId, () => T0);
  assert.deepEqual(listContracts(db, listing.id).map((c) => `${c.version}:${c.status}`), ['1:superseded', '2:approved']);
  assert.equal(currentContract(db, listing.id)!.id, v2.id);
  assert.equal(await code(() => approveContract(db, v1.id, s.accountId)), 'INVALID_TRANSITION', 'a superseded version cannot be revived');

  // the database itself refuses edits and deletes
  assert.throws(() => db.prepare("UPDATE contract_versions SET body_json = '{}' WHERE id = ?").run(v2.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM contract_versions WHERE id = ?').run(v2.id), /cannot be deleted/);
  const other = await signIn(db, newWallet());
  assert.equal(await code(() => approveContract(db, v2.id, other.accountId)), 'NOT_OWNER');
});

test('inferContract suggests required fields, non-empty strings and a freshness rule from samples', () => {
  const t = new Date(T0).toISOString();
  const c = inferContract([
    { json: { symbol: 'ETH', price: 1.2, updatedAt: t, meta: { src: 'x' } }, elapsedMs: 300 },
    { json: { symbol: 'ETH', price: 1.3, updatedAt: t, meta: { src: 'y' }, extra: 1 }, elapsedMs: 500 },
  ]);
  assert.deepEqual(c.success.fields.map((f) => `${f.path}:${f.type}`).sort(), ['meta.src:string', 'price:number', 'symbol:string', 'updatedAt:string']);
  assert.equal(c.success.freshness!.path, 'updatedAt');
  assert.equal(c.success.freshness!.format, 'iso');
  assert.ok(c.success.maxLatencyMs >= 1_000);
  assert.throws(() => inferContract([]), ContractError);
  assert.throws(() => inferContract([{ json: 'text', elapsedMs: 1 }]), ContractError);
});

// ------------------------------------------------------------------ gateway + tester

test('gateway: credentials are sent only after verification, only to the fixed endpoint, and never come back', async () => {
  const db = openDb(':memory:');
  const { w, s, listing } = await sellerWithListing(db);
  putCredential(db, mk, { listingId: listing.id, label: 'key', headerName: 'X-Api-Key', value: SECRET, actor: s.accountId }, () => T0);
  let seen: EgressRequest | undefined;
  const echo: Transport = async (r) => ((seen = r), { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ price: 2, echoedKey: r.headers['x-api-key'], note: `your key ${r.headers['x-api-key']}` })) });
  const fo = { resolver, transport: echo };
  const lim = () => new RateLimiter(100, 100);

  // not verified yet -> nothing is sent
  assert.equal(await code(callUpstream(db, [mk], listing.id, {}, { purpose: 'seller-test', fetchOptions: fo, limiter: lim() })), 'LISTING_NOT_VERIFIED');
  assert.equal(seen, undefined, 'no request left the gateway');

  await verify(db, w, s.accountId, listing.id);
  const r = await callUpstream(db, [mk], listing.id, { id: 'eth', n: 3, ok: true }, { purpose: 'seller-test', fetchOptions: fo, limiter: lim(), now: () => T0 });
  assert.equal(seen!.headers['x-api-key'], SECRET, 'the upstream received the credential');
  assert.equal(seen!.hostname, 'api.priceco.example');
  assert.equal(seen!.path, '/v1/price?id=eth&n=3&ok=true');
  assert.ok(!r.bodyText.includes(SECRET), 'echoed secret is redacted');
  assert.ok(!JSON.stringify(r.json).includes(SECRET));
  assert.equal(r.status, 200);
  const opened = query(db, "SELECT details_json FROM audit_log WHERE action = 'credentials_opened'");
  assert.equal(opened.length, 1, 'the unverified attempt never opened the vault');
  assert.ok(!String(opened[0]!.details_json).includes(SECRET));
});

test('gateway: input cannot change the destination or smuggle headers; bad inputs are refused; blocked egress and rate limit are mapped', async () => {
  const db = openDb(':memory:');
  const { w, s, listing } = await sellerWithListing(db);
  await verify(db, w, s.accountId, listing.id);
  let seen: EgressRequest | undefined;
  const t: Transport = async (r) => ((seen = r), { status: 200, headers: {}, body: Buffer.from('{}') });
  const o = (extra: Record<string, unknown> = {}) => ({ purpose: 'gateway-execution' as const, fetchOptions: { resolver, transport: t }, limiter: new RateLimiter(100, 100), ...extra });

  await callUpstream(db, [mk], listing.id, { url: 'https://evil.example/', host: '169.254.169.254', path: '/../admin' }, o());
  assert.equal(seen!.hostname, 'api.priceco.example');
  assert.ok(seen!.path.startsWith('/v1/price?'));
  assert.ok(seen!.path.includes('url=https%3A%2F%2Fevil.example%2F'), 'values are data, URL-encoded');
  assert.ok(!('host' in seen!.headers) || seen!.headers['host'] === 'api.priceco.example');

  for (const bad of [[1, 2], 'str', { 'bad key': 1 }, { a: { nested: 1 } }, { a: 'x'.repeat(501) }, { a: Number.POSITIVE_INFINITY }, { __proto__x: 1, 'a\r\nb': 1 }]) {
    assert.equal(await code(callUpstream(db, [mk], listing.id, bad, o())), 'BAD_INPUT', JSON.stringify(bad));
  }
  // endpoint resolving privately is blocked at the egress layer
  const priv: Resolver = async () => [{ address: '10.0.0.5', family: 4 }];
  assert.equal(await code(callUpstream(db, [mk], listing.id, {}, o({ fetchOptions: { resolver: priv, transport: t } }))), 'EGRESS_BLOCKED');
  // a redirect from the seller's server is not followed
  const redir: Transport = async () => ({ status: 302, headers: { location: 'https://169.254.169.254/' }, body: Buffer.alloc(0) });
  assert.equal(await code(callUpstream(db, [mk], listing.id, {}, o({ fetchOptions: { resolver, transport: redir } }))), 'EGRESS_BLOCKED');
  const tight = new RateLimiter(1, 0.0001);
  await callUpstream(db, [mk], listing.id, {}, o({ limiter: tight }));
  assert.equal(await code(callUpstream(db, [mk], listing.id, {}, o({ limiter: tight }))), 'RATE_LIMITED');
  // a refused call was not a successful upstream call: unknown listings are NOT_FOUND
  assert.equal(await code(callUpstream(db, [mk], 'lst_missing', {}, o())), 'NOT_FOUND');
});

test('tester: reports status, timing, shape and contract checks; never credentials; non-owners are refused; runs are stored', async () => {
  const db = openDb(':memory:');
  const { w, s, listing } = await sellerWithListing(db);
  putCredential(db, mk, { listingId: listing.id, label: 'key', headerName: 'Authorization', value: `Bearer ${SECRET}`, actor: s.accountId }, () => T0);
  await verify(db, w, s.accountId, listing.id);
  const c = proposeContract(db, listing.id, s.accountId, GOOD, () => T0);
  const fresh = new Date(T0 - 5_000).toISOString();
  const call = (body: unknown, extra = {}) => ({ now: () => T0, limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport: upstream(body, extra) } });

  const good = await runTest(db, [mk], s.accountId, listing.id, { id: 'eth' }, { contractId: c.id, call: call({ price: 1.5, asOf: fresh, leaked: `Bearer ${SECRET}` }) });
  assert.equal(good.outcome, 'RESPONDED');
  assert.equal(good.httpStatus, 200);
  assert.deepEqual(good.shape, { price: 'number', asOf: 'string', leaked: 'string' });
  assert.equal(good.contract!.qualified, true);
  assert.ok(!JSON.stringify(good).includes(SECRET), 'credential never appears in a report');

  const stale = await runTest(db, [mk], s.accountId, listing.id, {}, { contractId: c.id, call: call({ price: 1.5, asOf: new Date(T0 - 3_600_000).toISOString() }) });
  assert.equal(stale.contract!.qualified, false);
  assert.match(JSON.stringify(stale.contract!.checks), /freshness/);

  const err = await runTest(db, [mk], s.accountId, listing.id, {}, { call: call('oops', { status: 500, headers: { 'content-type': 'text/plain' } }) });
  assert.equal(err.outcome, 'RESPONDED');
  assert.equal(err.httpStatus, 500);

  const unreachable = await runTest(db, [mk], s.accountId, listing.id, {}, { call: { now: () => T0, limiter: new RateLimiter(100, 100), fetchOptions: { resolver: async () => { throw new Error('boom'); }, transport: upstream('') } } });
  assert.equal(unreachable.outcome, 'FAILED');
  assert.equal(unreachable.failure!.code, 'UPSTREAM_UNREACHABLE');

  const stored = query(db, 'SELECT report_json FROM test_runs');
  assert.equal(stored.length, 4);
  assert.ok(!stored.map((r) => String(r.report_json)).join().includes(SECRET));
  const other = await signIn(db, newWallet());
  assert.equal(await code(runTest(db, [mk], other.accountId, listing.id, {})), 'NOT_OWNER');
});

test('publishing requires verification and an approved contract', async () => {
  const db = openDb(':memory:');
  const { w, s, listing } = await sellerWithListing(db);
  assert.equal(await code(() => publishListing(db, s.accountId, listing.id)), 'WRONG_STATE');
  await verify(db, w, s.accountId, listing.id);
  assert.equal(await code(() => publishListing(db, s.accountId, listing.id)), 'PROOF_MISSING', 'no approved contract');
  const c = proposeContract(db, listing.id, s.accountId, GOOD, () => T0);
  assert.equal(await code(() => publishListing(db, s.accountId, listing.id)), 'PROOF_MISSING', 'proposed is not approved');
  approveContract(db, c.id, s.accountId, () => T0);
  assert.equal(publishListing(db, s.accountId, listing.id).status, 'published');
  assert.equal(publishListing(db, s.accountId, listing.id).status, 'published', 'idempotent');
  assert.ok(SellerError && GatewayError);
});

// ------------------------------------------------------------------ regression: the two reported domain-verification errors
test('reported error 2: a refused/unavailable DNS service is a TEMPORARY failure, not a failed ownership proof', async () => {
  const db = openDb(':memory:');
  const { s, listing } = await sellerWithListing(db, newWallet(), 'https://jsonplaceholder.typicode.com/todos/1');
  const refused = { txt: async () => { throw Object.assign(new Error('queryTxt ECONNREFUSED _payrail-challenge.jsonplaceholder.typicode.com'), { code: 'ECONNREFUSED' }); } };
  const e = await checkDomainProof(db, s.accountId, listing.id, 'dns_txt', refused).catch((x) => x as SellerError);
  assert.equal((e as SellerError).code, 'DNS_UNAVAILABLE');
  assert.match((e as SellerError).message, /neither confirmed nor rejected/);
  assert.match((e as SellerError).message, /try again/i);
  assert.equal(getListing(db, listing.id)!.status, 'draft', 'nothing about the listing changed');
  for (const c of ['ETIMEOUT', 'ESERVFAIL', 'EAI_AGAIN']) {
    assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'dns_txt', { txt: async () => { throw Object.assign(new Error(c), { code: c }); } })), 'DNS_UNAVAILABLE', c);
  }
});

test('why _payrail-challenge.<host> is queried, and that a seller cannot claim a third-party domain (jsonplaceholder.typicode.com)', async () => {
  const db = openDb(':memory:');
  const { s, listing, challenge } = await sellerWithListing(db, newWallet(), 'https://jsonplaceholder.typicode.com/todos/1');
  assert.equal(challenge.dnsRecord.name, '_payrail-challenge.jsonplaceholder.typicode.com', 'the record is looked up under the endpoint host: it is the host the seller claims to own');
  // the real domain owner has published nothing: an empty answer and a missing name are both a failed proof, with instructions
  for (const txt of [async () => [], async () => { throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }); }, async () => [['v=spf1 -all']]]) {
    const e = await checkDomainProof(db, s.accountId, listing.id, 'dns_txt', { txt }).catch((x) => x as SellerError);
    assert.equal((e as SellerError).code, 'DOMAIN_PROOF_FAILED');
    assert.match((e as SellerError).message, /domain you control/);
    assert.match((e as SellerError).message, /_payrail-challenge\.jsonplaceholder\.typicode\.com/);
    assert.match((e as SellerError).message, /third-party API/);
    assert.match((e as SellerError).message, /payrail-verification\.txt/);
  }
  assert.notEqual(getListing(db, listing.id)!.status, 'verified');
});

test('a legitimate domain verifies by DNS, and is then refused to every other seller', async () => {
  const db = openDb(':memory:');
  const a = await sellerWithListing(db, newWallet(), 'https://api.priceco.example/v1/price');
  const done = await verify(db, a.w, a.s.accountId, a.listing.id);
  assert.equal(done.domainVerified, true);
  assert.equal(getListing(db, a.listing.id)!.status, 'verified');
  const b = await sellerWithListing(db, newWallet(), 'https://api.priceco.example/v1/other');
  await submitWalletProof(db, b.s.accountId, b.listing.id, await b.w.signMessage({ message: b.challenge.walletMessage }), () => T0);
  assert.equal(await code(checkDomainProof(db, b.s.accountId, b.listing.id, 'dns_txt', { txt: async () => [[b.challenge.dnsRecord.value]] })), 'HOST_CLAIMED');
  // a token that belongs to another listing never proves this one
  assert.equal(await code(checkDomainProof(db, b.s.accountId, b.listing.id, 'dns_txt', { txt: async () => [[a.challenge.dnsRecord.value]] })), 'DOMAIN_PROOF_FAILED');
});

test('file proof: an unreachable host or DNS outage is temporary (ENDPOINT_UNREACHABLE), a missing file is a failed proof', async () => {
  const db = openDb(':memory:');
  const { s, listing } = await sellerWithListing(db);
  const wkTransport = (t: Transport, r: Resolver = resolver) => ({ fetchOptions: { resolver: r, transport: t } });
  const dnsDown: Resolver = async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); };
  const gone: Resolver = async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', wkTransport(upstream('x'), dnsDown))), 'ENDPOINT_UNREACHABLE');
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', wkTransport(upstream('x'), gone))), 'ENDPOINT_UNREACHABLE');
  const slow: Transport = async () => { throw new EgressError('TIMEOUT', 'no response'); };
  assert.equal(await code(checkDomainProof(db, s.accountId, listing.id, 'well_known', wkTransport(slow))), 'ENDPOINT_UNREACHABLE');
  const e = await checkDomainProof(db, s.accountId, listing.id, 'well_known', wkTransport(async () => ({ status: 404, headers: {}, body: Buffer.from('') }))).catch((x) => x as SellerError);
  assert.equal((e as SellerError).code, 'DOMAIN_PROOF_FAILED');
  assert.match((e as SellerError).message, /HTTP 404/);
});
