// PRODUCTION GUARANTEES (real-funds mode). The marketplace runs against a FAKE chain here, but through the real HTTP server and the
// real modules: these tests prove that demo / test-credit / simulated paths are rejected by the backend itself, not just hidden in
// the screens, and that failed or unverifiable transactions can never credit a balance or produce a successful purchase.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/dev/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import type { Resolver, Transport } from '../src/egress.ts';
import { TRANSFER_TOPIC, fundingMessage } from '../src/funding.ts';
import type { ChainReader, ChainReceipt } from '../src/funding.ts';
import { verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import type { ConversionRuntime } from '../src/multifunding.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const mk = generateMasterKey('k1');
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const OTHER_TOKEN = ASSETS.find((a) => a.symbol === 'cNGN')!.address;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const SECRET = 'sk_prod_test_secret_0123456789abcdef';
const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;

async function start(o: { simulatedConversion?: boolean } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mk); // the demo listings EXIST in the database, as they do in an old marketplace file
  seedConversionAssets(db);
  const receipts = new Map<string, ChainReceipt>();
  let head = 5_000n;
  const reader: ChainReader = { blockNumber: async () => head, receipt: async (h) => receipts.get(h.toLowerCase()) ?? null };
  const demo = createDemoNetwork();
  const txt = new Map<string, string>();
  const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const transport: Transport = async (r) => {
    const ok = r.headers['x-api-key'] === SECRET;
    return { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(ok ? { quote: 7, asOf: new Date().toISOString() } : { error: 'bad key' })) };
  };
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR });
  const conversion: ConversionRuntime | undefined = o.simulatedConversion
    ? { registry: new RouteRegistry(db, [provider]), provider, reader: provider.reader, reactor: TEXTILE_REACTOR, usdt: USDT, chainId: 42220, minConfirmations: 3, creditAsset: 'TESTUSDT', depositAddress: DEP, maxPerDayBuyAtomic: 10n ** 12n, simulated: true }
    : undefined;
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, sandbox: true, // a sandbox flag set on purpose: production must still refuse it
    execute: {
      call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport } },
      demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 150 } },
    },
    testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport } },
    domain: { txt: async (name) => (txt.has(name) ? [[txt.get(name)!]] : []) },
    ...(conversion ? { conversion } : {}),
    live: {
      funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: DEP, minConfirmations: 5, maxDepositAtomic: 1_000_000n, reader },
      payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: 1_000_000n },
    },
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'prod-test', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, o2: { body?: unknown; bearer?: string } = {}) => {
    const r = await fetch(base + '/api/market' + path, {
      method,
      headers: { ...(o2.bearer ? { authorization: `Bearer ${o2.bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(o2.body ?? {}) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as any };
  };
  const setHead = (n: bigint) => { head = n; };
  return { db, base, call, receipts, txt, setHead, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;
const count = (h: H, table: string, where = '1=1') => Number((h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number | bigint }).n);

async function walletBuyer(h: H) {
  const k = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/buyer/login/start', { body: { wallet: k.address, chainId: 42220 } });
  const c = await h.call('POST', '/buyer/login/complete', { body: { wallet: k.address, nonce: s.body.nonce, signature: await k.signMessage({ message: s.body.message }) } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.accountId as string;
  const funding = privateKeyToAccount(generatePrivateKey());
  const reg = await h.call('POST', '/funding/wallet', { bearer: c.body.token, body: { wallet: funding.address, signature: await funding.signMessage({ message: fundingMessage(id, funding.address) }) } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return { token: c.body.token as string, id, funding };
}
async function sellerWithListing(h: H, price = '0.5') {
  const w = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address, chainId: 42220 } });
  const c = await h.call('POST', '/seller/login/complete', { body: { wallet: w.address, nonce: s.body.nonce, signature: await w.signMessage({ message: s.body.message }) } });
  const st = c.body.token as string;
  // NOTE: no `live: true` flag is sent: in production every listing is a real-USDT listing
  const created = await h.call('POST', '/seller/listings', { bearer: st, body: { name: 'Real quote API', endpointUrl: 'https://api.sellerco.example/v1/quote', price } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const l = created.body.listing;
  assert.equal(l.price.asset, 'USDT');
  await h.call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: st, body: { signature: await w.signMessage({ message: l.challenge.walletMessage }) } });
  h.txt.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
  await h.call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: st, body: { method: 'dns_txt' } });
  await h.call('POST', `/seller/listing/${l.id}/credential`, { bearer: st, body: { label: 'key', headerName: 'X-Api-Key', value: SECRET } });
  const sug = await h.call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: st, body: { input: {} } });
  const prop = await h.call('POST', `/seller/listing/${l.id}/contract`, { bearer: st, body: { contract: sug.body.suggestion } });
  await h.call('POST', `/seller/contract/${prop.body.contract.id}/approve`, { bearer: st });
  const pub = await h.call('POST', `/seller/listing/${l.id}/publish`, { bearer: st });
  assert.equal(pub.body.listing.status, 'published', JSON.stringify(pub.body));
  return { id: l.id as string, token: st, wallet: w };
}
const transferReceipt = (o: { token?: string; from: string; to?: string; amount: bigint; status?: 'success' | 'reverted'; block?: bigint }): ChainReceipt => ({
  status: o.status ?? 'success',
  blockNumber: o.block ?? 4_990n,
  logs: o.status === 'reverted' ? [] : [{ address: o.token ?? USDT, topics: [TRANSFER_TOPIC, pad(o.from), pad(o.to ?? DEP)], data: `0x${o.amount.toString(16).padStart(64, '0')}`, logIndex: 1 }],
});
let n = 0x100;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
const live = async (h: H, token: string) => (await h.call('GET', '/me', { bearer: token })).body.live;

test('demo, test-credit, anonymous and sandbox routes are rejected by the backend in real-funds mode', async () => {
  const h = await start();
  try {
    assert.equal((await h.call('POST', '/buyer')).body.code, 'NOT_AVAILABLE');
    const b = await walletBuyer(h);
    assert.equal((await h.call('POST', '/credits', { bearer: b.token, body: { amount: '1' } })).body.code, 'NOT_AVAILABLE');
    const me = (await h.call('GET', '/me', { bearer: b.token })).body;
    assert.equal(me.mode, 'real-funds');
    assert.equal(me.available, undefined, 'no test-credit balance is exposed');
    assert.equal(me.creditCap, undefined);
    assert.equal((await h.call('POST', '/seller/sandbox/login', { body: {} })).body.code, 'SANDBOX_DISABLED');
    // a seller cannot list a sandbox endpoint as a real service
    const w = privateKeyToAccount(generatePrivateKey());
    const s = await h.call('POST', '/seller/login/start', { body: { wallet: w.address, chainId: 42220 } });
    const c = await h.call('POST', '/seller/login/complete', { body: { wallet: w.address, nonce: s.body.nonce, signature: await w.signMessage({ message: s.body.message }) } });
    const sb = await h.call('POST', '/seller/listings', { bearer: c.body.token, body: { name: 'x', endpointUrl: 'https://my-abc.sandbox.payrail.example/v1/price', price: '0.01' } });
    assert.equal(sb.body.code, 'NOT_A_REAL_ENDPOINT');
    // the escrow TESTNET helper and sandbox signing do not exist either
    assert.equal((await h.call('POST', '/escrow/deposit', { bearer: b.token, body: { amount: '1' } })).status >= 400, true);
  } finally {
    await h.close();
  }
});

test('demo and test-credit listings are invisible and unpurchasable even though they exist in the database', async () => {
  const h = await start();
  try {
    const demoRows = h.db.prepare("SELECT id FROM listings WHERE demo = 1").all() as Array<{ id: string }>;
    assert.ok(demoRows.length >= 2, 'precondition: demo listings exist in the file');
    const real = await sellerWithListing(h);
    const cat = (await h.call('GET', '/catalog')).body;
    assert.equal(cat.mode, 'real-funds');
    const ids = (cat.items as any[]).filter((i) => i.source === 'payrail').map((i) => i.id);
    assert.deepEqual(ids, [real.id], 'only the real listing is offered');
    assert.ok((cat.items as any[]).every((i) => !i.demo && i.origin !== 'payrail-demo' && i.origin !== 'payrail-sandbox' && i.origin !== 'buy-gateway-simulated'));
    for (const d of demoRows) {
      assert.equal((await h.call('GET', `/listing/${d.id}`)).status, 404);
      assert.equal((await h.call('GET', `/quote/${d.id}`)).status, 404);
    }
    const b = await walletBuyer(h);
    const before = await live(h, b.token);
    for (const d of demoRows) {
      const r = await h.call('POST', '/execute', { bearer: b.token, body: { listingId: d.id, input: { id: 'eth' }, idempotencyKey: `demo-attempt-${d.id}` } });
      assert.equal(r.body.code, 'NOT_REAL_LISTING');
    }
    assert.deepEqual(await live(h, b.token), before);
    assert.equal(count(h, 'executions'), 0, 'no execution row was created');
    // agents are held to the same rule
    const ag = await h.call('POST', '/agents', { bearer: b.token, body: { name: 'bot', perRequestCap: '1', dailyCap: '1' } });
    assert.equal(ag.status, 201, JSON.stringify(ag.body));
    const viaAgent = await fetch(`${h.base}/api/market/agent/execute`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ag.body.key}` }, body: JSON.stringify({ listingId: demoRows[0]!.id, input: { id: 'eth' }, idempotencyKey: 'agent-demo-attempt-1' }) });
    assert.equal(((await viaAgent.json()) as { code?: string }).code, 'NOT_REAL_LISTING');
    assert.equal(count(h, 'executions'), 0);
  } finally {
    await h.close();
  }
});

