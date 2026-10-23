// Keystore: passphrase-protected key file + the browser unlock endpoint. Keys here are throwaway test keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { KeystoreError, decryptKey, encryptKey } from '../src/keystore.ts';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const PASS = 'correct horse battery staple';

test('keystore: round trip; the file holds no plaintext key; wrong passphrase, tampering and weak passphrases are refused', () => {
  const key = generatePrivateKey();
  const f = encryptKey(key, PASS);
  assert.equal(f.address, privateKeyToAccount(key).address.toLowerCase());
  assert.equal(decryptKey(f, PASS), key);
  const text = JSON.stringify(f);
  assert.ok(!text.includes(key.slice(2)), 'the key is not in the file');
  assert.throws(() => decryptKey(f, 'wrong passphrase!!'), (e: unknown) => e instanceof KeystoreError && e.code === 'BAD_PASSPHRASE');
  const flipped = { ...f, ciphertext: (parseInt(f.ciphertext.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + f.ciphertext.slice(2) };
  assert.throws(() => decryptKey(flipped, PASS), (e: unknown) => e instanceof KeystoreError && e.code === 'BAD_PASSPHRASE');
  // the address is authenticated: swapping it makes the file fail
  assert.throws(() => decryptKey({ ...f, address: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() }, PASS), KeystoreError);
  assert.throws(() => encryptKey(key, 'short'), (e: unknown) => e instanceof KeystoreError && e.code === 'WEAK_PASSPHRASE');
  assert.throws(() => encryptKey('0x1234', PASS), (e: unknown) => e instanceof KeystoreError && e.code === 'BAD_KEY');
  assert.throws(() => decryptKey({ ...f, N: 2 }, PASS), (e: unknown) => e instanceof KeystoreError && e.code === 'BAD_FILE');
});

test('unlock endpoint: wrong passphrase fails and is rate limited; right passphrase enables signing; lock disables it; the key never appears', async () => {
  const key = generatePrivateKey();
  const file = encryptKey(key, PASS);
  let unlocked = false;
  const base = createSimulatedRuntime({ scenario: 'ok', delayMs: 5 });
  const rt = {
    ...base,
    get signing() {
      return unlocked;
    },
    signer: {
      canUnlock: () => !unlocked,
      async unlock(p: string) {
        try {
          decryptKey(file, p);
          unlocked = true;
          return { ok: true as const };
        } catch {
          return { ok: false as const, message: 'Wrong passphrase.' };
        }
      },
      lock() {
        unlocked = false;
      },
    },
  };
  const { server, token } = createWebServer(rt, { token: 'unlock-token' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base_ = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base_ + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': token, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  try {
    const st = (await (await fetch(base_ + '/api/status')).json()) as any;
    assert.equal(st.signing, false);
    assert.equal(st.canUnlock, true);

    assert.equal((await post('/api/unlock', { passphrase: 'nope' })).status, 401);
    assert.equal((await post('/api/unlock', {}, {})).status, 400);
    assert.equal((await post('/api/unlock', { passphrase: PASS }, { 'x-payrail-token': 'wrong' })).status, 403, 'needs the page token');
    assert.equal((await post('/api/unlock', { passphrase: PASS }, { origin: 'http://evil.example' })).status, 403, 'needs a same-origin request');

    const ok = await post('/api/unlock', { passphrase: PASS });
    assert.equal(ok.status, 200);
    assert.ok(!ok.text.includes(key.slice(2)) && !ok.text.includes(PASS));
    assert.equal(((await (await fetch(base_ + '/api/status')).json()) as any).signing, true);
    assert.equal((await post('/api/lock', {})).status, 200);
    assert.equal(((await (await fetch(base_ + '/api/status')).json()) as any).signing, false);

    // brute force is throttled: 5 attempts per minute in total
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await post('/api/unlock', { passphrase: `guess-${i}` })).status;
    assert.equal(last, 429);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
