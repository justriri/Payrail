// Seller credential vault: envelope encryption at rest.
//
//   secret ──AES-256-GCM(DEK)──▶ ciphertext          DEK = a fresh random 32-byte key PER secret VERSION
//   DEK ─────AES-256-GCM(master)─▶ wrapped_dek       master key = held OUTSIDE the database (env / key file)
//
// GUARANTEES
//   * The database holds only ciphertext + wrapped keys. Plaintext secrets never touch a column, a log or a URL.
//   * Binding: the secret is encrypted with the credential id, listing and version as AAD, so a ciphertext copied to
//     another row, listing or version fails authentication.
//   * Rotation creates a new version and retires the previous one. Revocation makes a credential unusable at once.
//   * `openForGateway` is the ONLY function that returns plaintext. It records an audit entry (never the value) and
//     refuses revoked or rotated versions. Only the gateway may import it (enforced by a structural test).
//   * Master-key rotation re-wraps data keys without ever decrypting the secrets (`rewrapAll`).
//   * `redact` removes secret values from any text before it is logged or returned.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';

export class VaultError extends Error {
  code: 'BAD_KEY' | 'BAD_HEADER' | 'BAD_VALUE' | 'NOT_FOUND' | 'REVOKED' | 'DECRYPT_FAILED' | 'UNKNOWN_KEY';
  constructor(code: VaultError['code'], message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export interface MasterKey {
  /** Public identifier of this key (stored beside each wrapped data key so rotation is possible). */
  id: string;
  /** 32 raw bytes. Never logged, never stored in the database. */
  key: Buffer;
}

const ALG = 'aes-256-gcm';

/** Parse a master key from hex or base64 (for example the value of PAYRAIL_VAULT_KEY loaded with --env-file). */
export function masterKeyFrom(id: string, material: string): MasterKey {
  const s = material.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else {
    key = Buffer.from(s, 'base64');
    if (key.length !== 32) throw new VaultError('BAD_KEY', 'the vault master key must be 32 bytes (64 hex characters or base64)');
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) throw new VaultError('BAD_KEY', 'invalid key id');
  return { id, key };
}

export function generateMasterKey(id: string): MasterKey {
  return { id, key: randomBytes(32) };
}

// Header names a seller may attach. Anything that could confuse routing, framing or the proxy is refused.
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'expect', 'cookie', 'set-cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-real-ip', 'origin', 'referer',
]);
export function assertHeaderName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) throw new VaultError('BAD_HEADER', 'a header name may only contain letters, digits and dashes');
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new VaultError('BAD_HEADER', `the header ${name} cannot be set by a credential`);
}
function assertValue(v: string): void {
  if (v.length === 0 || v.length > 4096) throw new VaultError('BAD_VALUE', 'a credential value must be 1 to 4096 characters');
  if (/[\r\n\0]/.test(v)) throw new VaultError('BAD_VALUE', 'a credential value cannot contain line breaks or NUL');
}

