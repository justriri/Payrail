// Checkout for SELLER-LISTED APIs.  (Buy-gateway APIs have their own flow in src/buypay.ts; the two are never mixed.)
//
// A seller listing is settled by Payrail's own ledger, not by Buy: the buyer's USDT reaches Payrail's deposit address, the server verifies the
// transfer on-chain and credits the buyer's ledger, a request RESERVES the price, and only a response that meets the listing's contract CAPTURES it
// (seller proceeds and the platform fee are booked in the same ledger transaction). This module is the server-side orchestration around that:
//
//   start     the server reads the AUTHORITATIVE price from the listing (never from the browser), freezes it with the request input, and works out
//             what the buyer must still do: ledger balance, what a top-up must be, what the wallet holds, and so what is short.
//   convert   (optional) when the wallet lacks USDT but holds a currency Textile can convert, the buyer-signed Textile conversion in src/buyconvert.ts
//             puts USDT in the buyer's OWN wallet. A conversion only counts once its receipt was verified on-chain.
//   deposit   the buyer's wallet sends exactly the top-up in USDT to the deposit address; the existing on-chain verification credits the ledger.
//   execute   the server re-checks the listing (published, same price), that the ledger covers the price, then runs the request ONCE under an
//             idempotency key derived from the checkout. Paid content comes only from a qualifying, ledger-captured execution.
//   receipt   one record tying listing, authoritative price, buyer, seller, conversion tx, deposit tx, execution and ledger entries together.
//
// Never charged twice (one idempotency key per checkout); never content without a captured payment; an interrupted or unknown outcome is
// reconciled from the execution table before anything is reported as failed.
import { randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { receiptFor } from './billing.ts';
import { confirmDeposit } from './funding.ts';
import type { FundingConfig } from './funding.ts';
import { executeRequest } from './execute.ts';
import type { ExecuteOptions, ExecutionResult } from './execute.ts';
import { cleanInput } from './gateway.ts';
import { balance } from './ledger.ts';
import { getListing } from './seller.ts';
import type { MasterKey } from './vault.ts';
import type { BuyConvert } from './buyconvert.ts';

export class CheckoutError extends Error {
  readonly code:
    | 'NOT_FOUND' | 'NOT_OWNER' | 'LISTING_UNAVAILABLE' | 'NOT_REAL_LISTING' | 'BAD_INPUT' | 'WRONG_STATE' | 'PRICE_CHANGED' | 'EXPIRED' | 'OVER_DEPOSIT_LIMIT'
    | 'INSUFFICIENT_BALANCE' | 'CONVERSION_NOT_CONFIRMED' | 'CONVERSION_DISABLED' | 'NOT_NEEDED' | 'RATE_LIMITED';
  constructor(code: CheckoutError['code'], message: string) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
  }
}

export type CheckoutState = 'QUOTED' | 'RUNNING' | 'CHARGED' | 'NOT_CHARGED' | 'UNRESOLVED' | 'EXPIRED';