test('simulated conversion and payout runtimes cannot serve production, and payout requests are disabled', async () => {
  const h = await start({ simulatedConversion: true });
  try {
    const b = await walletBuyer(h);
    for (const [method, path, body] of [
      ['GET', '/fund/routes', undefined], ['GET', '/fund/config', undefined], ['POST', '/fund/quote', { asset: 'cNGN', amount: '1364' }],
      ['POST', '/fund/wallet', { demo: true, chainId: 42220 }], ['POST', '/fund/approve', { opId: 'x', digest: 'y' }],
    ] as const) {
      const r = await h.call(method, path, { bearer: b.token, ...(body ? { body } : {}) });
      assert.equal(r.body.code, 'NOT_AVAILABLE', `${method} ${path}`);
    }
    const s = await sellerWithListing(h);
    assert.ok(['NOT_AVAILABLE', 'CONVERSION_DISABLED'].includes((await h.call('POST', '/seller/payouts/convert', { bearer: s.token, body: { amount: '1' } })).body.code), 'no payout conversion in production');
    assert.equal((await h.call('POST', '/seller/payouts', { bearer: s.token, body: { amount: '0.1' } })).body.code, 'PAYOUTS_DISABLED');
    const cfg = (await h.call('GET', '/config')).body;
    assert.equal(cfg.features.payouts, false);
    assert.equal(cfg.features.conversion, false, 'a simulated provider is never reported as available conversion');
  } finally {
    await h.close();
  }
});

