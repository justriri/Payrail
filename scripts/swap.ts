// Payrail swap CLI: pay a SERVICE by converting a held currency first (Textile FX). PLAN-ONLY BY DEFAULT.
// For a standalone top-up (e.g. USDT -> cNGN) use scripts/convert.ts.
//
//   node scripts/swap.ts --service x.posts.search
//       Plans only: reads the real price, balances and a preview. Requests NO firm quote, signs NOTHING.
//
//   node --env-file=... scripts/swap.ts --service <id> --execute --approve
//       Confirms the approval first (before any quote), then requests a firm quote (a real side effect), then
//       asks you to type a second confirmation of the exact swap. Not yet exercised against a live fill.
import { stdin } from 'node:process';
import { privateKeyToAccount } from 'viem/accounts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { createLiveSwapDeps, terminalConfirmers } from '../src/liveswap.ts';
import { AuthorizationRefused, authorizeSwap, planPayment, renderPlan } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';
import { runSwap } from '../src/swapexec.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const EXECUTE = args.includes('--execute');
const APPROVE = args.includes('--approve');
const line = (s = '') => console.log(s);
function stop(m: string, code = 2): never {
  line(`\n[STOP] ${m}`);
  process.exit(code);
}

line('=== Payrail swap (to pay a service) ===');
line(EXECUTE ? 'MODE: EXECUTE' : 'MODE: PLAN ONLY (no firm quote, nothing signed)');

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) line(`[FAIL] ${p}`);
    stop('configuration invalid; nothing was contacted.', 1);
  }
  throw e;
}
const policy = policyFromEnv(process.env);
const live = createLive(cfg, policy);
const wallet = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
const payer = wallet?.address ?? cfg.walletAddress;
if (!payer) stop('set PAYRAIL_WALLET_ADDRESS (or load the key file) so a wallet can be planned.', 1);

let catalog;
try {
  catalog = await live.catalog.get();
} catch (e) {
  stop(`the service catalog is unavailable (${e instanceof Error ? e.message : String(e)}). Nothing was planned.`, 4);
}
const service = catalog.services.find((s) => s.id === (opt('service') ?? 'x.posts.search'));
if (!service) stop('service not in the catalog.');
const body = opt('body') ?? JSON.stringify({ query: 'Celo agents', type: 'latest' });

const plan = await planPayment({ ...live.planDeps, swapExecution: true }, { service: service!, body, payer: payer! });
line(renderPlan(plan));
if (plan.route !== 'swap') stop(`plan route is ${plan.route ?? 'none'} (${plan.status}); there is nothing to swap.`, plan.route === 'direct' ? 0 : 2);
if (!EXECUTE) {
  line('\nPLAN ONLY. Nothing was requested, signed or sent.');
  process.exit(0);
}

if (!wallet) stop('--execute needs the key file loaded with --env-file (it signs only after you confirm).');
let auth;
try {
  auth = authorizeSwap(plan, { now: Date.now(), ...(APPROVE ? { approvedBy: 'human:cli --approve' } : {}) });
} catch (e) {
  if (e instanceof AuthorizationRefused) stop(`${e.code}: ${e.message}${e.code === 'APPROVAL_REQUIRED' ? ' (re-run with --approve)' : ''}`);
  throw e;
}
if (!stdin.isTTY) stop('an interactive terminal is required to confirm the transactions.');

const confirmers = terminalConfirmers(line);
const outcome = await runSwap(auth, createLiveSwapDeps({ cfg, account: wallet!, live, approvalPhase: 'before-quote', dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd, log: line }), {
  confirm: confirmers.confirm,
  confirmApproval: confirmers.confirmApproval,
});
if (outcome.kind === 'refused') stop(`refused [${outcome.code}]: ${outcome.message}`);
line(`\nSTATE: ${outcome.state} (${outcome.record.code})`);
line(outcome.record.message);
for (const st of outcome.record.steps) line(`  ${st.kind}: ${st.status} ${st.hash ?? ''} attribution=${st.attribution?.verified ?? 'n/a'}`);
if (outcome.state === 'UNCERTAIN') line('Do NOT retry. Inspect the transaction hashes above, then resolve receipts/pending/ by hand.');
process.exit(outcome.state === 'CONFIRMED' ? 0 : outcome.state === 'UNCERTAIN' ? 3 : 2);
