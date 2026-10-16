// Run the BACKEND escrow path (src/escrow.ts) against the deployed testnet contract (Celo Sepolia, mock token).
// The seller API is the in-process demo network; the escrow transactions are real testnet transactions.
//   node --env-file=C:\Users\<you>\.payrail\testnet-deployer.env scripts/escrow-testnet-backend.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openDb } from '../../src/db.ts';
import { createDemoNetwork, seedDemo } from '../../src/dev/demoapis.ts';
import { RateLimiter } from '../../src/egress.ts';
import { createViemEscrowClient, executeEscrowRequest, holdIdFor, recoverEscrow } from '../../src/escrow.ts';
import { createAccount } from '../../src/ledger.ts';
import { generateMasterKey } from '../../src/vault.ts';

const ID = 11142220;
const RPC = process.env.TESTNET_RPC ?? 'https://forno.celo-sepolia.celo-testnet.org';
const dep = JSON.parse(readFileSync('contracts/deployments.testnet.json', 'utf8')) as { mockToken: `0x${string}`; escrow: `0x${string}` };
const abi = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { abi: any[] }).abi;
const tokenAbi = abi('contracts/out/PayrailEscrow.t.sol/MockToken.json');
const escrowAbi = abi('contracts/out/PayrailEscrow.sol/PayrailEscrow.json');
const key = process.env.TESTNET_DEPLOYER_KEY as `0x${string}`;
const operator = privateKeyToAccount(key);
const sellerWallet = privateKeyToAccount(generatePrivateKey()).address; // receives nothing here; only named as payee
const chain = defineChain({ id: ID, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: operator, chain, transport: http(RPC) });
if ((await pub.getChainId()) !== ID) throw new Error('not Celo Sepolia');

const client = createViemEscrowClient({ rpcUrl: RPC, chainId: ID, escrow: dep.escrow, abi: escrowAbi, operatorKey: key, holdTimeoutSeconds: 86_400 });
const tx = async (label: string, hash: Promise<`0x${string}`>) => {
  const h = await hash;
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`${label.padEnd(30)} ${h}`);
  return h;
};
const record: Record<string, unknown> = { chainId: ID, escrow: dep.escrow, seller: sellerWallet, steps: [] as unknown[] };
const steps = record.steps as unknown[];

await tx('approve escrow', wallet.writeContract({ address: dep.mockToken, abi: tokenAbi, functionName: 'approve', args: [dep.escrow, 10n ** 12n] }));
await tx('deposit 0.1 to escrow', wallet.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: 'deposit', args: [100_000n] }));
let bal = 0n;
for (let i = 0; i < 12 && bal < 100_000n; i++) {
  bal = await client.available(operator.address);
  if (bal < 100_000n) await new Promise((r) => setTimeout(r, 1_500));
}
console.log(`escrow available for buyer: ${bal}`);

const db = openDb(':memory:');
const mk = generateMasterKey('k1');
const demo = seedDemo(db, mk);
db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run(sellerWallet.toLowerCase(), demo.sellerId);
const buyer = createAccount(db, { kind: 'buyer', displayName: 'Testnet buyer' });
db.prepare("INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES (?, ?, 'testnet-operator-owned', ?)").run(operator.address.toLowerCase(), buyer, new Date().toISOString());
const net = createDemoNetwork();
const opts = { demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: net.resolver, transport: net.transport, timeoutMs: 3_000 } } };

const stamp = Date.now();
const good = await executeEscrowRequest(db, [mk], client, { buyerId: buyer, listingId: demo.priceListingId, idempotencyKey: `be-good-${stamp}`, input: { id: 'eth' }, asset: 'TESTUSDT' }, opts);
console.log(`qualifying   -> ${good.state}  charged=${good.charged}  fee=${good.feeAtomic} seller=${good.sellerAtomic}`);
const bad = await executeEscrowRequest(db, [mk], client, { buyerId: buyer, listingId: demo.priceListingId, idempotencyKey: `be-stale-${stamp}`, input: { id: 'eth', scenario: 'stale' }, asset: 'TESTUSDT' }, opts);
console.log(`stale answer -> ${bad.state}  charged=${bad.charged}  reason=${bad.reason}`);
const hang = await executeEscrowRequest(db, [mk], client, { buyerId: buyer, listingId: demo.priceListingId, idempotencyKey: `be-hang-${stamp}`, input: { id: 'eth', scenario: 'hang' }, asset: 'TESTUSDT' }, opts);
console.log(`timeout      -> ${hang.state}  held=${hang.held}`);

// verify against the chain itself, not against what the backend says
const names = ['None', 'Held', 'Captured', 'Released'];
const chainState = async (execId: string) => {
  const h = (await pub.readContract({ address: dep.escrow, abi: escrowAbi, functionName: 'holds', args: [holdIdFor(execId)] })) as any;
  return names[Number(Array.isArray(h) ? h[4] : h.state)];
};
const results = [
  ['qualifying', good.executionId, 'Captured', good.state],
  ['stale', bad.executionId, 'Released', bad.state],
  ['timeout', hang.executionId, 'Held', hang.state],
] as const;
for (const [label, id, want, backendState] of results) {
  let got = await chainState(id);
  for (let i = 0; i < 12 && got !== want; i++) {
    await new Promise((r) => setTimeout(r, 1_500));
    got = await chainState(id);
  }
  console.log(`on-chain ${label.padEnd(10)} ${got}  (expected ${want})  backend=${backendState}`);
  if (got !== want) throw new Error(`${label}: chain says ${got}, expected ${want}`);
  steps.push({ label, executionId: id, holdId: holdIdFor(id), onChain: got, backend: backendState });
}
// the unresolved one is still within its 1-day window: recovery must leave it alone
const rec = await recoverEscrow(db, client);
console.log(`recovery pass changed ${rec.length} execution(s) (expected 0: hold is within its timeout)`);
if (rec.length !== 0) throw new Error('recovery changed something it should not have');
writeFileSync('contracts/backend-run.testnet.json', JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
console.log('Recorded in contracts/backend-run.testnet.json');
process.exit(0);
