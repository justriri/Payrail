// Buyer wallet sign-in: signature, network, single use, expiry, per-role accounts, session works as a buyer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openDb } from '../src/db.ts';
import { authenticate } from '../src/seller.ts';
import { completeBuyerLogin, startBuyerLogin } from '../src/walletauth.ts';

const T0 = 1_800_000_000_000;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? 'other';
  }
};

test('wallet sign-in creates one buyer account, binds the network, and rejects replay, wrong signer, wrong chain and expiry', async () => {
  const db = openDb(':memory:');
  let clock = T0;
  const now = () => clock;
  const k = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());

  // wrong network is refused before any challenge exists
  assert.equal(await code(() => startBuyerLogin(db, { wallet: k.address, chainId: 1, expectedChainId: 42220 }, now)), 'WRONG_NETWORK');
  assert.equal(await code(() => startBuyerLogin(db, { wallet: 'nope', chainId: 42220, expectedChainId: 42220 }, now)), 'BAD_INPUT');

  const s = startBuyerLogin(db, { wallet: k.address, chainId: 42220, expectedChainId: 42220 }, now);
  assert.match(s.message, /Network: chain 42220/);
  assert.match(s.message, /no access to your funds/);
  // signed by someone else
  assert.equal(await code(completeBuyerLogin(db, { wallet: k.address, nonce: s.nonce, signature: await other.signMessage({ message: s.message }) }, now)), 'BAD_SIGNATURE');
  // a challenge for wallet A cannot be completed as wallet B
  assert.equal(await code(completeBuyerLogin(db, { wallet: other.address, nonce: s.nonce, signature: await other.signMessage({ message: s.message }) }, now)), 'NONCE_INVALID');

  const sig = await k.signMessage({ message: s.message });
  const first = await completeBuyerLogin(db, { wallet: k.address, nonce: s.nonce, signature: sig }, now);
  assert.equal(first.created, true);
  assert.equal(authenticate(db, first.token, now), first.accountId);
  // single use
  assert.equal(await code(completeBuyerLogin(db, { wallet: k.address, nonce: s.nonce, signature: sig }, now)), 'NONCE_INVALID');

  // signing in again returns the SAME account
  const s2 = startBuyerLogin(db, { wallet: k.address.toUpperCase().replace('0X', '0x'), chainId: 42220, expectedChainId: 42220 }, now);
  const second = await completeBuyerLogin(db, { wallet: k.address, nonce: s2.nonce, signature: await k.signMessage({ message: s2.message }) }, now);
  assert.equal(second.accountId, first.accountId);
  assert.equal(second.created, false);

  // expiry
  const s3 = startBuyerLogin(db, { wallet: k.address, chainId: 42220, expectedChainId: 42220 }, now);
  clock += 6 * 60_000;
  assert.equal(await code(completeBuyerLogin(db, { wallet: k.address, nonce: s3.nonce, signature: await k.signMessage({ message: s3.message }) }, now)), 'NONCE_INVALID');
});

test('HTTP: wallet sign-in yields a working buyer session; wrong chain and bad signature are refused with clear codes', async () => {
  const { createWebServer } = await import('../src/webapi.ts');
  const { createSimulatedRuntime } = await import('../src/websim.ts');
  const { generateMasterKey } = await import('../src/vault.ts');
  const mk = generateMasterKey('k1');
  const db = openDb(':memory:');
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'wa', market: { db, keys: [mk], activeKey: mk, sandbox: true } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/market`;
  const post = async (path: string, body: unknown, bearer?: string) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const k = privateKeyToAccount(generatePrivateKey());
    const wrong = await post('/buyer/login/start', { wallet: k.address, chainId: 1 });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.code, 'WRONG_NETWORK');
    const s = await post('/buyer/login/start', { wallet: k.address, chainId: 42220 });
    assert.equal(s.status, 200);
    const bad = await post('/buyer/login/complete', { wallet: k.address, nonce: s.body.nonce, signature: `0x${'11'.repeat(65)}` });
    assert.equal(bad.status, 422);
    const done = await post('/buyer/login/complete', { wallet: k.address, nonce: s.body.nonce, signature: await k.signMessage({ message: s.body.message }) });
    assert.equal(done.status, 201);
    const me = await fetch(base + '/me', { headers: { authorization: `Bearer ${done.body.token}` } });
    assert.equal(me.status, 200);
    const credits = await post('/credits', { amount: '1' }, done.body.token);
    assert.equal(credits.body.ok, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
