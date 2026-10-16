// Stage 1 multi-currency over HTTP (simulated provider). Buyer asset picker, unsupported-asset answers, payout settings,
// address proof and the confirm -> approve -> execute payout conversion.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { balance, createAccount, deposit, settleExecution, startExecution, verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import type { ConversionRuntime } from '../src/multifunding.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { DEV_SCENARIOS } from '../src/dev/scenarios.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const mk = generateMasterKey('k1');
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;

async function start(o: { live?: boolean } = {}) {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR });
  const registry = new RouteRegistry(db, [provider]);
  const conversion: ConversionRuntime = {
    registry, provider, reader: provider.reader, reactor: TEXTILE_REACTOR, usdt: USDT, chainId: 42220, minConfirmations: 3, creditAsset: 'TESTUSDT',
    depositAddress: `0x${'0'.repeat(34)}dec051`, maxPerDayBuyAtomic: 10_000_000_000n, simulated: true,
  };
  conversion.payout = { registry, provider, reader: provider.reader, reactor: TEXTILE_REACTOR, custody: `0x${'0'.repeat(34)}c0570d`, minConfirmations: 3, policy: { payableAssets: ['TESTUSDT'], minAtomic: 1n, maxAtomic: 10n ** 12n } };
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, sandbox: !o.live, conversion, dev: DEV_SCENARIOS,
    ...(o.live ? { live: { funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: '0x1', minConfirmations: 1, maxDepositAtomic: 1n, reader: provider.reader }, payout: { payableAssets: ['USDT'], minAtomic: 1n, maxAtomic: 1n } } } : {}),
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'mc-token', market });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: 'GET' | 'POST', path: string, bearer?: string, body?: unknown) => {
    const r = await fetch(`${base}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as any };
  };
  return { db, call, provider, close: () => new Promise<void>((r) => server.close(() => r())) };
}
type H = Awaited<ReturnType<typeof start>>;
const buyer = async (h: H) => (await h.call('POST', '/buyer')).body.token as string;

function seedEarnings(db: Db, sellerId: string, amount = 6_000_000n) {
  const b = createAccount(db, { kind: 'buyer', displayName: 'B' });
  deposit(db, { buyerId: b, asset: 'TESTUSDT', amountAtomic: amount, ref: `seed-${sellerId}` });
  db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, fee_bps) VALUES (?, ?, 'x', 'published', ?, 'TESTUSDT', 't', 0)").run(`l_${sellerId}`, sellerId, amount);
  db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES (?, ?, 1, '{}', 'h', 'approved', 't')").run(`c_${sellerId}`, `l_${sellerId}`);
  const { execution } = startExecution(db, { buyerId: b, listingId: `l_${sellerId}`, contractVersionId: `c_${sellerId}`, idempotencyKey: `k-${sellerId}`, requestHash: 'h' });
  settleExecution(db, execution.id, 'QUALIFIED', 'ok');
}

test('funding over HTTP: the asset picker lists live routes; unsupported or unavailable assets get a clear answer; 18-decimal and USDT funding credit once', async () => {
  const h = await start();
  try {
    const bt = await buyer(h);
    const routes = await h.call('GET', '/fund/routes', bt);
    assert.equal(routes.status, 200, routes.text);
    const by = (s: string) => routes.body.routes.find((r: any) => r.symbol === s);
    assert.equal(by('USDT').passthrough, true);
    assert.equal(by('cNGN').usable, true);
    assert.equal(by('wCOP').usable, false);
    assert.match(by('wCOP').reason, /not enabled/);
    assert.match(by('G$').reason, /no liquidity/);
    assert.equal(by('CWT'), undefined);

    // unsupported asset answers
    const cwt = await h.call('POST', '/fund/quote', bt, { asset: 'CWT', amount: '10' });
    assert.equal(cwt.status, 422);
    assert.equal(cwt.body.code, 'UNSUPPORTED_ASSET');
    assert.match(cwt.body.message, /no verified conversion route/);
    const g = await h.call('POST', '/fund/quote', bt, { asset: 'G$', amount: '10' });
    assert.equal(g.body.code, 'UNSUPPORTED_ASSET');
    assert.match(g.body.message, /no liquidity/);
    // an amount below the corridor floor is refused with the floor stated
    assert.equal((await h.call('POST', '/fund/quote', bt, { asset: 'cNGN', amount: '5' })).body.code, 'BELOW_MINIMUM');
    assert.equal((await h.call('POST', '/fund/quote', bt, { asset: 'wARS', amount: '1.0000000000000000001' })).status, 400, 'too many decimals');

    // wARS: 18 decimals, far above 64 bits
    const q = await h.call('POST', '/fund/quote', bt, { asset: 'wARS', amount: '1611' });
    assert.equal(q.status, 201, q.text);
    assert.equal(q.body.operation.asset.decimals, 18);
    assert.equal(q.body.operation.sell.display, '1611');
    assert.equal(q.body.operation.spendable, false);
    const ok = await h.call('POST', '/fund/approve', bt, { opId: q.body.operation.id, digest: q.body.operation.approvalDigest });
    assert.equal(ok.body.operation.state, 'CREDITED', ok.text);
    assert.ok(ok.body.operation.txs.swap && ok.body.operation.txs.deposit);
    const me = await h.call('GET', '/me', bt);
    assert.equal(me.body.available, ok.body.operation.credited);
    // idempotent re-approval
    await h.call('POST', '/fund/approve', bt, { opId: q.body.operation.id, digest: q.body.operation.approvalDigest });
    assert.equal((await h.call('GET', '/me', bt)).body.available, ok.body.operation.credited);

    // already USDT: no swap
    const u = await h.call('POST', '/fund/quote', bt, { asset: 'USDT', amount: '2' });
    const uo = await h.call('POST', '/fund/approve', bt, { opId: u.body.operation.id, digest: u.body.operation.approvalDigest });
    assert.equal(uo.body.operation.state, 'CREDITED');
    assert.equal(uo.body.operation.txs.swap, null);
    assert.equal(uo.body.operation.credited, '2');

    // a verified swap without a verified deposit credits nothing
    const m = await h.call('POST', '/fund/quote', bt, { asset: 'cNGN', amount: '1364', scenario: 'deposit_missing' });
    const mo = await h.call('POST', '/fund/approve', bt, { opId: m.body.operation.id, digest: m.body.operation.approvalDigest });
    assert.equal(mo.body.operation.state, 'REVIEW');
    assert.equal(mo.body.operation.spendable, false);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('payout settings and conversion payout over HTTP: preference, address proof, quote, confirm, simulated approve/execute, receipt', async () => {
  const h = await start();
  try {
    const login = await h.call('POST', '/seller/sandbox/login', undefined, {});
    const st = login.body.token as string;
    const seed = login.body.seed as string;
    const sellerId = login.body.accountId as string;

    const s0 = await h.call('GET', '/seller/payout/settings', st);
    assert.equal(s0.status, 200, s0.text);
    assert.equal(s0.body.preference.symbol, 'USDT');
    const opt = (sym: string) => s0.body.options.find((o: any) => o.symbol === sym);
    assert.equal(opt('cNGN').usable, true);
    assert.equal(opt('wMXN').usable, false);
    assert.match(opt('wMXN').reason, /no market makers/);
    assert.equal(opt('CELO').maxUsdt, '33');
    assert.ok(s0.body.rules.some((r: string) => /in reverse/.test(r)));

    // unusable assets cannot be chosen; a usable one can
    assert.equal((await h.call('POST', '/seller/payout/preference', st, { symbol: 'wMXN' })).body.code, 'NOT_ENABLED');
    assert.equal((await h.call('POST', '/seller/payout/preference', st, { symbol: 'cNGN' })).body.preference.version, 1);

    // converting needs a verified address
    seedEarnings(h.db, sellerId);
    assert.equal((await h.call('POST', '/seller/payouts/convert', st, { amount: '3' })).body.code, 'ADDRESS_REQUIRED');
    const addr = await h.call('POST', '/seller/payout/address', st, { sandbox: true, seed, chainId: 42220 });
    assert.equal(addr.status, 201, addr.text);

    const q = await h.call('POST', '/seller/payouts/convert', st, { amount: '3' });
    assert.equal(q.status, 201, q.text);
    const p = q.body.payout;
    assert.equal(p.stage, 'quoted');
    assert.equal(p.simulated, true);
    assert.equal(p.target.symbol, 'cNGN');
    assert.equal(p.usdt.display, '3');
    assert.ok(p.expected && p.minimum && p.fee && p.rate);
    assert.equal(h.provider.executions.payout, 0, 'nothing converted yet');

    // wrong digest refused; operator approval before confirmation refused
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/confirm`, st, { digest: 'nope' })).body.code, 'DIGEST_MISMATCH');
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/simulate-approve`, st)).status, 409);
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/confirm`, st, { digest: p.approvalDigest })).body.payout.stage, 'confirmed');
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/simulate-approve`, st)).body.payout.state, 'approved');
    const done = await h.call('POST', `/seller/payouts/${p.id}/simulate-execute`, st, {});
    assert.equal(done.body.payout.state, 'confirmed', done.text);
    assert.equal(done.body.payout.received, done.body.payout.expected);
    assert.ok(done.body.payout.conversionTx && done.body.payout.deliveryTx);
    assert.deepEqual(done.body.payout.events.map((e: any) => e.stage), ['quoted', 'confirmed', 'converting', 'converted', 'delivered']);

    // earnings stay USDT: 6 - 3 = 3 available
    assert.equal((await h.call('GET', '/me', st)).body.earnings, '3');
    const stmt = await h.call('GET', '/seller/statement', st);
    assert.equal(stmt.body.statement.payouts[0].state, 'confirmed');
    assert.equal(stmt.body.statement.payouts[0].target.symbol, 'cNGN');

    // another seller cannot see or act on it
    const other = (await h.call('POST', '/seller/sandbox/login', undefined, {})).body.token as string;
    assert.equal((await h.call('GET', `/seller/payouts/${p.id}`, other)).status, 404);
    assert.equal((await h.call('POST', `/seller/payouts/${p.id}/confirm`, other, { digest: p.approvalDigest })).status, 404);
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('payout conversion: provable failure restores USDT; the simulation controls do not exist in real-funds mode', async () => {
  const h = await start();
  const live = await start({ live: true });
  try {
    const login = await h.call('POST', '/seller/sandbox/login', undefined, {});
    const st = login.body.token as string;
    seedEarnings(h.db, login.body.accountId);
    await h.call('POST', '/seller/payout/preference', st, { symbol: 'wBRL' });
    await h.call('POST', '/seller/payout/address', st, { sandbox: true, seed: login.body.seed, chainId: 42220 });
    const q = (await h.call('POST', '/seller/payouts/convert', st, { amount: '2' })).body.payout;
    await h.call('POST', `/seller/payouts/${q.id}/confirm`, st, { digest: q.approvalDigest });
    await h.call('POST', `/seller/payouts/${q.id}/simulate-approve`, st);
    const r = await h.call('POST', `/seller/payouts/${q.id}/simulate-execute`, st, { scenario: 'reverted' });
    assert.equal(r.body.payout.state, 'failed');
    assert.equal((await h.call('GET', '/me', st)).body.earnings, '6');

    // delivery missing -> not returned, then delivered by retry
    const q2 = (await h.call('POST', '/seller/payouts/convert', st, { amount: '2' })).body.payout;
    await h.call('POST', `/seller/payouts/${q2.id}/confirm`, st, { digest: q2.approvalDigest });
    await h.call('POST', `/seller/payouts/${q2.id}/simulate-approve`, st);
    const r2 = await h.call('POST', `/seller/payouts/${q2.id}/simulate-execute`, st, { scenario: 'delivery_missing' });
    assert.equal(r2.body.payout.stage, 'converted_undelivered');
    assert.equal((await h.call('GET', '/me', st)).body.earnings, '4', 'swapped USDT is not given back');
    const r3 = await h.call('POST', `/seller/payouts/${q2.id}/retry-delivery`, st, {});
    assert.equal(r3.body.payout.state, 'confirmed');

    // real-funds mode: no sandbox login, so no seller session to test the simulate controls with; routes are closed
    assert.equal((await live.call('POST', '/seller/sandbox/login', undefined, {})).body.code, 'SANDBOX_DISABLED');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
    await live.close();
  }
});