test('no failed, unconfirmed or mismatched transaction can credit a balance or produce a successful purchase', async () => {
  const h = await start();
  try {
    const s = await sellerWithListing(h, '0.5');
    const b = await walletBuyer(h);
    const from = b.funding.address;
    const attempt = async (r: ChainReceipt | null, label: string) => {
      const tx = hash();
      if (r) h.receipts.set(tx, r);
      const res = await h.call('POST', '/funding/confirm', { bearer: b.token, body: { txHash: tx } });
      assert.equal(res.status >= 400, true, `${label}: must be refused (${JSON.stringify(res.body)})`);
      assert.equal((await live(h, b.token)).available, '0', `${label}: nothing credited`);
      return res.body.code as string;
    };
    assert.equal(await attempt(null, 'transaction not found'), 'TX_NOT_FOUND');
    assert.equal(await attempt(transferReceipt({ from, amount: 500_000n, status: 'reverted' }), 'reverted'), 'TX_REVERTED');
    assert.equal(await attempt(transferReceipt({ from, amount: 500_000n, block: 4_999n }), 'only 2 confirmations'), 'NOT_ENOUGH_CONFIRMATIONS');
    assert.equal(await attempt(transferReceipt({ from, amount: 500_000n, token: OTHER_TOKEN }), 'wrong token'), 'NO_MATCHING_TRANSFER');
    assert.equal(await attempt(transferReceipt({ from, amount: 500_000n, to: '0x00000000000000000000000000000000000000ee' }), 'wrong recipient'), 'NO_MATCHING_TRANSFER');
    assert.equal(await attempt(transferReceipt({ from: '0x00000000000000000000000000000000000000dd', amount: 500_000n }), 'sender is not the verified wallet'), 'NO_MATCHING_TRANSFER');
    assert.equal(await attempt(transferReceipt({ from, amount: 2_000_000n }), 'above the per-deposit limit'), 'OVER_LIMIT');
    assert.equal(count(h, 'chain_deposits'), 0, 'no deposit record exists for any refused transaction');

    // an under-funded buyer cannot buy: no reservation, no execution, no successful record
    const r1 = await h.call('POST', '/execute', { bearer: b.token, body: { listingId: s.id, input: {}, idempotencyKey: 'prod-underfunded-1' } });
    assert.equal(r1.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(count(h, 'executions', "state = 'QUALIFIED'"), 0);

    // a genuine, confirmed transfer credits exactly once and the record carries network, token, recipient and confirmations
    const good = hash();
    h.receipts.set(good, transferReceipt({ from, amount: 500_000n }));
    const c1 = await h.call('POST', '/funding/confirm', { bearer: b.token, body: { txHash: good } });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    const c2 = await h.call('POST', '/funding/confirm', { bearer: b.token, body: { txHash: good } });
    assert.equal(c2.body.credited[0].alreadyCredited, true);
    assert.equal((await live(h, b.token)).available, '0.5');
    const row = h.db.prepare('SELECT * FROM chain_deposits').get() as Record<string, unknown>;
    assert.equal(row.tx_hash, good.toLowerCase());
    assert.equal(Number(row.chain_id), 42220);
    assert.equal(String(row.token), USDT.toLowerCase());
    assert.equal(String(row.to_address), DEP.toLowerCase());
    assert.equal(Number(row.confirmations), 11);
    assert.equal(row.verification, 'verified');
    assert.equal(BigInt(row.amount_atomic as bigint), 500_000n);
    assert.ok(String(row.credited_at).length > 10);

    // the purchase charges only a validated outcome, and the 3% fee is intact
    const run = await h.call('POST', '/execute', { bearer: b.token, body: { listingId: s.id, input: {}, idempotencyKey: 'prod-real-purchase-1' } });
    assert.equal(run.body.result.charged, true, JSON.stringify(run.body));
    assert.equal(run.body.result.asset, 'USDT');
    assert.equal((await live(h, b.token)).available, '0');
    assert.equal((await h.call('GET', '/me', { bearer: s.token })).body.live.earnings, '0.485');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('the configuration states the real network and token, and offers no demo switches', async () => {
  const h = await start();
  try {
    const cfg = (await h.call('GET', '/config')).body;
    assert.equal(cfg.realFunds, true);
    assert.equal(cfg.sandbox, false);
    assert.equal(cfg.escrow, null);
    assert.equal(cfg.network.chainId, 42220);
    assert.equal(cfg.network.name, 'Celo mainnet');
    assert.equal(cfg.network.token.symbol, 'USDT');
    assert.equal(cfg.network.token.address, USDT);
    assert.equal(cfg.network.depositAddress, DEP);
    assert.equal(cfg.network.platformFeePercent, 3);
  } finally {
    await h.close();
  }
});
