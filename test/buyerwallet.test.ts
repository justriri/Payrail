// Buyer-owned wallet connection for funding (SIMULATED provider). Proves ownership by signature, binds deposits to the
// buyer, and checks that the wallet can produce Textile's TakerControl authorization without sending anything to Textile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { fundingMessage, fundingMessageOnChain, TRANSFER_TOPIC } from '../src/funding.ts';
import { verifyLedger } from '../src/ledger.ts';
import type { MarketRuntime } from '../src/market.ts';
import { verifyDeposit } from '../src/marketfunding.ts';
import type { ConversionRuntime } from '../src/multifunding.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { takerControlTypedData } from '../src/takerproof.ts';
import { generateMasterKey } from '../src/vault.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const mk = generateMasterKey('k1');
const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;

async function start(o: { live?: boolean; sandbox?: boolean; simulated?: boolean } = {}) {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const provider = createSimProvider({ reactor: TEXTILE_REACTOR });
  const conversion: ConversionRuntime = {
    registry: new RouteRegistry(db, [provider]), provider, reader: provider.reader, reactor: TEXTILE_REACTOR, usdt: USDT, chainId: 42220, minConfirmations: 3,
    creditAsset: 'TESTUSDT', depositAddress: `0x${'0'.repeat(34)}dec051`, maxPerDayBuyAtomic: 10n ** 12n, simulated: o.simulated ?? true,
  };
  const market: MarketRuntime = {
    db, keys: [mk], activeKey: mk, sandbox: o.sandbox ?? true, conversion,
    ...(o.live ? { live: { funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: '0x1', minConfirmations: 1, maxDepositAtomic: 1n, reader: provider.reader }, payout: { payableAssets: ['USDT'], minAtomic: 1n, maxAtomic: 1n } } } : {}),
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'bw', market });
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
const newBuyer = async (h: H) => {
  const b = await h.call('POST', '/buyer');
  return { token: b.body.token as string, id: b.body.accountId as string };
};
/** real-funds mode has no anonymous buyers: sign in with a wallet signature, exactly as the browser does */
const walletBuyer = async (h: H) => {
  const k = privateKeyToAccount(generatePrivateKey());
  const s = await h.call('POST', '/buyer/login/start', undefined, { wallet: k.address, chainId: 42220 });
  const c = await h.call('POST', '/buyer/login/complete', undefined, { wallet: k.address, nonce: s.body.nonce, signature: await k.signMessage({ message: s.body.message }) });
  return { token: c.body.token as string, id: c.body.accountId as string };
};
const connect = async (h: H, b: { token: string; id: string }, key = generatePrivateKey()) => {
  const w = privateKeyToAccount(key);
  const signature = await w.signMessage({ message: fundingMessageOnChain(b.id, w.address.toLowerCase(), 42220) });
  const r = await h.call('POST', '/fund/wallet', b.token, { wallet: w.address, signature, chainId: 42220 });
  return { w, r };
};

