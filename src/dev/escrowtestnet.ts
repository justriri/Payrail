// Wiring for the Celo SEPOLIA TESTNET escrow deployment (mock token, no real value). Refuses any other chain.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createViemEscrowClient } from '../escrow.ts';
import type { MarketRuntime } from '../market.ts';

export const SEPOLIA_CHAIN_ID = 11142220;
export const SEPOLIA_EXPLORER = 'https://celo-sepolia.blockscout.com';

interface Deployment {
  chainId: number;
  mockToken: `0x${string}`;
  escrow: `0x${string}`;
}

export function createTestnetEscrow(o: { operatorKey: `0x${string}`; rpcUrl?: string; deploymentsPath?: string; outDir?: string }): NonNullable<MarketRuntime['escrow']> {
  const rpc = o.rpcUrl ?? 'https://forno.celo-sepolia.celo-testnet.org';
  const dep = JSON.parse(readFileSync(o.deploymentsPath ?? 'contracts/deployments.testnet.json', 'utf8')) as Deployment;
  if (dep.chainId !== SEPOLIA_CHAIN_ID) throw new Error('the deployment file is not for Celo Sepolia; refusing');
  const out = o.outDir ?? 'contracts/out';
  const abi = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { abi: any[] }).abi;
  const escrowAbi = abi(`${out}/PayrailEscrow.sol/PayrailEscrow.json`);
  const tokenAbi = abi(`${out}/PayrailEscrow.t.sol/MockToken.json`);
  const account = privateKeyToAccount(o.operatorKey);
  const chain = defineChain({ id: SEPOLIA_CHAIN_ID, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const client = createViemEscrowClient({ rpcUrl: rpc, chainId: SEPOLIA_CHAIN_ID, escrow: dep.escrow, abi: escrowAbi, operatorKey: o.operatorKey, holdTimeoutSeconds: 86_400 });
  return {
    client,
    asset: 'TESTUSDT',
    testnet: {
      chainId: SEPOLIA_CHAIN_ID,
      escrow: dep.escrow,
      token: dep.mockToken,
      wallet: account.address,
      explorer: SEPOLIA_EXPLORER,
      async deposit(amount: bigint) {
        const wait = async (hash: `0x${string}`) => {
          const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
          if (r.status !== 'success') throw new Error(`transaction ${hash} reverted`);
          return hash;
        };
        await wait(await wallet.writeContract({ address: dep.mockToken, abi: tokenAbi, functionName: 'approve', args: [dep.escrow, amount] }));
        return wait(await wallet.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'deposit', args: [amount] }));
      },
    },
  };
}
