// Buy AI purchases paid DIRECTLY by the buyer's own wallet. No deposit wallet, no ledger, no server key.
//
// This is the payment mechanism Buy AI actually supports (x402 v1, scheme "exact", Celo, EIP-3009), split across the browser and the
// server so the buyer's key never leaves their wallet:
//   1. QUOTE   the server asks the Buy gateway for the REAL price (an unpaid request answers HTTP 402), checks it against hard rules
//              (pinned payee, USDT on Celo, EIP-3009 capable, price under the operator cap) and builds the exact EIP-3009
//              TransferWithAuthorization the buyer must sign: from = the buyer's wallet, to = Buy's payTo, value = the price.
//   2. SIGN    the buyer's wallet signs that typed data (eth_signTypedData_v4). Nothing is sent on-chain by the buyer.
//   3. PAY     the server checks the signature recovers to the buyer's wallet over EXACTLY the stored authorization, then makes the one
//              paid request to the gateway with the X-PAYMENT header. Buy settles on-chain (the gateway submits the transfer) and runs the API.
//   4. VERIFY  the settlement is checked independently on-chain (the token's own record of the authorization nonce, and a
//              Transfer(buyer -> payTo, amount) in the receipt). Only then is the order CONFIRMED.
// A paid request is sent AT MOST ONCE per order. Anything ambiguous is UNRESOLVED/REVIEW, never "success", and is never resent.
//
// THE PLATFORM FEE. The payment above pays 100% to Buy's payTo; Payrail is not a party to it, so Payrail cannot take 3% out of it.
// Each order therefore records the fee that is DUE (3%) and whether it has been COLLECTED (it is not, in this version: fee_state
// 'not_collected'). Nothing here ever claims a fee was received. See docs/BUY-PAYMENTS.md for the compatible designs.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, isAddress, verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';
import { x402 } from '@celo/buy-core';
import type { Catalog, Service } from './catalog.ts';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { discoverRequirements } from './requirements.ts';
import type { PaymentOffer } from './requirements.ts';
import type { SpendingPolicy } from './policy.ts';
import { isSettled, verifySettlement } from './verify.ts';
import type { SettlementEvidence, VerifyDeps } from './verify.ts';

export class BuyPayError extends Error {
  readonly code:
    | 'NOT_FOUND' | 'NOT_OWNER' | 'SERVICE_UNAVAILABLE' | 'INVALID_INPUT' | 'NO_USDT_OFFER' | 'PRICE_ABOVE_LIMIT' | 'CHALLENGE_REJECTED'
    | 'QUOTE_EXPIRED' | 'BAD_SIGNATURE' | 'WRONG_STATE' | 'RATE_LIMITED' | 'GATEWAY_UNREACHABLE' | 'INSUFFICIENT_USDT';
  constructor(code: BuyPayError['code'], message: string) {
    super(message);
    this.name = 'BuyPayError';
    this.code = code;
  }
}

export type BuyOrderState = 'QUOTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REVIEW' | 'UNRESOLVED' | 'EXPIRED';

export interface BuyPayDeps {
  db: Db;
  catalog: { get(o?: { forceRefresh?: boolean }): Promise<Catalog> };
  policy: SpendingPolicy;
  verify: VerifyDeps;
  chainId: number;
  /** the only token a payment may use (USDT on Celo) */
  usdt: Address;
  /** the only payee a payment may go to (Buy's gateway address, pinned) */
  payTo: Address;
  /** a single payment above this is refused before the buyer is asked to sign */
  maxPerPaymentAtomic: bigint;
  feeBps: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  explorerTx?: (hash: string) => string;
  /** timeout of the one paid request (ms) */
  paidTimeoutMs?: number;
  /** how many times the settlement check is repeated right after the response (chain reads lag a little) */
  settleChecks?: number;
  settleDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** the wallet's USDT balance (a read-only chain call). When present, a payment the wallet cannot cover is refused BEFORE anything is sent. */
  usdtBalance?: (wallet: Address) => Promise<bigint>;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const MAX_BODY = 1_000_000;

interface StoredTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  message: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
}