test('wallet connection: ownership is proven by a chain-bound signature; wrong network, wrong signer and a taken wallet are refused', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h);
    const cfg = await h.call('GET', '/fund/wallet', b.token);
    assert.equal(cfg.body.expectedChainId, 42220);
    assert.equal(cfg.body.wallets.length, 0);

    const { w, r } = await connect(h, b);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.address, w.address.toLowerCase());
    assert.equal((await h.call('GET', '/fund/wallet', b.token)).body.wallets[0], w.address.toLowerCase());

    // wrong network reported by the wallet
    const b2 = await newBuyer(h);
    const w2 = privateKeyToAccount(generatePrivateKey());
    const sig2 = await w2.signMessage({ message: fundingMessageOnChain(b2.id, w2.address.toLowerCase(), 42220) });
    const wrongNet = await h.call('POST', '/fund/wallet', b2.token, { wallet: w2.address, signature: sig2, chainId: 1 });
    assert.equal(wrongNet.status, 422);
    assert.equal(wrongNet.body.code, 'WRONG_NETWORK');
    // a signature over the network-less message is not accepted by the chain-bound flow
    const legacy = await w2.signMessage({ message: fundingMessage(b2.id, w2.address.toLowerCase()) });
    assert.equal((await h.call('POST', '/fund/wallet', b2.token, { wallet: w2.address, signature: legacy, chainId: 42220 })).body.code, 'BAD_SIGNATURE');
    // someone else's signature, or a signature meant for another buyer
    const other = privateKeyToAccount(generatePrivateKey());
    const sigOther = await other.signMessage({ message: fundingMessageOnChain(b2.id, w2.address.toLowerCase(), 42220) });
    assert.equal((await h.call('POST', '/fund/wallet', b2.token, { wallet: w2.address, signature: sigOther, chainId: 42220 })).body.code, 'BAD_SIGNATURE');
    const forB1 = await w2.signMessage({ message: fundingMessageOnChain(b.id, w2.address.toLowerCase(), 42220) });
    assert.equal((await h.call('POST', '/fund/wallet', b2.token, { wallet: w2.address, signature: forB1, chainId: 42220 })).body.code, 'BAD_SIGNATURE');
    // a proven wallet cannot be claimed by a second buyer, even with their own valid signature
    const steal = await w.signMessage({ message: fundingMessageOnChain(b2.id, w.address.toLowerCase(), 42220) });
    assert.equal((await h.call('POST', '/fund/wallet', b2.token, { wallet: w.address, signature: steal, chainId: 42220 })).body.code, 'WALLET_TAKEN');
  } finally {
    await h.close();
  }
});

test('funding uses the proven wallet as the taker and credits only a deposit from that wallet', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h);
    const { w } = await connect(h, b);
    const q = await h.call('POST', '/fund/quote', b.token, { asset: 'wARS', amount: '1611' });
    assert.equal(q.status, 201, q.text);
    assert.equal(q.body.operation.taker, w.address.toLowerCase(), 'the wallet that fills and receives is the buyer\'s proven wallet');
    const ok = await h.call('POST', '/fund/approve', b.token, { opId: q.body.operation.id, digest: q.body.operation.approvalDigest });
    assert.equal(ok.body.operation.state, 'CREDITED', ok.text);
    assert.equal((await h.call('GET', '/me', b.token)).body.available, ok.body.operation.credited);
    assert.equal((await h.call('GET', '/me', b.token)).body.live, undefined, 'simulated funding is never presented as real USDT');
    assert.deepEqual(verifyLedger(h.db), { ok: true, problems: [] });
  } finally {
    await h.close();
  }
});

test('deposit attribution: a transfer from any other wallet, to any other address, or in any other token is not credited', () => {
  const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  const buyerWallet = '0x00000000000000000000000000000000000000b1';
  const custody = '0x00000000000000000000000000000000000dec51';
  const rcpt = (token: string, from: string, to: string) => ({ status: 'success' as const, blockNumber: 100n, logs: [{ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(5n), logIndex: 0 }] });
  const e = { usdt: USDT, from: buyerWallet, to: custody, minConfirmations: 3 };
  assert.equal(verifyDeposit(rcpt(USDT, buyerWallet, custody), 200n, e).kind, 'confirmed');
  assert.equal(verifyDeposit(rcpt(USDT, '0x00000000000000000000000000000000000000b2', custody), 200n, e).kind, 'mismatch', 'someone else\'s wallet');
  assert.equal(verifyDeposit(rcpt(USDT, buyerWallet, '0x00000000000000000000000000000000000000ee'), 200n, e).kind, 'mismatch', 'wrong recipient');
  assert.equal(verifyDeposit(rcpt('0x00000000000000000000000000000000000000cc', buyerWallet, custody), 200n, e).kind, 'mismatch', 'wrong token');
  assert.equal(verifyDeposit(rcpt(USDT, buyerWallet, custody), 101n, e).kind, 'pending', 'not enough confirmations');
  assert.equal(verifyDeposit({ status: 'reverted', blockNumber: 100n, logs: [] }, 200n, e).kind, 'reverted');
});

