// READ-ONLY preflight for real-funds USDT deposits. Sends nothing, signs nothing, needs no key.
//   node --env-file=.env scripts/golive-check.ts
// It checks the settings the server would start with and a few facts on chain, then prints the exact launch command.
import { createPublicClient, erc20Abi, http } from 'viem';
import { celo } from 'viem/chains';
import { ASSETS } from '../src/assets.ts';
import { DEFAULT_RPC_FALLBACKS } from '../src/chainread.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';

const env = process.env;
const usdt = ASSETS.find((a) => a.symbol === 'USDT')!;
const rows: Array<[string, string, string]> = [];
const row = (ok: boolean | 'warn', name: string, detail: string) => rows.push([ok === true ? 'OK  ' : ok === 'warn' ? 'WARN' : 'FAIL', name, detail]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const dep = env.PAYRAIL_DEPOSIT_ADDRESS ?? '';
row(ADDR.test(dep), 'PAYRAIL_DEPOSIT_ADDRESS', ADDR.test(dep) ? dep : 'not set: choose an address YOU control and set it explicitly');
if (ADDR.test(dep)) {
  const l = dep.toLowerCase();
  row(l !== '0x0000000000000000000000000000000000000000' && l !== usdt.address.toLowerCase() && l !== TEXTILE_REACTOR.toLowerCase(), 'deposit address is not zero / the token / the reactor', '');
}
if (env.PAYRAIL_WALLET_ADDRESS && ADDR.test(dep)) row(dep.toLowerCase() === env.PAYRAIL_WALLET_ADDRESS.toLowerCase() ? true : 'warn', 'deposit address vs PAYRAIL_WALLET_ADDRESS', dep.toLowerCase() === env.PAYRAIL_WALLET_ADDRESS.toLowerCase() ? 'same wallet' : `different wallet (${env.PAYRAIL_WALLET_ADDRESS}); confirm you control the deposit address`);
const cap = Number(env.PAYRAIL_MAX_DEPOSIT_USD ?? '5');
row(Number.isFinite(cap) && cap > 0 && cap <= 50, 'PAYRAIL_MAX_DEPOSIT_USD', `${cap} USDT per deposit${cap > 50 ? ' (above 50: lower it for the first run)' : ''}`);
const conf = Number(env.PAYRAIL_DEPOSIT_CONFIRMATIONS ?? '20');
row(conf >= 12 ? true : 'warn', 'PAYRAIL_DEPOSIT_CONFIRMATIONS', String(conf));
row(Boolean(env.PAYRAIL_VAULT_KEY), 'PAYRAIL_VAULT_KEY', env.PAYRAIL_VAULT_KEY ? 'set' : 'not set: real-funds mode must keep seller credentials readable across restarts');
row(env.PAYRAIL_MARKET_LIVE !== '1' ? 'warn' : true, 'PAYRAIL_MARKET_LIVE', env.PAYRAIL_MARKET_LIVE === '1' ? 'set to 1' : 'not set (live mode is off until you start the server with it)');

try {
  const urls = [env.PAYRAIL_RPC_URL, ...DEFAULT_RPC_FALLBACKS].filter((u): u is string => Boolean(u));
  const client = createPublicClient({ chain: celo, transport: http(urls[0]) });
  const id = await client.getChainId();
  row(id === 42220, 'RPC chain id', String(id));
  const [sym, dec] = await Promise.all([
    client.readContract({ address: usdt.address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: usdt.address, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  row(sym === 'USD₮' || sym === 'USDT' || String(sym).includes('USD'), 'USDT contract answers', `${sym}, ${dec} decimals at ${usdt.address}`);
  if (ADDR.test(dep)) {
    const code = await client.getCode({ address: dep as `0x${string}` });
    row(!code || code === '0x' ? true : 'warn', 'deposit address is an ordinary wallet (no contract code)', !code || code === '0x' ? 'EOA' : 'has contract code: make sure it can hold and move ERC-20 tokens');
    const bal = await client.readContract({ address: usdt.address, abi: erc20Abi, functionName: 'balanceOf', args: [dep as `0x${string}`] });
    row(true, 'current USDT balance at the deposit address', `${Number(bal) / 1e6} USDT`);
  }
} catch (e) {
  row(false, 'chain read', (e as Error).message.slice(0, 120));
}

for (const [s, n, d] of rows) console.log(`${s}  ${n}${d ? '  ->  ' + d : ''}`);
const failed = rows.some(([s]) => s === 'FAIL');
console.log('');
if (failed) console.log('NOT READY: fix the FAIL lines above.');
else {
  console.log('Ready to start. This is the ONLY command that enables real funds:');
  console.log('  PAYRAIL_MARKET_LIVE=1 node --env-file=.env scripts/serve.ts --port 4402 --market-db data/marketplace-live.db');
  console.log('Then: sign in with your wallet, Add funds, send a SMALL USDT amount from that wallet to the deposit address, paste the tx hash.');
}
process.exit(failed ? 1 : 0);
