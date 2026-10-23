// Exports the verified payment receipts from evidence/evidence.json (written by scripts/evidence.ts --verify) to
// evidence/payment-receipts.json and .csv. Reads local files only: no network, no keys, no payment. Re-run
// `node scripts/evidence.ts --verify` first to refresh the on-chain checks.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evidence');
const e = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
const txByHash = new Map<string, any>(e.transactions.map((t: any) => [String(t.hash).toLowerCase(), t]));

const rows = e.payments.map((p: any) => {
  const t = txByHash.get(String(p.txHash).toLowerCase());
  const order = e.orders.find((o: any) => o.payment?.receiptId === p.receiptId);
  const swapHash = order?.conversion?.txHashes?.[0];
  const swapTx = swapHash ? txByHash.get(String(swapHash).toLowerCase()) : undefined;
  return {
    receiptId: p.receiptId,
    paidAt: p.at,
    status: p.status,
    chain: 'Celo mainnet (chainId 42220)',
    txHash: p.txHash,
    explorerUrl: p.explorerUrl,
    onChainStatus: t?.onChain?.status ?? null,
    blockNumber: t?.onChain?.blockNumber ?? null,
    amount: p.amount,
    currency: p.token,
    tokenContract: p.asset,
    service: p.service,
    endpoint: p.serviceUrl,
    payer: p.payer,
    payTo: p.payTo,
    transferVerified: p.transferVerified,
    delivered: p.delivered,
    httpStatus: p.httpStatus,
    responseSha256: p.responseSha256,
    orderId: p.orderId,
    conversion: order?.conversion
      ? {
          provider: order.conversion.provider,
          route: order.route,
          sold: order.conversion.sell,
          received: order.conversion.buy,
          swapTxHash: swapHash,
          swapBlock: swapTx?.onChain?.blockNumber ?? null,
          swapExplorerUrl: swapTx?.explorerUrl ?? null,
          attributionCodes: swapTx?.onChain?.attributionCodes ?? swapTx?.attribution?.codes ?? null,
        }
      : null,
  };
});

const out = { generatedFrom: 'evidence/evidence.json', evidenceGeneratedAt: e.generatedAt, addresses: e.addresses, payments: rows };
writeFileSync(join(dir, 'payment-receipts.json'), JSON.stringify(out, null, 2) + '\n');

const cols = ['receiptId', 'paidAt', 'status', 'chain', 'txHash', 'onChainStatus', 'blockNumber', 'amount', 'currency', 'service', 'endpoint', 'payer', 'payTo', 'responseSha256', 'orderId', 'conversionRoute', 'conversionSold', 'conversionReceived', 'conversionSwapTxHash'] as const;
const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [cols.join(',')].concat(rows.map((r: any) => cols.map((c) => cell(({ conversionRoute: r.conversion?.route, conversionSold: r.conversion?.sold, conversionReceived: r.conversion?.received, conversionSwapTxHash: r.conversion?.swapTxHash } as Record<string, unknown>)[c] ?? r[c])).join(','))).join('\n');
writeFileSync(join(dir, 'payment-receipts.csv'), csv + '\n');
console.log(`exported ${rows.length} payment receipts to evidence/payment-receipts.json and .csv`);
