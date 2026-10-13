// Reliable chain reads.
//
// WHY THIS EXISTS (investigated 2026-10-13, read-only probes):
//   The public endpoint https://forno.celo.org is a load balancer over MIXED backends (different reth builds and a
//   Geth node). For OLDER transactions, `eth_getTransactionByHash` and the block are always answered, but
//   `eth_getTransactionReceipt` returns `null` on some backends (receipts pruned there). So "receipt not found"
//   from ONE answer means "that backend does not have it", not "the transaction does not exist". Other public
//   endpoints (Ankr, 1RPC) answered every receipt; some others (Stakely) prune too; some are unusable.
//
// WHAT IT DOES:
//   * asks several endpoints and retries with bounded exponential backoff;
//   * validates every receipt against the requested hash and, when available, the transaction's block;
//   * separates the outcomes callers must NOT confuse:
//       found                  a validated receipt (from as many independent endpoints as were required)
//       receipt_unavailable    the transaction IS in a block, but no endpoint could produce its receipt
//       not_found              no endpoint knows the transaction
//       conflict               endpoints disagree (status or block): inconclusive
//       insufficient_agreement fewer endpoints than required confirmed the receipt
//       error                  every attempt failed with an error: the chain could not be read
//     Only `found` is evidence. Nothing else may be turned into "failed", "missing" or "unverified" for a
//     transaction that is known to have been sent: it is inconclusive, and a payment must never be repeated
//     because of it.
import { createPublicClient, fallback, http } from 'viem';
import type { Hex } from 'viem';
import { celo } from 'viem/chains';

/** Public endpoints verified consistent for historical receipts on 2026-10-13. Override with PAYRAIL_RPC_FALLBACK_URLS. */
export const DEFAULT_RPC_FALLBACKS: readonly string[] = Object.freeze(['https://rpc.ankr.com/celo', 'https://1rpc.io/celo']);
export const DEFAULT_PRIMARY_RPC = 'https://forno.celo.org';

export interface ReceiptShape {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
}
export interface TxShape {
  hash: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
}

/** One endpoint. `url` is only a label for reports. Both methods THROW on not-found/errors (as viem does). */
export interface ReadEndpoint<R extends ReceiptShape = ReceiptShape> {
  url: string;
  getTransactionReceipt(a: { hash: Hex }): Promise<R>;
  getTransaction(a: { hash: Hex }): Promise<TxShape & Record<string, any>>;
}

export type ReceiptLookup<R extends ReceiptShape = ReceiptShape> =
  | { kind: 'found'; receipt: R; endpoints: string[]; attempts: number }
  | { kind: 'receipt_unavailable'; blockNumber: bigint; attempts: number; detail: string }
  | { kind: 'not_found'; attempts: number; detail: string }
  | { kind: 'conflict'; detail: string; attempts: number }
  | { kind: 'insufficient_agreement'; receipt: R; agreed: number; needed: number; attempts: number }
  | { kind: 'error'; detail: string; attempts: number };

