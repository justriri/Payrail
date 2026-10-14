// Escrow settlement path: the buyer's funds sit in the PayrailEscrow contract instead of the off-chain ledger.
// Same outcome rule as the ledger path: hold -> call the seller -> validate against the pinned contract -> capture or release.
// The hold/capture/release are on-chain transactions sent by the operator key held by THIS process.
//
// STATUS: built for and exercised on Celo Sepolia testnet only. The contract is unaudited; see docs/MARKETPLACE.md.
// Execution rows for this path carry settlement = 'escrow' and are not part of the off-chain ledger (verifyLedger skips them).
import { createHash, randomUUID } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import type { Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { currentContract, evaluate, getContract } from './contracts.ts';
import { GatewayError, callUpstream, cleanInput } from './gateway.ts';
import type { CallOptions } from './gateway.ts';
import { LedgerError, feeFor } from './ledger.ts';
import { getListing } from './seller.ts';
import type { MasterKey } from './vault.ts';
import { fundingWallets } from './funding.ts';
import type { ExecutionResult } from './execute.ts';

export type HoldState = 'None' | 'Held' | 'Captured' | 'Released';
export interface OnChainHold {
  state: HoldState;
  buyer: string;
  seller: string;
  amount: bigint;
  createdAt: number;
}
export interface EscrowClient {
  /** the escrow's configured hold timeout, seconds */
  holdTimeoutSeconds: number;
  available(buyer: string): Promise<bigint>;
  hold(id: string): Promise<OnChainHold>;
  placeHold(id: string, buyer: string, seller: string, amount: bigint): Promise<string>;
  capture(id: string): Promise<string>;
  release(id: string): Promise<string>;
  expire(id: string): Promise<string>;
}

export class EscrowError extends Error {
  code: 'NO_FUNDING_WALLET' | 'NO_SELLER_WALLET' | 'HOLD_FAILED';
  constructor(code: EscrowError['code'], message: string) {
    super(message);
    this.name = 'EscrowError';
    this.code = code;
  }
}

/** The on-chain id of an execution's hold. Deterministic, so a crash can always find it. */
export const holdIdFor = (executionId: string): `0x${string}` => keccak256(toHex(executionId));

const STATE_NAMES: HoldState[] = ['None', 'Held', 'Captured', 'Released'];

export function createViemEscrowClient(o: { rpcUrl: string; chainId: number; escrow: `0x${string}`; abi: Abi; operatorKey: `0x${string}`; holdTimeoutSeconds: number }): EscrowClient {
  const chain = defineChain({ id: o.chainId, name: `chain-${o.chainId}`, nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const account = privateKeyToAccount(o.operatorKey);
  const pub = createPublicClient({ chain, transport: http(o.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(o.rpcUrl) });
  const read = (functionName: string, args: unknown[]) => pub.readContract({ address: o.escrow, abi: o.abi, functionName, args } as never) as Promise<any>;
  const write = async (functionName: string, args: unknown[]): Promise<string> => {
    const hash = await wallet.writeContract({ address: o.escrow, abi: o.abi, functionName, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== 'success') throw new EscrowError('HOLD_FAILED', `${functionName} reverted (${hash})`);
    return hash;
  };
  return {
    holdTimeoutSeconds: o.holdTimeoutSeconds,
    available: async (b) => BigInt(await read('available', [b])),
    async hold(id) {
      const h = await read('holds', [id]);
      // viem returns the public struct getter as a tuple
      const [buyer, seller, amount, createdAt, state] = Array.isArray(h) ? h : [h.buyer, h.seller, h.amount, h.createdAt, h.state];
      return { buyer: String(buyer), seller: String(seller), amount: BigInt(amount), createdAt: Number(createdAt), state: STATE_NAMES[Number(state)] ?? 'None' };
    },
    placeHold: (id, b, s, a) => write('placeHold', [id, b, s, a]),
    capture: (id) => write('capture', [id]),
    release: (id) => write('release', [id]),
    expire: (id) => write('expire', [id]),
  };
}

// ------------------------------------------------------------------ execution

interface Evidence {
  checks: unknown[];
  upstream: { status: number; elapsedMs: number } | null;
  bodyText?: string;
  bodySha256?: string;
  failure?: { code: string; message: string };
  txs: { hold?: string; settle?: string; expire?: string };
  holdId: string;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

function write(db: Db, id: string, state: string, reason: string, ev: Evidence, now: () => number, fee?: { fee: bigint; seller: bigint }): void {
  db.prepare('UPDATE executions SET state = ?, reason = ?, evidence_json = ?, fee_atomic = ?, seller_atomic = ?, updated_at = ? WHERE id = ?').run(
    state, reason.slice(0, 300), JSON.stringify(ev), fee ? fee.fee : null, fee ? fee.seller : null, new Date(now()).toISOString(), id,
  );
}

function resultOf(db: Db, id: string, replay: boolean): ExecutionResult {
  const r = queryOne(db, 'SELECT * FROM executions WHERE id = ?', id)!;
  const ev = r.evidence_json ? (JSON.parse(String(r.evidence_json)) as Evidence) : undefined;
  const state = String(r.state) as ExecutionResult['state'];
  let body: unknown;
  if (state === 'QUALIFIED' && ev?.bodyText !== undefined) {
    try {
      body = JSON.parse(ev.bodyText);
    } catch {
      body = undefined;
    }
  }
  return {
    executionId: id,
    state,
    charged: state === 'QUALIFIED',
    held: state === 'HELD' || state === 'UNRESOLVED',
    priceAtomic: String(r.price_atomic),
    asset: String(r.asset),
    feeAtomic: r.fee_atomic === null ? null : String(r.fee_atomic),
    sellerAtomic: r.seller_atomic === null ? null : String(r.seller_atomic),
    reason: r.reason === null ? null : String(r.reason),
    replay,
    contractVersion: getContract(db, String(r.contract_version_id))?.version ?? 0,
    checks: (ev?.checks ?? []) as ExecutionResult['checks'],
    upstream: ev?.upstream ?? null,
    body,
  };
}

export interface EscrowExecuteOptions {
  now?: () => number;
  call?: Omit<CallOptions, 'purpose'>;
  demoCall?: Omit<CallOptions, 'purpose'>;
}

/** One paid request settled through the escrow contract. Idempotent per (buyer, key), like the ledger path. */
export async function executeEscrowRequest(
  db: Db,
  keys: readonly MasterKey[],
  client: EscrowClient,
  a: { buyerId: string; listingId: string; idempotencyKey: string; input: unknown; asset: string },
  opts: EscrowExecuteOptions = {},
): Promise<ExecutionResult> {
  const now = opts.now ?? Date.now;
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(a.idempotencyKey)) throw new LedgerError('NOT_FOUND', 'idempotencyKey must be 8-100 characters');
  const listing = getListing(db, a.listingId);
  if (!listing) throw new LedgerError('NOT_FOUND', `no listing ${a.listingId}`);
  if (listing.status !== 'published') throw new LedgerError('LISTING_NOT_PUBLISHED', 'the listing is not published');
  const input = cleanInput(a.input);
  const contract = currentContract(db, a.listingId);
  if (!contract) throw new LedgerError('CONTRACT_NOT_APPROVED', 'no approved contract');
  const requestHash = sha256(canonical({ l: a.listingId, i: input }));

  const buyerWallet = fundingWallets(db, a.buyerId)[0];
  if (!buyerWallet) throw new EscrowError('NO_FUNDING_WALLET', 'register the wallet that holds your escrow deposit first');
  const sellerWallet = (queryOne(db, 'SELECT wallet_address FROM accounts WHERE id = ?', listing.sellerId)?.wallet_address as string | null) ?? null;
  if (!sellerWallet) throw new EscrowError('NO_SELLER_WALLET', 'the seller has no verified wallet to be paid at');

  // create the execution row atomically (idempotent)
  const created = inTransaction(db, () => {
    const prior = queryOne(db, 'SELECT id, request_hash FROM executions WHERE buyer_id = ? AND idempotency_key = ?', a.buyerId, a.idempotencyKey);
    if (prior) {
      if (String(prior.request_hash) !== requestHash) throw new LedgerError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request');
      return { id: String(prior.id), replay: true };
    }
    const id = `exec_${randomUUID()}`;
    const at = new Date(now()).toISOString();
    db.prepare(
      `INSERT INTO executions (id, buyer_id, listing_id, contract_version_id, idempotency_key, request_hash, state, price_atomic, asset, fee_bps, created_at, updated_at, settlement)
       VALUES (?, ?, ?, ?, ?, ?, 'HELD', ?, ?, ?, ?, ?, 'escrow')`,
    ).run(id, a.buyerId, a.listingId, contract.id, a.idempotencyKey, requestHash, listing.priceAtomic, a.asset, listing.feeBps, at, at);
    audit(db, a.buyerId, 'escrow.execution_created', id, { listing: a.listingId }, new Date(now()));
    return { id, replay: false };
  });
  if (created.replay) return resultOf(db, created.id, true);

  const id = created.id;
  const holdId = holdIdFor(id);
  const ev: Evidence = { checks: [], upstream: null, txs: {}, holdId };

  // 1) reserve on-chain BEFORE contacting the seller
  try {
    const bal = await client.available(buyerWallet);
    if (bal < listing.priceAtomic) {
      write(db, id, 'NOT_QUALIFIED', `escrow balance ${bal} is below the price ${listing.priceAtomic}; nothing was sent`, ev, now);
      return resultOf(db, id, false);
    }
    ev.txs.hold = await client.placeHold(holdId, buyerWallet, sellerWallet, listing.priceAtomic);
  } catch (e) {
    // the hold may or may not exist: recoverEscrow decides from the chain, never from here
    ev.failure = { code: 'HOLD_FAILED', message: (e as Error).message.slice(0, 200) };
    write(db, id, 'UNRESOLVED', 'placing the escrow hold failed; checking the chain will settle this', ev, now);
    return resultOf(db, id, false);
  }

  // 2) call the seller and validate against the pinned version
  const pinned = getContract(db, contract.id)!;
  const callOpts = listing.demo ? (opts.demoCall ?? opts.call) : opts.call;
  let verdict: { qualified: boolean; reason: string } | { unknown: string };
  try {
    const r = await callUpstream(db, keys, a.listingId, input, { ...(callOpts ?? {}), now, purpose: 'gateway-execution' });
    const evaluation = evaluate(pinned.body, r, now());
    ev.checks = evaluation.checks;
    ev.upstream = { status: r.status, elapsedMs: r.elapsedMs };
    ev.bodySha256 = sha256(r.bodyText);
    if (evaluation.qualified) ev.bodyText = r.bodyText;
    verdict = { qualified: evaluation.qualified, reason: evaluation.qualified ? 'response satisfied the contract' : evaluation.reasons.join('; ') };
  } catch (e) {
    const code = e instanceof GatewayError ? e.code : 'INTERNAL';
    ev.failure = { code, message: (e as Error).message.slice(0, 200) };
    const neverSent = ['EGRESS_BLOCKED', 'RATE_LIMITED', 'BAD_INPUT', 'LISTING_NOT_VERIFIED', 'NOT_FOUND'].includes(code);
    verdict = neverSent ? { qualified: false, reason: `the request was not sent (${code})` } : { unknown: `the API did not answer in time or the connection failed (${code}); outcome unknown` };
  }

  // 3) settle on-chain, then record
  if ('unknown' in verdict) {
    write(db, id, 'UNRESOLVED', verdict.unknown, ev, now);
    return resultOf(db, id, false);
  }
  try {
    if (verdict.qualified) {
      ev.txs.settle = await client.capture(holdId);
      write(db, id, 'QUALIFIED', verdict.reason, ev, now, feeFor(listing.priceAtomic, listing.feeBps));
    } else {
      ev.txs.settle = await client.release(holdId);
      write(db, id, 'NOT_QUALIFIED', verdict.reason, ev, now);
    }
  } catch (e) {
    ev.failure = { code: 'SETTLE_FAILED', message: (e as Error).message.slice(0, 200) };
    write(db, id, 'UNRESOLVED', 'the on-chain settlement did not complete; the chain is the source of truth and will be re-read', ev, now);
  }
  return resultOf(db, id, false);
}

/**
 * Reconcile every escrow execution that is not final against the chain. The chain decides:
 *  - hold absent                  -> NOT_QUALIFIED (nothing was reserved)
 *  - hold Released                -> NOT_QUALIFIED / RELEASED_UNRESOLVED (buyer has the funds back)
 *  - hold Captured                -> QUALIFIED (fee split recorded)
 *  - hold Held and past timeout   -> expire() on-chain, then RELEASED_UNRESOLVED
 *  - hold Held, within timeout    -> UNRESOLVED (left for the operator or the timeout)
 */
export async function recoverEscrow(db: Db, client: EscrowClient, now: () => number = Date.now): Promise<Array<{ id: string; from: string; to: string }>> {
  const out: Array<{ id: string; from: string; to: string }> = [];
  const rows = query(db, "SELECT id, state, price_atomic, fee_bps, evidence_json FROM executions WHERE settlement = 'escrow' AND state IN ('HELD','UNRESOLVED')");
  for (const r of rows) {
    const id = String(r.id);
    const from = String(r.state);
    const ev: Evidence = r.evidence_json ? (JSON.parse(String(r.evidence_json)) as Evidence) : { checks: [], upstream: null, txs: {}, holdId: holdIdFor(id) };
    const h = await client.hold(holdIdFor(id));
    let to = from;
    if (h.state === 'None') {
      write(db, id, 'NOT_QUALIFIED', 'no escrow hold exists; nothing was reserved or charged', ev, now);
      to = 'NOT_QUALIFIED';
    } else if (h.state === 'Released') {
      write(db, id, from === 'UNRESOLVED' ? 'RELEASED_UNRESOLVED' : 'NOT_QUALIFIED', 'the escrow hold was released to the buyer', ev, now);
      to = from === 'UNRESOLVED' ? 'RELEASED_UNRESOLVED' : 'NOT_QUALIFIED';
    } else if (h.state === 'Captured') {
      write(db, id, 'QUALIFIED', 'the escrow hold was captured on-chain', ev, now, feeFor(BigInt(r.price_atomic as bigint), Number(r.fee_bps)));
      to = 'QUALIFIED';
    } else if (now() / 1000 >= h.createdAt + client.holdTimeoutSeconds) {
      ev.txs.expire = await client.expire(holdIdFor(id));
      write(db, id, 'RELEASED_UNRESOLVED', 'the hold expired on-chain and was returned to the buyer', ev, now);
      to = 'RELEASED_UNRESOLVED';
    } else if (from === 'HELD') {
      write(db, id, 'UNRESOLVED', 'interrupted; the on-chain hold is still open', ev, now);
      to = 'UNRESOLVED';
    }
    if (to !== from) out.push({ id, from, to });
  }
  return out;
}
