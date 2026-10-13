// Submission evidence: which services Payrail used, proof of every payment, and the swaps it executed.
// Built ONLY from records Payrail wrote (receipts/*.json, receipts/swaps/*.json). Contains public facts
// (addresses, hashes, amounts); never keys, signatures or claim tokens.
//
// Honest by construction: a field Payrail did not capture is reported as "not retained", never invented,
// and unresolved items are listed separately, never counted as proof.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assetBySymbol } from './assets.ts';
import { readResolutionFiles } from './history.ts';
import { readOrders } from './orderstore.ts';

export const EXPLORER_TX = 'https://celoscan.io/tx/';

export interface EvidencePayment {
  receiptId: string;
  at: string;
  status: string;
  service: string;
  serviceUrl: string;
  amount: string;
  token: string;
  asset: string;
  /** The wallet that signed the payment authorization. */
  payer: string;
  /** The recipient of the stablecoin transfer (the service gateway). */
  payTo: string;
  txHash: string | null;
  explorerUrl: string | null;
  /** The order this payment belongs to, when it was made through the order flow. */
  orderId: string | null;
  settlementAuthorizationState: string;
  transferVerified: boolean;
  httpStatus: number | null;
  delivered: boolean;
  responseSha256: string | null;
  responseFile: string | null;
  responseSummary: string;
  /** What this receipt can and cannot prove. */
  notes: string[];
}

export interface EvidenceSwap {
  planId: string;
  at: string;
  state: string;
  code: string;
  provider: string;
  route: string;
  requestedSell: string;
  received: string | null;
  sellSymbol?: string;
  buySymbol?: string;
  orderId?: string;
  transactions: Array<{ kind: string; to?: string | null; hash: string | null; explorerUrl: string | null; mined: boolean; attributionVerified: boolean; attributionCodes: string[] | null }>;
  notes: string[];
}

/** What a read-only on-chain check of one transaction found (filled by scripts/evidence.ts --verify). */
export interface OnChainCheck {
  checkedAt: string;
  found: boolean;
  status: string | null;
  blockNumber: string | null;
  /** The account that signed and submitted the transaction (tx.from). */
  from: string | null;
  to: string | null;
  /** Celo's verifyTx result: the ERC-8021 attribution codes found at the end of the calldata, or null. */
  attributionCodes: string[] | null;
  /** A one-line decoding of the call when it is a known ERC-20 approve. */
  decoded: string | null;
  /** Token Transfer events in the transaction that involve the Payrail wallet. */
  transfers: Array<{ token: string; from: string; to: string; value: string }>;
  notes: string[];
}

export interface EvidenceTransaction {
  seq: number;
  /** Always a real transaction recorded by Payrail; mock tests and simulations are never listed here. */
  classification: 'real on-chain transaction';
  kind: 'x402 payment' | 'approve_reset' | 'approve' | 'swap' | 'erc8004 registration';
  purpose: string;
  /** The service gateway or conversion venue involved. */
  provider: string;
  token: string;
  /** Human amount from Payrail's own journal; the on-chain figures are in `onChain`. */
  amount: string;
  hash: string;
  explorerUrl: string;
  /** The contract the transaction was sent to, when Payrail's journal recorded it. */
  to: string | null;
  roles: Array<{ role: string; address: string }>;
  /** What Payrail's own journal says about settlement. */
  journalSettlement: string;
  attribution: { applicable: boolean; journalVerified: boolean | null; codes: string[] | null; note: string };
  /** Where this transaction came from: a payment receipt, a confirmed conversion, or a stopped attempt. */
  origin: string;
  /** The order it belongs to, when it was made through the order flow. */
  orderId?: string;
  onChain?: OnChainCheck;
}

