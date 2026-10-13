// Read-only: payment and swap history, including anything that still needs a human.
//   node scripts/history.ts [--limit 20] [--swap <planId>] [--order <orderId>]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listActivity, renderSwapRecord } from '../src/activity.ts';
import { loadOrder, renderOrderRecord } from '../src/orchestrator.ts';
import { RECEIPT_DIR } from '../src/live.ts';
import type { SwapRecord } from '../src/swapjournal.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const orderId = opt('order');
if (orderId) {
  const o = loadOrder(RECEIPT_DIR, orderId);
  if (!o) {
    console.log(`no order found for ${orderId}`);
    process.exit(2);
  }
  console.log(renderOrderRecord(o));
  process.exit(0);
}

const swapId = opt('swap');
if (swapId) {
  for (const sub of ['swaps', 'pending']) {
    const file = join(RECEIPT_DIR, sub, sub === 'pending' ? `swap-${swapId}.json` : `${swapId}.json`);
    try {
      console.log(renderSwapRecord(JSON.parse(readFileSync(file, 'utf8')) as SwapRecord));
      process.exit(0);
    } catch {
      /* try the next location */
    }
  }
  console.log(`no swap record found for ${swapId}`);
  process.exit(2);
}

const { items, warnings } = listActivity(RECEIPT_DIR);
const limit = Number(opt('limit') ?? 20);
console.log(`${items.length} item(s); showing ${Math.min(limit, items.length)} (newest first)\n`);
for (const it of items.slice(0, limit)) {
  const part = it.kind !== 'order' && it.orderId ? `  [part of order ${it.orderId}]` : '';
  console.log(`${it.unresolved ? '!! ' : '   '}${it.at || '(no time)'}  ${it.kind.padEnd(7)} ${it.status.padEnd(26)} ${it.summary}${part}`);
  for (const h of it.txHashes) console.log(`        tx ${h}`);
}
const open = items.filter((i) => i.unresolved);
if (open.length > 0) console.log(`\n${open.length} item(s) are UNRESOLVED and block new payments/swaps until a human resolves them.`);
for (const w of warnings) console.log(`warning: ${w}`);
