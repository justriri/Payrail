// Credential vault: nothing secret may reach the database, logs or any returned metadata; tampering must fail closed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAccount } from '../src/ledger.ts';
import { openDb, query } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import {
  VaultError, assertHeaderName, generateMasterKey, listCredentials, masterKeyFrom, openForGateway, putCredential, redact, revokeCredential, rewrapAll,
} from '../src/vault.ts';
import { tempDir } from './support.ts';

const SECRET = 'sk_fixture_9f8e7d6c5b4a39281706aabbccddeeff';
const T0 = 1_800_000_000_000;

function listing(db: Db, name = 'l1') {
  const seller = createAccount(db, { kind: 'seller', displayName: 'S' }, () => T0);
  const id = `lst_${name}_${seller}`;
  db.prepare("INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at) VALUES (?, ?, 'n', 'draft', 1000, 'USDT', 't')").run(id, seller);
  return { id, seller };
}
const put = (db: Db, mk: ReturnType<typeof generateMasterKey>, listingId: string, value = SECRET, label = 'api-key', header = 'Authorization') =>
  putCredential(db, mk, { listingId, label, headerName: header, value, actor: 'seller-1' }, () => T0);

test('round trip: the gateway gets the plaintext back; the same data is useless without the master key', () => {
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  put(db, mk, id);
  const got = openForGateway(db, [mk], id, 'gateway-execution', () => T0);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.value, SECRET);
  assert.equal(got[0]!.headerName, 'Authorization');
  assert.throws(() => openForGateway(db, [generateMasterKey('k1')], id, 'gateway-execution'), (e: unknown) => e instanceof VaultError && e.code === 'DECRYPT_FAILED');
  assert.throws(() => openForGateway(db, [], id, 'gateway-execution'), (e: unknown) => e instanceof VaultError && e.code === 'UNKNOWN_KEY');
});

test('no plaintext at rest: not in any column, not in the database FILE (including the WAL), not in the audit log', () => {
  const dir = tempDir();
  const file = join(dir, 'vault.db');
  const db = openDb(file);
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  put(db, mk, id);
  openForGateway(db, [mk], id, 'gateway-execution', () => T0);

  const dump = JSON.stringify(
    query(db, 'SELECT * FROM credentials').map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]))),
  );
  assert.ok(!dump.includes(SECRET), 'no column holds the secret');
  assert.ok(!JSON.stringify(query(db, 'SELECT * FROM audit_log').map((r) => ({ ...r })), (_k: string, v: unknown) => (typeof v === 'bigint' ? String(v) : v)).includes(SECRET));
  for (const f of readdirSync(dir)) {
    assert.ok(!readFileSync(join(dir, f)).includes(Buffer.from(SECRET)), `${f} contains the plaintext`);
    assert.ok(!readFileSync(join(dir, f)).includes(mk.key), `${f} contains the master key`);
  }
});

test('metadata lists labels and versions, never values', () => {
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  put(db, mk, id);
  const meta = listCredentials(db, id);
  assert.equal(meta.length, 1);
  assert.deepEqual(Object.keys(meta[0]!).sort(), ['createdAt', 'headerName', 'id', 'keyId', 'label', 'listingId', 'revokedAt', 'status', 'version']);
  assert.ok(!JSON.stringify(meta).includes(SECRET));
});

test('rotation: a new version becomes active and the old one is retired and unusable; revocation stops use at once', () => {
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  const v1 = put(db, mk, id, 'first-secret-value');
  const v2 = put(db, mk, id, 'second-secret-value');
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  const meta = listCredentials(db, id);
  assert.deepEqual(meta.map((m) => `${m.version}:${m.status}`), ['1:rotated', '2:active']);
  const used = openForGateway(db, [mk], id, 'gateway-execution');
  assert.deepEqual(used.map((u) => u.value), ['second-secret-value']);

  const revoked = revokeCredential(db, v2.id, 'seller-1', () => T0);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedAt !== null, true);
  assert.deepEqual(openForGateway(db, [mk], id, 'gateway-execution'), [], 'nothing usable after revocation');
  assert.equal(revokeCredential(db, v2.id, 'seller-1').status, 'revoked', 'idempotent');
  assert.throws(() => revokeCredential(db, 'cred_missing', 'x'), (e: unknown) => e instanceof VaultError && e.code === 'NOT_FOUND');
});