test('taker authorization check: the wallet signs Textile\'s TakerControl typed data; it is verified here and never sent to Textile', async () => {
  const h = await start();
  try {
    const b = await newBuyer(h);
    assert.equal((await h.call('POST', '/fund/wallet/authorization-check', b.token, {})).body.code, 'NO_FUNDING_WALLET');
    const { w } = await connect(h, b);
    const req = await h.call('POST', '/fund/wallet/authorization-check', b.token, {});
    assert.equal(req.status, 200, req.text);
    assert.equal(req.body.typedData.domain.name, 'Textile Taker Control');
    assert.equal(req.body.typedData.primaryType, 'TakerControl');
    assert.equal(req.body.typedData.message.taker.toLowerCase(), w.address.toLowerCase());
    const { nonce, issuedAt } = req.body;
    const t = takerControlTypedData(w.address, 42220, nonce, issuedAt);
    const signature = await w.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const ok = await h.call('POST', '/fund/wallet/authorization-check', b.token, { nonce, issuedAt, signature });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.verified, true);
    assert.equal(ok.body.sentToTextile, false);
    // a different key, a changed nonce, and a stale request all fail
    const imposter = privateKeyToAccount(generatePrivateKey());
    const ti = takerControlTypedData(w.address, 42220, nonce, issuedAt);
    const bad = await imposter.signTypedData({ domain: ti.domain, types: ti.types, primaryType: ti.primaryType, message: ti.message });
    assert.equal((await h.call('POST', '/fund/wallet/authorization-check', b.token, { nonce, issuedAt, signature: bad })).body.code, 'BAD_SIGNATURE');
    assert.equal((await h.call('POST', '/fund/wallet/authorization-check', b.token, { nonce: `0x${'11'.repeat(32)}`, issuedAt, signature })).body.code, 'BAD_SIGNATURE');
    assert.equal((await h.call('POST', '/fund/wallet/authorization-check', b.token, { nonce, issuedAt: issuedAt - 10 * 60_000, signature })).body.code, 'PROOF_EXPIRED');
  } finally {
    await h.close();
  }
});

test('demo wallet exists only in simulation; real-funds mode requires a proven wallet; a live provider needs real-funds mode', async () => {
  const sim = await start();
  const noSandbox = await start({ sandbox: false });
  const liveBad = await start({ simulated: false });
  const live = await start({ simulated: false, live: true, sandbox: false });
  try {
    const b = await newBuyer(sim);
    const demo = await sim.call('POST', '/fund/wallet', b.token, { demo: true, chainId: 42220 });
    assert.equal(demo.status, 201, demo.text);
    assert.equal(demo.body.demo, true);
    const chk = await sim.call('POST', '/fund/wallet/authorization-check', b.token, {});
    const done = await sim.call('POST', '/fund/wallet/authorization-check', b.token, { demo: true, nonce: chk.body.nonce, issuedAt: chk.body.issuedAt, signature: '0x' });
    assert.equal(done.body.verified, true, done.text);

    const n = await newBuyer(noSandbox);
    assert.equal((await noSandbox.call('POST', '/fund/wallet', n.token, { demo: true, chainId: 42220 })).body.code, 'SANDBOX_DISABLED');

    const lb = await newBuyer(liveBad);
    assert.equal((await liveBad.call('POST', '/fund/quote', lb.token, { asset: 'cNGN', amount: '1364' })).body.code, 'LIVE_DISABLED');

    const l = await walletBuyer(live);
    assert.equal((await live.call('POST', '/fund/quote', l.token, { asset: 'cNGN', amount: '1364' })).body.code, 'NO_FUNDING_WALLET');
    assert.equal((await live.call('POST', '/fund/wallet', l.token, { demo: true, chainId: 42220 })).body.code, 'SANDBOX_DISABLED');
  } finally {
    await sim.close();
    await noSandbox.close();
    await liveBad.close();
    await live.close();
  }
});
