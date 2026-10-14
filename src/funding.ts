// Real-funds deposits. A buyer is credited ONLY for an ERC-20 Transfer that this module verified on-chain:
//   - the transaction succeeded and has at least `minConfirmations` confirmations,
//   - the log was emitted by the configured token contract,
//   - it went to the configured deposit address,
//   - it came from a wallet the buyer proved they control (signed message) and nobody else has registered,
//   - the (tx hash, log index) pair has not been credited before.
// Anything else is refused with a reason. Crediting never depends on what the caller *says* happened.
import { createPublicClient, getAddress, isAddress, verifyMessage } from 'viem';
import { celo } from 'viem/chains';
import { audit, inTransaction, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { deposit } from './ledger.ts';
import { readTransport } from './chainread.ts';

export class FundingError extends Error {
  code:
    | 'BAD_INPUT'
    | 'BAD_SIGNATURE'
    | 'WALLET_TAKEN'
    | 'NO_FUNDING_WALLET'
    | 'TX_NOT_FOUND'
    | 'TX_REVERTED'
    | 'NOT_ENOUGH_CONFIRMATIONS'
    | 'NO_MATCHING_TRANSFER'
    | 'OVER_LIMIT'
    | 'READ_FAILED';
  constructor(code: FundingError['code'], message: string) {
    super(message);
    this.name = 'FundingError';
    this.code = code;
  }
}

export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
}
export interface ChainReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: readonly ChainLog[];
}
/** The only chain access this module needs. Production = viem over public RPCs; tests inject fakes. */
export interface ChainReader {
  blockNumber(): Promise<bigint>;
  receipt(hash: string): Promise<ChainReceipt | null>;
}

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface FundingConfig {
  chainId: number;
  token: string;
  asset: string;
  depositAddress: string;
  minConfirmations: number;
  /** a safety cap per single deposit while the system is new (atomic units) */
  maxDepositAtomic: bigint;
  reader: ChainReader;
}

const lower = (a: string) => a.toLowerCase();
const topicAddress = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();

export function fundingMessage(buyerId: string, wallet: string): string {
  return `Payrail funding wallet\nBuyer: ${buyerId}\nWallet: ${lower(wallet)}\nI control this wallet and will send deposits from it.`;
}

