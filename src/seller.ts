// Sellers: wallet sign-in, sessions, listing submission and ownership verification.
// A listing is only "verified" (and only then may stored credentials be sent to its endpoint) after BOTH:
//   1. the seller's wallet signed this listing's challenge (binds the account to the claim), and
//   2. the seller proved control of the API's host: a DNS TXT record or a well-known file holding the challenge token.
// A wallet signature alone proves wallet control, not API ownership, so it never suffices.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { verifyMessage } from 'viem';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { safeFetch, validateDestination } from './egress.ts';
import type { FetchOptions } from './egress.ts';

export class SellerError extends Error {
  code:
    | 'BAD_INPUT'
    | 'BAD_SIGNATURE'
    | 'NONCE_INVALID'
    | 'SESSION_INVALID'
    | 'NOT_FOUND'
    | 'NOT_OWNER'
    | 'WRONG_STATE'
    | 'PROOF_MISSING'
    | 'DOMAIN_PROOF_FAILED'
    | 'HOST_CLAIMED';
  constructor(code: SellerError['code'], message: string) {
    super(message);
    this.name = 'SellerError';
    this.code = code;
  }
}
type Clock = () => number;
const iso = (now: Clock) => new Date(now()).toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 3_600_000;
export const DNS_LABEL = '_payrail-challenge';
export const WELL_KNOWN_PATH = '/.well-known/payrail-verification.txt';
export const proofValue = (token: string) => `payrail-verify=${token}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function wallet(a: string): `0x${string}` {
  if (!ADDRESS.test(a)) throw new SellerError('BAD_INPUT', 'wallet must be a 0x address');
  return a.toLowerCase() as `0x${string}`;
}

// ------------------------------------------------------------------ sign-in

export function loginMessage(w: string, nonce: string, expiresAt: string): string {
  return `Payrail seller sign-in\nWallet: ${w}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
}

/** Step 1: get a message to sign. Signing proves wallet control; nothing is sent on-chain and no funds move. */
export function startLogin(db: Db, walletAddress: string, now: Clock = Date.now): { message: string; nonce: string } {
  const w = wallet(walletAddress);
  const nonce = randomBytes(16).toString('hex');
  const expires = new Date(now() + NONCE_TTL_MS).toISOString();
  const message = loginMessage(w, nonce, expires);
  db.prepare('INSERT INTO login_nonces (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)').run(nonce, w, message, expires);
  return { message, nonce };
}