test('binding: a ciphertext moved to another listing or version fails authentication (fails closed)', () => {
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const a = listing(db, 'a');
  const b = listing(db, 'b');
  const ca = put(db, mk, a.id, 'secret-for-listing-a');
  put(db, mk, b.id, 'secret-for-listing-b');
  // an attacker with write access copies A's encrypted blobs over B's row
  const rowA = query(db, 'SELECT * FROM credentials WHERE id = ?', ca.id)[0]!;
  db.prepare("UPDATE credentials SET iv = ?, ciphertext = ?, tag = ?, wrapped_dek = ? WHERE listing_id = ?").run(
    rowA.iv as Uint8Array, rowA.ciphertext as Uint8Array, rowA.tag as Uint8Array, rowA.wrapped_dek as Uint8Array, b.id,
  );
  assert.throws(() => openForGateway(db, [mk], b.id, 'gateway-execution'), (e: unknown) => e instanceof VaultError && e.code === 'DECRYPT_FAILED');
  // flipping a ciphertext bit is detected
  const db2 = openDb(':memory:');
  const l = listing(db2);
  put(db2, mk, l.id);
  const r = query(db2, 'SELECT ciphertext FROM credentials')[0]!;
  const bad = Buffer.from(r.ciphertext as Uint8Array);
  bad[0] = bad[0]! ^ 1;
  db2.prepare('UPDATE credentials SET ciphertext = ?').run(bad);
  assert.throws(() => openForGateway(db2, [mk], l.id, 'gateway-execution'), (e: unknown) => e instanceof VaultError && e.code === 'DECRYPT_FAILED');
});

test('decrypt errors never contain keys, ciphertext or the secret', () => {
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  put(db, mk, id);
  try {
    openForGateway(db, [generateMasterKey('k1')], id, 'gateway-execution');
    assert.fail('should have thrown');
  } catch (e) {
    const m = String((e as Error).message);
    assert.ok(!m.includes(SECRET) && !m.includes(mk.key.toString('hex')) && !m.includes(mk.key.toString('base64')));
  }
});

test('master-key rotation re-wraps data keys without decrypting or changing any secret', () => {
  const db = openDb(':memory:');
  const oldKey = generateMasterKey('old');
  const newKey = generateMasterKey('new');
  const { id } = listing(db);
  put(db, oldKey, id);
  assert.throws(() => rewrapAll(db, generateMasterKey('old'), newKey, 'operator'), /./, 'a wrong old key is not silently accepted');
  assert.equal(openForGateway(db, [oldKey], id, 'gateway-execution')[0]!.value, SECRET, 'a failed rewrap changed nothing');
  const before =Buffer.from(query(db, 'SELECT ciphertext FROM credentials')[0]!.ciphertext as Uint8Array);
  assert.equal(rewrapAll(db, oldKey, newKey, 'operator', () => T0), 1);
  const after = Buffer.from(query(db, 'SELECT ciphertext FROM credentials')[0]!.ciphertext as Uint8Array);
  assert.ok(before.equals(after), 'the secret ciphertext is untouched');
  assert.equal(openForGateway(db, [newKey], id, 'gateway-execution')[0]!.value, SECRET);
  assert.throws(() => openForGateway(db, [oldKey], id, 'gateway-execution'), (e: unknown) => e instanceof VaultError && e.code === 'UNKNOWN_KEY');
  assert.equal(rewrapAll(db, oldKey, newKey, 'operator'), 0, 'nothing left under the old key');
});

test('validation: dangerous header names and values are refused; keys parse from hex and base64 only at 32 bytes', () => {
  for (const h of ['Host', 'content-length', 'Cookie', 'X-Forwarded-For', 'Transfer-Encoding', 'bad header', 'a:b', '1x', '']) {
    assert.throws(() => assertHeaderName(h), (e: unknown) => e instanceof VaultError && e.code === 'BAD_HEADER', h);
  }
  assertHeaderName('Authorization');
  assertHeaderName('X-Api-Key');
  const db = openDb(':memory:');
  const mk = generateMasterKey('k1');
  const { id } = listing(db);
  assert.throws(() => put(db, mk, id, 'line1\r\nX-Evil: 1'), (e: unknown) => e instanceof VaultError && e.code === 'BAD_VALUE');
  assert.throws(() => put(db, mk, id, ''), (e: unknown) => e instanceof VaultError && e.code === 'BAD_VALUE');
  assert.throws(() => put(db, mk, 'lst_missing', 'x'.repeat(8)), (e: unknown) => e instanceof VaultError && e.code === 'NOT_FOUND');

  assert.equal(masterKeyFrom('a', 'ab'.repeat(32)).key.length, 32);
  assert.equal(masterKeyFrom('a', Buffer.alloc(32, 7).toString('base64')).key.length, 32);
  assert.throws(() => masterKeyFrom('a', 'too-short'), (e: unknown) => e instanceof VaultError && e.code === 'BAD_KEY');
  assert.throws(() => masterKeyFrom('bad id!', 'ab'.repeat(32)), (e: unknown) => e instanceof VaultError && e.code === 'BAD_KEY');
});

test('redact removes every occurrence of a secret value (and ignores trivially short ones)', () => {
  assert.equal(redact(`token=${SECRET}; again ${SECRET}.`, [SECRET]), 'token=***; again ***.');
  assert.equal(redact('abc', ['a']), 'abc', 'a 1-character "secret" is not redacted (it would shred the text)');
});

test('structural: only the vault (and the future gateway module) may reference openForGateway', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !['vault.ts', 'gateway.ts'].includes(f))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('openForGateway'));
  assert.deepEqual(offenders, []);
});
