// Unified, read-only activity history: service payments (receipts/*.json) and swaps (receipts/swaps/*.json,
// plus unresolved ones in receipts/pending/swap-*.json). Tolerant of legacy and malformed files.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readOrders } from './orderstore.ts';
import type { SwapRecord } from './swapjournal.ts';

export interface ActivityItem {
  kind: 'payment' | 'swap' | 'order';
  id: string;
  /** The order this payment/swap belongs to (set on payments and swaps; an order item's id IS the order id). */
  orderId?: string;
  at: string;
  status: string;
  /** One line a human can read. */
  summary: string;
  txHashes: string[];
  /** True while a human still has to resolve it. */
  unresolved: boolean;
  file: string;
}

export interface Activity {
  items: ActivityItem[];
  /** Files that could not be read (reported, never hidden). */
  warnings: string[];
}

function jsonIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.json')) // not isFile(): OneDrive reparse points report as symlinks
    .map((e) => e.name);
}

function atomicToHuman(atomic: string | undefined, decimals: number): string {
  if (atomic === undefined || !/^\d+$/.test(atomic)) return '?';
  const s = atomic.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function listActivity(dir: string): Activity {
  const items: ActivityItem[] = [];
  const warnings: string[] = [];

  for (const f of jsonIn(dir)) {
    const file = join(dir, f);
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
      if (typeof j.id !== 'string' || typeof j.createdAt !== 'string') throw new Error('missing id/createdAt');
      const status = typeof j.status === 'string' ? j.status : j.outcome?.settled === true ? 'CONFIRMED (legacy receipt)' : 'UNKNOWN (legacy receipt)';
      const amount = atomicToHuman(j.payment?.amountAtomic, 6);
      const token = j.input?.token ?? 'token';
      items.push({
        kind: 'payment',
        id: j.id,
        at: j.createdAt,
        status,
        summary: `paid ${amount} ${token} to ${j.service?.capability ?? 'a service'}`,
        txHashes: typeof j.payment?.txHash === 'string' ? [j.payment.txHash] : [],
        unresolved: status === 'UNCERTAIN',
        file,
        ...(typeof j.orderId === 'string' ? { orderId: j.orderId } : {}),
      });
    } catch (e) {
      warnings.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const readSwap = (file: string, name: string) => {
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as SwapRecord;
      if (typeof r.planId !== 'string' || typeof r.state !== 'string') throw new Error('not a swap record');
      items.push({
        kind: 'swap',
        id: r.planId,
        at: r.updatedAt ?? r.createdAt,
        status: r.state,
        summary: `${r.route.sellSymbol} -> ${r.route.buySymbol}: ${r.code}${r.amounts.takerPays ? ` (pays ${r.amounts.takerPays} atomic)` : ''}`,
        txHashes: r.steps.map((s) => s.hash).filter((h): h is string => typeof h === 'string'),
        unresolved: !['CONFIRMED', 'FAILED', 'EXPIRED'].includes(r.state),
        file,
      });
    } catch (e) {
      warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const f of jsonIn(join(dir, 'swaps'))) readSwap(join(dir, 'swaps', f), `swaps/${f}`);
  for (const f of jsonIn(join(dir, 'pending')).filter((n) => n.startsWith('swap-'))) readSwap(join(dir, 'pending', f), `pending/${f}`);

  // Orders tie a conversion and its payment together; the swap and payment items above keep their own records.
  const orderBySwap = new Map<string, string>();
  const ordersRead = readOrders(dir);
  for (const w of ordersRead.warnings) warnings.push(w);
  for (const o of ordersRead.orders) {
    if (o.conversion?.swapPlanId) orderBySwap.set(o.conversion.swapPlanId, o.orderId);
    const convertRef = o.steps.find((s) => s.kind === 'convert')?.ref;
    if (convertRef) orderBySwap.set(convertRef, o.orderId);
    const hashes = [...(o.conversion?.txHashes ?? []), ...(typeof o.payment?.txHash === 'string' ? [o.payment.txHash] : [])];
    const route = o.payment?.route ?? (o.conversion ? 'converted' : o.approved.route === 'swap' ? 'converted' : 'direct');
    items.push({
      kind: 'order',
      id: o.orderId,
      orderId: o.orderId,
      at: o.updatedAt ?? o.createdAt,
      status: o.state,
      summary:
        `${o.service.id}: ${route === 'converted' ? `convert ${o.conversion?.sellSymbol ?? '?'} -> ${o.conversion?.buySymbol ?? o.approved.symbol}, then pay` : 'pay directly'} ` +
        `${o.approved.amountAtomic} atomic ${o.approved.symbol}; payment ${o.payment?.status ?? 'not made'}`,
      txHashes: hashes,
      unresolved: o.state === 'UNCERTAIN' || o.needsAttention,
      file: join(dir, 'orders', `${o.orderId}.json`),
    });
  }
  for (const it of items) {
    if (it.kind === 'swap' && it.orderId === undefined) {
      const oid = orderBySwap.get(it.id);
      if (oid) it.orderId = oid;
    }
  }

  // a payment's pending journal is also unresolved work
  for (const f of jsonIn(join(dir, 'pending')).filter((n) => !n.startsWith('swap-'))) {
    items.push({
      kind: 'payment',
      id: f.replace(/\.json$/, ''),
      at: '',
      status: 'IN_FLIGHT',
      summary: 'a payment was started and not resolved; inspect the wallet and chain, then resolve it by hand',
      txHashes: [],
      unresolved: true,
      file: join(dir, 'pending', f),
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { items, warnings };
}

/** A human-readable swap receipt. States exactly what the evidence supports and no more. */
export function renderSwapRecord(r: SwapRecord): string {
  const L: string[] = [];
  L.push(`SWAP ${r.planId}   state: ${r.state}   (${r.code})`);
  L.push(r.message);
  L.push(`route   : ${r.route.sellSymbol} -> ${r.route.buySymbol} via ${r.route.provider}`);
  L.push(`amounts : requested ${r.amounts.requestedSell} atomic; takerPays ${r.amounts.takerPays ?? 'n/a'}; buy ${r.amounts.buy ?? 'n/a'}; fee ${r.amounts.fee ?? 'n/a'}; min buy ${r.amounts.minBuy}`);
  L.push(`quote   : id ${r.quote.id ?? 'n/a'}; expires ${r.quote.expiresAt ?? 'n/a'}; Textile status ${r.quote.textileStatus ?? 'n/a'}${r.quote.textileStatusNote ? ` (${r.quote.textileStatusNote})` : ''}`);
  for (const s of r.steps) {
    L.push(`tx      : ${s.kind} ${s.status} hash ${s.hash ?? 'n/a'} nonce ${s.nonce ?? 'n/a'} gas ${s.gasUsed ?? 'n/a'}`);
    L.push(`          attribution ${s.attribution ? (s.attribution.verified ? 'VERIFIED by verifyTx' : `NOT verified: ${s.attribution.note}`) : 'n/a'}`);
  }
  for (const sim of r.simulations) L.push(`simulate: ${sim.step}: ${sim.verdict} (tagged ${sim.tagged}; untagged ${sim.untagged})`);
  L.push(`verify  : swap mined ${r.verification.swapMined}; fill event ${r.verification.fillEvent}; debited ${r.verification.sellDebited ?? 'n/a'}; received ${r.verification.buyReceived ?? 'n/a'}`);
  for (const n of r.verification.notes) L.push(`          ${n}`);
  L.push(`balances: sell ${r.balances.sellBefore ?? '?'} -> ${r.balances.sellAfter ?? '?'}; buy ${r.balances.buyBefore ?? '?'} -> ${r.balances.buyAfter ?? '?'}; CELO ${r.balances.nativeBefore ?? '?'} -> ${r.balances.nativeAfter ?? '?'}`);
  L.push(`gas     : ${r.gas.usedUnits} units; cost ${r.gas.costWei ?? 'unknown'} wei (${r.gas.note})`);
  L.push(`approval: ${r.approvedBy ?? 'none'}; residual allowance ${r.residualAllowance ?? 'n/a'}; funds may have moved: ${r.fundsMayHaveMoved}`);
  if (r.state === 'UNCERTAIN') L.push('ACTION  : do NOT retry. Inspect the hashes above on a block explorer, then resolve receipts/pending/ by hand.');
  return L.join('\n');
}
