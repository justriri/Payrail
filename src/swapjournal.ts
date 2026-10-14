// Swap state journal. Persisted BEFORE each externally visible action so a crash can never lose track
// of a transaction that may have been broadcast. Contains NO secrets (no keys, no claim token).
//
// Non-terminal and UNCERTAIN swaps live in receipts/pending/swap-<planId>.json. That is the same folder the
// payment duplicate-guard reads, so an unresolved swap also blocks new payments until a human resolves it.
// Resolved swaps are written to receipts/swaps/<planId>.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetBySymbol, microUsd } from './assets.ts';
import { replaceFileAtomic } from './fsutil.ts';

export type SwapState =
  | 'PLANNED'
  | 'QUOTED'
  | 'AWAITING_APPROVAL'
  | 'READY_TO_EXECUTE'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'UNCERTAIN'
  | 'FAILED'
  | 'EXPIRED';

/** States after which nothing is in flight and no human resolution is needed. */
export const RESOLVED_STATES: readonly SwapState[] = ['CONFIRMED', 'FAILED', 'EXPIRED'];

export type StepStatus = 'prepared' | 'broadcast' | 'mined' | 'reverted' | 'unknown';

export interface StepRecord {
  kind: 'approve_reset' | 'approve' | 'swap';
  to: string;
  hash: string | undefined;
  nonce: number | undefined;
  status: StepStatus;
  attribution: { verified: boolean; codes: string[] | null; note: string } | undefined;
  gasUsed: string | undefined;
}

export interface SwapRecord {
  schemaVersion: 1;
  planId: string;
  state: SwapState;
  /** Why the state is what it is (a stable code, then prose). */
  code: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  route: {
    sellSymbol: string;
    sellAsset: string;
    buySymbol: string;
    buyAsset: string;
    provider: string;
  };
  amounts: {
    requestedSell: string;
    takerPays: string | undefined;
    buy: string | undefined;
    fee: string | undefined;
    minBuy: string;
  };
  quote: {
    id: string | undefined;
    expiresAt: string | undefined;
    textileStatus: string | undefined;
    textileStatusNote: string | undefined;
    /** The quote's raw deadline fields as returned (accept cutoff, order deadline, ...). */
    deadlines?: Record<string, string>;
  };
  steps: StepRecord[];
  simulations: Array<{ step: string; tagged: string; untagged: string; verdict: string }>;
  verification: {
    swapMined: boolean;
    sellDebited: string | undefined;
    buyReceived: string | undefined;
    fillEvent: boolean;
    notes: string[];
  };
  /** Balance reconciliation (atomic units, as decimal strings). Filled in as far as the run got. */
  balances: {
    sellBefore: string | undefined;
    sellAfter: string | undefined;
    buyBefore: string | undefined;
    buyAfter: string | undefined;
    nativeBefore: string | undefined;
    nativeAfter: string | undefined;
  };
  /** Gas actually used by mined transactions (receipt gasUsed x effective gas price when known). */
  gas: { usedUnits: string; costWei: string | undefined; note: string };
  approvedBy: string | undefined;
  /** Allowance left standing after the run (an approval can outlive a failed swap). */
  residualAllowance: string | undefined;
  attributionTag: string;
  /** True if value may have left the wallet (a swap tx was or may have been broadcast). */
  fundsMayHaveMoved: boolean;
}

function pendingFile(dir: string, planId: string): string {
  return join(dir, 'pending', `swap-${planId}.json`);
}
function resolvedFile(dir: string, planId: string): string {
  return join(dir, 'swaps', `${planId}.json`);
}

function atomicWrite(file: string, contents: string): void {
  // temp file + rename (atomic); retried when a sync client transiently blocks it, and it THROWS if it cannot be done
  replaceFileAtomic(file, contents);
}

/** Persist the record. Throws on failure; callers treat that as "do not proceed" (fail closed). */
export function saveSwapRecord(dir: string, rec: SwapRecord, now: Date = new Date()): void {
  rec.updatedAt = now.toISOString();
  const text = JSON.stringify(rec, null, 2);
  if (RESOLVED_STATES.includes(rec.state)) {
    mkdirSync(join(dir, 'swaps'), { recursive: true });
    atomicWrite(resolvedFile(dir, rec.planId), text);
    const p = pendingFile(dir, rec.planId);
    if (existsSync(p)) unlinkSync(p);
  } else {
    mkdirSync(join(dir, 'pending'), { recursive: true });
    atomicWrite(pendingFile(dir, rec.planId), text);
  }
}

export function loadSwapRecord(dir: string, planId: string): SwapRecord | undefined {
  for (const f of [pendingFile(dir, planId), resolvedFile(dir, planId)]) {
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as SwapRecord;
  }
  return undefined;
}

