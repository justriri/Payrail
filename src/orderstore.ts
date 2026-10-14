// Order records: types and persistence only (no spending logic). Shared by the orchestrator, the executor
// (which stamps receipts with the order link), history and evidence.
//
// Persisted to receipts/orders/<orderId>.json. Contains public facts only: never keys or claim tokens.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomic } from './fsutil.ts';

export type OrderState = 'CONVERTING' | 'CONVERTED' | 'PAYING' | 'COMPLETED' | 'STOPPED' | 'UNCERTAIN';

/** What a payment receipt says about the order it belongs to. */
export interface OrderLink {
  orderId: string;
  /** The ACTUAL route the funds took: paid directly, or converted first. */
  route: 'direct' | 'converted';
  conversion?: OrderConversion;
}

export interface OrderConversion {
  provider: string;
  swapPlanId: string;
  state: string;
  txHashes: string[];
  sellSymbol?: string;
  sellAmountAtomic?: string;
  buySymbol?: string;
  receivedAtomic?: string;
}

export interface OrderStepRecord {
  kind: 'convert' | 'pay';
  state: 'pending' | 'running' | 'done' | 'failed' | 'uncertain' | 'skipped';
  /** Reference to the underlying record: the swap plan id or the payment plan id. */
  ref?: string;
  detail?: string;
}

/** The service-delivery result, copied from the payment receipt (the receipt remains the source of truth). */
export interface OrderDelivery {
  delivered: boolean;
  httpStatus: number | null;
  responseSha256: string | null;
  responseFile: string | null;
  responseSummary: string | null;
}

export interface OrderRecord {
  schemaVersion: 1;
  orderId: string;
  state: OrderState;
  /** A stable code for why the order is in this state. */
  code: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  service: { id: string; title: string; url: string; provider: string };
  payer: string;
  bodyHash: string;
  /** Digest of the exact order plan the approval was bound to. */
  planDigest?: string;
  /** What the human approved: the payment may not exceed this, to this payee, in this asset. */
  approved: {
    asset: string;
    symbol: string;
    payTo: string;
    amountAtomic: string;
    route: 'direct' | 'swap';
    totalMicroUsd: string | undefined;
    conversionProvider: string | undefined;
  };
  approvedBy: string | undefined;
  steps: OrderStepRecord[];
  conversion?: OrderConversion;
  payment?: {
    /** The route the payment actually took. */
    route: 'direct' | 'converted';
    receiptFile: string | undefined;
    receiptId: string | undefined;
    planId?: string;
    txHash: string | null | undefined;
    /** CONFIRMED / REJECTED / UNCERTAIN / IN_DOUBT: never collapsed into one another. */
    status: string;
    delivery?: OrderDelivery;
  };
  /** True when value may have moved and a human should look (UNCERTAIN, or converted but unpaid). */
  needsAttention: boolean;
  /** Notes written by crash recovery. */
  recovery?: string[];
}

const orderFile = (dir: string, id: string) => join(dir, 'orders', `${id}.json`);

/** Exclusive create: returns false if the order id already exists (also across processes). */
export function createOrderFile(dir: string, rec: OrderRecord): boolean {
  mkdirSync(join(dir, 'orders'), { recursive: true });
  try {
    writeFileSync(orderFile(dir, rec.orderId), JSON.stringify(rec, null, 2), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export function saveOrder(dir: string, rec: OrderRecord, now: Date): void {
  rec.updatedAt = now.toISOString();
  replaceFileAtomic(orderFile(dir, rec.orderId), JSON.stringify(rec, null, 2));
}

export function loadOrder(dir: string, id: string): OrderRecord | undefined {
  const f = orderFile(dir, id);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as OrderRecord) : undefined;
}

/**
 * Every readable order, plus the files that could not be read (reported, never hidden).
 * Directory entries are filtered with !isDirectory(), not isFile(): OneDrive reparse points report as symlinks.
 */
export function readOrders(dir: string): { orders: OrderRecord[]; warnings: string[] } {
  const d = join(dir, 'orders');
  const orders: OrderRecord[] = [];
  const warnings: string[] = [];
  if (!existsSync(d)) return { orders, warnings };
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory() || !e.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(d, e.name), 'utf8')) as OrderRecord;
      if (typeof j.orderId !== 'string' || typeof j.state !== 'string') throw new Error('not an order record');
      orders.push(j);
    } catch (err) {
      warnings.push(`orders/${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { orders, warnings };
}

export function listOrders(dir: string): OrderRecord[] {
  return readOrders(dir).orders;
}