/** Register the wallet a buyer will deposit from. One wallet belongs to one buyer. */
export async function registerFundingWallet(db: Db, buyerId: string, wallet: string, signature: string, now: () => number = Date.now): Promise<{ address: string }> {
  if (!isAddress(wallet)) throw new FundingError('BAD_INPUT', 'wallet must be a 0x address');
  const addr = lower(wallet);
  let ok = false;
  try {
    ok = await verifyMessage({ address: getAddress(wallet), message: fundingMessage(buyerId, addr), signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new FundingError('BAD_SIGNATURE', 'the signature does not match this wallet and buyer');
  return inTransaction(db, () => {
    const prior = queryOne(db, 'SELECT buyer_id FROM funding_wallets WHERE address = ?', addr);
    if (prior) {
      if (String(prior.buyer_id) !== buyerId) throw new FundingError('WALLET_TAKEN', 'this wallet is registered to another account');
      return { address: addr };
    }
    db.prepare('INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES (?, ?, ?, ?)').run(addr, buyerId, signature, new Date(now()).toISOString());
    audit(db, buyerId, 'funding_wallet.registered', addr, undefined, new Date(now()));
    return { address: addr };
  });
}

export function fundingWallets(db: Db, buyerId: string): string[] {
  return (db.prepare('SELECT address FROM funding_wallets WHERE buyer_id = ? ORDER BY verified_at').all(buyerId) as Array<{ address: string }>).map((r) => r.address);
}

export interface DepositResult {
  credited: Array<{ ref: string; amountAtomic: bigint; from: string; logIndex: number; created: boolean }>;
  confirmations: number;
}

/** Verify a transaction and credit every qualifying transfer in it. Safe to call repeatedly. */
export async function confirmDeposit(db: Db, cfg: FundingConfig, buyerId: string, txHash: string, now: () => number = Date.now): Promise<DepositResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new FundingError('BAD_INPUT', 'transaction hash must be 0x followed by 64 hex characters');
  const mine = new Set(fundingWallets(db, buyerId));
  if (mine.size === 0) throw new FundingError('NO_FUNDING_WALLET', 'register the wallet you will send from first');
  let receipt: ChainReceipt | null;
  let head: bigint;
  try {
    [receipt, head] = await Promise.all([cfg.reader.receipt(txHash), cfg.reader.blockNumber()]);
  } catch (e) {
    throw new FundingError('READ_FAILED', `could not read the chain: ${(e as Error).message.slice(0, 120)}`);
  }
  if (!receipt) throw new FundingError('TX_NOT_FOUND', 'the transaction was not found (it may still be pending)');
  if (receipt.status !== 'success') throw new FundingError('TX_REVERTED', 'the transaction failed on-chain; nothing was credited');
  const confirmations = Number(head - receipt.blockNumber) + 1;
  if (confirmations < cfg.minConfirmations) throw new FundingError('NOT_ENOUGH_CONFIRMATIONS', `${confirmations} of ${cfg.minConfirmations} confirmations; try again shortly`);

  const out: DepositResult['credited'] = [];
  let overLimit = false;
  for (const log of receipt.logs) {
    if (lower(log.address) !== lower(cfg.token) || log.topics.length !== 3 || lower(log.topics[0]!) !== TRANSFER_TOPIC) continue;
    if (topicAddress(log.topics[2]!) !== lower(cfg.depositAddress)) continue;
    const from = topicAddress(log.topics[1]!);
    if (!mine.has(from)) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    const amount = BigInt(log.data);
    if (amount <= 0n) continue;
    if (amount > cfg.maxDepositAtomic) {
      overLimit = true;
      continue;
    }
    const ref = `chain:${cfg.chainId}:${lower(txHash)}:${log.logIndex}`;
    // deposit() is atomic and idempotent per ref; chain_deposits is a read-friendly record of what was credited
    const { created } = deposit(db, { buyerId, asset: cfg.asset, amountAtomic: amount, ref, memo: `on-chain deposit ${lower(txHash)}` }, now);
    db.prepare(
      'INSERT OR IGNORE INTO chain_deposits (ref, buyer_id, tx_hash, log_index, from_address, amount_atomic, asset, block_number, credited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(ref, buyerId, lower(txHash), log.logIndex, from, amount, cfg.asset, receipt.blockNumber, new Date(now()).toISOString());
    out.push({ ref, amountAtomic: amount, from, logIndex: log.logIndex, created });
  }
  if (out.length === 0) {
    if (overLimit) throw new FundingError('OVER_LIMIT', `a single deposit is capped at ${cfg.maxDepositAtomic} atomic units while the system is new`);
    throw new FundingError('NO_MATCHING_TRANSFER', 'no transfer of the deposit token from your registered wallet to the deposit address was found in that transaction');
  }
  return { credited: out, confirmations };
}

/** Production reader: viem over the configured public RPCs, trying each in turn (some prune old receipts). */
export function createViemReader(urls: readonly string[]): ChainReader {
  const clients = urls.map((u) => createPublicClient({ chain: celo, transport: readTransport([u]) }));
  return {
    async blockNumber() {
      let last: unknown;
      for (const c of clients) {
        try {
          return await c.getBlockNumber();
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error('no RPC answered');
    },
    async receipt(hash) {
      let last: unknown;
      for (const c of clients) {
        try {
          const r = await c.getTransactionReceipt({ hash: hash as `0x${string}` });
          return { status: r.status, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as readonly string[], data: l.data, logIndex: Number(l.logIndex) })) };
        } catch (e) {
          if ((e as { name?: string }).name === 'TransactionReceiptNotFoundError') continue; // try the next endpoint
          last = e;
        }
      }
      if (last) throw last instanceof Error ? last : new Error('read failed');
      return null;
    },
  };
}