function seal(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  const d = createDecipheriv(ALG, key, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
const aadSecret = (id: string, listingId: string, version: number) => `payrail/credential/v1|${id}|${listingId}|${version}`;
const aadDek = (id: string, keyId: string) => `payrail/dek/v1|${id}|${keyId}`;

export interface CredentialMeta {
  id: string;
  listingId: string;
  label: string;
  headerName: string;
  version: number;
  status: 'active' | 'rotated' | 'revoked';
  keyId: string;
  createdAt: string;
  revokedAt: string | null;
}

/** Store (or rotate) a credential. The previous active version, if any, becomes `rotated` in the same transaction. */
export function putCredential(
  db: Db,
  mk: MasterKey,
  a: { listingId: string; label: string; headerName: string; value: string; actor: string },
  now: () => number = Date.now,
): CredentialMeta {
  assertHeaderName(a.headerName);
  assertValue(a.value);
  if (!/^[A-Za-z0-9 ._-]{1,60}$/.test(a.label)) throw new VaultError('BAD_VALUE', 'invalid credential label');
  return inTransaction(db, () => {
    const listing = queryOne(db, 'SELECT id FROM listings WHERE id = ?', a.listingId);
    if (!listing) throw new VaultError('NOT_FOUND', `no listing ${a.listingId}`);
    const prev = queryOne<{ v: bigint | null }>(db, 'SELECT MAX(version) AS v FROM credentials WHERE listing_id = ? AND label = ?', a.listingId, a.label);
    const version = Number(prev?.v ?? 0n) + 1;
    const id = `cred_${randomUUID()}`;
    const dek = randomBytes(32);
    const sealed = seal(dek, Buffer.from(a.value, 'utf8'), aadSecret(id, a.listingId, version));
    const wrapped = seal(mk.key, dek, aadDek(id, mk.id));
    dek.fill(0);
    db.prepare("UPDATE credentials SET status = 'rotated' WHERE listing_id = ? AND label = ? AND status = 'active'").run(a.listingId, a.label);
    db.prepare(
      `INSERT INTO credentials (id, listing_id, label, header_name, version, status, algorithm, key_id, iv, ciphertext, tag, wrapped_dek, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.listingId, a.label, a.headerName, version, ALG, mk.id, sealed.iv, sealed.ct, sealed.tag, Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct]), new Date(now()).toISOString());
    audit(db, a.actor, version === 1 ? 'credential_added' : 'credential_rotated', id, { listing: a.listingId, label: a.label, version }, new Date(now()));
    return metaOf(queryOne(db, 'SELECT * FROM credentials WHERE id = ?', id)!);
  });
}

function metaOf(r: Record<string, any>): CredentialMeta {
  return {
    id: String(r.id),
    listingId: String(r.listing_id),
    label: String(r.label),
    headerName: String(r.header_name),
    version: Number(r.version),
    status: String(r.status) as CredentialMeta['status'],
    keyId: String(r.key_id),
    createdAt: String(r.created_at),
    revokedAt: r.revoked_at === null ? null : String(r.revoked_at),
  };
}

/** Metadata only. There is deliberately no function that returns a value to a seller or buyer. */
export function listCredentials(db: Db, listingId: string): CredentialMeta[] {
  return query(db, 'SELECT * FROM credentials WHERE listing_id = ? ORDER BY label, version', listingId).map(metaOf);
}

export function revokeCredential(db: Db, credentialId: string, actor: string, now: () => number = Date.now): CredentialMeta {
  return inTransaction(db, () => {
    const r = queryOne(db, 'SELECT * FROM credentials WHERE id = ?', credentialId);
    if (!r) throw new VaultError('NOT_FOUND', `no credential ${credentialId}`);
    if (String(r.status) !== 'revoked') {
      db.prepare("UPDATE credentials SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date(now()).toISOString(), credentialId);
      audit(db, actor, 'credential_revoked', credentialId, undefined, new Date(now()));
    }
    return metaOf(queryOne(db, 'SELECT * FROM credentials WHERE id = ?', credentialId)!);
  });
}

export interface GatewayCredential {
  headerName: string;
  /** PLAINTEXT. Use it to build the outbound request and discard it. Never log it, return it or store it. */
  value: string;
  label: string;
  version: number;
}

/**
 * The ONLY path to plaintext. Returns the active credentials of a listing for one gateway execution.
 * Writes one audit entry per call (listing and count; never values).
 */
export function openForGateway(db: Db, keys: readonly MasterKey[], listingId: string, purpose: 'gateway-execution' | 'seller-test', now: () => number = Date.now): GatewayCredential[] {
  const rows = query(db, "SELECT * FROM credentials WHERE listing_id = ? AND status = 'active' ORDER BY label", listingId);
  const out: GatewayCredential[] = [];
  for (const r of rows) {
    const mk = keys.find((k) => k.id === String(r.key_id));
    if (!mk) throw new VaultError('UNKNOWN_KEY', `no master key ${String(r.key_id)} is loaded`);
    const id = String(r.id);
    try {
      const w = r.wrapped_dek as Uint8Array;
      const iv = Buffer.from(w.subarray(0, 12));
      const tag = Buffer.from(w.subarray(12, 28));
      const ct = Buffer.from(w.subarray(28));
      const dek = open(mk.key, iv, ct, tag, aadDek(id, mk.id));
      const plain = open(dek, Buffer.from(r.iv as Uint8Array), Buffer.from(r.ciphertext as Uint8Array), Buffer.from(r.tag as Uint8Array), aadSecret(id, listingId, Number(r.version)));
      dek.fill(0);
      out.push({ headerName: String(r.header_name), value: plain.toString('utf8'), label: String(r.label), version: Number(r.version) });
    } catch {
      // never include key material or ciphertext in the message
      throw new VaultError('DECRYPT_FAILED', `credential ${id} could not be decrypted (wrong master key, or the stored data was altered)`);
    }
  }
  audit(db, 'gateway', 'credentials_opened', listingId, { purpose, count: out.length }, new Date(now()));
  return out;
}

/** Re-wrap every data key under a new master key. Secrets are never decrypted. Returns the number re-wrapped. */
export function rewrapAll(db: Db, oldKey: MasterKey, newKey: MasterKey, actor: string, now: () => number = Date.now): number {
  return inTransaction(db, () => {
    const rows = query(db, 'SELECT * FROM credentials WHERE key_id = ?', oldKey.id);
    for (const r of rows) {
      const id = String(r.id);
      const w = r.wrapped_dek as Uint8Array;
      let dek: Buffer;
      try {
        dek = open(oldKey.key, Buffer.from(w.subarray(0, 12)), Buffer.from(w.subarray(28)), Buffer.from(w.subarray(12, 28)), aadDek(id, oldKey.id));
      } catch {
        throw new VaultError('DECRYPT_FAILED', `credential ${id}: the old master key does not unwrap its data key`);
      }
      const nw = seal(newKey.key, dek, aadDek(id, newKey.id));
      dek.fill(0);
      db.prepare('UPDATE credentials SET wrapped_dek = ?, key_id = ? WHERE id = ?').run(Buffer.concat([nw.iv, nw.tag, nw.ct]), newKey.id, id);
    }
    audit(db, actor, 'vault_rewrapped', `${oldKey.id}->${newKey.id}`, { count: rows.length }, new Date(now()));
    return rows.length;
  });
}

/** Replace every occurrence of the given secret values with ***. Use before logging or returning any upstream text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}