export interface CheckoutDeps {
  db: Db;
  keys: readonly MasterKey[];
  funding: FundingConfig;
  execute: ExecuteOptions;
  convert?: BuyConvert;
  /** read-only USDT balance of a wallet; when absent the wallet shortfall is unknown and reported as null */
  usdtBalance?: (wallet: `0x${string}`) => Promise<bigint>;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const usdt = (a: bigint) => formatUnits(a, 6);
const TTL_MS = 30 * 60_000;

interface Row {
  id: string; buyer_id: string; wallet: string; listing_id: string; seller_id: string; price_atomic: string; fee_bps: number; listed_json: string | null;
  input_json: string; state: CheckoutState; conversion_id: string | null; deposit_txs: string; execution_id: string | null; failure: string | null;
  created_at: string; updated_at: string; expires_at: string;
}

export function createCheckout(d: CheckoutDeps) {
  const now = d.now ?? Date.now;
  const norm = (r: Record<string, unknown>): Row => ({ ...r, fee_bps: Number(r.fee_bps) }) as unknown as Row;
  const get = (id: string): Row | undefined => {
    const r = queryOne(d.db, 'SELECT * FROM listing_checkouts WHERE id = ?', id);
    return r ? norm(r) : undefined;
  };
  const owned = (buyerId: string, id: string): Row => {
    const r = get(id);
    if (!r || r.buyer_id !== buyerId) throw new CheckoutError('NOT_FOUND', 'no such checkout');
    return r;
  };
  const event = (id: string, state: string, note: string) => d.db.prepare('INSERT INTO listing_checkout_events (checkout_id, at, state, note) VALUES (?, ?, ?, ?)').run(id, iso(now()), state, note.slice(0, 400));
  const setState = (id: string, state: CheckoutState, note: string, patch: Record<string, string | null> = {}) => {
    const cols = Object.keys(patch);
    d.db.prepare(`UPDATE listing_checkouts SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(state, iso(now()), ...cols.map((c) => patch[c]!), id);
    event(id, state, note);
  };

  /** what the buyer still has to do, computed from the server's own numbers (price frozen in the checkout, ledger, chain) */
  async function plan(r: Row) {
    const price = BigInt(r.price_atomic);
    const available = balance(d.db, r.buyer_id, 'buyer_available', 'USDT');
    const topUp = price > available ? price - available : 0n;
    let walletUsdt: bigint | null = null;
    if (d.usdtBalance) {
      try { walletUsdt = await d.usdtBalance(r.wallet as `0x${string}`); } catch { walletUsdt = null; }
    }
    const walletShort = walletUsdt === null ? null : topUp > walletUsdt ? topUp - walletUsdt : 0n;
    const overCap = topUp > d.funding.maxDepositAtomic;
    return {
      priceAtomic: price, ledgerAvailableAtomic: available, topUpAtomic: topUp, walletUsdtAtomic: walletUsdt, walletShortAtomic: walletShort, overCap,
      ledgerAvailable: usdt(available), topUp: usdt(topUp), walletUsdt: walletUsdt === null ? null : usdt(walletUsdt), walletShort: walletShort === null ? null : usdt(walletShort),
      maxDeposit: usdt(d.funding.maxDepositAtomic),
      next: topUp === 0n ? 'run' : overCap ? 'blocked_over_limit' : walletShort === null || walletShort === 0n ? 'deposit' : 'convert_or_add_usdt',
    };
  }

  async function view(r: Row) {
    const l = getListing(d.db, r.listing_id);
    const listed = r.listed_json ? (JSON.parse(r.listed_json) as { currency: string; amount: string; rate: string; quotedAt: string; source: string }) : null;
    const deposits = JSON.parse(r.deposit_txs) as string[];
    const conv = r.conversion_id && d.convert ? d.convert.get(r.buyer_id, r.conversion_id) : null;
    const exec = r.execution_id ? receiptFor(d.db, r.execution_id) ?? null : null;
    const expired = r.state === 'QUOTED' && Date.parse(r.expires_at) < now();
    return {
      id: r.id,
      state: expired ? 'EXPIRED' : r.state,
      /** true only when the buyer's payment was captured in the ledger for a qualifying response */
      paid: r.state === 'CHARGED',
      listing: { id: r.listing_id, name: l?.name ?? '', seller: r.seller_id, status: l?.status ?? 'unknown' },
      price: { atomic: r.price_atomic, usdt: usdt(BigInt(r.price_atomic)), listed, feePercent: r.fee_bps / 100 },
      buyer: { wallet: r.wallet },
      plan: r.state === 'QUOTED' ? await plan(r) : null,
      conversion: conv,
      depositTxs: deposits,
      depositTxUrls: deposits.map((h) => `https://celoscan.io/tx/${h}`),
      executionId: r.execution_id,
      receipt: exec,
      failure: r.failure,
      note: r.state === 'UNRESOLVED' ? 'The outcome of the API call could not be established. Your amount is held, NOT charged, and is released automatically if it stays unresolved. Re-check below; nothing will be charged twice.' : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
    };
  }

  async function start(a: { buyerId: string; wallet: string; listingId: string; input: unknown }) {
    const l = getListing(d.db, a.listingId);
    if (!l || l.status !== 'published') throw new CheckoutError('LISTING_UNAVAILABLE', 'that API is not published');
    if (l.demo || l.asset !== 'USDT') throw new CheckoutError('NOT_REAL_LISTING', 'only real USDT listings can be purchased');
    let input;
    try { input = cleanInput(a.input); } catch (e) { throw new CheckoutError('BAD_INPUT', (e as Error).message); }
    const recent = Number((queryOne(d.db, 'SELECT COUNT(*) AS n FROM listing_checkouts WHERE buyer_id = ? AND created_at > ?', a.buyerId, iso(now() - 10 * 60_000)) as { n: number | bigint }).n);
    if (recent >= 30) throw new CheckoutError('RATE_LIMITED', 'too many checkouts in the last 10 minutes; wait a little');
    const id = `co_${randomUUID()}`;
    const listed = l.listed ? JSON.stringify({ currency: l.listed.currency, amount: formatUnits(l.listed.amountAtomic, l.listed.decimals), rate: l.listed.rate, quotedAt: l.listed.quotedAt, source: l.listed.source }) : null;
    d.db.prepare(
      `INSERT INTO listing_checkouts (id, buyer_id, wallet, listing_id, seller_id, price_atomic, fee_bps, listed_json, input_json, state, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUOTED', ?, ?, ?)`,
    ).run(id, a.buyerId, a.wallet.toLowerCase(), l.id, l.sellerId, l.priceAtomic.toString(), l.feeBps, listed, JSON.stringify(input), iso(now()), iso(now()), iso(now() + TTL_MS));
    event(id, 'QUOTED', `authoritative price ${usdt(l.priceAtomic)} USDT frozen from the listing; nothing signed or sent`);
    audit(d.db, a.buyerId, 'checkout.started', id, { listing: l.id, priceAtomic: l.priceAtomic.toString() }, new Date(now()));
    return view(get(id)!);
  }

  /** the wallet's conversion covers the shortfall: the server sizes it, the existing Textile flow performs it */
  async function estimate(a: { buyerId: string; checkoutId: string; symbol: string }) {
    if (!d.convert) throw new CheckoutError('CONVERSION_DISABLED', 'paying with another currency is not enabled on this server (the operator must set PAYRAIL_BUY_CONVERSION=1). Only USDT can be used.');
    const r = owned(a.buyerId, a.checkoutId);
    if (r.state !== 'QUOTED') throw new CheckoutError('WRONG_STATE', `a ${r.state} checkout cannot be funded`);
    const p = await plan(r);
    if (p.overCap) throw new CheckoutError('OVER_DEPOSIT_LIMIT', `this purchase needs a top-up of ${p.topUp} USDT, above the per-deposit limit of ${p.maxDeposit} USDT`);
    if (p.walletShortAtomic === null) throw new CheckoutError('WRONG_STATE', 'this server cannot read wallet balances, so it cannot work out how much to convert');
    if (p.walletShortAtomic === 0n) throw new CheckoutError('NOT_NEEDED', 'your wallet already holds enough USDT for this purchase; pay directly');
    const est = await d.convert.estimate({ buyerId: a.buyerId, wallet: r.wallet, symbol: a.symbol, targetAtomic: p.walletShortAtomic });
    const minOut = BigInt(est.conversion.receive.minimumAtomic);
    const expOut = BigInt(est.conversion.receive.expectedAtomic);
    const wallet = p.walletUsdtAtomic ?? 0n;
    return {
      ...est,
      checkout: {
        priceUsdt: usdt(p.priceAtomic), topUpUsdt: p.topUp, walletUsdt: p.walletUsdt, shortfallUsdt: p.walletShort,
        // after converting and then depositing the top-up, this much USDT stays in the buyer's wallet (at the guaranteed minimum / at the expected output)
        usdtLeftAtLeast: usdt(wallet + minOut - p.topUpAtomic),
        usdtLeftExpected: usdt(wallet + expOut - p.topUpAtomic),
      },
    };
  }

  /** a conversion that was PROVEN on-chain for this buyer; recorded on the checkout so the receipt can show it */
  function attachConversion(a: { buyerId: string; checkoutId: string; conversionId: string }) {
    const r = owned(a.buyerId, a.checkoutId);
    if (r.state !== 'QUOTED') throw new CheckoutError('WRONG_STATE', `a ${r.state} checkout cannot take a conversion`);
    const c = d.convert?.confirmedFor(a.buyerId, a.conversionId);
    if (!c) throw new CheckoutError('CONVERSION_NOT_CONFIRMED', 'that conversion is not confirmed on-chain, so it cannot be attached to a purchase');
    d.db.prepare('UPDATE listing_checkouts SET conversion_id = ?, updated_at = ? WHERE id = ?').run(c.id, iso(now()), r.id);
    event(r.id, r.state, `conversion ${c.swapTx ?? c.id} (verified on-chain) attached`);
    return view(get(r.id)!);
  }

  /** verify the top-up transfer on-chain (existing deposit verification) and credit the ledger; idempotent per transaction */
  async function deposit(a: { buyerId: string; checkoutId: string; txHash: string }) {
    const r = owned(a.buyerId, a.checkoutId);
    if (r.state !== 'QUOTED') throw new CheckoutError('WRONG_STATE', `a ${r.state} checkout cannot take a deposit`);
    const res = await confirmDeposit(d.db, d.funding, a.buyerId, a.txHash, now); // throws FundingError (pending codes included) without crediting anything
    const txs = JSON.parse(r.deposit_txs) as string[];
    const h = a.txHash.toLowerCase();
    if (!txs.includes(h)) d.db.prepare('UPDATE listing_checkouts SET deposit_txs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...txs, h]), iso(now()), r.id);
    event(r.id, r.state, `deposit ${h} verified on-chain: ${res.credited.map((c) => `${usdt(c.amountAtomic)} USDT${c.created ? '' : ' (already credited)'}`).join(', ')}`);
    return { credited: res.credited.map((c) => ({ amount: usdt(c.amountAtomic), alreadyCredited: !c.created })), confirmations: res.confirmations, checkout: await view(get(r.id)!) };
  }

  const keyOf = (id: string) => `co-${id.replace(/^co_/, '')}`.slice(0, 100);
  const mapState = (e: { state: string }): CheckoutState =>
    e.state === 'QUALIFIED' ? 'CHARGED' : e.state === 'NOT_QUALIFIED' || e.state === 'RELEASED_UNRESOLVED' ? 'NOT_CHARGED' : e.state === 'UNRESOLVED' ? 'UNRESOLVED' : 'RUNNING';

  /** align the checkout with its execution (the ledger's own record). Safe to call repeatedly; never invents an outcome. */
  function reconcile(id: string): Row {
    const r = get(id)!;
    if (r.state === 'QUOTED') return r;
    const e = queryOne(d.db, 'SELECT id, state FROM executions WHERE buyer_id = ? AND idempotency_key = ?', r.buyer_id, keyOf(r.id));
    if (!e) return r; // no execution was ever started for this checkout: nothing to reconcile
    const next = mapState({ state: String(e.state) });
    if (r.execution_id !== String(e.id) || r.state !== next) setState(r.id, next, `reconciled from execution ${String(e.id)}: ${String(e.state)}`, { execution_id: String(e.id) });
    return get(id)!;
  }

  async function execute(a: { buyerId: string; checkoutId: string }): Promise<{ checkout: Awaited<ReturnType<typeof view>>; result: ExecutionResult | null }> {
    let r = owned(a.buyerId, a.checkoutId);
    if (r.state !== 'QUOTED') {
      // a retry, a double click or a reload: report what is already known and never run the API or reserve funds again
      r = reconcile(r.id);
      const result = r.execution_id && ['CHARGED', 'NOT_CHARGED', 'UNRESOLVED', 'RUNNING'].includes(r.state) ? await replay(r) : null;
      return { checkout: await view(r), result };
    }
    if (Date.parse(r.expires_at) < now()) {
      setState(r.id, 'EXPIRED', 'the checkout expired before it was run; nothing was charged');
      throw new CheckoutError('EXPIRED', 'this checkout expired. Nothing was charged; start again to get the current price.');
    }
    // the listing may have changed since the price was frozen
    const l = getListing(d.db, r.listing_id);
    if (!l || l.status !== 'published') throw new CheckoutError('LISTING_UNAVAILABLE', 'that API is no longer published. Nothing was charged.');
    if (l.priceAtomic.toString() !== r.price_atomic) {
      setState(r.id, 'EXPIRED', `the listing price changed from ${usdt(BigInt(r.price_atomic))} to ${usdt(l.priceAtomic)} USDT; nothing was charged`);
      throw new CheckoutError('PRICE_CHANGED', `The seller changed the price to ${usdt(l.priceAtomic)} USDT (it was ${usdt(BigInt(r.price_atomic))} USDT). Nothing was charged. Start again to review the new price.`);
    }
    const available = balance(d.db, r.buyer_id, 'buyer_available', 'USDT');
    if (available < BigInt(r.price_atomic)) {
      throw new CheckoutError('INSUFFICIENT_BALANCE', `Your Payrail balance is ${usdt(available)} USDT but this API costs ${usdt(BigInt(r.price_atomic))} USDT. Nothing was charged: top up first.`);
    }
    // compare-and-set so two concurrent requests cannot both run
    const won = d.db.prepare("UPDATE listing_checkouts SET state = 'RUNNING', updated_at = ? WHERE id = ? AND state = 'QUOTED'").run(iso(now()), r.id);
    if (Number(won.changes) !== 1) return execute(a);
    event(r.id, 'RUNNING', 'balance verified server-side; running the request once under this checkout\'s idempotency key');
    let result: ExecutionResult;
    try {
      result = await executeRequest(d.db, d.keys, { buyerId: r.buyer_id, listingId: r.listing_id, idempotencyKey: keyOf(r.id), input: JSON.parse(r.input_json) }, d.execute);
    } catch (e) {
      // nothing was held if the hold itself failed: the checkout can be retried. Otherwise reconcile from the execution table.
      const code = (e as { code?: string }).code;
      const ex = queryOne(d.db, 'SELECT id FROM executions WHERE buyer_id = ? AND idempotency_key = ?', r.buyer_id, keyOf(r.id));
      if (!ex) {
        d.db.prepare("UPDATE listing_checkouts SET state = 'QUOTED', updated_at = ? WHERE id = ?").run(iso(now()), r.id);
        event(r.id, 'QUOTED', `the request was refused before anything was reserved (${code ?? 'error'}); nothing was charged`);
        throw e;
      }
      reconcile(r.id);
      return { checkout: await view(get(r.id)!), result: null };
    }
    setState(r.id, mapState({ state: result.state }), `execution ${result.executionId}: ${result.state}${result.charged ? ' (charged)' : result.held ? ' (held, not charged)' : ' (not charged)'}`, { execution_id: result.executionId });
    audit(d.db, r.buyer_id, 'checkout.finished', r.id, { state: result.state, execution: result.executionId }, new Date(now()));
    return { checkout: await view(get(r.id)!), result };
  }

  /** the stored result of an already-started execution, WITHOUT calling the seller again (the idempotency key makes this a pure read) */
  async function replay(r: Row): Promise<ExecutionResult | null> {
    try {
      return await executeRequest(d.db, d.keys, { buyerId: r.buyer_id, listingId: r.listing_id, idempotencyKey: keyOf(r.id), input: JSON.parse(r.input_json) }, d.execute);
    } catch { return null; }
  }

  return {
    start, estimate, attachConversion, deposit, execute,
    get: async (buyerId: string, id: string) => { owned(buyerId, id); return view(reconcile(id)); },
    list: async (buyerId: string) => Promise.all(query(d.db, 'SELECT id FROM listing_checkouts WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 30', buyerId).map((x) => view(reconcile(String(x.id))))),
    events: (buyerId: string, id: string) => { owned(buyerId, id); return query(d.db, 'SELECT at, state, note FROM listing_checkout_events WHERE checkout_id = ? ORDER BY id', id).map((e) => ({ at: String(e.at), state: String(e.state), note: String(e.note) })); },
    reconcile: (buyerId: string, id: string) => { owned(buyerId, id); return reconcile(id); },
  };
}
export type Checkout = ReturnType<typeof createCheckout>;