/** One order as ONE unit: the conversion and the payment it funded, each still backed by its own record. */
export interface EvidenceOrder {
  orderId: string;
  at: string;
  state: string;
  code: string;
  service: string;
  serviceProvider: string;
  /** The ACTUAL route the funds took. */
  route: 'direct' | 'converted' | 'not paid';
  approved: { symbol: string; amountAtomic: string; payTo: string; planDigest: string | null; approvedBy: string | null };
  conversion: { provider: string; swapPlanId: string; state: string; sell: string | null; buy: string | null; txHashes: string[] } | null;
  payment: {
    status: string;
    receiptId: string | null;
    txHash: string | null;
    delivered: boolean | null;
    httpStatus: number | null;
    responseSha256: string | null;
    responseFile: string | null;
  } | null;
  /** Ledger sequence numbers of the real transactions that belong to this order. */
  ledger: number[];
  needsAttention: boolean;
  /** Cross-checks of the order record against the receipts and swap journals it points at. */
  consistency: string[];
  /** Filled by --verify: every linked transaction was found on-chain and succeeded. */
  onChainVerified?: boolean;
}

export interface EvidencePack {
  generatedAt: string;
  /** Distinct payment recipients with their role, because "payTo" is easy to confuse with the payer. */
  addresses: Array<{ role: string; address: string; note: string }>;
  services: Array<{ service: string; url: string; payments: number; confirmed: number; totalPaid: string; token: string }>;
  payments: EvidencePayment[];
  swaps: EvidenceSwap[];
  /** Every real on-chain transaction, flattened, in time order. */
  transactions: EvidenceTransaction[];
  /** Orders: a conversion and its payment presented as one unit (the individual records stay in the ledger). */
  orders: EvidenceOrder[];
  unresolved: string[];
  warnings: string[];
  notes: string[];
}

type Json = Record<string, any>;

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.json')) // not isFile(): OneDrive reparse points report as symlinks
    .map((e) => e.name);
}

