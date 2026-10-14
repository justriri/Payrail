// Build the hackathon submission evidence: services used + proof of payments + tagged conversions.
//   node scripts/evidence.ts [--verify] [--out evidence]
//
// Reads Payrail's own receipts. With --verify it ALSO re-checks every payment against the chain (read-only):
// the settlement transaction must be successful and contain Transfer(payer -> payTo, amount). It never
// modifies receipts and sends nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyTx } from '@celo/attribution-tags';
import { decodeFunctionData, erc20Abi, getAddress, parseEventLogs } from 'viem';
import { buildEvidencePack, renderEvidenceMarkdown } from '../src/evidence.ts';
import { RECEIPT_DIR } from '../src/live.ts';
import { createPublicClient } from 'viem';
import { celo } from 'viem/chains';
import { createProductionChainReads, readTransport, rpcUrlList } from '../src/chainread.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VERIFY = args.includes('--verify');
const outDir = resolve(opt('out') ?? 'evidence');

const pack = buildEvidencePack(RECEIPT_DIR);

// Chain reads: several endpoints, bounded retries, validated receipts (see src/chainread.ts for why).
const fbEnv = process.env.PAYRAIL_RPC_FALLBACK_URLS;
const fallbacks = fbEnv === undefined ? undefined : fbEnv.split(',').map((s) => s.trim()).filter(Boolean);
const urls = rpcUrlList(process.env.PAYRAIL_RPC_URL || undefined, fallbacks);
const reads = createProductionChainReads(process.env.PAYRAIL_RPC_URL || undefined, fallbacks);
const minAgreement = reads.endpoints.length > 1 ? 2 : 1; // evidence wants two independent endpoints when available
const describe = (lk: { kind: string; detail?: string; agreed?: number; needed?: number }) =>
  lk.detail ?? (lk.kind === 'insufficient_agreement' ? `only ${lk.agreed} of ${lk.needed} required endpoints confirmed it` : lk.kind);

