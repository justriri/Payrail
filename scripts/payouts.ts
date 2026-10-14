// Operator tool for seller payouts. Payouts are NEVER sent by the web server; only this script can, and only with
// explicit flags. Reading and approving move no money.
//
//   node scripts/payouts.ts --db data/marketplace.db --list
//   node scripts/payouts.ts --db data/marketplace.db --approve <payoutId>
//   node scripts/payouts.ts --db data/marketplace.db --cancel  <payoutId>
//   node scripts/payouts.ts --db data/marketplace.db --verify  <payoutId>        (read-only chain check)
//   node --env-file=<key file> scripts/payouts.ts --db data/marketplace.db --send <payoutId> --confirm-real-funds <payoutId>
//
// --send signs and broadcasts ONE USDT transfer from the platform wallet to the seller's verified wallet. It refuses unless
// the payout is approved, the confirm flag repeats the payout id, and the signing wallet equals PAYRAIL_PAYOUT_SOURCE.
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { ASSETS } from '../src/assets.ts';
import { readTransport, rpcUrlList } from '../src/chainread.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createViemReader } from '../src/funding.ts';
import { approvePayout, cancelPayout, getPayout, markSent, pendingPayouts, verifyPayout } from '../src/payouts.ts';
import { verifyLedger } from '../src/ledger.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const line = (s = '') => console.log(s);
const dbPath = opt('db') ?? 'data/marketplace.db';
const db = openDb(dbPath);
const usdt = ASSETS.find((a) => a.symbol === 'USDT')!;
const show = (p: NonNullable<ReturnType<typeof getPayout>>) =>
  `${p.id}  ${p.state.padEnd(9)} ${formatUnits(p.amountAtomic, usdt.decimals)} ${p.asset}  -> ${p.destination}${p.txHash ? `  tx ${p.txHash}` : ''}`;
// configuration is only needed for the chain-facing commands (--verify, --send)
const config = () => {
  try {
    return loadConfig(process.env);
  } catch (e) {
    line(`[STOP] ${(e as Error).message}`);
    for (const pr of (e as { problems?: string[] }).problems ?? []) line(`  - ${pr}`);
    line('Run with --env-file=.env (or your key file) so the configuration is present.');
    process.exit(1);
  }
};
const operator = process.env.USERNAME ?? 'operator';

if (args.includes('--list') || args.length === 0) {
  const rows = pendingPayouts(db, ['requested', 'approved', 'sent']);
  line(rows.length ? 'Open payouts:' : 'No open payouts.');
  for (const p of rows) line('  ' + show(p));
  const v = verifyLedger(db);
  line(v.ok ? 'Ledger check: sound.' : `Ledger check FAILED:\n  ${v.problems.join('\n  ')}`);
  process.exit(v.ok ? 0 : 1);
}

const approve = opt('approve');
if (approve) {
  const p = approvePayout(db, approve, operator);
  line('Approved (no funds moved): ' + show(p));
  process.exit(0);
}
const cancel = opt('cancel');
if (cancel) {
  const p = cancelPayout(db, cancel, operator);
  line('Cancelled; earnings restored: ' + show(p));
  process.exit(0);
}
const verify = opt('verify');
if (verify) {
  const cfg = config();
  const urls = rpcUrlList(cfg.rpcUrl, cfg.rpcFallbackUrls);
  const source = process.env.PAYRAIL_PAYOUT_SOURCE ?? cfg.walletAddress;
  if (!source) {
    line('[STOP] set PAYRAIL_PAYOUT_SOURCE (the wallet payouts are sent from).');
    process.exit(1);
  }
  const r = await verifyPayout(db, { reader: createViemReader(urls), token: usdt.address, sourceAddress: source, minConfirmations: 10 }, verify);
  line(`Observed on-chain: ${r.observed}`);
  line(show(r.payout));
  process.exit(0);
}

const send = opt('send');
if (send) {
  const p = getPayout(db, send);
  if (!p) {
    line('[STOP] no such payout.');
    process.exit(1);
  }
  if (p.state !== 'approved') {
    line(`[STOP] payout is ${p.state}; only an approved payout can be sent.`);
    process.exit(1);
  }
  if (opt('confirm-real-funds') !== send) {
    line('[STOP] this moves REAL funds. Review:');
    line('  ' + show(p));
    line(`Re-run with:  --send ${send} --confirm-real-funds ${send}`);
    process.exit(1);
  }
  const cfg = config();
  const urls = rpcUrlList(cfg.rpcUrl, cfg.rpcFallbackUrls);
  if (!cfg.privateKey) {
    line('[STOP] no key loaded. Start with --env-file=<your key file>.');
    process.exit(1);
  }
  const account = privateKeyToAccount(cfg.privateKey);
  const expected = process.env.PAYRAIL_PAYOUT_SOURCE?.toLowerCase();
  if (!expected || account.address.toLowerCase() !== expected) {
    line('[STOP] the loaded key is not PAYRAIL_PAYOUT_SOURCE. Refusing.');
    process.exit(1);
  }
  const pub = createPublicClient({ chain: celo, transport: readTransport(urls) });
  const wallet = createWalletClient({ account, chain: celo, transport: readTransport(urls) });
  const data = encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']), functionName: 'transfer', args: [p.destination as `0x${string}`, p.amountAtomic] });
  const req = await wallet.prepareTransactionRequest({ account, chain: celo, to: usdt.address, data });
  const signed = await wallet.signTransaction(req as never);
  const hash = keccak256(signed);
  markSent(db, send, hash, operator); // recorded BEFORE broadcast so a crash can never lose track of it
  line(`Signed. Hash ${hash} recorded. Broadcasting...`);
  await pub.sendRawTransaction({ serializedTransaction: signed });
  line('Broadcast. Confirm with:  --verify ' + send);
  process.exit(0);
}
line('Nothing to do. See the usage at the top of this file.');
