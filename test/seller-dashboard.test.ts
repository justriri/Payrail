// Seller dashboard regressions: listing persistence, My APIs data, publication prerequisites and errors.
// LOCAL INTEGRATION over HTTP with the in-process sandbox network. No chain, no real funds.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createDemoNetwork, createSandboxNetwork, seedDemo } from '../src/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import { verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/websim.ts';
import { tempDir } from './support.ts';

const mk = generateMasterKey('k1');

async function start(db: Db = openDb(':memory:')) {
  seedDemo(db, mk);
  const sb = createSandboxNetwork(db);
  const demo = createDemoNetwork();
  const market: MarketRuntime = {
    db,
    keys: [mk],
    activeKey: mk,
    sandbox: true,
    execute: {
      call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
      demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 500 } },
    },
    testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sb.resolver, transport: sb.transport, timeoutMs: 1_000 } },
    domain: { txt: sb.txt, fetchOptions: { resolver: sb.resolver, transport: sb.transport } },
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'sd-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string, body?: unknown) => {
    const r = await fetch(`${base}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;

async function sellerLogin(h: H, seed?: string) {
  const r = await h.call('POST', '/seller/sandbox/login', undefined, seed ? { seed } : {});
  assert.equal(r.status, 200, r.text);
  return { token: r.body.token as string, seed: r.body.seed as string };
}
const listingOf = async (h: H, st: string, id: string) => (await h.call('GET', '/seller/listings', st)).body.listings.find((l: any) => l.id === id);

async function submit(h: H, st: string, over: Record<string, unknown> = {}) {
  const r = await h.call('POST', '/seller/listings', st, { name: 'Persist price API', description: 'keeps its details', endpointUrl: 'https://keep-1.sandbox.payrail.example/v1/price', method: 'GET', price: '0.03', ...over });
  assert.equal(r.status, 201, r.text);
  return r.body.listing as any;
}
const verify = async (h: H, st: string, seed: string, id: string) => {
  assert.equal((await h.call('POST', `/seller/listing/${id}/wallet-proof`, st, { sandbox: true, seed })).status, 200);
  assert.equal((await h.call('POST', `/seller/listing/${id}/domain-proof`, st, { method: 'dns_txt' })).status, 200);
};
const approveContract = async (h: H, st: string, id: string) => {
  const sug = await h.call('POST', `/seller/listing/${id}/suggest-contract`, st, { input: { id: 'eth' } });
  assert.equal(sug.status, 200, sug.text);
  const prop = await h.call('POST', `/seller/listing/${id}/contract`, st, { contract: sug.body.suggestion });
  assert.equal(prop.status, 201, prop.text);
  assert.equal((await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, st)).status, 200);
};

test('a submitted listing is immediately in My APIs with every entered value, and its status follows persisted state exactly', async () => {
  const h = await start();
  try {
    const { token: st, seed } = await sellerLogin(h);
    const l = await submit(h, st);
    // immediately visible, private, nothing verified
    let mine = await listingOf(h, st, l.id);
    assert.equal(mine.name, 'Persist price API');
    assert.equal(mine.description, 'keeps its details');
    assert.equal(mine.endpointUrl, 'https://keep-1.sandbox.payrail.example/v1/price');
    assert.equal(mine.method, 'GET');
    assert.equal(mine.price.usd, '0.03');
    assert.equal(mine.displayStatus, 'Draft');
    assert.equal(mine.public, false);
    assert.match(mine.visibility, /Private/);
    assert.deepEqual(mine.ownership, { wallet: false, domain: false, domainMethod: null, verified: false });
    assert.deepEqual(mine.contractStatus, { state: 'none', version: null });
    assert.deepEqual(mine.publishReadiness.missing.map((m: any) => m.code), ['WALLET_PROOF', 'DOMAIN_PROOF', 'CONTRACT_NOT_APPROVED']);

    // not in the public catalog
    const pub = async () => ((await h.call('GET', '/catalog')).body.items as any[]).map((i) => i.id);
    assert.ok(!(await pub()).includes(l.id));

    await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, st, { sandbox: true, seed });
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.displayStatus, 'Pending verification');
    assert.equal(mine.ownership.wallet, true);
    assert.equal(mine.ownership.domain, false);

    await h.call('POST', `/seller/listing/${l.id}/domain-proof`, st, { method: 'well_known' });
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.displayStatus, 'Verified: needs a response contract');
    assert.deepEqual(mine.ownership, { wallet: true, domain: true, domainMethod: 'well_known', verified: true });

    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, st, { input: { id: 'eth' } });
    const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, st, { contract: sug.body.suggestion });
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.displayStatus, 'Verified: contract awaiting approval');
    assert.deepEqual(mine.contractStatus, { state: 'proposed', version: 1 });
    assert.equal(mine.publishReadiness.ready, false);

    await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, st);
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.displayStatus, 'Contract approved: ready to publish');
    assert.equal(mine.publishReadiness.ready, true);
    assert.equal(mine.public, false, 'approved is not published');
    assert.ok(!(await pub()).includes(l.id));

    const published = await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal(published.status, 200, published.text);
    assert.equal(published.body.listing.displayStatus, 'Published');
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.public, true);
    assert.match(mine.visibility, /Public/);
    assert.ok((await pub()).includes(l.id), 'a published listing appears in the public marketplace');
    // everything entered is still there after the whole journey
    assert.deepEqual([mine.name, mine.description, mine.endpointUrl, mine.method, mine.price.usd], ['Persist price API', 'keeps its details', 'https://keep-1.sandbox.payrail.example/v1/price', 'GET', '0.03']);

    // unpublishing removes it from the marketplace but keeps it, with everything, in My APIs
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/unpublish`, st)).body.listing.displayStatus, 'Unpublished (private)');
    assert.ok(!(await pub()).includes(l.id));
    mine = await listingOf(h, st, l.id);
    assert.equal(mine.public, false);
    assert.equal(mine.name, 'Persist price API');
    assert.equal(mine.contractStatus.state, 'approved');
  } finally {
    await h.close();
  }
});

