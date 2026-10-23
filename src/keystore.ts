// Encrypted key file ("keystore") so the web app can be unlocked with a passphrase instead of being restarted with a
// plaintext key file. The key is decrypted into this process's memory only, never written back, never returned over HTTP.
// scrypt (N=2^15) derives a key from the passphrase; AES-256-GCM encrypts the private key, with the address as AAD.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

export class KeystoreError extends Error {
  code: 'BAD_KEY' | 'BAD_PASSPHRASE' | 'BAD_FILE' | 'WEAK_PASSPHRASE';
  constructor(code: KeystoreError['code'], message: string) {
    super(message);
    this.name = 'KeystoreError';
    this.code = code;
  }
}

export interface KeystoreFile {
  version: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  /** public address, stored in the clear so the app can say which wallet this unlocks */
  address: string;
}

const N = 1 << 15;
const R = 8;
const P = 1;
const derive = (pass: string, salt: Buffer, n: number, r: number, p: number) => scryptSync(pass.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * 1024 * 1024 });

export function encryptKey(privateKey: string, passphrase: string): KeystoreFile {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new KeystoreError('BAD_KEY', 'not a 0x-prefixed 32-byte hex key');
  if (passphrase.length < 10) throw new KeystoreError('WEAK_PASSPHRASE', 'use a passphrase of at least 10 characters');
  const address = privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive(passphrase, salt, N, R, P), iv);
  c.setAAD(Buffer.from(address));
  const ct = Buffer.concat([c.update(Buffer.from(privateKey.slice(2), 'hex')), c.final()]);
  return { version: 1, kdf: 'scrypt', N, r: R, p: P, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ciphertext: ct.toString('hex'), address };
}

/** Returns the key as 0x-hex. A wrong passphrase and a tampered file are indistinguishable by design. */
export function decryptKey(file: KeystoreFile, passphrase: string): `0x${string}` {
  if (file?.version !== 1 || file.kdf !== 'scrypt' || !/^[0-9a-f]+$/.test(file.salt + file.iv + file.tag + file.ciphertext)) throw new KeystoreError('BAD_FILE', 'not a Payrail keystore file');
  if (!Number.isInteger(file.N) || file.N > 1 << 20 || file.N < 1 << 14) throw new KeystoreError('BAD_FILE', 'unsupported key-derivation settings');
  try {
    const d = createDecipheriv('aes-256-gcm', derive(passphrase, Buffer.from(file.salt, 'hex'), file.N, file.r, file.p), Buffer.from(file.iv, 'hex'));
    d.setAAD(Buffer.from(file.address));
    d.setAuthTag(Buffer.from(file.tag, 'hex'));
    const pk = `0x${Buffer.concat([d.update(Buffer.from(file.ciphertext, 'hex')), d.final()]).toString('hex')}` as `0x${string}`;
    if (privateKeyToAccount(pk).address.toLowerCase() !== file.address) throw new Error('address mismatch');
    return pk;
  } catch {
    throw new KeystoreError('BAD_PASSPHRASE', 'wrong passphrase');
  }
}