/** Step 2: submit the signature. Creates the seller account on first sign-in. Returns a bearer token (only its hash is stored). */
export async function completeLogin(
  db: Db,
  a: { wallet: string; nonce: string; signature: string; displayName?: string },
  now: Clock = Date.now,
): Promise<{ accountId: string; token: string; expiresAt: string }> {
  const w = wallet(a.wallet);
  const row = queryOne(db, 'SELECT * FROM login_nonces WHERE nonce = ?', a.nonce);
  if (!row || String(row.wallet) !== w || row.used_at !== null || Date.parse(String(row.expires_at)) < now()) {
    throw new SellerError('NONCE_INVALID', 'sign-in request is unknown, used or expired');
  }
  let ok = false;
  try {
    ok = await verifyMessage({ address: w, message: String(row.message), signature: a.signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new SellerError('BAD_SIGNATURE', 'signature does not match the wallet');
  return inTransaction(db, () => {
    const used = db.prepare('UPDATE login_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(iso(now), a.nonce);
    if (Number(used.changes) !== 1) throw new SellerError('NONCE_INVALID', 'sign-in request already used');
    let acct = queryOne(db, 'SELECT id FROM accounts WHERE wallet_address = ?', w);
    if (!acct) {
      const id = `seller_${randomUUID()}`;
      db.prepare("INSERT INTO accounts (id, kind, display_name, created_at, wallet_address) VALUES (?, 'seller', ?, ?, ?)").run(id, (a.displayName ?? w).slice(0, 120), iso(now), w);
      audit(db, id, 'seller.created', id, { wallet: w }, new Date(now()));
      acct = { id };
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), String(acct.id), iso(now), expiresAt);
    return { accountId: String(acct.id), token, expiresAt };
  });
}

/** Resolve a bearer token to an account id, or throw. */
export function authenticate(db: Db, token: string, now: Clock = Date.now): string {
  const r = queryOne(db, 'SELECT account_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?', sha256(token));
  if (!r || r.revoked_at !== null || Date.parse(String(r.expires_at)) < now()) throw new SellerError('SESSION_INVALID', 'sign in again');
  return String(r.account_id);
}
export function logout(db: Db, token: string, now: Clock = Date.now): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(iso(now), sha256(token));
}

// ------------------------------------------------------------------ listings

export interface Listing {
  id: string;
  sellerId: string;
  name: string;
  description: string;
  status: 'draft' | 'verified' | 'published' | 'suspended' | 'unpublished';
  endpointUrl: string;
  method: 'GET' | 'POST';
  host: string;
  priceAtomic: bigint;
  asset: string;
  feeBps: number;
  verifiedAt: string | null;
  /** platform-operated demo listing: served only by the in-process demo network */
  demo: boolean;
}
const toListing = (r: Record<string, unknown>): Listing => ({
  id: String(r.id),
  sellerId: String(r.seller_id),
  name: String(r.name),
  description: String(r.description),
  status: r.status as Listing['status'],
  endpointUrl: String(r.endpoint_url),
  method: r.http_method as Listing['method'],
  host: String(r.host),
  priceAtomic: BigInt(r.price_atomic as bigint),
  asset: String(r.asset),
  feeBps: Number(r.fee_bps),
  verifiedAt: r.verified_at === null ? null : String(r.verified_at),
  demo: Number(r.demo) === 1,
});

export function getListing(db: Db, id: string): Listing | undefined {
  const r = queryOne(db, 'SELECT * FROM listings WHERE id = ?', id);
  return r ? toListing(r) : undefined;
}
export function listingsOf(db: Db, sellerId: string): Listing[] {
  return query(db, 'SELECT * FROM listings WHERE seller_id = ? ORDER BY created_at', sellerId).map(toListing);
}
function owned(db: Db, listingId: string, actorId: string): Listing {
  const l = getListing(db, listingId);
  if (!l) throw new SellerError('NOT_FOUND', `no listing ${listingId}`);
  if (l.sellerId !== actorId) throw new SellerError('NOT_OWNER', 'this listing belongs to another seller');
  return l;
}

export interface ListingInput {
  name: string;
  description?: string;
  endpointUrl: string;
  method?: 'GET' | 'POST';
  priceAtomic: bigint;
  asset: string;
}

/** Create a draft listing with an ownership challenge. The endpoint URL is validated by the same rules the gateway enforces. */
export function submitListing(db: Db, sellerId: string, i: ListingInput, now: Clock = Date.now): { listing: Listing; challenge: Challenge } {
  const name = i.name.trim();
  if (name.length < 3 || name.length > 80) throw new SellerError('BAD_INPUT', 'name must be 3-80 characters');
  if (!/^[A-Z0-9]{2,12}$/.test(i.asset)) throw new SellerError('BAD_INPUT', 'asset must be a symbol like USDT');
  if (typeof i.priceAtomic !== 'bigint' || i.priceAtomic <= 0n) throw new SellerError('BAD_INPUT', 'price must be a positive integer');
  const method = i.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') throw new SellerError('BAD_INPUT', 'method must be GET or POST');
  let dest;
  try {
    dest = validateDestination(i.endpointUrl);
  } catch (e) {
    throw new SellerError('BAD_INPUT', `endpoint rejected: ${(e as Error).message}`);
  }
  if (dest.url.search || dest.url.hash) throw new SellerError('BAD_INPUT', 'endpoint must not contain a query string or fragment');
  const acct = queryOne(db, "SELECT kind FROM accounts WHERE id = ?", sellerId);
  if (!acct || acct.kind !== 'seller') throw new SellerError('NOT_FOUND', 'unknown seller');
  const id = `lst_${randomUUID()}`;
  const token = randomBytes(24).toString('hex');
  inTransaction(db, () => {
    db.prepare(
      "INSERT INTO listings (id, seller_id, name, status, price_atomic, asset, created_at, endpoint_url, http_method, description, host) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, sellerId, name, i.priceAtomic, i.asset, iso(now), dest.url.toString(), method, (i.description ?? '').slice(0, 500), dest.hostname);
    db.prepare('INSERT INTO ownership_challenges (listing_id, token, created_at) VALUES (?, ?, ?)').run(id, token, iso(now));
    audit(db, sellerId, 'listing.submitted', id, { host: dest.hostname }, new Date(now()));
  });
  return { listing: getListing(db, id)!, challenge: challengeFor(db, id)! };
}

// ------------------------------------------------------------------ ownership

export interface Challenge {
  listingId: string;
  token: string;
  walletMessage: string;
  dnsRecord: { name: string; type: 'TXT'; value: string };
  wellKnown: { url: string; content: string };
  walletVerified: boolean;
  domainVerified: boolean;
  domainMethod: 'dns_txt' | 'well_known' | null;
}
export function walletMessage(listingId: string, host: string, token: string, w: string): string {
  return `Payrail listing ownership\nListing: ${listingId}\nHost: ${host}\nToken: ${token}\nWallet: ${w}`;
}
export function challengeFor(db: Db, listingId: string): Challenge | undefined {
  const r = queryOne(db, 'SELECT c.*, l.host, l.seller_id, a.wallet_address FROM ownership_challenges c JOIN listings l ON l.id = c.listing_id JOIN accounts a ON a.id = l.seller_id WHERE c.listing_id = ?', listingId);
  if (!r) return undefined;
  const host = String(r.host);
  return {
    listingId,
    token: String(r.token),
    walletMessage: walletMessage(listingId, host, String(r.token), String(r.wallet_address)),
    dnsRecord: { name: `${DNS_LABEL}.${host}`, type: 'TXT', value: proofValue(String(r.token)) },
    wellKnown: { url: `https://${host}${WELL_KNOWN_PATH}`, content: proofValue(String(r.token)) },
    walletVerified: r.wallet_verified_at !== null,
    domainVerified: r.domain_verified_at !== null,
    domainMethod: (r.domain_method as Challenge['domainMethod']) ?? null,
  };
}

/** Record the seller's wallet signature over the listing challenge. */
export async function submitWalletProof(db: Db, actorId: string, listingId: string, signature: string, now: Clock = Date.now): Promise<Challenge> {
  const l = owned(db, listingId, actorId);
  if (!['draft', 'verified'].includes(l.status)) throw new SellerError('WRONG_STATE', `listing is ${l.status}`);
  const ch = challengeFor(db, listingId)!;
  const w = String(queryOne(db, 'SELECT wallet_address FROM accounts WHERE id = ?', actorId)!.wallet_address);
  let ok = false;
  try {
    ok = await verifyMessage({ address: w as `0x${string}`, message: ch.walletMessage, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new SellerError('BAD_SIGNATURE', 'signature does not match the listing challenge and your wallet');
  db.prepare('UPDATE ownership_challenges SET wallet_signature = ?, wallet_verified_at = ? WHERE listing_id = ?').run(signature, iso(now), listingId);
  audit(db, actorId, 'listing.wallet_proof', listingId, undefined, new Date(now()));
  return finalize(db, listingId, actorId, now);
}

export interface DomainDeps {
  txt?: (name: string) => Promise<string[][]>;
  fetchOptions?: FetchOptions;
}

/** Check the domain proof. method 'dns_txt' reads the TXT record; 'well_known' fetches the file through the SSRF-safe gateway. */
export async function checkDomainProof(
  db: Db,
  actorId: string,
  listingId: string,
  method: 'dns_txt' | 'well_known',
  deps: DomainDeps = {},
  now: Clock = Date.now,
): Promise<Challenge> {
  const l = owned(db, listingId, actorId);
  if (!['draft', 'verified'].includes(l.status)) throw new SellerError('WRONG_STATE', `listing is ${l.status}`);
  const ch = challengeFor(db, listingId)!;
  const expected = proofValue(ch.token);
  let found = false;
  try {
    if (method === 'dns_txt') {
      const records = await (deps.txt ?? resolveTxt)(ch.dnsRecord.name);
      found = records.some((chunks) => chunks.join('') === expected);
    } else {
      const res = await safeFetch(ch.wellKnown.url, { method: 'GET', maxBytes: 512, timeoutMs: 8_000, maxRedirects: 0, ...(deps.fetchOptions ?? {}) });
      found = res.status === 200 && res.body.toString('utf8').trim() === expected;
    }
  } catch (e) {
    throw new SellerError('DOMAIN_PROOF_FAILED', `could not read the ${method === 'dns_txt' ? 'DNS record' : 'file'}: ${(e as Error).message}`);
  }
  if (!found) throw new SellerError('DOMAIN_PROOF_FAILED', `the ${method === 'dns_txt' ? 'TXT record' : 'file'} does not contain the expected value`);
  // another seller who already verified this host keeps it until they release it
  const clash = queryOne(db, "SELECT id FROM listings WHERE host = ? AND seller_id <> ? AND status IN ('verified','published')", l.host, actorId);
  if (clash) throw new SellerError('HOST_CLAIMED', 'this host is already verified by another seller');
  db.prepare('UPDATE ownership_challenges SET domain_method = ?, domain_verified_at = ? WHERE listing_id = ?').run(method, iso(now), listingId);
  audit(db, actorId, 'listing.domain_proof', listingId, { method }, new Date(now()));
  return finalize(db, listingId, actorId, now);
}

/** draft -> verified once both proofs exist. */
function finalize(db: Db, listingId: string, actorId: string, now: Clock): Challenge {
  const ch = challengeFor(db, listingId)!;
  if (ch.walletVerified && ch.domainVerified) {
    const r = db.prepare("UPDATE listings SET status = 'verified', verified_at = ? WHERE id = ? AND status = 'draft'").run(iso(now), listingId);
    if (Number(r.changes) === 1) audit(db, actorId, 'listing.verified', listingId, { method: ch.domainMethod }, new Date(now()));
  }
  return ch;
}

// ------------------------------------------------------------------ publishing

/** verified + approved contract -> published (visible to buyers). */
export function publishListing(db: Db, actorId: string, listingId: string, now: Clock = Date.now): Listing {
  return inTransaction(db, () => {
    const l = owned(db, listingId, actorId);
    if (l.status === 'published') return l;
    if (l.status !== 'verified' && l.status !== 'unpublished') throw new SellerError('WRONG_STATE', `a ${l.status} listing cannot be published`);
    if (l.verifiedAt === null) throw new SellerError('PROOF_MISSING', 'ownership is not verified');
    const c = queryOne(db, "SELECT id FROM contract_versions WHERE listing_id = ? AND status = 'approved'", listingId);
    if (!c) throw new SellerError('PROOF_MISSING', 'approve a response contract first');
    db.prepare("UPDATE listings SET status = 'published' WHERE id = ?").run(listingId);
    audit(db, actorId, 'listing.published', listingId, undefined, new Date(now()));
    return getListing(db, listingId)!;
  });
}
export function unpublishListing(db: Db, actorId: string, listingId: string, now: Clock = Date.now): Listing {
  const l = owned(db, listingId, actorId);
  if (l.status !== 'published') throw new SellerError('WRONG_STATE', `listing is ${l.status}`);
  db.prepare("UPDATE listings SET status = 'unpublished' WHERE id = ?").run(listingId);
  audit(db, actorId, 'listing.unpublished', listingId, undefined, new Date(now()));
  return getListing(db, listingId)!;
}