test('publishing without the prerequisites fails with the exact missing items and changes nothing', async () => {
  const h = await start();
  try {
    const { token: st, seed } = await sellerLogin(h);
    const l = await submit(h, st);
    await h.call('POST', `/seller/listing/${l.id}/credential`, st, { label: 'k', headerName: 'X-Api-Key', value: 'secret-value-123456' }).catch(() => undefined);
    const before = await listingOf(h, st, l.id);

    const early = await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal(early.status, 409);
    assert.match(early.body.message, /Wallet ownership proof is missing/);
    assert.match(early.body.message, /Domain ownership proof is missing/);
    assert.match(early.body.message, /No response contract is approved/);

    // verified but no contract: names the contract only
    await verify(h, st, seed, l.id);
    const noContract = await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal(noContract.status, 400);
    assert.equal(noContract.body.code, 'PROOF_MISSING');
    assert.match(noContract.body.message, /No response contract is approved/);
    assert.doesNotMatch(noContract.body.message, /Wallet ownership/);

    // a proposed (unapproved) contract is not enough
    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, st, { input: { id: 'eth' } });
    await h.call('POST', `/seller/listing/${l.id}/contract`, st, { contract: sug.body.suggestion });
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, st)).status, 400);

    // nothing was lost by the failures
    const after = await listingOf(h, st, l.id);
    for (const k of ['name', 'description', 'endpointUrl', 'method']) assert.equal(after[k], before[k], k);
    assert.equal(after.price.usd, before.price.usd);
    assert.equal(after.public, false);
    assert.equal(after.ownership.verified, true);
    assert.equal(after.contracts.length, 1);
    assert.equal((await h.call('GET', '/seller/listings', st)).body.listings.length, 1);

    // a suspended listing can never be published
    await approveContract(h, st, l.id);
    h.db.prepare("UPDATE listings SET status = 'suspended' WHERE id = ?").run(l.id);
    const sus = await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal(sus.status, 409);
    assert.match(sus.body.message, /suspended/);
  } finally {
    await h.close();
  }
});

