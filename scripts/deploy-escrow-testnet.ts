// Deploy PayrailEscrow (and a MOCK token) to Celo SEPOLIA TESTNET only. Refuses any other chain.
//
//   node --env-file=C:\Users\<you>\.payrail\testnet-deployer.env scripts/deploy-escrow-testnet.ts            (plan only)
//   node --env-file=... scripts/deploy-escrow-testnet.ts --deploy                                           (deploys)
//
// Needs `forge build` first (contracts/out). The deployer key is a testnet-only key; it is never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

const SEPOLIA_ID = 11142220;
const RPC = process.env.TESTNET_RPC ?? 'https://forno.celo-sepolia.celo-testnet.org';
const chain = defineChain({ id: SEPOLIA_ID, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const line = (s = '') => console.log(s);

const key = process.env.TESTNET_DEPLOYER_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  line('[STOP] TESTNET_DEPLOYER_KEY is missing. Run with --env-file=<your testnet-deployer.env>.');
  process.exit(1);
}
const account = privateKeyToAccount(key as `0x${string}`);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const id = await pub.getChainId();
if (id !== SEPOLIA_ID) {
  line(`[STOP] RPC reports chain ${id}, not Celo Sepolia (${SEPOLIA_ID}). This script only deploys to the testnet.`);
  process.exit(1);
}
const artifact = (path: string) => {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: j.abi, bytecode: j.bytecode.object as `0x${string}` };
};
const token = artifact('contracts/out/PayrailEscrow.t.sol/MockToken.json');
const escrow = artifact('contracts/out/PayrailEscrow.sol/PayrailEscrow.json');

const balance = await pub.getBalance({ address: account.address });
line(`Network:   Celo Sepolia (chain ${id})`);
line(`Deployer:  ${account.address}  balance ${formatEther(balance)} CELO`);
line('Plan:      1) deploy MockToken (test only)  2) deploy PayrailEscrow(operator = fee recipient = deployer, fee 300 bps, hold timeout 1 day)  3) mint test tokens to deployer');
if (!process.argv.includes('--deploy')) {
  line('Plan only. Re-run with --deploy to send the transactions (testnet; no real value).');
  process.exit(0);
}
if (balance === 0n) {
  line('[STOP] the deployer has no test CELO. Fund it from the Celo Sepolia faucet, then re-run.');
  process.exit(1);
}

const wait = async (hash: `0x${string}`) => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return r;
};
const th = await wallet.deployContract({ abi: token.abi, bytecode: token.bytecode, args: [] });
const tr = await wait(th);
line(`MockToken:      ${tr.contractAddress}  (tx ${th})`);
const eh = await wallet.deployContract({ abi: escrow.abi, bytecode: escrow.bytecode, args: [tr.contractAddress!, account.address, account.address, 300, 86_400n] });
const er = await wait(eh);
line(`PayrailEscrow:  ${er.contractAddress}  (tx ${eh})`);
const mh = await wallet.writeContract({ address: tr.contractAddress!, abi: token.abi, functionName: 'mint', args: [account.address, 1_000_000_000n] });
await wait(mh);
line(`Minted 1000 test tokens to the deployer (tx ${mh}).`);
writeFileSync('contracts/deployments.testnet.json', JSON.stringify({ chainId: SEPOLIA_ID, deployer: account.address, mockToken: tr.contractAddress, escrow: er.contractAddress, txs: { token: th, escrow: eh, mint: mh }, at: new Date().toISOString() }, null, 2));
line('Recorded in contracts/deployments.testnet.json');
