// Read-only: what does the wallet hold, what could it pay with, and what is already approved?
//   node scripts/balances.ts            (needs PAYRAIL_WALLET_ADDRESS, a public address; no key is read)
import { formatUnits } from 'viem';
import { ASSETS, microUsd } from '../src/assets.ts';
import { ConfigError, TEXTILE_REACTOR, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { DEFAULT_POLICY, formatUsd, policyFromEnv } from '../src/policy.ts';

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) console.log(`[FAIL] ${p}`);
    process.exit(1);
  }
  throw e;
}
if (!cfg.walletAddress) {
  console.log('[STOP] set PAYRAIL_WALLET_ADDRESS (a public address).');
  process.exit(1);
}
const owner = cfg.walletAddress;
const policy = policyFromEnv(process.env, DEFAULT_POLICY);
const live = createLive(cfg, policy);

const [chainId, native, gasPrice] = await Promise.all([live.client.getChainId(), live.client.getBalance({ address: owner }), live.client.getGasPrice()]);
console.log(`wallet : ${owner}`);
console.log(`network: chain ${chainId} ${chainId === cfg.chainId ? '(Celo mainnet, as configured)' : '(MISMATCH with configured chain!)'}`);
console.log(`gas    : ${formatUnits(native, 18)} CELO at ${formatUnits(gasPrice, 9)} gwei\n`);

console.log('asset  balance               usd-ish     can pay x402?  gas token?  allowance -> Textile reactor');
for (const a of ASSETS) {
  const bal = await live.getBalance(a.address, owner);
  let allowance = 0n;
  try {
    allowance = await live.client.readContract({
      address: a.address,
      abi: [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'allowance',
      args: [owner, TEXTILE_REACTOR],
    });
  } catch {
    allowance = -1n;
  }
  const usd = microUsd(a, bal);
  console.log(
    `${a.symbol.padEnd(6)} ${formatUnits(bal, a.decimals).padEnd(20)} ${(usd === undefined ? '-' : formatUsd(usd)).padEnd(11)} ${String(a.x402Signable).padEnd(14)} ${String(a.gasCapable).padEnd(11)} ${allowance < 0n ? 'unreadable' : formatUnits(allowance, a.decimals)}`,
  );
}
console.log('\nnothing was signed or sent.');
