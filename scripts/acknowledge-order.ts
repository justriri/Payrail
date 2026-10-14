// Acknowledge a STOPPED order that is flagged "needs a human" because a transaction (an approval) was sent but no
// swap or payment followed. Read-only against the chain; the only thing it can write is one additive note file.
//
//   node --env-file=.env scripts/acknowledge-order.ts --order <orderId> --by "<who>" [--reused-by <orderId>] [--write]
//
// Without --write it only verifies and prints. With --write it records receipts/acknowledgements/<orderId>.json,
// and only if EVERY fact below is verified. It never edits the order, journals, receipts or evidence inputs.
//
// Verified facts (all must pass):
//   F1  the approval transaction is mined and successful, from the wallet, approving exactly the amount to the
//       Textile reactor
//   F2  the journal's post-approval allowance read says 0 while the chain held the full amount at the approval's block
//       (so the read was stale, not the approval ineffective)
//   F3  the run stopped before any quote or swap: journal FAILED/APPROVAL_INEFFECTIVE, no quote id, no swap step
//   F4  no swap and no payment belong to this order (no payment record, no receipt, no swap hash)
//   F5  a later COMPLETED order reused that approval: its swap moved exactly the approved amount from the wallet, in a
//       later block, and it sent no approval of its own
//   F6  the allowance to the reactor is now zero
import { erc20Abi, decodeFunctionData, getAddress } from 'viem';
import { parseEventLogs } from 'viem';
import { verifyTx } from '@celo/attribution-tags';
import { readHistory } from '../src/history.ts';
import { acknowledgementRefusal, writeAcknowledgement } from '../src/ack.ts';
import type { AcknowledgedFact } from '../src/ack.ts';
import { ConfigError, TEXTILE_REACTOR, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { listOrders, loadOrder } from '../src/orderstore.ts';
import { policyFromEnv } from '../src/policy.ts';
import { loadSwapRecord } from '../src/swapjournal.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const line = (s = '') => console.log(s);
function stop(m: string, code = 2): never {
  line(`\n[STOP] ${m}`);
  process.exit(code);
}

const orderId = opt('order');
const by = opt('by');
if (!orderId) stop('pass --order <orderId>', 1);
if (args.includes('--write') && !by) stop('--write needs --by "<who is acknowledging>"', 1);

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) line(`[FAIL] ${p}`);
    stop('configuration invalid.', 1);
  }
  throw e;
}
if (!cfg.walletAddress) stop('set PAYRAIL_WALLET_ADDRESS (public address).', 1);
const wallet = cfg.walletAddress;
const live = createLive(cfg, policyFromEnv(process.env));
const dir = live.receiptDir;
const minAgreement = live.reads.endpoints.length > 1 ? 2 : 1;

const rec = loadOrder(dir, orderId!);
if (!rec) stop(`no order ${orderId}`);
const refusal = acknowledgementRefusal(rec!);
if (refusal) stop(refusal);
const order = rec!;

const facts: AcknowledgedFact[] = [];
const fact = (id: string, statement: string, evidence: string, verified: boolean) => {
  facts.push({ id, statement, evidence, verified });
  line(`${verified ? '[PASS]' : '[FAIL]'} ${id}: ${statement}\n         ${evidence}`);
};
const cngn = order.conversion?.sellSymbol === 'cNGN' ? (await import('../src/assets.ts')).assetBySymbol('cNGN')!.address : undefined;
const amount = order.conversion?.sellAmountAtomic ? BigInt(order.conversion.sellAmountAtomic) : undefined;
const swap = order.conversion ? loadSwapRecord(dir, order.conversion.swapPlanId) : undefined;
const approveStep = swap?.steps.find((s) => s.kind === 'approve' && s.hash);
if (!order.conversion || !cngn || amount === undefined || !swap || !approveStep?.hash) stop('the order does not have the expected conversion/approval records.');
const approvalHash = approveStep!.hash as `0x${string}`;

// ---- F1
let approvalBlock: bigint | undefined;
{
  const lk = await live.reads.lookupReceipt(approvalHash, { minAgreement });
  const tx = await live.reads.lookupTransaction(approvalHash);
  if (lk.kind !== 'found' || tx.kind !== 'found') {
    fact('F1', 'the approval transaction is mined and successful', `chain lookup did not conclude (${lk.kind}/${tx.kind})`, false);
  } else {
    approvalBlock = lk.receipt.blockNumber;
    let spender = '';
    let approved = 0n;
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data: tx.tx.input as `0x${string}` });
      if (d.functionName === 'approve') {
        spender = getAddress(d.args[0]);
        approved = d.args[1];
      }
    } catch {
      /* stays unverified */
    }
    const from = getAddress(tx.tx.from as string);
    const to = getAddress(tx.tx.to as string);
    const ok =
      lk.receipt.status === 'success' && from === wallet && to === getAddress(cngn!) && spender === TEXTILE_REACTOR && approved === amount;
    const v = await verifyTx({ client: live.client, hash: approvalHash }).catch(() => null);
    fact(
      'F1',
      `an approval for ${Number(amount) / 1e6} cNGN to the Textile reactor was mined successfully from the Payrail wallet (tagged: ${v ? v.codes.join(',') : 'no'})`,
      `${approvalHash} block ${lk.receipt.blockNumber}, status ${lk.receipt.status}, approve(${spender}, ${approved}), confirmed by ${lk.endpoints.length} endpoint(s)`,
      ok && v !== null && v.codes.includes(cfg.attributionTag),
    );
  }
}

