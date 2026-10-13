// Real (network-backed) dependencies for the planner and executor. Read-only unless the executor is used.
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, getAddress, parseEventLogs } from 'viem';
import type { Address } from 'viem';
import { celo } from 'viem/chains';
import { authorizationSettlement, getTokenBalance } from '@celo/buy-core';
import type { Asset } from './assets.ts';
import { createProductionChainReads, readTransport, rpcUrlList } from './chainread.ts';
import { createCatalogClient } from './catalog.ts';
import type { Config } from './config.ts';
import { readHistory, spentSince } from './history.ts';
import type { PlanDeps } from './planner.ts';
import type { SpendingPolicy } from './policy.ts';
import { discoverRequirements } from './requirements.ts';
import { createMentoRouteProvider } from './mento.ts';
import { createCompositeRouteProvider, createTextileRouteProvider } from './routes.ts';
import type { VerifyDeps } from './verify.ts';

export const RECEIPT_DIR = fileURLToPath(new URL('../receipts/', import.meta.url));

export function createLive(cfg: Config, policy: SpendingPolicy, receiptDir: string = RECEIPT_DIR) {
  // Reads fail over between endpoints on errors; receipt lookups (which can come back null from a pruned
  // backend) go through `reads`, which retries across endpoints before concluding anything.
  const client = createPublicClient({ chain: celo, transport: readTransport(rpcUrlList(cfg.rpcUrl, cfg.rpcFallbackUrls)) });
  const reads = createProductionChainReads(cfg.rpcUrl, cfg.rpcFallbackUrls);
  const catalog = createCatalogClient();

  const getBalance = (asset: Address, owner: Address): Promise<bigint> =>
    getTokenBalance({ network: 'celo', token: asset, owner });

  const planDeps: PlanDeps = {
    now: () => Date.now(),
    policy,
    discover: (service, body) => discoverRequirements(service, body, { policy }),
    async getBalances(owner, assets: readonly Asset[]) {
      const entries = await Promise.all(
        assets.map(async (a) => [a.address.toLowerCase(), await getBalance(a.address, owner)] as const),
      );
      return new Map(entries);
    },
    getNativeBalance: (owner) => client.getBalance({ address: owner }),
    gasPriceWei: () => client.getGasPrice(),
    routes: createCompositeRouteProvider([createTextileRouteProvider(), createMentoRouteProvider({ client: client as never })]),
    // The swap pipeline exists (swapexec.ts). It is mock-tested only and has never run live.
    swapExecution: true,
    spentSince: (sinceMs) => spentSince(readHistory(receiptDir), sinceMs),
  };

  const verify: VerifyDeps = {
    async resolveAuthorization(p) {
      const s = await authorizationSettlement({
        network: 'celo',
        asset: p.asset,
        authorization: {
          from: getAddress(p.authorization.from),
          nonce: p.authorization.nonce as `0x${string}`,
          validAfter: p.authorization.validAfter,
          validBefore: p.authorization.validBefore,
        },
        timestamp: p.timestamp,
      });
      if (s.state === 'settled') return { state: 'settled', txHash: s.txHash };
      if (s.state === 'not_settled') return { state: 'not_settled', detail: `expired at ${s.expiredAt}` };
      if (s.state === 'pending') return { state: 'pending', detail: `can still settle until ${s.until}` };
      return { state: 'unknown', detail: s.reason };
    },
    async getTransferLogs(txHash) {
      const lk = await reads.lookupReceipt(txHash as `0x${string}`);
      // Anything but a validated receipt is INCONCLUSIVE: throwing makes the caller record a note and leave the
      // payment UNCERTAIN (never failed, never confirmed on this evidence).
      if (lk.kind !== 'found') throw new Error(`receipt lookup inconclusive (${lk.kind})`);
      const receipt = lk.receipt as unknown as { status: string; logs: Parameters<typeof parseEventLogs>[0]['logs'] };
      const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs });
      return {
        status: receipt.status,
        logs: logs.map((l) => ({ address: getAddress(l.address), from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value })),
      };
    },
  };

  return { client, reads, catalog, planDeps, verify, getBalance, receiptDir };
}