export interface LookupOptions {
  /** How many DISTINCT endpoints must return the same receipt. Default 1. Use 2 for evidence when available. */
  minAgreement?: number;
  /** Rounds over all endpoints. Default 5. */
  attempts?: number;
  /** First backoff in ms (doubles each round, capped at maxBackoffMs). Default 250. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface ChainReads<R extends ReceiptShape = ReceiptShape> {
  endpoints: ReadEndpoint<R>[];
  lookupReceipt(hash: Hex, opts?: LookupOptions): Promise<ReceiptLookup<R>>;
  lookupTransaction(hash: Hex, opts?: LookupOptions): Promise<
    | { kind: 'found'; tx: TxShape & Record<string, any>; attempts: number }
    | { kind: 'not_found'; attempts: number; detail: string }
    | { kind: 'error'; attempts: number; detail: string }
  >;
}

const NOT_FOUND_NAMES = new Set(['TransactionReceiptNotFoundError', 'TransactionNotFoundError']);
const isNotFound = (e: unknown) => e instanceof Error && NOT_FOUND_NAMES.has(e.name);
const brief = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e)).slice(0, 160);
const eqHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createChainReads<R extends ReceiptShape = ReceiptShape>(
  endpoints: ReadEndpoint<R>[],
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): ChainReads<R> {
  if (endpoints.length === 0) throw new Error('at least one read endpoint is required');
  const sleep = deps.sleep ?? defaultSleep;

  async function lookupReceipt(hash: Hex, o: LookupOptions = {}): Promise<ReceiptLookup<R>> {
    const need = Math.max(1, o.minAgreement ?? 1);
    const rounds = Math.max(1, o.attempts ?? 5);
    const base = o.backoffMs ?? 250;
    const cap = o.maxBackoffMs ?? 2000;

    const found = new Map<string, R>(); // endpoint url -> validated receipt
    let notFoundAnswers = 0;
    const errors: string[] = [];
    const mismatches: string[] = [];
    let txBlock: { blockNumber: bigint; blockHash: Hex } | undefined;
    let attemptsUsed = 0;

    const checkTx = async (ep: ReadEndpoint<R>): Promise<void> => {
      if (txBlock) return;
      try {
        const t = await ep.getTransaction({ hash });
        if (eqHash(t.hash, hash) && t.blockNumber !== null && t.blockHash !== null) txBlock = { blockNumber: t.blockNumber, blockHash: t.blockHash };
      } catch {
        /* the transaction lookup is supporting evidence only */
      }
    };

    for (let round = 1; round <= rounds; round++) {
      attemptsUsed = round;
      // rotate the starting endpoint so one bad backend is not always asked first
      for (let i = 0; i < endpoints.length; i++) {
        const ep = endpoints[(i + round - 1) % endpoints.length]!;
        if (found.has(ep.url)) continue;
        try {
          const r = await ep.getTransactionReceipt({ hash });
          if (!r || !eqHash(r.transactionHash, hash)) {
            mismatches.push(`${ep.url}: receipt is for a different transaction`);
            continue;
          }
          found.set(ep.url, r);
        } catch (e) {
          if (isNotFound(e)) notFoundAnswers += 1;
          else errors.push(`${ep.url}: ${brief(e)}`);
        }
        if (found.size >= need) break;
      }
      if (found.size >= need) break;
      if (round < rounds) await sleep(Math.min(cap, base * 2 ** (round - 1)));
    }

    if (found.size > 0) {
      const rs = [...found.values()];
      const first = rs[0]!;
      const disagree = rs.some((r) => r.status !== first.status || !eqHash(r.blockHash, first.blockHash) || r.blockNumber !== first.blockNumber);
      if (disagree) return { kind: 'conflict', detail: `endpoints returned different receipts for ${hash}`, attempts: attemptsUsed };
      // cross-check the receipt against the transaction's own block, when any endpoint can say
      for (const ep of endpoints) {
        await checkTx(ep);
        if (txBlock) break;
      }
      if (txBlock && (!eqHash(txBlock.blockHash, first.blockHash) || txBlock.blockNumber !== first.blockNumber)) {
        return { kind: 'conflict', detail: 'the receipt is not for the block the transaction was included in', attempts: attemptsUsed };
      }
      if (found.size < need) return { kind: 'insufficient_agreement', receipt: first, agreed: found.size, needed: need, attempts: attemptsUsed };
      return { kind: 'found', receipt: first, endpoints: [...found.keys()], attempts: attemptsUsed };
    }

    // No receipt anywhere. Is the transaction itself known?
    for (const ep of endpoints) {
      await checkTx(ep);
      if (txBlock) break;
    }
    if (txBlock) {
      return {
        kind: 'receipt_unavailable',
        blockNumber: txBlock.blockNumber,
        attempts: attemptsUsed,
        detail: `the transaction is in block ${txBlock.blockNumber} but no endpoint returned its receipt (some nodes prune old receipts); this is inconclusive, not a failure`,
      };
    }
    if (notFoundAnswers > 0) {
      return {
        kind: 'not_found',
        attempts: attemptsUsed,
        detail: `no endpoint knows this transaction after ${attemptsUsed} round(s) (${notFoundAnswers} "not found" answers${errors.length ? `, ${errors.length} errors` : ''})`,
      };
    }
    return {
      kind: 'error',
      attempts: attemptsUsed,
      detail: `the chain could not be read: ${[...errors, ...mismatches].slice(0, 3).join('; ') || 'no endpoint answered'}`,
    };
  }

  async function lookupTransaction(hash: Hex, o: LookupOptions = {}) {
    const rounds = Math.max(1, o.attempts ?? 4);
    const base = o.backoffMs ?? 250;
    const cap = o.maxBackoffMs ?? 2000;
    let nf = 0;
    const errors: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      for (const ep of endpoints) {
        try {
          const t = await ep.getTransaction({ hash });
          if (eqHash(t.hash, hash)) return { kind: 'found' as const, tx: t, attempts: round };
        } catch (e) {
          if (isNotFound(e)) nf += 1;
          else errors.push(`${ep.url}: ${brief(e)}`);
        }
      }
      if (round < rounds) await sleep(Math.min(cap, base * 2 ** (round - 1)));
    }
    if (nf > 0) return { kind: 'not_found' as const, attempts: rounds, detail: `no endpoint knows this transaction (${nf} answers)` };
    return { kind: 'error' as const, attempts: rounds, detail: `the chain could not be read: ${errors.slice(0, 3).join('; ') || 'no endpoint answered'}` };
  }

  return { endpoints, lookupReceipt, lookupTransaction };
}

// ------------------------------------------------------------------ production wiring (viem)

/** Primary first, then fallbacks, de-duplicated, https only. */
export function rpcUrlList(primary: string | undefined, fallbacks: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const u of [primary ?? DEFAULT_PRIMARY_RPC, ...(fallbacks ?? DEFAULT_RPC_FALLBACKS)]) {
    if (typeof u === 'string' && u.startsWith('https://') && !out.includes(u)) out.push(u);
  }
  return out;
}

/** A viem transport that fails over between endpoints on ERRORS (null answers are handled by lookupReceipt). */
export function readTransport(urls: readonly string[]) {
  const t = urls.map((u) => http(u, { retryCount: 1, timeout: 10_000 }));
  return t.length === 1 ? t[0]! : fallback(t, { retryCount: 1 });
}

/** Production endpoints: one viem client per URL, each with no internal retries (lookupReceipt owns retrying). */
export function createReadEndpoints(urls: readonly string[]): ReadEndpoint<ReceiptShape & Record<string, any>>[] {
  return urls.map((url) => {
    const c = createPublicClient({ chain: celo, transport: http(url, { retryCount: 0, timeout: 10_000 }) });
    return {
      url,
      getTransactionReceipt: (a) => c.getTransactionReceipt(a) as never,
      getTransaction: (a) => c.getTransaction(a) as never,
    };
  });
}

export function createProductionChainReads(primary: string | undefined, fallbacks: readonly string[] | undefined, deps?: { sleep?: (ms: number) => Promise<void> }) {
  return createChainReads(createReadEndpoints(rpcUrlList(primary, fallbacks)), deps);
}