test('saved details persist, are editable where allowed, and cannot be changed by another seller', async () => {
  const h = await start();
  try {
    const { token: st, seed } = await sellerLogin(h);
    const l = await submit(h, st);
    const upd = await h.call('POST', `/seller/listing/${l.id}/details`, st, { name: 'Renamed API', description: 'new text', price: '0.05' });
    assert.equal(upd.status, 200, upd.text);
    const mine = await listingOf(h, st, l.id);
    assert.deepEqual([mine.name, mine.description, mine.price.usd], ['Renamed API', 'new text', '0.05']);
    assert.equal(mine.endpointUrl, 'https://keep-1.sandbox.payrail.example/v1/price', 'endpoint is not editable');
    // endpoint/method fields in the request are ignored, not applied
    await h.call('POST', `/seller/listing/${l.id}/details`, st, { endpointUrl: 'https://evil.example/', method: 'POST' });
    assert.equal((await listingOf(h, st, l.id)).endpointUrl, 'https://keep-1.sandbox.payrail.example/v1/price');
    // validation errors keep the old values
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/details`, st, { name: 'x' })).status, 400);
    assert.equal((await listingOf(h, st, l.id)).name, 'Renamed API');
    // price is locked while published
    await verify(h, st, seed, l.id);
    await approveContract(h, st, l.id);
    await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/details`, st, { price: '0.09' })).status, 409);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/details`, st, { description: 'allowed while published' })).status, 200);

    const other = await sellerLogin(h);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/details`, other.token, { name: 'Hijacked' })).status, 404);
    assert.equal((await h.call('GET', '/seller/listings', other.token)).body.listings.length, 0, 'My APIs shows only your own listings');
  } finally {
    await h.close();
  }
});

test('regression: after unpublishing, a seller can propose and approve a new contract version and publish again', async () => {
  const h = await start();
  try {
    const { token: st, seed } = await sellerLogin(h);
    const l = await submit(h, st);
    await verify(h, st, seed, l.id);
    await approveContract(h, st, l.id);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, st)).status, 200);
    assert.equal((await h.call('POST', `/seller/listing/${l.id}/unpublish`, st)).status, 200);

    const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, st, { input: { id: 'eth' } });
    const tighter = JSON.parse(JSON.stringify(sug.body.suggestion));
    tighter.success.maxLatencyMs = 1500;
    const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, st, { contract: tighter });
    assert.equal(prop.status, 201, prop.text);
    assert.equal(prop.body.contract.version, 2);
    assert.equal((await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, st)).status, 200);
    const again = await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    assert.equal(again.status, 200, again.text);
    assert.equal((await listingOf(h, st, l.id)).contractStatus.version, 2);
  } finally {
    await h.close();
  }
});

test('persistence across a server restart: listings, proofs, contracts, credentials and status are all restored', async () => {
  const dir = tempDir();
  const file = join(dir, 'sellers.db');
  let h = await start(openDb(file));
  const { token: st, seed } = await sellerLogin(h);
  const l = await submit(h, st, { description: 'survives restart' });
  await verify(h, st, seed, l.id);
  await h.call('POST', `/seller/listing/${l.id}/credential`, st, { label: 'k', headerName: 'X-Api-Key', value: 'restart-secret-1234' });
  await approveContract(h, st, l.id);
  assert.equal((await h.call('POST', `/seller/listing/${l.id}/publish`, st)).status, 200);
  await h.close();
  h.db.close();

  // a brand-new server process on the same database file; the same sandbox seed signs back in to the same account
  h = await start(openDb(file));
  try {
    const again = await sellerLogin(h, seed);
    const mine = await listingOf(h, again.token, l.id);
    assert.ok(mine, 'the listing is still there');
    assert.equal(mine.displayStatus, 'Published');
    assert.equal(mine.description, 'survives restart');
    assert.equal(mine.ownership.verified, true);
    assert.equal(mine.contractStatus.state, 'approved');
    assert.equal(mine.credentials.filter((c: any) => c.status === 'active').length, 1);
    assert.ok(!JSON.stringify(mine).includes('restart-secret-1234'));
    assert.ok(((await h.call('GET', '/catalog')).body.items as any[]).some((i) => i.id === l.id), 'still in the public marketplace');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('My APIs stats count requests and earnings for each listing', async () => {
  const h = await start();
  try {
    const { token: st, seed } = await sellerLogin(h);
    const l = await submit(h, st, { price: '0.1' });
    await verify(h, st, seed, l.id);
    await approveContract(h, st, l.id);
    await h.call('POST', `/seller/listing/${l.id}/publish`, st);
    const bt = (await h.call('POST', '/buyer')).body.token as string;
    await h.call('POST', '/credits', bt, { amount: '1' });
    await h.call('POST', '/execute', bt, { listingId: l.id, input: { id: 'eth' }, idempotencyKey: 'dash-run-0001' });
    await h.call('POST', '/execute', bt, { listingId: l.id, input: { id: 'eth', scenario: 'stale' }, idempotencyKey: 'dash-run-0002' });
    const mine = await listingOf(h, st, l.id);
    assert.deepEqual(mine.stats, { requests: 2, qualified: 1, earned: '0.097' });
  } finally {
    await h.close();
  }
});