export function newSwapRecord(init: {
  planId: string;
  now: Date;
  route: SwapRecord['route'];
  requestedSell: bigint;
  minBuy: bigint;
  tag: string;
}): SwapRecord {
  const t = init.now.toISOString();
  return {
    schemaVersion: 1,
    planId: init.planId,
    state: 'PLANNED',
    code: 'PLANNED',
    message: 'swap authorized; no quote requested yet',
    createdAt: t,
    updatedAt: t,
    route: init.route,
    amounts: { requestedSell: init.requestedSell.toString(), takerPays: undefined, buy: undefined, fee: undefined, minBuy: init.minBuy.toString() },
    quote: { id: undefined, expiresAt: undefined, textileStatus: undefined, textileStatusNote: undefined },
    steps: [],
    simulations: [],
    verification: { swapMined: false, sellDebited: undefined, buyReceived: undefined, fillEvent: false, notes: [] },
    balances: { sellBefore: undefined, sellAfter: undefined, buyBefore: undefined, buyAfter: undefined, nativeBefore: undefined, nativeAfter: undefined },
    gas: { usedUnits: '0', costWei: undefined, note: 'no transaction mined yet' },
    approvedBy: undefined,
    residualAllowance: undefined,
    attributionTag: init.tag,
    fundsMayHaveMoved: false,
  };
}

// ------------------------------------------------------------------ cumulative daily swap spending

/**
 * USD value (micro-USD) that moved, or may have moved, through swaps in the window. CONSERVATIVE: unresolved
 * and UNCERTAIN swaps count; a FAILED/EXPIRED swap counts only if a swap transaction was actually sent.
 * The value is the USD-stable side of the swap (what was sold, or what was received for a local currency).
 * A record that cannot be valued is reported in `unvalued`; callers must fail closed on it.
 */
export function swapNotionalSince(dir: string, sinceMs: number): { micro: bigint; counted: number; unvalued: string[] } {
  let micro = 0n;
  let counted = 0;
  const unvalued: string[] = [];
  const files: string[] = [];
  for (const sub of ['swaps', 'pending']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // !isDirectory(), not isFile(): OneDrive reparse points report as symlinks
      if (e.isDirectory() || !e.name.endsWith('.json')) continue;
      if (sub === 'pending' && !e.name.startsWith('swap-')) continue;
      files.push(join(d, e.name));
    }
  }
  for (const f of files) {
    let r: SwapRecord;
    try {
      r = JSON.parse(readFileSync(f, 'utf8')) as SwapRecord;
    } catch {
      unvalued.push(f);
      continue;
    }
    if (Date.parse(r.updatedAt ?? r.createdAt) < sinceMs) continue;
    const swapSent = (r.steps ?? []).some((s) => s.kind === 'swap' && s.hash !== undefined && s.hash !== null);
    const resolvedNoMove = (r.state === 'FAILED' || r.state === 'EXPIRED') && !swapSent;
    if (resolvedNoMove) continue;
    const sell = assetBySymbol(r.route?.sellSymbol ?? '');
    const buy = assetBySymbol(r.route?.buySymbol ?? '');
    let v: bigint | undefined;
    const sellAtomic = r.amounts?.takerPays ?? r.amounts?.requestedSell;
    if (sell && sell.usdStable && sellAtomic && /^\d+$/.test(sellAtomic)) v = microUsd(sell, BigInt(sellAtomic));
    else {
      const buyAtomic = r.verification?.buyReceived ?? r.amounts?.buy ?? r.amounts?.minBuy;
      if (buy && buy.usdStable && buyAtomic && /^\d+$/.test(buyAtomic)) v = microUsd(buy, BigInt(buyAtomic));
    }
    if (v === undefined) {
      unvalued.push(f);
      continue;
    }
    micro += v;
    counted += 1;
  }
  return { micro, counted, unvalued };
}

/** The USD value a new swap would add (USD-stable side), or undefined if it cannot be valued. */
export function newSwapNotionalMicroUsd(a: {
  sell: { symbol: string; sellAmountAtomic: bigint };
  buy: { symbol: string; expectedBuyAtomic: bigint };
}): bigint | undefined {
  const sell = assetBySymbol(a.sell.symbol);
  if (sell?.usdStable) return microUsd(sell, a.sell.sellAmountAtomic);
  const buy = assetBySymbol(a.buy.symbol);
  if (buy?.usdStable) return microUsd(buy, a.buy.expectedBuyAtomic);
  return undefined;
}

export type SwapCapCheck = { ok: true; spentMicro: bigint } | { ok: false; code: 'SWAP_DAILY_CAP' | 'SWAP_CAP_UNVERIFIABLE'; message: string };

/** Enforce the cumulative daily cap for a swap that would add `addMicro`. Fails closed on anything unreadable. */
export function checkSwapDailyCap(dir: string, args: { nowMs: number; addMicro: bigint | undefined; capMicro: bigint }): SwapCapCheck {
  if (args.addMicro === undefined) {
    return { ok: false, code: 'SWAP_CAP_UNVERIFIABLE', message: 'the value of this swap cannot be determined, so the daily swap cap cannot be enforced' };
  }
  let h: ReturnType<typeof swapNotionalSince>;
  try {
    h = swapNotionalSince(dir, args.nowMs - 86_400_000);
  } catch (e) {
    return { ok: false, code: 'SWAP_CAP_UNVERIFIABLE', message: `cannot read swap history: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (h.unvalued.length > 0) {
    return { ok: false, code: 'SWAP_CAP_UNVERIFIABLE', message: `swap history contains a record that cannot be valued (${h.unvalued[0]}); resolve it first` };
  }
  if (h.micro + args.addMicro > args.capMicro) {
    return {
      ok: false,
      code: 'SWAP_DAILY_CAP',
      message: `swaps in the last 24h total ${h.micro} micro-USD; adding ${args.addMicro} would exceed the daily swap cap of ${args.capMicro}`,
    };
  }
  return { ok: true, spentMicro: h.micro };
}