interface Row {
  id: string; buyer_id: string; wallet: string; service_id: string; service_url: string; input_json: string; input_sha256: string; network: string;
  chain_id: number; scheme: string; asset_symbol: string; asset_address: string; pay_to: string; amount_atomic: string; nonce: string; valid_before: number;
  typed_data_json: string; state: BuyOrderState; failure: string | null; tx_hash: string | null; settlement_json: string | null; http_status: number | null;
  response_body: string | null; response_sha256: string | null; response_content_type: string | null; fee_bps: number; fee_atomic: string; fee_state: string;
  fee_tx_hash: string | null; created_at: string; updated_at: string; conversion_id: string | null;
}

export function createBuyPay(d: BuyPayDeps) {
  const now = d.now ?? Date.now;
  const fetchImpl = d.fetchImpl ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const explorer = d.explorerTx ?? ((h: string) => `https://celoscan.io/tx/${h}`);

  // the database returns INTEGER columns as bigint: normalise the few that are plain numbers
  const norm = (r: Record<string, unknown>): Row => ({ ...r, valid_before: Number(r.valid_before), chain_id: Number(r.chain_id), fee_bps: Number(r.fee_bps), http_status: r.http_status === null ? null : Number(r.http_status) }) as unknown as Row;
  const get = (id: string): Row | undefined => {
    const r = queryOne(d.db, 'SELECT * FROM buy_orders WHERE id = ?', id);
    return r ? norm(r) : undefined;
  };
  const event = (id: string, state: string, note: string) => d.db.prepare('INSERT INTO buy_order_events (order_id, at, state, note) VALUES (?, ?, ?, ?)').run(id, iso(now()), state, note.slice(0, 400));
  const setState = (id: string, state: BuyOrderState, note: string, patch: Record<string, string | number | null> = {}) => {
    const cols = Object.keys(patch);
    d.db.prepare(`UPDATE buy_orders SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(state, iso(now()), ...cols.map((c) => patch[c]!), id);
    event(id, state, note);
  };

  function view(r: Row) {
    const evidence = r.settlement_json ? (JSON.parse(r.settlement_json) as SettlementEvidence) : undefined;
    return {
      id: r.id,
      state: r.state,
      /** true only when independent on-chain evidence exists */
      confirmed: r.state === 'CONFIRMED',
      serviceId: r.service_id,
      network: { name: r.network, chainId: r.chain_id, scheme: r.scheme },
      token: { symbol: r.asset_symbol, address: r.asset_address },
      payer: r.wallet,
      payTo: r.pay_to,
      amountAtomic: r.amount_atomic,
      amount: formatUsdt(BigInt(r.amount_atomic)),
      nonce: r.nonce,
      validBefore: r.valid_before,
      expiresInSeconds: r.state === 'QUOTED' ? Math.max(0, r.valid_before - Math.floor(now() / 1000)) : null,
      txHash: r.tx_hash,
      txUrl: r.tx_hash ? explorer(r.tx_hash) : null,
      settlement: evidence ? { authorization: evidence.authorizationState, transferVerified: evidence.transferVerified, notes: evidence.notes } : null,
      failure: r.failure,
      httpStatus: r.http_status,
      response: r.response_body === null ? null : { body: r.response_body, sha256: r.response_sha256, contentType: r.response_content_type },
      fee: {
        percent: r.fee_bps / 100,
        amountAtomic: r.fee_atomic,
        amount: formatUsdt(BigInt(r.fee_atomic)),
        state: r.fee_state,
        txHash: r.fee_tx_hash,
        note: r.fee_state === 'collected'
          ? 'The platform fee was received on-chain.'
          : 'The 3% platform fee is recorded as DUE but has NOT been collected: the Buy payment goes entirely to Buy, and fee collection is not enabled.',
      },
      conversionId: r.conversion_id ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // exactly what the wallet must sign (only while it can still be signed)
      typedData: r.state === 'QUOTED' ? typedDataForWallet(JSON.parse(r.typed_data_json) as StoredTypedData) : null,
    };
  }

  /** the buyer's wallet-ready EIP-712 payload (uint values as decimal strings, as eth_signTypedData_v4 expects) */
  function typedDataForWallet(t: StoredTypedData) {
    return {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
        ],
        ...EIP3009_TYPES,
      },
      primaryType: 'TransferWithAuthorization',
      domain: t.domain,
      message: t.message,
    };
  }

  function pickOffer(offers: PaymentOffer[], catalogPayTo: Address | undefined): PaymentOffer {
    const usdt = offers.find((o) => o.asset.toLowerCase() === d.usdt.toLowerCase());
    if (!usdt) throw new BuyPayError('NO_USDT_OFFER', `this API does not accept USDT on Celo right now (it offers: ${offers.map((o) => o.symbol ?? o.asset).join(', ') || 'nothing'}). Nothing was requested from your wallet.`);
    const problems: string[] = [];
    if (usdt.network !== 'celo') problems.push(`network is ${usdt.network}, not celo`);
    if (usdt.scheme !== 'exact') problems.push(`payment scheme is ${usdt.scheme}, not exact`);
    if (!usdt.signable) problems.push('USDT is not marked as able to sign an EIP-3009 authorization');
    if (!usdt.resourceMatches) problems.push('the challenge names a different resource than the service URL');
    if (usdt.payTo.toLowerCase() !== d.payTo.toLowerCase()) problems.push(`the payee ${usdt.payTo} is not the pinned Buy payee ${d.payTo}`);
    if (catalogPayTo && catalogPayTo.toLowerCase() !== usdt.payTo.toLowerCase()) problems.push('the challenge payee differs from the catalogue payee');
    if (!usdt.domain) problems.push('the challenge carries no EIP-712 domain for the token');
    if (usdt.amountAtomic <= 0n) problems.push('the price is zero');
    if (problems.length) throw new BuyPayError('CHALLENGE_REJECTED', `the payment requirements were refused: ${problems.join('; ')}. Nothing was requested from your wallet.`);
    if (usdt.amountAtomic > d.maxPerPaymentAtomic) throw new BuyPayError('PRICE_ABOVE_LIMIT', `the price ${formatUsdt(usdt.amountAtomic)} USDT is above this server's per-payment limit of ${formatUsdt(d.maxPerPaymentAtomic)} USDT. Nothing was requested from your wallet.`);
    return usdt;
  }

  async function quote(a: { buyerId: string; wallet: string; serviceId: string; input: unknown; conversionId?: string }) {
    if (!isAddress(a.wallet)) throw new BuyPayError('NOT_FOUND', 'a wallet address is required');
    const wallet = getAddress(a.wallet);
    if (a.input === null || typeof a.input !== 'object' || Array.isArray(a.input)) throw new BuyPayError('INVALID_INPUT', 'the input must be a JSON object');
    const body = JSON.stringify(a.input);
    if (body.length > 8_192) throw new BuyPayError('INVALID_INPUT', 'the input is too large (8 KB limit)');
    // each quote is an unpaid request to the gateway: bound how many one buyer can trigger
    const recent = Number((queryOne(d.db, 'SELECT COUNT(*) AS n FROM buy_orders WHERE buyer_id = ? AND created_at > ?', a.buyerId, iso(now() - 10 * 60_000)) as { n: number | bigint }).n);
    if (recent >= 30) throw new BuyPayError('RATE_LIMITED', 'too many quotes in the last 10 minutes; wait a little');

    const catalog = await d.catalog.get();
    const service: Service | undefined = catalog.services.find((s) => s.id === a.serviceId);
    if (!service) throw new BuyPayError('NOT_FOUND', 'no such Buy API in the current catalogue');
    if (!service.available) throw new BuyPayError('SERVICE_UNAVAILABLE', 'Buy reports this API as unavailable right now');

    const found = await discoverRequirements(service, body, { policy: d.policy, fetchImpl, now });
    if (found.kind === 'invalid_body') throw new BuyPayError('INVALID_INPUT', `the input does not match the API's schema: ${found.issues.slice(0, 5).join('; ')}`);
    if (found.kind === 'blocked') throw new BuyPayError('CHALLENGE_REJECTED', `this API cannot be contacted: ${found.reasons.join('; ')}`);
    if (found.kind === 'no_payment_required') throw new BuyPayError('CHALLENGE_REJECTED', 'the gateway did not ask for payment; nothing will be charged and nothing was requested from your wallet');
    if (found.kind === 'error') throw new BuyPayError('GATEWAY_UNREACHABLE', `the Buy gateway answered: ${found.message}`);
    const offer = pickOffer(found.offers, catalog.payment.payTo);

    const nowSec = Math.floor(now() / 1000);
    // the same window @celo/buy-core uses: now + max(maxTimeoutSeconds, 30)
    const validBefore = nowSec + Math.max(offer.maxTimeoutSeconds, 30);
    const typed: StoredTypedData = {
      domain: { name: offer.domain!.name, version: offer.domain!.version, chainId: d.chainId, verifyingContract: offer.asset },
      message: { from: wallet, to: offer.payTo, value: offer.amountAtomic.toString(), validAfter: '0', validBefore: String(validBefore), nonce: `0x${randomBytes(32).toString('hex')}` },
    };
    const id = `buy_${randomUUID()}`;
    const fee = (offer.amountAtomic * BigInt(d.feeBps) + 9_999n) / 10_000n;
    d.db.prepare(
      `INSERT INTO buy_orders (id, buyer_id, wallet, service_id, service_url, input_json, input_sha256, network, chain_id, scheme, asset_symbol, asset_address, pay_to, amount_atomic,
        nonce, valid_before, typed_data_json, state, fee_bps, fee_atomic, fee_state, created_at, updated_at, conversion_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USDT', ?, ?, ?, ?, ?, ?, 'QUOTED', ?, ?, 'not_collected', ?, ?, ?)`,
    ).run(id, a.buyerId, wallet, service.id, service.url, body, sha256(body), offer.network, d.chainId, offer.scheme, offer.asset, offer.payTo, offer.amountAtomic.toString(), typed.message.nonce, validBefore,
      JSON.stringify(typed), d.feeBps, fee.toString(), iso(now()), iso(now()), a.conversionId ?? null);
    event(id, 'QUOTED', `real price ${formatUsdt(offer.amountAtomic)} USDT confirmed by the gateway's 402 challenge; nothing signed or sent yet`);
    audit(d.db, a.buyerId, 'buy.quoted', id, { service: service.id, amountAtomic: offer.amountAtomic.toString() }, new Date(now()));
    // what the wallet holds right now (read-only), so the page can offer a conversion when USDT is short
    let funding: { usdtBalanceAtomic: string; usdtBalance: string; shortfallAtomic: string; shortfall: string } | null = null;
    if (d.usdtBalance) {
      try {
        const bal = await d.usdtBalance(wallet);
        const short = offer.amountAtomic > bal ? offer.amountAtomic - bal : 0n;
        funding = { usdtBalanceAtomic: bal.toString(), usdtBalance: formatUsdt(bal), shortfallAtomic: short.toString(), shortfall: formatUsdt(short) };
      } catch { /* balance unknown: reported as null, and pay() will not guess */ }
    }
    return { order: view(get(id)!), service: { id: service.id, title: service.title }, funding };
  }

  async function settle(r: Row): Promise<{ ev: SettlementEvidence; settled: boolean }> {
    const rec = {
      asset: getAddress(r.asset_address), amountAtomic: BigInt(r.amount_atomic), payer: getAddress(r.wallet), payTo: getAddress(r.pay_to), txHash: r.tx_hash ?? undefined,
      authorization: { from: getAddress(r.wallet), nonce: r.nonce, validAfter: '0', validBefore: String(r.valid_before) }, timestamp: iso(now()),
    };
    const tries = d.settleChecks ?? 4;
    let ev = await verifySettlement(rec, d.verify);
    for (let i = 1; i < tries && !isSettled(ev); i++) {
      await sleep(d.settleDelayMs ?? 2_000);
      ev = await verifySettlement(rec, d.verify);
    }
    return { ev, settled: isSettled(ev) };
  }

  async function pay(a: { buyerId: string; orderId: string; signature: string }) {
    const r = get(a.orderId);
    if (!r) throw new BuyPayError('NOT_FOUND', 'no such order');
    if (r.buyer_id !== a.buyerId) throw new BuyPayError('NOT_OWNER', 'not your order');
    // idempotent: an order that already left QUOTED is only ever reported, never paid again
    if (r.state !== 'QUOTED') return { order: view(r), alreadyProcessed: true };
    if (r.valid_before - Math.floor(now() / 1000) < 5) {
      setState(r.id, 'EXPIRED', 'the authorization window passed before it was submitted; nothing was sent');
      throw new BuyPayError('QUOTE_EXPIRED', 'the quote expired before it was signed; request a new one. Nothing was charged.');
    }
    const typed = JSON.parse(r.typed_data_json) as StoredTypedData;
    if (d.usdtBalance) {
      let bal: bigint | undefined;
      try { bal = await d.usdtBalance(getAddress(r.wallet)); } catch { bal = undefined; }
      if (bal !== undefined && bal < BigInt(r.amount_atomic)) {
        throw new BuyPayError('INSUFFICIENT_USDT', `your wallet holds ${formatUsdt(bal)} USDT but this API costs ${formatUsdt(BigInt(r.amount_atomic))} USDT. Nothing was sent or charged; convert some of your currency to USDT first.`);
      }
    }
    // the signature must recover to the buyer's wallet over EXACTLY the authorization that was stored
    let valid = false;
    try {
      valid = await verifyTypedData({
        address: getAddress(r.wallet),
        domain: typed.domain,
        types: EIP3009_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: typed.message.from, to: typed.message.to, value: BigInt(typed.message.value), validAfter: BigInt(typed.message.validAfter),
          validBefore: BigInt(typed.message.validBefore), nonce: typed.message.nonce,
        },
        signature: a.signature as Hex,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw new BuyPayError('BAD_SIGNATURE', 'the signature was not made by your wallet over this exact payment authorization. Nothing was sent.');

    // once-only: only one caller can move QUOTED -> SUBMITTED
    const claimed = d.db.prepare("UPDATE buy_orders SET state = 'SUBMITTED', updated_at = ? WHERE id = ? AND state = 'QUOTED'").run(iso(now()), r.id);
    if (Number(claimed.changes) !== 1) return { order: view(get(r.id)!), alreadyProcessed: true };
    event(r.id, 'SUBMITTED', 'signature verified; sending the single paid request to the Buy gateway');
    audit(d.db, a.buyerId, 'buy.submitted', r.id, { amountAtomic: r.amount_atomic }, new Date(now()));

    const payload = {
      x402Version: 1,
      scheme: r.scheme as 'exact',
      network: r.network,
      payload: { signature: a.signature as Hex, authorization: { from: typed.message.from, to: typed.message.to, value: typed.message.value, validAfter: typed.message.validAfter, validBefore: typed.message.validBefore, nonce: typed.message.nonce } },
    };
    const header = x402.encodePaymentHeader(payload);

    let status = 0;
    let text = '';
    let contentType: string | null = null;
    let paymentResponse: { success?: boolean; transaction?: string; payer?: string } | undefined;
    let transportError: string | undefined;
    try {
      const res = await fetchImpl(r.service_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-PAYMENT': header },
        body: r.input_json,
        redirect: 'manual',
        signal: AbortSignal.timeout(d.paidTimeoutMs ?? 90_000),
      });
      status = res.status;
      contentType = res.headers.get('content-type');
      text = (await res.text().catch(() => '')).slice(0, MAX_BODY);
      const ph = res.headers.get('x-payment-response');
      paymentResponse = ph ? x402.decodePaymentResponseHeader<{ success?: boolean; transaction?: string; payer?: string }>(ph) : undefined;
    } catch (e) {
      transportError = (e as Error).message.slice(0, 160);
    }

    const tx = paymentResponse?.transaction && /^0x[0-9a-fA-F]{64}$/.test(paymentResponse.transaction) ? paymentResponse.transaction.toLowerCase() : null;
    const base = { http_status: status || null, tx_hash: tx, response_body: text || null, response_sha256: text ? sha256(text) : null, response_content_type: contentType?.slice(0, 120) ?? null };
    const fresh = () => get(r.id)!;

    // 402 again: the gateway did not accept the authorization
    if (!transportError && status === 402) {
      const { ev, settled } = await settle({ ...fresh(), tx_hash: tx });
      if (settled) setState(r.id, 'REVIEW', 'the gateway answered 402 but the authorization IS settled on-chain; needs review', { ...base, settlement_json: JSON.stringify(ev), failure: 'gateway answered 402 although the payment settled' });
      else setState(r.id, 'FAILED', 'the gateway did not accept the payment authorization; nothing was charged', { ...base, settlement_json: JSON.stringify(ev), failure: 'the gateway rejected the payment (HTTP 402); nothing was charged' });
      return { order: view(fresh()) };
    }

    // success path: 2xx. Never CONFIRMED without independent evidence.
    if (!transportError && status >= 200 && status < 300 && paymentResponse?.success !== false) {
      const { ev, settled } = await settle({ ...fresh(), tx_hash: tx });
      const patch = { ...base, tx_hash: ev.txHash ?? tx, settlement_json: JSON.stringify(ev) };
      if (settled) setState(r.id, 'CONFIRMED', `payment settled on-chain and verified independently${patch.tx_hash ? ` (${patch.tx_hash})` : ''}; the API response was delivered`, patch);
      else setState(r.id, 'REVIEW', 'the API answered, but the payment could not be verified on-chain yet. It is NOT marked paid.', { ...patch, failure: 'settlement not verified: ' + ev.notes.slice(0, 3).join('; ') });
      return { order: view(fresh()) };
    }

    // anything else is ambiguous: the authorization may or may not have been settled. Ask the chain; never resend.
    const { ev, settled } = await settle({ ...fresh(), tx_hash: tx });
    const why = transportError ? `no usable answer from the gateway (${transportError})` : `the gateway answered HTTP ${status}${paymentResponse?.success === false ? ' with a failed payment response' : ''}`;
    const patch = { ...base, tx_hash: ev.txHash ?? tx, settlement_json: JSON.stringify(ev), failure: why };
    if (settled) setState(r.id, 'REVIEW', `${why}, but the payment IS settled on-chain: you may have paid without a usable response. Needs review; it is not resent.`, patch);
    else if (Math.floor(now() / 1000) > r.valid_before) setState(r.id, 'FAILED', `${why}; the authorization expired unused, so nothing was charged`, patch);
    else setState(r.id, 'UNRESOLVED', `${why}; the payment is not settled yet. Re-check later; the request is never resent.`, patch);
    return { order: view(fresh()) };
  }

  /** read-only: look at the chain again for an order whose outcome is not final. Never resends anything. */
  async function recheck(a: { buyerId: string; orderId: string }) {
    const r = get(a.orderId);
    if (!r) throw new BuyPayError('NOT_FOUND', 'no such order');
    if (r.buyer_id !== a.buyerId) throw new BuyPayError('NOT_OWNER', 'not your order');
    if (!['UNRESOLVED', 'REVIEW', 'SUBMITTED'].includes(r.state)) return view(r);
    const { ev, settled } = await settle(r);
    const patch = { settlement_json: JSON.stringify(ev), tx_hash: ev.txHash ?? r.tx_hash };
    if (settled && r.response_body !== null && r.http_status !== null && r.http_status >= 200 && r.http_status < 300) setState(r.id, 'CONFIRMED', 'settlement now verified on-chain; the delivered response is confirmed', patch);
    else if (settled) setState(r.id, 'REVIEW', 'the payment is settled on-chain but no usable response was delivered; needs review', patch);
    else if (Math.floor(now() / 1000) > r.valid_before) setState(r.id, 'FAILED', 'the authorization expired and was never settled: nothing was charged', patch);
    else event(r.id, r.state, 'checked again: not settled yet');
    return view(get(r.id)!);
  }

  /** startup: an order left SUBMITTED by a crash is UNRESOLVED (the request may have gone out); it is never resent */
  function recoverInterrupted(): number {
    const stale = query(d.db, "SELECT id FROM buy_orders WHERE state = 'SUBMITTED' AND updated_at < ?", iso(now() - 5 * 60_000));
    for (const s of stale) setState(String(s.id), 'UNRESOLVED', 'interrupted while submitted; the payment may or may not have settled. Re-check; it is never resent.');
    return stale.length;
  }

  /** how much USDT this order needs that the wallet does not hold (read-only) */
  async function shortfall(a: { buyerId: string; orderId: string }) {
    const r = get(a.orderId);
    if (!r || r.buyer_id !== a.buyerId) throw new BuyPayError('NOT_FOUND', 'no such order');
    if (r.state !== 'QUOTED') throw new BuyPayError('WRONG_STATE', 'only an unpaid quote can be funded');
    if (!d.usdtBalance) throw new BuyPayError('WRONG_STATE', 'this server cannot read wallet balances, so it cannot work out how much to convert');
    const bal = await d.usdtBalance(getAddress(r.wallet));
    const amount = BigInt(r.amount_atomic);
    const short = amount > bal ? amount - bal : 0n;
    return { amountAtomic: amount, amount: formatUsdt(amount), balanceAtomic: bal, balance: formatUsdt(bal), shortfallAtomic: short, shortfall: formatUsdt(short) };
  }

  return {
    shortfall,
    config: () => ({ payTo: d.payTo, usdt: d.usdt, chainId: d.chainId, maxPerPaymentAtomic: d.maxPerPaymentAtomic, feeBps: d.feeBps }),
    quote, pay, recheck, recoverInterrupted,
    order(buyerId: string, id: string) {
      const r = get(id);
      if (!r || r.buyer_id !== buyerId) throw new BuyPayError('NOT_FOUND', 'no such order');
      return view(r);
    },
    list(buyerId: string) {
      return query(d.db, 'SELECT * FROM buy_orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 50', buyerId).map((x) => ({ ...view(norm(x)), response: null, typedData: null }));
    },
    events(buyerId: string, id: string) {
      const r = get(id);
      if (!r || r.buyer_id !== buyerId) throw new BuyPayError('NOT_FOUND', 'no such order');
      return query(d.db, 'SELECT at, state, note FROM buy_order_events WHERE order_id = ? ORDER BY id', id);
    },
    /** operator summary: what was paid to Buy, and the fee that is due but not collected */
    summary() {
      const row = queryOne(
        d.db,
        "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_atomic AS INTEGER)), 0) AS paid, COALESCE(SUM(CAST(fee_atomic AS INTEGER)), 0) AS due FROM buy_orders WHERE state = 'CONFIRMED'",
      ) as { n: number | bigint; paid: number | bigint; due: number | bigint };
      const collected = queryOne(d.db, "SELECT COALESCE(SUM(CAST(fee_atomic AS INTEGER)), 0) AS c FROM buy_orders WHERE state = 'CONFIRMED' AND fee_state = 'collected'") as { c: number | bigint };
      return { confirmedOrders: Number(row.n), paidToBuyAtomic: String(row.paid), feeDueAtomic: String(row.due), feeCollectedAtomic: String(collected.c) };
    },
  };
}

export type BuyPay = ReturnType<typeof createBuyPay>;

export function formatUsdt(v: bigint): string {
  const s = v.toString().padStart(7, '0');
  const f = s.slice(-6).replace(/0+$/, '');
  return `${s.slice(0, -6)}${f ? `.${f}` : ''}`;
}