if (VERIFY) {
  for (const p of pack.payments) {
    if (!p.txHash) {
      p.notes.push('LIVE RE-VERIFICATION: no transaction hash to verify');
      continue;
    }
    try {
      const lk = await reads.lookupReceipt(p.txHash as `0x${string}`, { minAgreement });
      if (lk.kind !== 'found') {
        // Inconclusive is NOT "failed" and NOT "verified": report exactly what the chain reads could establish.
        p.notes.push(`LIVE RE-VERIFICATION INCONCLUSIVE (${lk.kind}): ${describe(lk)}`);
        pack.warnings.push(`payment ${p.receiptId}: live re-verification inconclusive (${lk.kind})`);
        continue;
      }
      const r = lk.receipt as unknown as { status: string; blockNumber: bigint; logs: Parameters<typeof parseEventLogs>[0]['logs'] };
      const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs });
      const want = BigInt(Math.round(Number(p.amount) * 1_000_000));
      const hit = logs.some(
        (l) =>
          getAddress(l.address) === getAddress(p.asset) &&
          getAddress(l.args.from) === getAddress(p.payer) &&
          getAddress(l.args.to) === getAddress(p.payTo) &&
          l.args.value === want,
      );
      p.notes.push(`LIVE RE-VERIFICATION ${new Date().toISOString()}: receipt ${r.status}, block ${r.blockNumber}, confirmed by ${lk.endpoints.length} endpoint(s), Transfer(payer -> payTo, ${p.amount} ${p.token}) found: ${hit}`);
      if (r.status !== 'success' || !hit) pack.warnings.push(`payment ${p.receiptId} did NOT re-verify on-chain`);
    } catch (e) {
      p.notes.push(`LIVE RE-VERIFICATION failed to run: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
}

// Every real transaction in the ledger is re-checked against the chain (read-only): receipt status, who sent
// it, what it called, which tag verifyTx finds, and the token transfers that involve the Payrail wallet.
if (VERIFY) {
  const client = createPublicClient({ chain: celo, transport: readTransport(urls) });
  const wallet = (pack.addresses.find((a) => a.role.startsWith('payer'))?.address ?? '').toLowerCase();
  for (const t of pack.transactions) {
    const hash = t.hash as `0x${string}`;
    const check = {
      checkedAt: new Date().toISOString(),
      found: false,
      status: null as string | null,
      blockNumber: null as string | null,
      from: null as string | null,
      to: null as string | null,
      attributionCodes: null as string[] | null,
      decoded: null as string | null,
      transfers: [] as Array<{ token: string; from: string; to: string; value: string }>,
      notes: [] as string[],
    };
    try {
      const lk = await reads.lookupReceipt(hash, { minAgreement });
      if (lk.kind !== 'found') throw new Error(`INCONCLUSIVE receipt (${lk.kind}): ${describe(lk)}`);
      const ltx = await reads.lookupTransaction(hash);
      if (ltx.kind !== 'found') throw new Error(`INCONCLUSIVE transaction (${ltx.kind}): ${ltx.detail}`);
      const r = lk.receipt as unknown as { status: string; blockNumber: bigint; logs: Parameters<typeof parseEventLogs>[0]['logs'] };
      const tx = ltx.tx as unknown as { from: string; to: string | null; input: `0x${string}` };
      check.found = true;
      check.status = r.status;
      check.blockNumber = r.blockNumber.toString();
      check.from = getAddress(tx.from);
      check.to = tx.to ? getAddress(tx.to) : null;
      for (const l of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })) {
        if (l.args.from.toLowerCase() === wallet || l.args.to.toLowerCase() === wallet) {
          check.transfers.push({ token: getAddress(l.address), from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value.toString() });
        }
      }
      if (t.kind === 'approve' || t.kind === 'approve_reset') {
        try {
          const d = decodeFunctionData({ abi: erc20Abi, data: tx.input });
          if (d.functionName === 'approve') check.decoded = `approve(spender ${getAddress(d.args[0])}, amount ${d.args[1]} atomic)`;
        } catch {
          check.notes.push('calldata did not decode as an ERC-20 approve');
        }
      }
      try {
        const v = await verifyTx({ client, hash });
        check.attributionCodes = v ? [...v.codes] : null;
      } catch (e) {
        check.notes.push(`verifyTx could not run: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
      if (r.status !== 'success') pack.warnings.push(`transaction ${t.hash} is not successful on-chain (${r.status})`);
      if (t.attribution.applicable) {
        if (!check.attributionCodes?.includes('celo_b2fff2ac9413')) pack.warnings.push(`transaction ${t.hash}: the official tag was NOT found on-chain`);
        if (check.from?.toLowerCase() !== wallet) pack.warnings.push(`transaction ${t.hash}: sender ${check.from} is not the Payrail wallet`);
      } else if (t.kind === 'x402 payment') {
        check.notes.push(
          check.from?.toLowerCase() === wallet
            ? 'sent by the Payrail wallet'
            : `submitted by ${check.from} (not the Payrail wallet), as expected for a gateway-sponsored x402 settlement`,
        );
      }
    } catch (e) {
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      check.notes.push(`on-chain check did not conclude: ${why}`);
      pack.warnings.push(`transaction ${t.hash} could not be verified on-chain (${why})`);
    }
    t.onChain = check;
  }
  // Delivery proof: recompute the sha256 of every stored response body and compare it with the receipt.
  const { createHash } = await import('node:crypto');
  const { existsSync, readFileSync } = await import('node:fs');
  for (const pay of pack.payments) {
    if (!pay.responseFile || !pay.responseSha256) continue;
    const file = join(RECEIPT_DIR, pay.responseFile);
    if (!existsSync(file)) {
      pay.notes.push(`RESPONSE FILE CHECK: ${pay.responseFile} is MISSING; the recorded hash cannot be re-verified`);
      pack.warnings.push(`payment ${pay.receiptId}: stored response file is missing`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual === pay.responseSha256) pay.notes.push(`RESPONSE FILE CHECK: sha256 of ${pay.responseFile} recomputed and matches the receipt`);
    else {
      pay.notes.push(`RESPONSE FILE CHECK: sha256 of ${pay.responseFile} is ${actual}, NOT the receipt's ${pay.responseSha256}`);
      pack.warnings.push(`payment ${pay.receiptId}: stored response does not match its recorded hash`);
    }
  }

  // an order is verified only if every transaction linked to it was found on-chain and succeeded
  for (const o of pack.orders) {
    const linked = pack.transactions.filter((t) => o.ledger.includes(t.seq));
    // an order that sent nothing has no transactions to verify: leave it unset rather than report "false"
    if (linked.length > 0) o.onChainVerified = linked.every((t) => t.onChain?.found === true && t.onChain.status === 'success');
    if (o.onChainVerified === false && o.state === 'COMPLETED') pack.warnings.push(`order ${o.orderId} is COMPLETED but its transactions did not all verify on-chain`);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'SUBMISSION-EVIDENCE.md'), renderEvidenceMarkdown(pack));
writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(pack, null, 2));

console.log(`orders: ${pack.orders.length} | transactions: ${pack.transactions.length} | payments: ${pack.payments.length} | services: ${pack.services.length} | conversions: ${pack.swaps.length} | unresolved: ${pack.unresolved.length} | warnings: ${pack.warnings.length}`);
for (const a of pack.addresses) console.log(`${a.role.padEnd(42)} ${a.address}`);
console.log(`written: ${join(outDir, 'SUBMISSION-EVIDENCE.md')} and evidence.json`);
if (pack.unresolved.length > 0) console.log('NOTE: unresolved items are listed and are NOT counted as proof.');
