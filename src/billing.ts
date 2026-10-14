// Outcome-based billing views: the quote shown BEFORE a purchase, the receipt for each request, and the account
// statements that tie requests, ledger entries and payouts together. Everything here is derived from persisted state
// (executions, ledger transactions, payouts); nothing is recomputed from assumptions.
import { query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { currentContract, describeContract, getContract } from './contracts.ts';
import { feeFor, balance } from './ledger.ts';
import { getListing } from './seller.ts';

export const VALIDATION_NOTE =
  'Payrail checks that a response has the agreed structure, field types and freshness. That is structural validation: it does not and cannot verify that the data is true or accurate.';

const fmt = (v: bigint, decimals = 6): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -decimals)}${frac ? `.${frac}` : ''}`;
};
const money = (v: bigint) => ({ atomic: v.toString(), display: fmt(v) });

// ------------------------------------------------------------------ quote

export interface Quote {
  listingId: string;
  name: string;
  description: string;
  asset: string;
  available: boolean;
  unavailableReason: string | null;
  buyerPays: { atomic: string; display: string };
  platformFee: { bps: number; percent: number; atomic: string; display: string };
  sellerReceives: { atomic: string; display: string };
  chargedOnlyIf: string[];
  contract: { id: string; version: number; hash: string } | null;
  maxLatencyMs: number | null;
  freshness: { path: string; maxAgeSeconds: number } | null;
  notCharged: string[];
  validationNote: string;
  settlementPaths: Array<'ledger' | 'escrow'>;
}

/** What a buyer will pay and what the seller will earn, before anything is held. Pure read; no side effects. */
export function quoteFor(db: Db, listingId: string, opts: { escrowEnabled?: boolean } = {}): Quote | undefined {
  const l = getListing(db, listingId);
  if (!l) return undefined;
  const c = currentContract(db, listingId);
  const { fee, seller } = feeFor(l.priceAtomic, l.feeBps);
  const available = l.status === 'published' && c !== undefined;
  return {
    listingId: l.id,
    name: l.name,
    description: l.description,
    asset: l.asset,
    available,
    unavailableReason: available ? null : l.status !== 'published' ? `the listing is ${l.status}, not published` : 'it has no approved response contract',
    buyerPays: money(l.priceAtomic),
    platformFee: { bps: l.feeBps, percent: l.feeBps / 100, ...money(fee) },
    sellerReceives: money(seller),
    chargedOnlyIf: c ? describeContract(c.body) : [],
    contract: c ? { id: c.id, version: c.version, hash: c.bodyHash } : null,
    maxLatencyMs: c ? c.body.success.maxLatencyMs : null,
    freshness: c?.body.success.freshness ? { path: c.body.success.freshness.path, maxAgeSeconds: c.body.success.freshness.maxAgeSeconds } : null,
    notCharged: [
      'A response that fails any condition above is not charged; the reserved amount is released in full.',
      'If the outcome cannot be established (timeout, lost connection) the amount stays reserved and is NOT charged. It is released to you if it stays unresolved.',
      'Repeating a request with the same idempotency key never charges twice.',
    ],
    validationNote: VALIDATION_NOTE,
    settlementPaths: opts.escrowEnabled ? ['ledger', 'escrow'] : ['ledger'],
  };
}

// ------------------------------------------------------------------ receipt

export type OutcomeCode = 'QUALIFIED' | 'NOT_QUALIFIED' | 'UNRESOLVED' | 'RELEASED_UNRESOLVED' | 'IN_PROGRESS';

export interface Receipt {
  receiptId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  listing: { id: string; name: string };
  contract: { version: number; hash: string } | null;
  outcome: OutcomeCode;
  /** one plain sentence a person or an agent can show */
  summary: string;
  reason: string | null;
  settlement: 'ledger' | 'escrow';
  asset: string;
  price: { atomic: string; display: string };
  charged: { atomic: string; display: string };
  held: { atomic: string; display: string };
  returned: { atomic: string; display: string };
  platformFee: { atomic: string; display: string } | null;
  sellerEarned: { atomic: string; display: string } | null;
  /** ledger transactions for off-chain settlement */
  ledger: Array<{ id: number; kind: string; ref: string | null; at: string }>;
  /** on-chain references for escrow settlement */
  escrow: { holdId: string | null; txs: Record<string, string> } | null;
  validation: { kind: 'structural'; note: string; checks: Array<{ name: string; ok: boolean; detail: string }>; responseSha256: string | null };
  upstream: { status: number; elapsedMs: number } | null;
  agentId: string | null;
}

const SUMMARY: Record<OutcomeCode, (r: { price: string; asset: string }) => string> = {
  QUALIFIED: (r) => `The response met the agreed requirements. ${r.price} ${r.asset} was charged.`,
  NOT_QUALIFIED: () => 'The response did not meet the agreed requirements, or the request was never sent. Nothing was charged.',
  UNRESOLVED: (r) => `The outcome could not be established. ${r.price} ${r.asset} is held, not charged, and will be released to the buyer if it stays unresolved.`,
  RELEASED_UNRESOLVED: () => 'The outcome could not be established within the window. The held amount was released to the buyer. Nothing was charged.',
  IN_PROGRESS: (r) => `The request is still in progress. ${r.price} ${r.asset} is reserved, not charged.`,
};

export function receiptFor(db: Db, executionId: string): Receipt | undefined {
  const e = queryOne(db, 'SELECT * FROM executions WHERE id = ?', executionId);
  if (!e) return undefined;
  const l = getListing(db, String(e.listing_id));
  const c = getContract(db, String(e.contract_version_id));
  const state = String(e.state);
  const price = BigInt(e.price_atomic as bigint);
  const outcome: OutcomeCode = state === 'HELD' ? 'IN_PROGRESS' : (state as OutcomeCode);
  const open = state === 'HELD' || state === 'UNRESOLVED';
  const charged = state === 'QUALIFIED' ? price : 0n;
  const returned = state === 'NOT_QUALIFIED' || state === 'RELEASED_UNRESOLVED' ? price : 0n;
  const ev = e.evidence_json ? (JSON.parse(String(e.evidence_json)) as { checks?: Receipt['validation']['checks']; upstream?: Receipt['upstream']; bodySha256?: string; txs?: Record<string, string>; holdId?: string }) : {};
  const settlement = String(e.settlement) as 'ledger' | 'escrow';
  const ledger =
    settlement === 'ledger'
      ? query(db, 'SELECT id, kind, ref, created_at FROM ledger_transactions WHERE execution_id = ? ORDER BY id', executionId).map((t) => ({ id: Number(t.id), kind: String(t.kind), ref: t.ref === null ? null : String(t.ref), at: String(t.created_at) }))
      : [];
  const display = fmt(price);
  return {
    receiptId: executionId,
    idempotencyKey: String(e.idempotency_key).replace(/^agent_[0-9a-f-]+:/, ''),
    createdAt: String(e.created_at),
    updatedAt: String(e.updated_at),
    listing: { id: String(e.listing_id), name: l?.name ?? '' },
    contract: c ? { version: c.version, hash: c.bodyHash } : null,
    outcome,
    summary: SUMMARY[outcome]({ price: display, asset: String(e.asset) }),
    reason: e.reason === null ? null : String(e.reason),
    settlement,
    asset: String(e.asset),
    price: money(price),
    charged: money(charged),
    held: money(open ? price : 0n),
    returned: money(returned),
    platformFee: e.fee_atomic === null ? null : money(BigInt(e.fee_atomic as bigint)),
    sellerEarned: e.seller_atomic === null ? null : money(BigInt(e.seller_atomic as bigint)),
    ledger,
    escrow: settlement === 'escrow' ? { holdId: ev.holdId ?? null, txs: ev.txs ?? {} } : null,
    validation: { kind: 'structural', note: VALIDATION_NOTE, checks: ev.checks ?? [], responseSha256: ev.bodySha256 ?? null },
    upstream: ev.upstream ?? null,
    agentId: e.agent_id === null || e.agent_id === undefined ? null : String(e.agent_id),
  };
}

// ------------------------------------------------------------------ statements

type Row = { asset: string; settlement: string; state: string; n: bigint; price: bigint | null; fee: bigint | null; seller: bigint | null };

const num = (v: bigint | null | undefined) => BigInt(v ?? 0n);

export interface SettlementBucket {
  settlement: 'ledger' | 'escrow';
  asset: string;
  requests: number;
  qualified: number;
  notCharged: number;
  unresolvedOpen: number;
  releasedUnresolved: number;
  gross: { atomic: string; display: string };
  platformFees: { atomic: string; display: string };
  sellerEarnings: { atomic: string; display: string };
  /** amounts returned to buyers (non-qualifying and expired-unresolved) */
  refunded: { atomic: string; display: string };
  /** reserved while the outcome is unknown */
  heldOpen: { atomic: string; display: string };
}

function buckets(rows: Row[]): SettlementBucket[] {
  const map = new Map<string, SettlementBucket & { _g: bigint; _f: bigint; _s: bigint; _r: bigint; _h: bigint }>();
  for (const r of rows) {
    const k = `${r.settlement}|${r.asset}`;
    const b = map.get(k) ?? { settlement: r.settlement as 'ledger' | 'escrow', asset: r.asset, requests: 0, qualified: 0, notCharged: 0, unresolvedOpen: 0, releasedUnresolved: 0, gross: money(0n), platformFees: money(0n), sellerEarnings: money(0n), refunded: money(0n), heldOpen: money(0n), _g: 0n, _f: 0n, _s: 0n, _r: 0n, _h: 0n };
    const n = Number(r.n);
    b.requests += n;
    if (r.state === 'QUALIFIED') { b.qualified += n; b._g += num(r.price); b._f += num(r.fee); b._s += num(r.seller); }
    else if (r.state === 'NOT_QUALIFIED') { b.notCharged += n; b._r += num(r.price); }
    else if (r.state === 'RELEASED_UNRESOLVED') { b.releasedUnresolved += n; b._r += num(r.price); }
    else { b.unresolvedOpen += n; b._h += num(r.price); }
    map.set(k, b);
  }
  return [...map.values()].map((b) => ({
    settlement: b.settlement, asset: b.asset, requests: b.requests, qualified: b.qualified, notCharged: b.notCharged, unresolvedOpen: b.unresolvedOpen, releasedUnresolved: b.releasedUnresolved,
    gross: money(b._g), platformFees: money(b._f), sellerEarnings: money(b._s), refunded: money(b._r), heldOpen: money(b._h),
  }));
}

export interface SellerStatement {
  sellerId: string;
  buckets: SettlementBucket[];
  /** off-chain ledger earnings available to request as a payout, per asset */
  ledgerBalances: Array<{ asset: string; available: { atomic: string; display: string }; pendingPayout: { atomic: string; display: string } }>;
  payouts: Array<{ id: string; asset: string; amount: { atomic: string; display: string }; state: string; destination: string; requestedAt: string; settledAt: string | null; txHash: string | null }>;
  payoutTotals: Array<{ asset: string; pending: { atomic: string; display: string }; completed: { atomic: string; display: string } }>;
  recentSales: Array<{ receiptId: string; at: string; listing: string; asset: string; gross: string; fee: string; earned: string; settlement: string; state: string }>;
  notes: string[];
}

export function sellerStatement(db: Db, sellerId: string): SellerStatement {
  const rows = query<Row>(
    db,
    `SELECT e.asset AS asset, e.settlement AS settlement, e.state AS state, COUNT(*) AS n, SUM(e.price_atomic) AS price, SUM(e.fee_atomic) AS fee, SUM(e.seller_atomic) AS seller
       FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? GROUP BY e.asset, e.settlement, e.state`,
    sellerId,
  );
  const assets = new Set<string>(rows.map((r) => String(r.asset)));
  const payouts = query(db, 'SELECT * FROM payouts WHERE seller_id = ? ORDER BY requested_at DESC', sellerId);
  for (const p of payouts) assets.add(String(p.asset));
  const totals = new Map<string, { pending: bigint; completed: bigint }>();
  for (const p of payouts) {
    const t = totals.get(String(p.asset)) ?? { pending: 0n, completed: 0n };
    const a = BigInt(p.amount_atomic as bigint);
    if (['requested', 'approved', 'sent'].includes(String(p.state))) t.pending += a;
    if (p.state === 'confirmed') t.completed += a;
    totals.set(String(p.asset), t);
  }
  const recent = query(
    db,
    `SELECT e.id, e.updated_at, e.asset, e.settlement, e.state, e.price_atomic, e.fee_atomic, e.seller_atomic, l.name
       FROM executions e JOIN listings l ON l.id = e.listing_id WHERE l.seller_id = ? AND e.state = 'QUALIFIED' ORDER BY e.updated_at DESC LIMIT 20`,
    sellerId,
  );
  return {
    sellerId,
    buckets: buckets(rows),
    ledgerBalances: [...assets].map((asset) => ({
      asset,
      available: money(balance(db, sellerId, 'seller_earnings', asset)),
      pendingPayout: money(balance(db, sellerId, 'payout_pending', asset)),
    })),
    payouts: payouts.map((p) => ({ id: String(p.id), asset: String(p.asset), amount: money(BigInt(p.amount_atomic as bigint)), state: String(p.state), destination: String(p.destination), requestedAt: String(p.requested_at), settledAt: p.settled_at === null ? null : String(p.settled_at), txHash: p.tx_hash === null ? null : String(p.tx_hash) })),
    payoutTotals: [...totals.entries()].map(([asset, t]) => ({ asset, pending: money(t.pending), completed: money(t.completed) })),
    recentSales: recent.map((r) => ({ receiptId: String(r.id), at: String(r.updated_at), listing: String(r.name), asset: String(r.asset), gross: fmt(BigInt(r.price_atomic as bigint)), fee: fmt(BigInt(r.fee_atomic as bigint)), earned: fmt(BigInt(r.seller_atomic as bigint)), settlement: String(r.settlement), state: String(r.state) })),
    notes: [
      'Direct (ledger) settlement: earnings accrue to your Payrail balance and can be requested as a payout; payouts need operator approval and are not sent automatically.',
      'Escrow settlement: earnings are claimable on-chain from the escrow contract by your wallet and are not part of your Payrail balance.',
      'Test-credit earnings (asset TESTUSDT) cannot be paid out.',
    ],
  };
}

export interface BuyerStatement {
  buyerId: string;
  buckets: SettlementBucket[];
  balances: Array<{ asset: string; available: { atomic: string; display: string }; held: { atomic: string; display: string }; deposited: { atomic: string; display: string }; charged: { atomic: string; display: string }; returned: { atomic: string; display: string } }>;
}

export function buyerStatement(db: Db, buyerId: string): BuyerStatement {
  const rows = query<Row>(
    db,
    `SELECT asset, settlement, state, COUNT(*) AS n, SUM(price_atomic) AS price, SUM(fee_atomic) AS fee, SUM(seller_atomic) AS seller FROM executions WHERE buyer_id = ? GROUP BY asset, settlement, state`,
    buyerId,
  );
  const assets = new Set<string>(rows.map((r) => String(r.asset)));
  for (const a of query(db, "SELECT DISTINCT asset FROM ledger_accounts WHERE owner_id = ?", buyerId)) assets.add(String(a.asset));
  const b = buckets(rows);
  return {
    buyerId,
    buckets: b,
    balances: [...assets].map((asset) => {
      const dep = queryOne<{ s: bigint | null }>(
        db,
        `SELECT SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.tx_id JOIN ledger_accounts a ON a.id = e.account_id
          WHERE t.kind = 'deposit' AND a.owner_id = ? AND a.kind = 'buyer_available' AND e.asset = ?`,
        buyerId,
        asset,
      );
      const ledgerRows = b.filter((x) => x.asset === asset && x.settlement === 'ledger');
      const sum = (f: (x: SettlementBucket) => string) => ledgerRows.reduce((acc, x) => acc + BigInt(f(x)), 0n);
      return {
        asset,
        available: money(balance(db, buyerId, 'buyer_available', asset)),
        held: money(balance(db, buyerId, 'buyer_held', asset)),
        deposited: money(num(dep?.s)),
        charged: money(sum((x) => x.gross.atomic)),
        returned: money(sum((x) => x.refunded.atomic)),
      };
    }),
  };
}

export interface PlatformStatement {
  buckets: SettlementBucket[];
  feesCollected: Array<{ asset: string; atomic: string; display: string }>;
  openPayouts: Array<{ asset: string; atomic: string; display: string }>;
}
export function platformStatement(db: Db): PlatformStatement {
  const rows = query<Row>(db, 'SELECT asset, settlement, state, COUNT(*) AS n, SUM(price_atomic) AS price, SUM(fee_atomic) AS fee, SUM(seller_atomic) AS seller FROM executions GROUP BY asset, settlement, state');
  const fees = query<{ asset: string; s: bigint }>(db, "SELECT a.asset AS asset, SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'platform_fee' GROUP BY a.asset");
  const open = query<{ asset: string; s: bigint | null }>(db, "SELECT asset, SUM(amount_atomic) AS s FROM payouts WHERE state IN ('requested','approved','sent') GROUP BY asset");
  return {
    buckets: buckets(rows),
    feesCollected: fees.map((f) => ({ asset: String(f.asset), ...money(BigInt(f.s)) })),
    openPayouts: open.map((f) => ({ asset: String(f.asset), ...money(num(f.s)) })),
  };
}