function human(atomic: string | undefined, decimals: number): string {
  if (atomic === undefined || !/^\d+$/.test(atomic)) return '?';
  const s = atomic.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function buildEvidencePack(dir: string, now: Date = new Date(), opts: { wallet?: string } = {}): EvidencePack {
  const warnings: string[] = [];
  const payments: EvidencePayment[] = [];
  const swaps: EvidenceSwap[] = [];
  const unresolved: string[] = [];
  const resolutions = readResolutionFiles(dir);

  for (const f of jsonFiles(dir)) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Json;
      if (typeof j.id !== 'string' || typeof j.createdAt !== 'string' || !j.payment) throw new Error('not a payment receipt');
      const notes: string[] = [];
      const legacy = j.schemaVersion === undefined;
      const status = typeof j.status === 'string' ? j.status : j.outcome?.settled === true ? 'CONFIRMED' : 'UNKNOWN';
      if (legacy) notes.push('legacy receipt (written before schema v1)');
      if (!j.outcome?.responseSha256) notes.push('the response body was not retained for this payment (only a structural summary was kept)');
      notes.push('x402 settlement is submitted by the facilitator and carries no attribution tag; the organizers confirmed none is needed for Buy');
      const txHash = typeof j.payment.txHash === 'string' ? j.payment.txHash : null;
      payments.push({
        receiptId: j.id,
        at: j.createdAt,
        status,
        service: j.service?.capability ?? 'unknown',
        serviceUrl: j.service?.url ?? '',
        amount: j.input?.amount ?? human(j.payment.amountAtomic, 6),
        token: j.input?.token ?? 'token',
        asset: j.payment.asset ?? '',
        payer: j.payment.payer ?? '',
        payTo: j.payment.payTo ?? '',
        txHash,
        explorerUrl: txHash ? EXPLORER_TX + txHash : null,
        orderId: typeof j.orderId === 'string' ? j.orderId : null,
        settlementAuthorizationState: j.payment.settlement?.authorizationState ?? 'unknown',
        transferVerified: j.payment.settlement?.transferVerified === true,
        httpStatus: typeof j.outcome?.httpStatus === 'number' ? j.outcome.httpStatus : null,
        delivered: j.outcome?.delivered === true,
        responseSha256: j.outcome?.responseSha256 ?? null,
        responseFile: j.outcome?.responseFile ?? null,
        responseSummary: j.outcome?.responseSummary ?? '',
        notes,
      });
      const resolved = resolutions.get(j.id);
      if (resolved) {
        notes.push(
          resolved === 'SETTLED'
            ? 'RESOLVED from the chain (receipts/resolutions): the payment SETTLED; the money is spent'
            : 'RESOLVED from the chain (receipts/resolutions): the payment was NOT settled; nothing was charged',
        );
      }
      if (status === 'UNCERTAIN' && !resolved) unresolved.push(`payment ${j.id} is UNCERTAIN`);
    } catch (e) {
      warnings.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const readSwap = (file: string, label: string, pending: boolean) => {
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Json;
      if (typeof r.planId !== 'string' || typeof r.state !== 'string') throw new Error('not a swap record');
      if (pending || !['CONFIRMED', 'FAILED', 'EXPIRED'].includes(r.state)) {
        unresolved.push(`swap ${r.planId} is ${r.state} (${r.code})`);
        return;
      }
      const notes: string[] = [];
      for (const n of r.verification?.notes ?? []) notes.push(String(n));
      if (r.quote?.textileStatus) notes.push(`Textile order status: ${r.quote.textileStatus}`);
      swaps.push({
        planId: r.planId,
        at: r.updatedAt ?? r.createdAt,
        state: r.state,
        code: r.code,
        provider: r.route?.provider ?? 'unknown',
        route: `${r.route?.sellSymbol} -> ${r.route?.buySymbol}`,
        requestedSell: r.amounts?.requestedSell ?? '?',
        received: r.verification?.buyReceived ?? null,
        sellSymbol: r.route?.sellSymbol,
        buySymbol: r.route?.buySymbol,
        transactions: (r.steps ?? []).map((s: Json) => ({
          kind: s.kind,
          to: s.to ?? null,
          hash: s.hash ?? null,
          explorerUrl: s.hash ? EXPLORER_TX + s.hash : null,
          mined: s.status === 'mined',
          attributionVerified: s.attribution?.verified === true,
          attributionCodes: s.attribution?.codes ?? null,
        })),
        notes,
      });
    } catch (e) {
      warnings.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const f of jsonFiles(join(dir, 'swaps'))) readSwap(join(dir, 'swaps', f), `swaps/${f}`, false);
  for (const f of jsonFiles(join(dir, 'pending')).filter((n) => n.startsWith('swap-'))) readSwap(join(dir, 'pending', f), `pending/${f}`, true);
  for (const f of jsonFiles(join(dir, 'pending')).filter((n) => !n.startsWith('swap-'))) unresolved.push(`payment journal ${f} is unresolved`);

  payments.sort((a, b) => (a.at < b.at ? -1 : 1));
  swaps.sort((a, b) => (a.at < b.at ? -1 : 1));

  const bySvc = new Map<string, EvidencePack['services'][number]>();
  for (const p of payments) {
    const cur = bySvc.get(p.service) ?? { service: p.service, url: p.serviceUrl, payments: 0, confirmed: 0, totalPaid: '0', token: p.token };
    cur.payments += 1;
    if (p.status === 'CONFIRMED' || p.status.startsWith('CONFIRMED')) {
      cur.confirmed += 1;
      cur.totalPaid = String(Number(cur.totalPaid) + Number(p.amount));
    }
    bySvc.set(p.service, cur);
  }

  const addr = new Map<string, { role: string; address: string; note: string }>();
  for (const p of payments) {
    if (p.payTo) addr.set(`payTo:${p.payTo.toLowerCase()}`, { role: 'payTo (recipient of the x402 payment)', address: p.payTo, note: 'the service gateway\'s receiving address' });
    if (p.payer) addr.set(`payer:${p.payer.toLowerCase()}`, { role: 'payer (Payrail wallet)', address: p.payer, note: 'signed the payment authorization; NOT the payTo' });
  }

  // ---- orders (receipts/orders): link each to its swap journal and payment receipt
  const ordersRead = readOrders(dir);
  for (const w of ordersRead.warnings) warnings.push(w);
  const orderOfSwap = new Map<string, string>();
  for (const o of ordersRead.orders) {
    if (o.conversion?.swapPlanId) orderOfSwap.set(o.conversion.swapPlanId, o.orderId);
    const ref = o.steps.find((s) => s.kind === 'convert')?.ref;
    if (ref) orderOfSwap.set(ref, o.orderId);
  }
  for (const s of swaps) {
    const oid = orderOfSwap.get(s.planId);
    if (oid) s.orderId = oid;
  }

  // ---- flat ledger of every real transaction
  const wallet = opts.wallet ?? payments.find((p) => p.payer)?.payer ?? '';
  const ledger: Array<Omit<EvidenceTransaction, 'seq'> & { at: string }> = [];
  for (const x of payments) {
    if (!x.txHash) continue;
    ledger.push({
      at: x.at,
      classification: 'real on-chain transaction',
      kind: 'x402 payment',
      purpose: `Pay for the service ${x.service} through the x402 protocol`,
      provider: 'Buy gateway (x402, gateway.usebuy.ai)',
      token: x.token,
      amount: x.amount,
      hash: x.txHash,
      explorerUrl: EXPLORER_TX + x.txHash,
      to: x.asset || null,
      roles: [
        { role: 'payer (signed the payment authorization)', address: x.payer },
        { role: 'payTo (recipient of the stablecoin transfer)', address: x.payTo },
        { role: 'transaction submitter', address: 'the gateway/facilitator; shown as tx.from when verified on-chain' },
      ],
      journalSettlement: `authorization ${x.settlementAuthorizationState}; Transfer(payer -> payTo) found: ${x.transferVerified}; receipt status ${x.status}`,
      attribution: {
        applicable: false,
        journalVerified: null,
        codes: null,
        note: 'x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy',
      },
      origin: 'payment receipt',
      ...(x.orderId ? { orderId: x.orderId } : {}),
    });
  }
  for (const s of swaps) {
    const sellDecimals = s.sellSymbol ? (assetBySymbol(s.sellSymbol)?.decimals ?? 6) : 6;
    const confirmed = s.state === 'CONFIRMED';
    for (const tx of s.transactions) {
      if (!tx.hash) continue;
      const origin = confirmed ? 'confirmed conversion' : `stopped attempt (${s.state}/${s.code}); no swap was sent`;
      const purpose =
        tx.kind === 'swap'
          ? `Convert ${s.route} through ${s.provider}`
          : `Approve ${s.sellSymbol ?? 'the sell token'} for the ${s.provider} contract so ${s.route} can be converted`;
      ledger.push({
        at: s.at,
        classification: 'real on-chain transaction',
        kind: tx.kind as EvidenceTransaction['kind'],
        purpose: confirmed ? purpose : `${purpose} (the attempt it belonged to ended ${s.state}/${s.code} before any swap was sent)`,
        provider: s.provider,
        token: s.sellSymbol ?? 'n/a',
        amount: human(s.requestedSell, sellDecimals),
        hash: tx.hash,
        explorerUrl: EXPLORER_TX + tx.hash,
        to: tx.to ?? null,
        roles: [
          { role: 'sender / signer (Payrail wallet)', address: wallet || 'unknown' },
          { role: tx.kind === 'swap' ? 'called contract (venue)' : 'called contract (token)', address: tx.to ?? 'not recorded' },
        ],
        journalSettlement: `${tx.mined ? 'mined' : 'not confirmed mined'}; conversion state ${s.state}${s.received ? `; received ${s.received} atomic` : ''}`,
        attribution: {
          applicable: true,
          journalVerified: tx.attributionVerified,
          codes: tx.attributionCodes,
          note: 'Payrail submitted this transaction itself, so it carries the ERC-8021 tag',
        },
        origin,
        ...(s.orderId ? { orderId: s.orderId } : {}),
      });
    }
  }
  // ---- ERC-8004 agent identity registration (receipts/registrations/agent-registration.json)
  const regFile = join(dir, 'registrations', 'agent-registration.json');
  if (existsSync(regFile)) {
    try {
      const g = JSON.parse(readFileSync(regFile, 'utf8')) as Json;
      if (typeof g.txHash === 'string' && g.state !== 'SUBMITTING') {
        const confirmed = g.state === 'CONFIRMED';
        if (!confirmed) unresolved.push(`ERC-8004 registration is ${String(g.state)} (${g.txHash})`);
        ledger.push({
          at: g.createdAt ?? '',
          classification: 'real on-chain transaction',
          kind: 'erc8004 registration',
          purpose: `Register the Payrail agent identity on the ERC-8004 Identity Registry${g.agentId ? ` (agent ID ${g.agentId})` : ''}`,
          provider: 'ERC-8004 Identity Registry (Celo mainnet)',
          token: 'CELO (gas only)',
          amount: '0',
          hash: g.txHash,
          explorerUrl: EXPLORER_TX + g.txHash,
          to: g.registry ?? null,
          roles: [
            { role: 'sender / owner of the agent identity (Payrail wallet)', address: g.owner ?? wallet ?? 'unknown' },
            { role: 'called contract (Identity Registry)', address: g.registry ?? 'not recorded' },
          ],
          journalSettlement: `${String(g.state)}${g.blockNumber ? `; block ${g.blockNumber}` : ''}${g.agentId ? `; agent ID ${g.agentId}` : ''}; owner verified: ${g.verifiedOwner ?? 'n/a'}; stored tokenURI matches: ${String(g.tokenUriMatches)}`,
          attribution: {
            applicable: true,
            journalVerified: Array.isArray(g.attributionCodes) ? g.attributionCodes.includes(g.attributionTag) : null,
            codes: Array.isArray(g.attributionCodes) ? g.attributionCodes : null,
            note: 'Payrail submitted this transaction itself, so it carries the ERC-8021 tag',
          },
          origin: 'agent identity registration',
        });
      }
    } catch (e) {
      warnings.push(`registrations/agent-registration.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  ledger.sort((a, b) => (a.at < b.at ? -1 : 1));
  const transactions: EvidenceTransaction[] = ledger.map(({ at: _at, ...rest }, i) => ({ seq: i + 1, ...rest }));

  const orders: EvidenceOrder[] = ordersRead.orders.map((o) => {
    const consistency: string[] = [];
    const swap = swaps.find((s) => s.planId === o.conversion?.swapPlanId);
    if (o.conversion) {
      if (!swap) consistency.push(`conversion ${o.conversion.swapPlanId} has no resolved swap record in receipts/swaps`);
      else {
        const have = new Set(swap.transactions.map((t) => t.hash).filter((h): h is string => h !== null));
        const missing = o.conversion.txHashes.filter((h) => !have.has(h));
        if (missing.length > 0) {
          consistency.push(`order lists conversion tx(s) not in the swap record: ${missing.join(', ')}`);
          warnings.push(`order ${o.orderId}: conversion tx hashes do not match swap record ${swap.planId}`);
        } else consistency.push(`conversion tx hashes match swap record ${swap.planId} (${swap.state})`);
      }
    }
    const rcpt = payments.find((p) => p.receiptId === o.payment?.receiptId) ?? payments.find((p) => p.orderId === o.orderId);
    if (o.payment?.receiptId || o.state === 'COMPLETED') {
      if (!rcpt) {
        consistency.push('no payment receipt for this order exists in receipts/');
        if (o.state === 'COMPLETED') warnings.push(`order ${o.orderId} is COMPLETED but its payment receipt was not found`);
      } else {
        if (o.payment?.txHash && rcpt.txHash && o.payment.txHash !== rcpt.txHash) {
          consistency.push(`order payment tx ${o.payment.txHash} differs from receipt tx ${rcpt.txHash}`);
          warnings.push(`order ${o.orderId}: payment tx hash differs from receipt ${rcpt.receiptId}`);
        } else consistency.push(`payment tx matches receipt ${rcpt.receiptId} (${rcpt.status})`);
        // the order's own claims must agree with the receipt (the receipt is the source of truth)
        if (o.payment?.status && o.payment.status !== rcpt.status && !resolutions.has(rcpt.receiptId)) {
          consistency.push(`order says payment ${o.payment.status} but receipt ${rcpt.receiptId} says ${rcpt.status}`);
          warnings.push(`order ${o.orderId}: payment status ${o.payment.status} differs from receipt ${rcpt.receiptId} (${rcpt.status})`);
        }
        const od = o.payment?.delivery;
        if (od) {
          if (od.delivered !== rcpt.delivered) {
            consistency.push(`order says delivered=${od.delivered} but the receipt says ${rcpt.delivered}`);
            warnings.push(`order ${o.orderId}: delivery flag differs from receipt ${rcpt.receiptId}`);
          }
          if ((od.responseSha256 ?? null) !== (rcpt.responseSha256 ?? null)) {
            consistency.push('order and receipt record different response hashes');
            warnings.push(`order ${o.orderId}: response sha256 differs from receipt ${rcpt.receiptId}`);
          }
        }
        if (rcpt.orderId !== o.orderId) consistency.push('the receipt is not stamped with this order id (older receipt)');
      }
    }
    const hashes = new Set<string>([...(o.conversion?.txHashes ?? []), ...(rcpt?.txHash ? [rcpt.txHash] : o.payment?.txHash ? [o.payment.txHash] : [])]);
    const ledgerSeq = transactions.filter((t) => hashes.has(t.hash)).map((t) => t.seq);
    const route: EvidenceOrder['route'] = o.payment ? o.payment.route : o.conversion ? 'not paid' : 'not paid';
    return {
      orderId: o.orderId,
      at: o.updatedAt ?? o.createdAt,
      state: o.state,
      code: o.code,
      service: o.service.id,
      serviceProvider: o.service.provider,
      route,
      approved: {
        symbol: o.approved.symbol,
        amountAtomic: o.approved.amountAtomic,
        payTo: o.approved.payTo,
        planDigest: o.planDigest ?? null,
        approvedBy: o.approvedBy ?? null,
      },
      conversion: o.conversion
        ? {
            provider: o.conversion.provider,
            swapPlanId: o.conversion.swapPlanId,
            state: o.conversion.state,
            sell: o.conversion.sellSymbol ? `${o.conversion.sellAmountAtomic ?? '?'} atomic ${o.conversion.sellSymbol}` : null,
            buy: o.conversion.buySymbol ? `${o.conversion.receivedAtomic ?? '?'} atomic ${o.conversion.buySymbol}` : null,
            txHashes: o.conversion.txHashes,
          }
        : null,
      payment: o.payment
        ? {
            status: o.payment.status,
            receiptId: o.payment.receiptId ?? null,
            txHash: o.payment.txHash ?? null,
            delivered: o.payment.delivery?.delivered ?? null,
            httpStatus: o.payment.delivery?.httpStatus ?? null,
            responseSha256: o.payment.delivery?.responseSha256 ?? null,
            responseFile: o.payment.delivery?.responseFile ?? null,
          }
        : null,
      ledger: ledgerSeq,
      needsAttention: o.needsAttention,
      consistency,
    };
  });
  for (const o of ordersRead.orders) {
    if (o.state === 'UNCERTAIN' || o.needsAttention) unresolved.push(`order ${o.orderId} is ${o.state} (${o.code}) and needs a human`);
  }

  return {
    generatedAt: now.toISOString(),
    addresses: [...addr.values()],
    services: [...bySvc.values()],
    payments,
    swaps,
    transactions,
    orders,
    unresolved,
    warnings,
    notes: [
      'Payment proof = the Transfer(payer -> payTo) in the settlement transaction, plus the independent on-chain authorization state.',
      'x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy.',
      'Transactions Payrail submits itself (approvals and swaps) carry the official ERC-8021 tag and are verified with Celo\'s verifyTx; see the swaps section.',
      'The automated test suite (npm test) uses mocks and fakes only. It sends nothing and is NOT evidence of on-chain activity; only the transactions in the ledger are real.',
    ],
  };
}

export function renderEvidenceMarkdown(p: EvidencePack): string {
  const L: string[] = [];
  L.push('# Payrail: services used and proof of payments', '');
  L.push(`Generated ${p.generatedAt}`, '');
  L.push('## Addresses', '', '| Role | Address | Note |', '|---|---|---|');
  for (const a of p.addresses) L.push(`| ${a.role} | \`${a.address}\` | ${a.note} |`);
  L.push('', '## Services used', '', '| Service | Endpoint | Payments | Confirmed | Total paid |', '|---|---|---|---|---|');
  for (const s of p.services) L.push(`| \`${s.service}\` | ${s.url} | ${s.payments} | ${s.confirmed} | ${s.totalPaid} ${s.token} |`);
  if (p.services.length === 0) L.push('| (none yet) | | | | |');
  L.push('', '## Orders (a conversion and the payment it funded, as one unit)', '');
  if (p.orders.length === 0) L.push('(no orders recorded yet; orders are created by `scripts/order.ts --execute`)', '');
  for (const o of p.orders) {
    L.push(`### Order ${o.orderId}: ${o.state} (${o.code})`, '');
    L.push(`- **Service:** \`${o.service}\` via ${o.serviceProvider}`);
    L.push(`- **Route taken:** ${o.route}`);
    L.push(`- **Approved:** pay ${o.approved.amountAtomic} atomic ${o.approved.symbol} to \`${o.approved.payTo}\`${o.approved.planDigest ? `; plan digest \`${o.approved.planDigest}\`` : ''}${o.approved.approvedBy ? `; approved by ${o.approved.approvedBy}` : ''}`);
    if (o.conversion) {
      L.push(`- **Conversion:** ${o.conversion.provider} ${o.conversion.state}; swap plan \`${o.conversion.swapPlanId}\`; sold ${o.conversion.sell ?? 'n/a'}; received ${o.conversion.buy ?? 'n/a'}`);
      for (const h of o.conversion.txHashes) L.push(`  - tx [${h}](${EXPLORER_TX}${h})`);
    }
    if (o.payment) {
      L.push(`- **Payment:** ${o.payment.status}${o.payment.receiptId ? `; receipt \`${o.payment.receiptId}\`` : ''}${o.payment.txHash ? `; tx [${o.payment.txHash}](${EXPLORER_TX}${o.payment.txHash})` : ''}`);
      L.push(`- **Service delivery:** delivered ${o.payment.delivered ?? 'n/a'}; HTTP ${o.payment.httpStatus ?? 'n/a'}${o.payment.responseSha256 ? `; response sha256 \`${o.payment.responseSha256}\`` : ''}${o.payment.responseFile ? `; stored at \`${o.payment.responseFile}\`` : ''}`);
    } else {
      L.push('- **Payment:** none was made for this order');
    }
    L.push(`- **Ledger entries:** ${o.ledger.length > 0 ? o.ledger.map((n) => `#${n}`).join(', ') : 'none'}`);
    for (const c of o.consistency) L.push(`- _Cross-check:_ ${c}`);
    if (o.onChainVerified !== undefined) L.push(`- **On-chain re-check:** every linked transaction found and successful: ${o.onChainVerified}`);
    if (o.needsAttention) L.push('- **NEEDS A HUMAN:** value may have moved, or converted funds are unpaid');
    L.push('');
  }
  L.push('', '## Transaction ledger (every real on-chain transaction)', '');
  L.push('Only transactions that were actually sent to Celo mainnet are listed. Mock tests, simulations and read-only previews are not transactions and are not listed.', '');
  for (const t of p.transactions) {
    L.push(`### ${t.seq}. ${t.kind}: [${t.hash}](${t.explorerUrl})`, '');
    L.push(`- **Purpose:** ${t.purpose}`);
    L.push(`- **Provider:** ${t.provider}`);
    L.push(`- **Token / amount (journal):** ${t.amount} ${t.token}`);
    L.push(`- **Origin:** ${t.origin}${t.orderId ? `; part of order \`${t.orderId}\`` : ''}`);
    for (const r of t.roles) L.push(`- **${r.role}:** ${r.address.startsWith('0x') ? '`' + r.address + '`' : r.address}`);
    L.push(`- **Settlement (journal):** ${t.journalSettlement}`);
    L.push(`- **Attribution:** ${t.attribution.applicable ? `journal verified: ${t.attribution.journalVerified}${t.attribution.codes ? ` (${t.attribution.codes.join(', ')})` : ''}` : 'not applicable'}; ${t.attribution.note}`);
    const c = t.onChain;
    if (c) {
      L.push(`- **On-chain re-check (${c.checkedAt}):** found: ${c.found}; status: ${c.status ?? 'n/a'}; block ${c.blockNumber ?? 'n/a'}; tx.from ${c.from ? '`' + c.from + '`' : 'n/a'}; to ${c.to ? '`' + c.to + '`' : 'n/a'}`);
      L.push(`  - verifyTx attribution codes: ${c.attributionCodes ? c.attributionCodes.join(', ') : 'none'}`);
      if (c.decoded) L.push(`  - call: ${c.decoded}`);
      for (const tr of c.transfers) L.push(`  - Transfer of ${tr.token}: ${tr.from} -> ${tr.to}, ${tr.value} atomic`);
      for (const n of c.notes) L.push(`  - ${n}`);
    } else {
      L.push('- **On-chain re-check:** not run for this document (run `node scripts/evidence.ts --verify`)');
    }
    L.push('');
  }
  if (p.transactions.length === 0) L.push('(no transactions recorded)', '');
  L.push('', '## Payments (x402)', '');
  for (const x of p.payments) {
    L.push(`### ${x.receiptId}`, '');
    L.push(`- **Status:** ${x.status}; delivered: ${x.delivered}; HTTP ${x.httpStatus ?? 'n/a'}`);
    L.push(`- **Service:** \`${x.service}\` (${x.serviceUrl})`);
    L.push(`- **Amount:** ${x.amount} ${x.token} (asset \`${x.asset}\`)`);
    L.push(`- **payTo:** \`${x.payTo}\``);
    L.push(`- **Payer:** \`${x.payer}\``);
    L.push(`- **Transaction:** ${x.txHash ? `[${x.txHash}](${x.explorerUrl})` : 'n/a'}`);
    L.push(`- **Settlement:** authorization \`${x.settlementAuthorizationState}\`; Transfer(payer -> payTo) found: ${x.transferVerified}`);
    L.push(`- **Response:** ${x.responseSummary || 'n/a'}${x.responseSha256 ? `; sha256 \`${x.responseSha256}\`${x.responseFile ? `; stored at \`${x.responseFile}\`` : ''}` : ''}`);
    for (const n of x.notes) L.push(`- _Note:_ ${n}`);
    L.push('');
  }
  if (p.payments.length === 0) L.push('(no payments recorded)', '');
  const executed = p.swaps.filter((s) => s.state === 'CONFIRMED');
  const stopped = p.swaps.filter((s) => s.state !== 'CONFIRMED');
  L.push('## Conversions Payrail executed (ERC-8021 tagged)', '');
  for (const s of executed) {
    L.push(`### ${s.route} via ${s.provider}: ${s.state} (${s.code})`, '', `Plan \`${s.planId}\`, ${s.at}; requested ${s.requestedSell} atomic; received ${s.received ?? 'n/a'} atomic.`, '');
    for (const t of s.transactions) {
      L.push(`- ${t.kind}: ${t.hash ? `[${t.hash}](${t.explorerUrl})` : 'n/a'}; mined: ${t.mined}; attribution verified by verifyTx: ${t.attributionVerified}${t.attributionCodes ? ` (${t.attributionCodes.join(', ')})` : ''}`);
    }
    for (const n of s.notes) L.push(`- _Note:_ ${n}`);
    L.push('');
  }
  if (executed.length === 0) L.push('(no confirmed conversions)', '');
  if (stopped.length > 0) {
    L.push('## Conversion attempts that were stopped (no swap was sent)', '');
    L.push('These are safety stops, kept for transparency; only the transactions listed under each (if any) were sent.', '');
    for (const s of stopped) {
      L.push(`- ${s.route} via ${s.provider}: **${s.state}** (${s.code}), plan \`${s.planId}\`, ${s.at}`);
      for (const t of s.transactions) L.push(`  - ${t.kind}: ${t.hash ? `[${t.hash}](${t.explorerUrl})` : 'n/a'}; mined: ${t.mined}; attribution verified: ${t.attributionVerified}`);
    }
    L.push('');
  }
  if (p.unresolved.length > 0) {
    L.push('## Unresolved (NOT counted as proof)', '');
    for (const u of p.unresolved) L.push(`- ${u}`);
    L.push('');
  }
  L.push('## Notes', '');
  for (const n of p.notes) L.push(`- ${n}`);
  for (const w of p.warnings) L.push(`- _warning:_ ${w}`);
  return L.join('\n') + '\n';
}
