// Human acknowledgement of an order that stopped but is flagged "needs a human".
//
// An acknowledgement is an ADDITIVE note: receipts/acknowledgements/<orderId>.json. It never edits the order, its
// swap journal, receipts or evidence inputs. It exists for one situation: an order that STOPPED with nothing paid
// and nothing unsettled, but which is flagged because a transaction (for example an approval) was sent. The note
// records WHY that is understood and safe, together with the facts that were re-verified before it was written.
//
// What can NOT be acknowledged (these always stay unresolved until the underlying problem is resolved):
//   * an order whose state is not STOPPED (UNCERTAIN / PAYING / CONVERTING ...),
//   * an order that has a payment record (a payment may have been sent),
//   * an order for which any required fact failed verification.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrderRecord } from './orderstore.ts';

export interface AcknowledgedFact {
  id: string;
  statement: string;
  /** How it was checked (a transaction, a journal field, an on-chain read ...). */
  evidence: string;
  verified: boolean;
}

export interface OrderAcknowledgement {
  schemaVersion: 1;
  orderId: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
  note: string;
  facts: AcknowledgedFact[];
}

/** Why this order may not be acknowledged, or undefined if it may. */
export function acknowledgementRefusal(rec: OrderRecord): string | undefined {
  if (rec.state !== 'STOPPED') return `the order is ${rec.state}, not STOPPED; only a stopped order that paid nothing can be acknowledged`;
  if (rec.payment !== undefined) return 'the order has a payment record, so a payment may have been sent; it cannot be acknowledged';
  if (!rec.needsAttention) return 'the order is not flagged as needing attention; there is nothing to acknowledge';
  return undefined;
}

const file = (dir: string, orderId: string) => join(dir, 'acknowledgements', `${orderId}.json`);

/** Writes the note. Refuses unless the order is eligible AND every fact is verified. Never overwrites. */
export function writeAcknowledgement(dir: string, rec: OrderRecord, ack: Omit<OrderAcknowledgement, 'schemaVersion' | 'orderId'>): OrderAcknowledgement {
  const refusal = acknowledgementRefusal(rec);
  if (refusal) throw new Error(`cannot acknowledge order ${rec.orderId}: ${refusal}`);
  const failed = ack.facts.filter((f) => !f.verified);
  if (ack.facts.length === 0) throw new Error('an acknowledgement needs at least one verified fact');
  if (failed.length > 0) throw new Error(`cannot acknowledge: ${failed.length} fact(s) did not verify: ${failed.map((f) => f.id).join(', ')}`);
  if (!ack.note.trim()) throw new Error('an acknowledgement needs a note');
  const full: OrderAcknowledgement = { schemaVersion: 1, orderId: rec.orderId, ...ack };
  mkdirSync(join(dir, 'acknowledgements'), { recursive: true });
  writeFileSync(file(dir, rec.orderId), JSON.stringify(full, null, 2), { flag: 'wx' }); // additive: never overwrites
  return full;
}

/** All readable acknowledgements. Directory entries are filtered with !isDirectory() (OneDrive reparse points). */
export function readAcknowledgements(dir: string): { acks: Map<string, OrderAcknowledgement>; warnings: string[] } {
  const acks = new Map<string, OrderAcknowledgement>();
  const warnings: string[] = [];
  const d = join(dir, 'acknowledgements');
  if (!existsSync(d)) return { acks, warnings };
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory() || !e.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(d, e.name), 'utf8')) as OrderAcknowledgement;
      if (typeof j.orderId !== 'string' || !Array.isArray(j.facts) || typeof j.note !== 'string') throw new Error('not an acknowledgement');
      acks.set(j.orderId, j);
    } catch (err) {
      warnings.push(`acknowledgements/${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { acks, warnings };
}
