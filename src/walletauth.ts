// Wallet-signature sign-in for BUYERS (sellers use src/seller.ts). Signing proves control of the wallet; nothing is sent
// on-chain, no key or seed phrase is ever requested, and the signed message names the network, so a signature made for
// one chain or purpose cannot be replayed for another. Each challenge is single-use and short-lived.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { audit, inTransaction, queryOne } from './db.ts';
import type { Db } from './db.ts';

export class WalletAuthError extends Error {
  readonly code: 'BAD_INPUT' | 'WRONG_NETWORK' | 'NONCE_INVALID' | 'BAD_SIGNATURE';
  constructor(code: WalletAuthError['code'], message: string) {
    super(message);
    this.name = 'WalletAuthError';
    this.code = code;
  }
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TTL_MS = 5 * 60_000;
const SESSION_MS = 12 * 3_600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function buyerLoginMessage(wallet: string, chainId: number, nonce: string, expiresAt: string): string {
  return `Payrail buyer sign-in\nWallet: ${wallet}\nNetwork: chain ${chainId}\nNonce: ${nonce}\nExpires: ${expiresAt}\nThis only proves you control this wallet. It sends no transaction and gives Payrail no access to your funds.`;
}

export function startBuyerLogin(db: Db, a: { wallet: string; chainId: number; expectedChainId: number }, now: () => number = Date.now): { message: string; nonce: string; expiresAt: string } {
  if (!ADDRESS.test(a.wallet)) throw new WalletAuthError('BAD_INPUT', 'wallet must be a 0x address');
  if (a.chainId !== a.expectedChainId) throw new WalletAuthError('WRONG_NETWORK', `switch your wallet to chain ${a.expectedChainId}; it is on chain ${a.chainId}`);
  const wallet = a.wallet.toLowerCase();
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(now() + TTL_MS).toISOString();
  const message = buyerLoginMessage(wallet, a.chainId, nonce, expiresAt);
  db.prepare('INSERT INTO login_nonces (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)').run(nonce, `buyer:${wallet}`, message, expiresAt);
  return { message, nonce, expiresAt };
}

export async function completeBuyerLogin(db: Db, a: { wallet: string; nonce: string; signature: string }, now: () => number = Date.now): Promise<{ accountId: string; token: string; expiresAt: string; created: boolean }> {
  if (!ADDRESS.test(a.wallet)) throw new WalletAuthError('BAD_INPUT', 'wallet must be a 0x address');
  const wallet = a.wallet.toLowerCase();
  const row = queryOne(db, 'SELECT * FROM login_nonces WHERE nonce = ?', a.nonce);
  if (!row || String(row.wallet) !== `buyer:${wallet}` || row.used_at !== null || Date.parse(String(row.expires_at)) < now()) {
    throw new WalletAuthError('NONCE_INVALID', 'sign-in request is unknown, used, expired or for another wallet');
  }
  let ok = false;
  try {
    ok = await verifyMessage({ address: wallet as `0x${string}`, message: String(row.message), signature: a.signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new WalletAuthError('BAD_SIGNATURE', 'the signature was not made by this wallet over this sign-in request');
  return inTransaction(db, () => {
    const used = db.prepare('UPDATE login_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(new Date(now()).toISOString(), a.nonce);
    if (Number(used.changes) !== 1) throw new WalletAuthError('NONCE_INVALID', 'sign-in request already used');
    let acct = queryOne(db, "SELECT account_id AS id FROM account_wallets WHERE wallet = ? AND kind = 'buyer'", wallet);
    let created = false;
    if (!acct) {
      const id = `buyer_${randomUUID()}`;
      db.prepare("INSERT INTO accounts (id, kind, display_name, created_at) VALUES (?, 'buyer', ?, ?)").run(id, `Buyer ${wallet.slice(0, 8)}…`, new Date(now()).toISOString());
      db.prepare("INSERT INTO account_wallets (wallet, kind, account_id, created_at) VALUES (?, 'buyer', ?, ?)").run(wallet, id, new Date(now()).toISOString());
      audit(db, id, 'buyer.created', id, { wallet }, new Date(now()));
      acct = { id };
      created = true;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + SESSION_MS).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), String(acct.id), new Date(now()).toISOString(), expiresAt);
    return { accountId: String(acct.id), token, expiresAt, created };
  });
}