// ---- F2
{
  let atBlock: bigint | undefined;
  if (approvalBlock !== undefined) {
    for (let i = 0; i < 4 && atBlock === undefined; i++) {
      try {
        atBlock = await live.client.readContract({ address: cngn!, abi: erc20Abi, functionName: 'allowance', args: [wallet, TEXTILE_REACTOR], blockNumber: approvalBlock });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  fact(
    'F2',
    'the allowance read recorded right after the approval was 0, although the chain held the full approved amount at the approval block (the read was stale; consistent with a lagging RPC node)',
    `journal residualAllowance=${swap!.residualAllowance}; exact-block allowance at block ${approvalBlock} = ${atBlock}`,
    swap!.residualAllowance === '0' && atBlock !== undefined && atBlock === amount,
  );
}

// ---- F3
fact(
  'F3',
  'Payrail stopped before requesting a swap quote or executing a swap',
  `swap journal ${swap!.planId}: state ${swap!.state}, code ${swap!.code}, quote id ${swap!.quote.id ?? 'none'}, steps ${swap!.steps.map((s) => s.kind).join(',') || 'none'}`,
  swap!.state === 'FAILED' && swap!.code === 'APPROVAL_INEFFECTIVE' && swap!.quote.id === undefined && swap!.steps.every((s) => s.kind === 'approve'),
);

// ---- F4
{
  const receiptsForOrder = readHistory(dir).receipts.filter((r) => r.orderId === order.orderId);
  fact(
    'F4',
    'no swap and no API payment occurred during this attempt',
    `order has no payment record (${order.payment === undefined}); receipts stamped with this order: ${receiptsForOrder.length}; swap transaction hashes in the journal: ${swap!.steps.filter((s) => s.kind === 'swap' && s.hash).length}`,
    order.payment === undefined && receiptsForOrder.length === 0 && !swap!.steps.some((s) => s.kind === 'swap'),
  );
}

// ---- F5
{
  const reusedBy = opt('reused-by');
  const later = reusedBy
    ? loadOrder(dir, reusedBy)
    : listOrders(dir).find(
        (o) =>
          o.state === 'COMPLETED' &&
          o.createdAt > order.createdAt &&
          o.conversion?.sellAmountAtomic === order.conversion!.sellAmountAtomic &&
          o.conversion?.sellSymbol === 'cNGN',
      );
  let ok = false;
  let evidence = 'no later completed order was found';
  if (later?.conversion && later.state === 'COMPLETED') {
    const lswap = loadSwapRecord(dir, later.conversion.swapPlanId);
    const swapHash = lswap?.steps.find((s) => s.kind === 'swap')?.hash as `0x${string}` | undefined;
    const ownApproval = lswap?.steps.some((s) => s.kind === 'approve') ?? true;
    if (swapHash && approvalBlock !== undefined) {
      const lk = await live.reads.lookupReceipt(swapHash, { minAgreement });
      if (lk.kind === 'found') {
        const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: lk.receipt.logs as never });
        const moved = logs
          .filter((l) => getAddress(l.address) === getAddress(cngn!) && getAddress(l.args.from) === wallet)
          .reduce((n, l) => n + l.args.value, 0n);
        ok = lk.receipt.status === 'success' && lk.receipt.blockNumber > approvalBlock && moved === amount && !ownApproval;
        evidence = `order ${later.orderId} COMPLETED; its swap ${swapHash} (block ${lk.receipt.blockNumber}, after the approval block ${approvalBlock}) moved ${moved} cNGN atomic from the wallet; it sent no approval of its own`;
      } else evidence = `the later swap lookup did not conclude (${lk.kind})`;
    }
  }
  fact('F5', 'the existing approval was reused by the later, successful attempt', evidence, ok);
}

// ---- F6
{
  let now: bigint | undefined;
  for (let i = 0; i < 4 && now === undefined; i++) {
    try {
      now = await live.client.readContract({ address: cngn!, abi: erc20Abi, functionName: 'allowance', args: [wallet, TEXTILE_REACTOR] });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  fact('F6', 'the remaining allowance to the reactor is now zero', `allowance(${wallet}, ${TEXTILE_REACTOR}) = ${now}`, now === 0n);
}

const allOk = facts.every((f) => f.verified);
line(`\n${allOk ? 'ALL FACTS VERIFIED' : 'NOT ALL FACTS VERIFIED: nothing will be recorded'}`);
if (!allOk) process.exit(3);

const note =
  `Attempt 2 of the cNGN→USDT conversion. The approval of ${Number(amount) / 1e6} cNGN to the Textile reactor was mined. ` +
  `The allowance read immediately afterwards returned 0 because the RPC node was lagging (the chain held the full amount at the approval's block), ` +
  `so Payrail correctly stopped before requesting a swap quote or executing a swap. No swap or API payment occurred in this attempt. ` +
  `The existing approval was reused by the successful later attempt, and the remaining allowance to the reactor is now zero.`;

if (!args.includes('--write')) {
  line('\nDry run: nothing was recorded. Re-run with --write --by "<who>" to record this acknowledgement.');
  process.exit(0);
}
const out = writeAcknowledgement(dir, order, { acknowledgedAt: new Date().toISOString(), acknowledgedBy: by!, note, facts });
line(`\nRecorded: ${dir}\\acknowledgements\\${out.orderId}.json`);
line('The order, journals, receipts and transactions were not modified.');
