// Exercise the deployed PayrailEscrow on Celo SEPOLIA TESTNET end to end (mock token, no real value).
//   node --env-file=C:\Users\<you>\.payrail\testnet-deployer.env scripts/escrow-testnet-flow.ts
// Reads contracts/deployments.testnet.json. Refuses any chain other than 11142220.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ID = 11142220;
const RPC = process.env.TESTNET_RPC ?? 'https://forno.celo-sepolia.celo-testnet.org';
const chain = defineChain({ id: ID, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const dep = JSON.parse(readFileSync('contracts/deployments.testnet.json', 'utf8')) as { mockToken: `0x${string}`; escrow: `0x${string}` };
const abi = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { abi: any[] }).abi;
const tokenAbi = abi('contracts/out/PayrailEscrow.t.sol/MockToken.json');
const escrowAbi = abi('contracts/out/PayrailEscrow.sol/PayrailEscrow.json');

const operator = privateKeyToAccount(process.env.TESTNET_DEPLOYER_KEY as `0x${string}`);
const seller = privateKeyToAccount(generatePrivateKey()); // throwaway testnet seller
const pub = createPublicClient({ chain, transport: http(RPC) });
const op = createWalletClient({ account: operator, chain, transport: http(RPC) });
const sw = createWalletClient({ account: seller, chain, transport: http(RPC) });
if ((await pub.getChainId()) !== ID) throw new Error('not Celo Sepolia');

const log: Array<{ step: string; tx?: string; note?: string }> = [];
const send = async (step: string, p: Promise<`0x${string}`>) => {
  const hash = await p;
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${step} reverted (${hash})`);
  log.push({ step, tx: hash });
  console.log(`${step.padEnd(34)} ${hash}`);
};
const read = (address: `0x${string}`, a: any[], functionName: string, args: unknown[] = []) => pub.readContract({ address, abi: a, functionName, args } as never) as Promise<any>;
// public RPCs sit behind load balancers and can briefly serve a state older than a block that was just mined: re-read
const expect = async (name: string, get: () => Promise<bigint>, want: bigint) => {
  let got = await get();
  for (let i = 0; i < 12 && got !== want; i++) {
    await new Promise((r) => setTimeout(r, 1_500));
    got = await get();
  }
  if (got !== want) throw new Error(`${name}: got ${got}, expected ${want}`);
  log.push({ step: `check ${name}`, note: `${got}` });
  console.log(`  ok  ${name} = ${got}`);
};
const avail0: bigint = await read(dep.escrow, escrowAbi, 'available', [operator.address]);
const earnSeller0: bigint = 0n;
const earnFee0: bigint = await read(dep.escrow, escrowAbi, 'earnings', [operator.address]);
const liab0: bigint = await read(dep.escrow, escrowAbi, 'totalLiabilities');
void earnSeller0;
const idA = keccak256(toHex(`flow-A-${Date.now()}`));
const idB = keccak256(toHex(`flow-B-${Date.now()}`));

await send('fund throwaway seller (gas)', op.sendTransaction({ to: seller.address, value: 5n * 10n ** 16n }));
await send('buyer approves escrow', op.writeContract({ address: dep.mockToken, abi: tokenAbi, functionName: 'approve', args: [dep.escrow, 10n ** 12n] }));
await send('buyer deposits 0.1', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'deposit', args: [100_000n] }));
await expect('available after deposit', () => read(dep.escrow, escrowAbi, 'available', [operator.address]), avail0 + 100_000n);

await send('hold A (0.02 -> seller)', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'placeHold', args: [idA, operator.address, seller.address, 20_000n] }));
await send('capture A (qualifying)', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'capture', args: [idA] }));
await expect('seller earnings (97%)', () => read(dep.escrow, escrowAbi, 'earnings', [seller.address]), 19_400n);
await expect('fee recipient earnings (3%)', () => read(dep.escrow, escrowAbi, 'earnings', [operator.address]), earnFee0 + 600n);

await send('hold B (0.02 -> seller)', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'placeHold', args: [idB, operator.address, seller.address, 20_000n] }));
await expect('available while B held', () => read(dep.escrow, escrowAbi, 'available', [operator.address]), avail0 + 60_000n);
await send('release B (not qualifying)', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'release', args: [idB] }));
await expect('available after release', () => read(dep.escrow, escrowAbi, 'available', [operator.address]), avail0 + 80_000n);

// double resolution must revert
let reverted = false;
try {
  await pub.simulateContract({ address: dep.escrow, abi: escrowAbi, functionName: 'capture', args: [idB], account: operator.address });
} catch {
  reverted = true;
}
if (!reverted) throw new Error('a released hold could be captured');
log.push({ step: 'check released hold cannot be captured', note: 'reverted as expected' });
console.log('  ok  released hold cannot be captured');

await send('seller claims', sw.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'claim', args: [] }));
await expect('seller token balance', () => read(dep.mockToken, tokenAbi, 'balanceOf', [seller.address]), 19_400n);
await send('buyer withdraws remainder', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'withdraw', args: [avail0 + 80_000n] }));
await send('fee recipient claims', op.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'claim', args: [] }));
await expect('escrow liabilities at end', () => read(dep.escrow, escrowAbi, 'totalLiabilities'), liab0 - avail0 - earnFee0);
await expect('escrow token balance at end', () => read(dep.mockToken, tokenAbi, 'balanceOf', [dep.escrow]), liab0 - avail0 - earnFee0);

writeFileSync('contracts/flow-run.testnet.json', JSON.stringify({ chainId: ID, escrow: dep.escrow, seller: seller.address, at: new Date().toISOString(), log }, null, 2));
console.log('Recorded in contracts/flow-run.testnet.json');
