// Paying for a Buy AI API with a currency other than USDT (cNGN, ...): Textile converts, Buy is paid in USDT. Payrail builds neither.
//
//   Buy AI    sells the API and is paid in USDT on Celo by the buyer's own wallet (src/buypay.ts).
//   Textile   is the currency conversion layer: it swaps the buyer's cNGN (etc.) into USDT. The swap is signed and sent by the BUYER's wallet
//             as the Textile taker, and Textile pays the output to that same wallet. Payrail never holds the key or the money.
//
// So a purchase with cNGN is two verified steps in the buyer's wallet: (1) Textile swap cNGN -> USDT, (2) Buy payment in USDT.
// Textile does NOT settle the API purchase and Buy does not accept cNGN: the USDT in the buyer's wallet is the hand-off.
//
// This module only plans, validates and VERIFIES. A conversion is CONFIRMED only from the swap's receipt (success, enough confirmations,
// a Fill from the verified Textile reactor for this wallet, USDT of the exact token contract delivered to this wallet, at least the
// minimum that was shown). It reuses the buyer-signed Textile code (src/buyerswap.ts, src/swapquote.ts) and the pure verifier in
// src/marketfunding.ts; it adds no payment system of its own.
//
// Textile has a corridor minimum (about 1 USD of notional): the swap can be larger than the API price, and the USDT left over simply
// stays in the buyer's wallet. The page says so before the buyer approves.
import { createHash, randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import type { BuyerSwapRuntime, PrepareResult } from './buyerswap.ts';
import { USDT_CELO } from './conversion.ts';
import { DOCUMENTED_ON_CELO } from './routeevidence.ts';
import type { OfficialCorridors } from './textiledocs.ts';
import type { ConversionProvider, RouteRegistry } from './conversion.ts';
import type { ChainReader } from './funding.ts';
import { verifyConversion } from './marketfunding.ts';
import type { FundingOp } from './marketfunding.ts';
import type { TakerProof } from './textile.ts';

export class BuyConvertError extends Error {
  readonly code: 'UNSUPPORTED_CURRENCY' | 'NOT_FOUND' | 'NOT_OWNER' | 'WRONG_STATE' | 'BAD_INPUT' | 'ABOVE_LIMIT' | 'RATE_LIMITED' | 'NO_QUOTE' | 'TX_ALREADY_USED' | 'QUOTE_STALE' | 'INSUFFICIENT_FUNDS' | 'PRICE_UNAVAILABLE';
  constructor(code: BuyConvertError['code'], message: string) {
    super(message);
    this.name = 'BuyConvertError';
    this.code = code;
  }
}

/** live = Textile is quoting the route on Celo right now and it can be executed through Payrail; simulated = a development/test provider (never in production) */
export type CurrencyStatus = 'live' | 'simulated' | 'temporarily_unavailable' | 'unsupported';
const STATUS_LABEL: Record<CurrencyStatus, string> = {
  live: 'Live',
  simulated: 'Simulated',
  temporarily_unavailable: 'Temporarily unavailable',
  unsupported: 'Unsupported',
};

/** never offered as a conversion source */
const GAS_TOKENS: ReadonlySet<string> = new Set(['CELO']);

export type ConversionState = 'QUOTED' | 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REVIEW' | 'EXPIRED';

export interface BuyConvertDeps {
  db: Db;
  registry: RouteRegistry;
  provider: ConversionProvider;
  buyerSwap: BuyerSwapRuntime;
  reader: ChainReader;
  usdt: string;
  reactor: string;
  chainId: number;
  minConfirmations: number;
  /** the most USDT one conversion may deliver (operator cap) */
  maxUsdtAtomic: bigint;
  /**
   * Currencies that Textile's live API quotes but its OFFICIAL address book does not list as a Celo corridor stay Unsupported here unless the operator
   * names them (PAYRAIL_BUY_CONVERT_UNDOCUMENTED). This is enforced in code, so a stale allow-list row in the database cannot switch one on.
   */
  allowUndocumented?: ReadonlySet<string>;
  /** symbols the operator switches OFF explicitly (PAYRAIL_BUY_CONVERT_DISABLED). Nothing else in the stored allow-list can veto an official, live corridor. */
  disabledSymbols?: ReadonlySet<string>;
  /** Textile's OFFICIAL Celo corridor list (read from its address book). Absent = the built-in snapshot. */
  officialCorridors?: () => Promise<OfficialCorridors>;
  /** read-only balance of an ERC-20 for a wallet; when present, a conversion the wallet cannot fund is refused before anything is signed */
  tokenBalance?: (token: Address, wallet: Address) => Promise<bigint>;
  /** read-only native CELO balance of a wallet (gas); only used to warn */
  nativeBalance?: (wallet: Address) => Promise<bigint>;
  now?: () => number;
  explorerTx?: (hash: string) => string;
}

interface Row {
  id: string; buyer_id: string; wallet: string; provider: string; sell_symbol: string; sell_address: string; sell_decimals: number; sell_atomic: string;
  target_atomic: string; expected_atomic: string; min_atomic: string; fee_atomic: string; rate: string; quote_id: string; quote_expires_at: string; state: ConversionState;
  failure: string | null; approve_txs: string; swap_tx: string | null; received_atomic: string | null; created_at: string; updated_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TX = /^0x[0-9a-fA-F]{64}$/;
/** an estimate that is not started within this time is dropped (the firm quote is requested only when the buyer starts signing) */
const QUOTE_LIFETIME_MS = 15 * 60_000;
const usdtText = (a: bigint) => formatUnits(a, 6);

export function createBuyConvert(d: BuyConvertDeps) {
  const now = d.now ?? Date.now;
  const explorer = d.explorerTx ?? ((h: string) => `https://celoscan.io/tx/${h}`);
  const norm = (r: Record<string, unknown>): Row => ({ ...r, sell_decimals: Number(r.sell_decimals) }) as unknown as Row;
  const get = (id: string): Row | undefined => {
    const r = queryOne(d.db, 'SELECT * FROM buy_conversions WHERE id = ?', id);
    return r ? norm(r) : undefined;
  };
  const event = (id: string, state: string, note: string) => d.db.prepare('INSERT INTO buy_conversion_events (conversion_id, at, state, note) VALUES (?, ?, ?, ?)').run(id, iso(now()), state, note.slice(0, 400));
  const setState = (id: string, state: ConversionState, note: string, patch: Record<string, string | null> = {}) => {
    const cols = Object.keys(patch);
    d.db.prepare(`UPDATE buy_conversions SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(state, iso(now()), ...cols.map((c) => patch[c]!), id);
    event(id, state, note);
  };
  const owned = (buyerId: string, id: string): Row => {
    const r = get(id);
    if (!r) throw new BuyConvertError('NOT_FOUND', 'no such conversion');
    if (r.buyer_id !== buyerId) throw new BuyConvertError('NOT_FOUND', 'no such conversion'); // do not reveal other buyers' records
    return r;
  };

  function view(r: Row) {
    const dec = r.sell_decimals;
    const expected = BigInt(r.expected_atomic);
    const min = BigInt(r.min_atomic);
    const target = BigInt(r.target_atomic);
    const approveTxs = JSON.parse(r.approve_txs) as string[];
    return {
      id: r.id,
      state: r.state,
      /** true only when the receipt proved the conversion */
      confirmed: r.state === 'CONFIRMED',
      provider: r.provider,
      payer: r.wallet,
      sell: { symbol: r.sell_symbol, address: r.sell_address, decimals: dec, amountAtomic: r.sell_atomic, amount: formatUnits(BigInt(r.sell_atomic), dec) },
      receive: {
        symbol: 'USDT', address: d.usdt,
        expected: usdtText(expected), expectedAtomic: r.expected_atomic,
        minimum: usdtText(min), minimumAtomic: r.min_atomic,
        received: r.received_atomic === null ? null : usdtText(BigInt(r.received_atomic)), receivedAtomic: r.received_atomic,
      },
      apiPrice: { symbol: 'USDT', amount: usdtText(target), atomic: r.target_atomic },
      /** USDT that stays in the buyer's wallet after the API is paid, at the minimum the swap guarantees */
      leftoverAtLeast: usdtText(min > target ? min - target : 0n),
      conversionFee: { symbol: r.sell_symbol, amount: formatUnits(BigInt(r.fee_atomic), dec), note: "Textile's venue fee, already inside the numbers above. Payrail adds no conversion charge." },
      rate: r.rate,
      quoteExpiresAt: r.quote_expires_at,
      network: { name: 'celo', chainId: d.chainId },
      approveTxs,
      swapTx: r.swap_tx,
      swapTxUrl: r.swap_tx ? explorer(r.swap_tx) : null,
      failure: r.failure,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Currencies the buyer may pay with: only routes that are live on Textile's ladder AND enabled by the operator AND whose smallest allowed
   * swap (Textile's corridor minimum) fits the per-conversion limit. Each states how it is known. A short cache keeps the page quick.
   */
  let cache: { at: number; ttl: number; value: Awaited<ReturnType<typeof buildCurrencies>> } | undefined;
  /**
   * Is this route switched on? An official Textile corridor that is live is ON by default: the stored operator allow-list (conversion_assets) is only a
   * seed and must not keep a live corridor such as wARS or wBRL off. The only vetoes are the network gas token (a buyer could spend the CELO needed
   * for gas) and symbols the operator names in PAYRAIL_BUY_CONVERT_DISABLED.
   */
  const effectiveEnabled = async (r: { enabled: boolean; from: { symbol: string; address: string } }): Promise<boolean> => {
    if (GAS_TOKENS.has(r.from.symbol) || d.disabledSymbols?.has(r.from.symbol)) return false;
    if (r.enabled) return true;
    return (await documentationGate(r.from.symbol, r.from.address)) === undefined;
  };

  async function buildCurrencies() {
    const rs = (await d.registry.routes('funding')).filter((r) => !r.passthrough);
    return Promise.all(rs.map(async (r) => {
      let status: CurrencyStatus;
      const on = await effectiveEnabled(r);
      let reason: string | null = r.available && on ? null : r.reason;
      if (GAS_TOKENS.has(r.from.symbol)) reason = `${r.from.symbol} is the network gas token: a buyer could spend the ${r.from.symbol} needed to pay gas, so it is not offered as a conversion source.`;
      let minUsdt: string | null = null;
      const gate = on && r.available ? await documentationGate(r.from.symbol, r.from.address) : undefined;
      if (r.unavailableReason === 'provider_error') {
        // Textile could not be reached while the routes were read: temporary, and NOT the same as "not listed"
        status = 'temporarily_unavailable';
        reason = 'Textile could not be reached just now, so this route cannot be checked. It is checked again automatically.';
      } else if (r.unavailableReason === 'not_on_ladder' && !r.available && (await documentationGate(r.from.symbol, r.from.address)) === undefined) {
        // an OFFICIAL Textile Celo corridor whose price ladder has no entry at this moment: a temporary gap, not an unsupported currency
        status = 'temporarily_unavailable';
        reason = `${r.from.symbol} is an official Textile corridor on Celo, but Textile's price ladder has no entry for it right now. It is checked again automatically.`;
      } else if (gate) {
        status = 'unsupported';
        reason = gate;
      } else if (!on) {
        status = 'unsupported'; // not offered by this server (not registered, not on Textile's ladder, or switched off by the operator)
      } else if (!r.available) {
        // Textile lists the pair but has no makers / quote right now (or could not be reached)
        status = r.unavailableReason === 'not_on_ladder' || r.unavailableReason === 'chain_unsupported' ? 'unsupported' : 'temporarily_unavailable';
      } else {
        status = d.provider.simulated ? 'simulated' : 'live';
        // what the smallest swap Textile allows is worth in USDT (an indicative price; reserves nothing)
        try {
          const q = await d.provider.quote({ direction: 'funding', from: r.from, to: USDT_CELO, inputAtomic: r.minInputAtomic });
          minUsdt = usdtText(q.expectedOutputAtomic);
          if (q.expectedOutputAtomic > d.maxUsdtAtomic) {
            status = 'temporarily_unavailable';
            reason = `Textile's smallest swap for ${r.from.symbol} is about ${minUsdt} USDT, above this server's limit of ${usdtText(d.maxUsdtAtomic)} USDT per conversion`;
          }
        } catch (e) {
          status = 'temporarily_unavailable';
          const msg = (e as Error).message;
          reason = /no_makers_online/.test(msg)
            ? `Textile has no market makers online for ${r.from.symbol} -> USDT right now. It becomes Live again by itself when they return.`
            : `Textile gave no price for ${r.from.symbol} -> USDT just now (${msg.slice(0, 80)})`;
        }
      }
      const selectable = status === 'live' || status === 'simulated';
      return {
        symbol: r.from.symbol, address: r.from.address, decimals: r.from.decimals,
        status,
        statusLabel: STATUS_LABEL[status],
        statusDetail: status === 'live'
          ? `Textile is quoting ${r.from.symbol} -> USDT on Celo right now. Your wallet signs every step.${r.evidence.level === 'live-executed' ? ' Payrail has completed a mainnet conversion on this route.' : ''}`
          : status === 'simulated'
            ? 'SIMULATED route (development only): nothing here is real.'
            : status === 'temporarily_unavailable' ? (reason ?? 'The route cannot be verified right now.') : (reason ?? 'No compatible Textile route exists for this currency.'),
        /** true when a buyer may start a conversion with it */
        available: selectable,
        reason: selectable ? null : reason,
        minSell: selectable ? formatUnits(r.minInputAtomic, r.from.decimals) : null,
        maxSell: selectable ? formatUnits(r.maxInputAtomic, r.from.decimals) : null,
        minUsdt,
        /** about how much USDT worth Textile can convert right now (the price at the smallest swap, scaled to the ladder's depth); null when unknown */
        depthUsdt: selectable && minUsdt !== null && r.minInputAtomic > 0n ? Math.round((Number(formatUnits(r.maxInputAtomic, r.from.decimals)) * Number(minUsdt)) / Number(formatUnits(r.minInputAtomic, r.from.decimals)) * 100) / 100 : null,
        route: `${r.from.symbol} -> USDT on Textile (Celo)`,
        /** the general Textile integration label, SEPARATE from the verification status above: true only when a real (non-simulated) Textile ladder shows makers right now */
        textileLive: on && r.available && !d.provider.simulated,
        /** Buy's 402 challenge offers USDC and USAT as well; Payrail's flow is pinned to USDT, so these are converted instead (documented, not a verified direct payment) */
        directNote: r.from.symbol === 'USDC' || r.from.symbol === 'USAT'
          ? `Buy's gateway also offers ${r.from.symbol} for its APIs, so converting is not strictly needed; Payrail's payment flow only supports USDT today, so ${r.from.symbol} is converted to USDT first.`
          : null,
        evidence: { level: r.evidence.level, basis: r.evidence.basis, executedByPayrailOnMainnet: r.evidence.level === 'live-executed' },
      };
    }));
  }
  /** below this much USDT of depth a route is called thin: a purchase through it may not fill */
  const THIN_DEPTH_USDT = 1000;
  /**
   * The currencies the landing page shows: exactly the ones on Textile's OFFICIAL Celo list (that Payrail has a token for), in the official order,
   * with their real status. Currencies Textile quotes but does not list officially are not part of this list at all.
   */
  async function landing() {
    const o = d.officialCorridors ? await d.officialCorridors() : { symbols: DOCUMENTED_ON_CELO, addresses: new Set<string>() };
    const all = await currencies();
    const out = [];
    for (const sym of o.symbols) {
      const c = all.find((x) => x.symbol === sym);
      if (!c) continue;
      const thin = c.status === 'live' && c.depthUsdt !== null && c.depthUsdt < THIN_DEPTH_USDT;
      out.push({
        symbol: c.symbol, status: c.status, statusLabel: c.statusLabel, reason: c.available ? null : c.reason,
        thinLiquidity: thin,
        liquidityNote: thin ? `Thin liquidity: only about ${c.depthUsdt} USDT can be converted at once right now, so a large amount may not fill.` : null,
        minSell: c.minSell, minUsdt: c.minUsdt, depthUsdt: c.depthUsdt,
      });
    }
    return out;
  }

  async function currencies() {
    if (cache && now() - cache.at < cache.ttl) return cache.value;
    const value = await buildCurrencies();
    // a list with temporary problems is re-read soon; a settled one is kept for 30 s
    cache = { at: now(), value, ttl: value.some((c) => c.status === 'temporarily_unavailable') ? 5_000 : 30_000 };
    return value;
  }

  /** why a route may not be used although the registry says it is live and enabled (undefined = fine) */
  const documentationGate = async (symbol: string, address: string): Promise<string | undefined> => {
    if (d.allowUndocumented?.has(symbol)) return undefined;
    const o = d.officialCorridors ? await d.officialCorridors() : { symbols: DOCUMENTED_ON_CELO, addresses: new Set<string>() };
    // the symbol must be an official Celo corridor AND the token contract Payrail uses must appear on the official page (when it could be read)
    if (o.symbols.has(symbol) && (o.addresses.size === 0 || o.addresses.has(address.toLowerCase()))) return undefined;
    return `Textile's live API quotes ${symbol} -> USDT, but Textile's official address book does not list it as a Celo corridor, so Payrail does not offer it. It is enabled automatically once Textile documents it.`;
  };

  const balanceOf = async (token: Address, wallet: Address): Promise<bigint | undefined> => {
    if (!d.tokenBalance) return undefined;
    try { return await d.tokenBalance(token, wallet); } catch { return undefined; }
  };

  async function estimate(a: { buyerId: string; wallet: string; symbol: string; targetAtomic: bigint }) {
    if (a.targetAtomic <= 0n) throw new BuyConvertError('BAD_INPUT', 'there is nothing to convert for: the API price is zero');
    const recent = Number((queryOne(d.db, 'SELECT COUNT(*) AS n FROM buy_conversions WHERE buyer_id = ? AND created_at > ?', a.buyerId, iso(now() - 10 * 60_000)) as { n: number | bigint }).n);
    if (recent >= 20) throw new BuyConvertError('RATE_LIMITED', 'too many conversion estimates in the last 10 minutes; wait a little');
    const route = await d.registry.find('funding', a.symbol);
    if (!route) throw new BuyConvertError('UNSUPPORTED_CURRENCY', `${a.symbol} cannot be used: Textile has no conversion route from it to USDT, so the currency is not offered.`);
    if (route.passthrough) throw new BuyConvertError('BAD_INPUT', 'USDT needs no conversion');
    if (!(route.available && (await effectiveEnabled(route)))) throw new BuyConvertError('UNSUPPORTED_CURRENCY', `${route.from.symbol} cannot be used right now: ${route.reason ?? 'unavailable'}.`);
    const gated = await documentationGate(route.from.symbol, route.from.address);
    if (gated) throw new BuyConvertError('UNSUPPORTED_CURRENCY', gated);
    // pick the smallest sell amount that is at least the corridor minimum AND whose guaranteed (minimum) USDT covers the API price
    let sell = route.minInputAtomic;
    let q = await d.provider.quote({ direction: 'funding', from: route.from, to: USDT_CELO, inputAtomic: sell }).catch((e: Error) => { throw new BuyConvertError('NO_QUOTE', `Textile gave no price for ${route.from.symbol} -> USDT: ${e.message.slice(0, 160)}`); });
    for (let i = 0; i < 4 && q.minOutputAtomic < a.targetAtomic; i++) {
      sell = (sell * a.targetAtomic * 1_005n) / (q.minOutputAtomic * 1_000n) + 1n;
      if (sell > route.maxInputAtomic) throw new BuyConvertError('ABOVE_LIMIT', `Textile's current depth for ${route.from.symbol} is too small for this amount`);
      q = await d.provider.quote({ direction: 'funding', from: route.from, to: USDT_CELO, inputAtomic: sell }).catch((e: Error) => { throw new BuyConvertError('NO_QUOTE', `Textile gave no price: ${e.message.slice(0, 160)}`); });
    }
    if (q.minOutputAtomic < a.targetAtomic) throw new BuyConvertError('NO_QUOTE', 'Textile could not quote enough USDT for this API right now');
    if (q.expectedOutputAtomic > d.maxUsdtAtomic) throw new BuyConvertError('ABOVE_LIMIT', `this conversion would deliver ${usdtText(q.expectedOutputAtomic)} USDT, above the limit of ${usdtText(d.maxUsdtAtomic)} USDT per conversion`);
    // the wallet must actually hold the amount to be sold (a read-only check; nothing is signed)
    const bal = await balanceOf(route.from.address as Address, a.wallet as Address);
    if (bal !== undefined && bal < sell) {
      throw new BuyConvertError('INSUFFICIENT_FUNDS', `your wallet holds ${formatUnits(bal, route.from.decimals)} ${route.from.symbol} but the smallest conversion that covers this API needs ${formatUnits(sell, route.from.decimals)} ${route.from.symbol} (Textile's minimum swap is about 1 USD). Nothing was signed or sent.`);
    }
    let gas: { celoBalance: string; recommendedCelo: string; low: boolean } | null = null;
    if (d.nativeBalance) {
      try {
        const celo = await d.nativeBalance(a.wallet as Address);
        gas = { celoBalance: formatUnits(celo, 18), recommendedCelo: '0.03', low: celo < 30_000_000_000_000_000n };
      } catch { /* unknown: no warning */ }
    }
    const id = `cnv_${randomUUID()}`;
    d.db.prepare(
      `INSERT INTO buy_conversions (id, buyer_id, wallet, provider, sell_symbol, sell_address, sell_decimals, sell_atomic, target_atomic, expected_atomic, min_atomic, fee_atomic, rate, quote_id, quote_expires_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUOTED', ?, ?)`,
    ).run(id, a.buyerId, a.wallet, q.provider, route.from.symbol, route.from.address, route.from.decimals, sell.toString(), a.targetAtomic.toString(), q.expectedOutputAtomic.toString(), q.minOutputAtomic.toString(),
      q.feeAtomic.toString(), q.rate, q.id, iso(now() + QUOTE_LIFETIME_MS), iso(now()), iso(now()));
    event(id, 'QUOTED', 'indicative price shown; nothing signed or sent yet');
    audit(d.db, a.buyerId, 'buyconv.quoted', id, { sell: route.from.symbol, sellAtomic: sell.toString() }, new Date(now()));
    return { conversion: view(get(id)!), evidence: route.evidence, notes: q.notes, limits: { minSell: formatUnits(route.minInputAtomic, route.from.decimals), maxSell: formatUnits(route.maxInputAtomic, route.from.decimals) }, walletHolds: bal === undefined ? null : formatUnits(bal, route.from.decimals), gas };
  }

  /** The buyer's wallet signed Textile's TakerControl proof: ask Textile for a FIRM quote, validate every field, return only validated steps. */
  async function prepare(a: { buyerId: string; wallet: string; conversionId: string; proof: TakerProof }): Promise<{ conversion: ReturnType<typeof view>; prepared: PrepareResult }> {
    const r = owned(a.buyerId, a.conversionId);
    if (r.wallet.toLowerCase() !== a.wallet.toLowerCase()) throw new BuyConvertError('NOT_OWNER', 'this conversion belongs to another wallet');
    if (!['QUOTED', 'PREPARED'].includes(r.state)) throw new BuyConvertError('WRONG_STATE', `a ${r.state} conversion cannot be prepared`);
    {
      const bal = await balanceOf(r.sell_address as Address, r.wallet as Address);
      if (bal !== undefined && bal < BigInt(r.sell_atomic)) throw new BuyConvertError('INSUFFICIENT_FUNDS', `your wallet now holds ${formatUnits(bal, r.sell_decimals)} ${r.sell_symbol}, less than the ${formatUnits(BigInt(r.sell_atomic), r.sell_decimals)} ${r.sell_symbol} this conversion needs. Nothing was signed or sent.`);
    }
    if (Date.parse(r.quote_expires_at) < now()) {
      setState(r.id, 'EXPIRED', 'the estimate expired before signing started; nothing was sent');
      throw new BuyConvertError('QUOTE_STALE', 'this estimate expired; get a new one. Nothing was sent or charged.');
    }
    const op = {
      id: r.id, buyerId: r.buyer_id, sellAtomic: BigInt(r.sell_atomic), minAtomic: BigInt(r.min_atomic), expectedAtomic: BigInt(r.expected_atomic),
      approvalDigest: sha(`${r.id}|${r.sell_atomic}|${r.min_atomic}|${r.wallet}`),
    } as unknown as FundingOp;
    const prepared = await d.buyerSwap.prepare({ op, wallet: r.wallet, sell: { chainId: d.chainId, address: r.sell_address, symbol: r.sell_symbol, decimals: r.sell_decimals }, proof: a.proof });
    audit(d.db, a.buyerId, 'buyconv.prepared', r.id, { result: prepared.kind }, new Date(now()));
    if (prepared.kind === 'ready') setState(r.id, 'PREPARED', 'a firm Textile quote was validated; the wallet may send the listed transactions');
    else event(r.id, r.state, prepared.kind === 'no_quote' ? `no firm quote: ${prepared.reason}` : `firm quote rejected: ${prepared.problems.join('; ')}`);
    return { conversion: view(get(r.id)!), prepared };
  }

  /** The wallet reports a transaction it sent. Reporting is never proof: the receipt decides. */
  async function recordTx(a: { buyerId: string; conversionId: string; kind: 'approve' | 'swap'; txHash: string }) {
    const r = owned(a.buyerId, a.conversionId);
    if (!TX.test(a.txHash)) throw new BuyConvertError('BAD_INPUT', 'a transaction hash (0x + 64 hex characters) is required');
    const tx = a.txHash.toLowerCase();
    if (a.kind === 'approve') {
      const list = JSON.parse(r.approve_txs) as string[];
      if (!list.includes(tx)) d.db.prepare('UPDATE buy_conversions SET approve_txs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...list, tx]), iso(now()), r.id);
      event(r.id, r.state, 'the wallet reported an approval transaction (informational; only the swap receipt counts)');
      return view(get(r.id)!);
    }
    if (r.swap_tx) {
      if (r.swap_tx.toLowerCase() === tx) return verify({ buyerId: a.buyerId, conversionId: r.id });
      throw new BuyConvertError('WRONG_STATE', 'a different swap transaction is already recorded for this conversion');
    }
    if (!['QUOTED', 'PREPARED'].includes(r.state)) throw new BuyConvertError('WRONG_STATE', `a ${r.state} conversion cannot take a transaction`);
    const used = queryOne(d.db, 'SELECT id FROM buy_conversions WHERE lower(swap_tx) = ? AND id <> ?', tx, r.id);
    if (used) throw new BuyConvertError('TX_ALREADY_USED', 'that transaction is already attached to another conversion');
    setState(r.id, 'SUBMITTED', 'the wallet reported the swap transaction; verifying on-chain before anything counts', { swap_tx: tx });
    audit(d.db, a.buyerId, 'buyconv.swap_tx', r.id, { tx }, new Date(now()));
    return verify({ buyerId: a.buyerId, conversionId: r.id });
  }

  /** Read the chain and settle. Safe to repeat. */
  async function verify(a: { buyerId: string; conversionId: string }) {
    const r = owned(a.buyerId, a.conversionId);
    if (r.state !== 'SUBMITTED' || !r.swap_tx) return view(r);
    let receipt;
    try {
      receipt = await d.reader.receipt(r.swap_tx);
    } catch {
      event(r.id, 'SUBMITTED', 'the chain could not be read just now; try again');
      return view(get(r.id)!);
    }
    if (!receipt) {
      event(r.id, 'SUBMITTED', 'the transaction is not on-chain yet');
      return view(get(r.id)!);
    }
    const head = await d.reader.blockNumber();
    const v = verifyConversion(receipt, head, { usdt: d.usdt, reactor: d.reactor, recipient: r.wallet, minBuyAtomic: BigInt(r.min_atomic), minConfirmations: d.minConfirmations });
    switch (v.kind) {
      case 'pending': event(r.id, 'SUBMITTED', `waiting for confirmations (${v.confirmations}/${d.minConfirmations})`); break;
      case 'reverted': setState(r.id, 'FAILED', 'the swap transaction reverted on-chain; no currency was converted', { failure: 'the swap transaction reverted' }); break;
      case 'mismatch': setState(r.id, 'REVIEW', `the transaction does not show the expected conversion: ${v.reason}`, { failure: v.reason }); break;
      case 'below_minimum': setState(r.id, 'REVIEW', `the wallet received ${usdtText(v.receivedAtomic)} USDT, below the minimum that was shown`, { received_atomic: v.receivedAtomic.toString(), failure: 'received less than the guaranteed minimum' }); break;
      case 'confirmed': setState(r.id, 'CONFIRMED', `verified on-chain: ${usdtText(v.receivedAtomic)} USDT delivered to your wallet by the Textile reactor`, { received_atomic: v.receivedAtomic.toString() }); break;
    }
    return view(get(r.id)!);
  }

  /**
   * SELLER PRICING. Express an API price in a currency Textile can convert, and get the USDT amount that the marketplace will actually bill.
   * The rate comes from a Textile indicative preview at (at least) the corridor minimum, scaled to the seller's amount: a price of a few cents in a
   * local currency is far below Textile's ~1 USD minimum, so it cannot be previewed directly. The result states the quote time and every limitation.
   * A currency that is not selectable (no live makers, not documented, switched off) cannot be used, so a price is never silently reinterpreted.
   */
  async function normalizePrice(a: { symbol: string; amountAtomic: bigint }) {
    if (a.amountAtomic <= 0n) throw new BuyConvertError('BAD_INPUT', 'the price must be greater than zero');
    const list = await currencies();
    const c = list.find((x) => x.symbol.toLowerCase() === a.symbol.toLowerCase());
    if (!c) throw new BuyConvertError('UNSUPPORTED_CURRENCY', `${a.symbol} cannot be used for pricing: Textile has no conversion route between it and USDT.`);
    if (!c.available) {
      // a temporary problem (no makers, Textile unreachable) is not the same as an unsupported currency: the seller is told to try again
      if (c.status === 'temporarily_unavailable') throw new BuyConvertError('PRICE_UNAVAILABLE', `${c.symbol} cannot be converted reliably right now (${c.statusLabel}): ${c.reason ?? c.statusDetail} Try again shortly, or price in USDT.`);
      throw new BuyConvertError('UNSUPPORTED_CURRENCY', `${c.symbol} cannot be used for pricing (${c.statusLabel}): ${c.reason ?? c.statusDetail}`);
    }
    const route = await d.registry.find('funding', c.symbol);
    if (!route) throw new BuyConvertError('UNSUPPORTED_CURRENCY', `${c.symbol} cannot be used for pricing.`);
    const probe = a.amountAtomic < route.minInputAtomic ? route.minInputAtomic : a.amountAtomic > route.maxInputAtomic ? route.maxInputAtomic : a.amountAtomic;
    let q;
    try {
      q = await d.provider.quote({ direction: 'funding', from: route.from, to: USDT_CELO, inputAtomic: probe });
    } catch (e) {
      throw new BuyConvertError('PRICE_UNAVAILABLE', `Textile gave no price for ${c.symbol} -> USDT just now (${(e as Error).message.slice(0, 100)}), so this price cannot be converted reliably. Try again shortly, or price in USDT.`);
    }
    if (q.expectedOutputAtomic <= 0n || probe <= 0n) throw new BuyConvertError('PRICE_UNAVAILABLE', 'Textile returned an unusable price');
    // round UP so the seller is never under-priced by rounding; 6 decimals is USDT's precision
    const usdtAtomic = (a.amountAtomic * q.expectedOutputAtomic + probe - 1n) / probe;
    if (usdtAtomic < 1n) throw new BuyConvertError('BAD_INPUT', `this price is worth less than 0.000001 USDT, the smallest amount the marketplace can bill`);
    const rate = formatUnits((q.expectedOutputAtomic * 10n ** BigInt(route.from.decimals) * 1_000_000n) / probe, 12);
    const quotedAt = new Date(now()).toISOString();
    return {
      currency: c.symbol, decimals: route.from.decimals, amountAtomic: a.amountAtomic, amount: formatUnits(a.amountAtomic, route.from.decimals),
      usdtAtomic, usdt: usdtText(usdtAtomic), rate, quotedAt,
      source: `Textile indicative preview of ${formatUnits(probe, route.from.decimals)} ${c.symbol} -> USDT${probe === a.amountAtomic ? '' : ' (scaled to your amount)'}`,
      status: c.status, statusLabel: c.statusLabel,
      limitations: [
        'This is an INDICATIVE rate from Textile, not a firm quote and not a promise of liquidity. The USDT price is fixed from it when you save or re-check the listing; buyers are billed that USDT amount.',
        `Textile only converts about ${c.minUsdt ?? '1'} USDT or more at a time, so a buyer paying with ${c.symbol} converts more than a small API costs and keeps the unused USDT.`,
        'If the rate moves, re-check the price: a price derived from a quote older than an hour cannot be published.',
      ],
    };
  }

  /** the currencies a seller may price in: USDT directly, plus every currency whose Textile route is currently selectable */
  async function pricingCurrencies() {
    const list = await currencies();
    return list.map((c) => ({ symbol: c.symbol, decimals: c.decimals, status: c.status, statusLabel: c.statusLabel, selectable: c.available, reason: c.available ? null : c.reason ?? c.statusDetail, minUsdt: c.minUsdt }));
  }

  return {
    landing,
    official: async () => { const o = d.officialCorridors ? await d.officialCorridors() : undefined; return o ? { symbols: [...o.symbols], source: o.source, fetchedAt: o.fetchedAt } : { symbols: [...DOCUMENTED_ON_CELO].filter((x) => x !== 'USDT'), source: 'built-in-snapshot', fetchedAt: null }; },
    normalizePrice, pricingCurrencies,
    currencies, estimate, prepare, recordTx, verify,
    get: (buyerId: string, id: string) => view(owned(buyerId, id)),
    /** used to attach the conversion to the Buy order it funded */
    confirmedFor: (buyerId: string, id: string) => {
      const r = get(id);
      return r && r.buyer_id === buyerId && r.state === 'CONFIRMED' ? view(r) : undefined;
    },
    list: (buyerId: string) => query(d.db, 'SELECT * FROM buy_conversions WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 30', buyerId).map((r) => view(norm(r))),
    events: (buyerId: string, id: string) => {
      owned(buyerId, id);
      return query(d.db, 'SELECT at, state, note FROM buy_conversion_events WHERE conversion_id = ? ORDER BY id', id).map((e) => ({ at: String(e.at), state: String(e.state), note: String(e.note) }));
    },
    config: () => ({ maxUsdt: usdtText(d.maxUsdtAtomic), chainId: d.chainId, reactor: d.reactor as Address }),
  };
}
export type BuyConvert = ReturnType<typeof createBuyConvert>;
