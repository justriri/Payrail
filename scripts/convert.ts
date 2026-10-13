// Payrail currency conversion (top-up) through Textile FX. PLAN-ONLY BY DEFAULT.
//
//   node scripts/convert.ts --from USDT --to cNGN --amount 1
//       Plans only (needs PAYRAIL_WALLET_ADDRESS, a public address): reads balances, the allowance, a live
//       preview and a MEASURED approve gas. Requests NO firm quote. Signs NOTHING.
//
//   node --env-file=C:\Users\HP\.payrail\rehearsal.env scripts/convert.ts --from USDT --to cNGN --amount 1 --execute --approve
//       1. you type a confirmation of the exact APPROVE transaction(s)   (no quote exists yet)
//       2. the approval is signed, sent and verified
//       3. ONLY THEN a firm quote is requested (a real side effect: it holds market-maker inventory and one of
//          4 concurrent quote slots until the signed order's deadline; cancelling does not release it)
//       4. the quote is validated and the exact tagged swap simulated; you type a second confirmation
//       5. the swap is signed, sent, then verified from receipts, logs and balances
//
// NOT YET EXERCISED AGAINST A LIVE FILL. Do not use --execute without an explicit decision to spend.
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assetBySymbol } from '../src/assets.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { boundedConfirmers, createConversionDeps, createLiveSwapDeps, terminalConfirmers } from '../src/liveswap.ts';
import { MENTO_PROVIDER, createMentoVenue } from '../src/mento.ts';
import { AuthorizationRefused, authorizeConversion, planConversion, renderConversionPlan } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';
import { runAmmSwap, runSwap } from '../src/swapexec.ts';
import { stdin } from 'node:process';

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

line('=== Payrail conversion ===');
line(EXECUTE ? 'MODE: EXECUTE (will confirm an approval, then request a firm quote)' : 'MODE: PLAN ONLY (no firm quote, nothing signed)');

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
const from = opt('from') ?? 'USDT';
const to = opt('to') ?? 'cNGN';
const amountText = opt('amount');
if (!amountText || !/^\d+(\.\d+)?$/.test(amountText)) stop('pass --amount <number> (in units of the sell asset, e.g. 1).', 1);
const sellAsset = assetBySymbol(from);
if (!sellAsset) stop(`unknown asset ${from}.`, 1);
const amountAtomic = parseUnits(amountText!, sellAsset!.decimals);

const policy = policyFromEnv(process.env);
const live = createLive(cfg, policy);
const wallet = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
const payer = wallet?.address ?? cfg.walletAddress;
if (!payer) stop('set PAYRAIL_WALLET_ADDRESS (or load the key file) so a wallet can be planned.', 1);

// --what-if-balance N: PLAN ONLY. Pretend the wallet holds N of the sell asset, to show the plan you would
// get once it is funded. Everything else (preview, allowance, gas price, approve gas) is real and live.
const whatIf = opt('what-if-balance');
if (whatIf !== undefined && EXECUTE) stop('--what-if-balance is plan-only and cannot be combined with --execute.', 1);
const deps = createConversionDeps(live, policy);
if (whatIf !== undefined) {
  if (!/^\d+(\.\d+)?$/.test(whatIf)) stop('--what-if-balance must be a number.', 1);
  const fake = parseUnits(whatIf, sellAsset!.decimals);
  const real = deps.getBalances;
  deps.getBalances = async (owner, assets) => {
    const m = await real(owner, assets);
    m.set(sellAsset!.address.toLowerCase(), fake);
    return m;
  };
  line(`*** WHAT-IF: assuming a balance of ${whatIf} ${from}. The real wallet holds less. This is not executable. ***\n`);
}

const plan = await planConversion(deps, { sell: from, buy: to, sellAmountAtomic: amountAtomic, payer: payer! });
line(renderConversionPlan(plan));

if (!EXECUTE) {
  line('\nPLAN ONLY. Nothing was requested, signed or sent.');
  line('--execute would first ask you to confirm the approval, and only then request a firm quote (see the header).');
  process.exit(plan.status === 'SWAP_REQUIRED' || plan.status === 'APPROVAL_REQUIRED' ? 0 : 2);
}

if (!wallet) stop('--execute needs the key file loaded with --env-file (it signs only after you confirm).');
let auth;
try {
  auth = authorizeConversion(plan, { now: Date.now(), ...(APPROVE ? { approvedBy: 'human:cli --approve' } : {}) });
} catch (e) {
  if (e instanceof AuthorizationRefused) stop(`${e.code}: ${e.message}${e.code === 'APPROVAL_REQUIRED' ? ' (re-run with --approve)' : ''}`);
  throw e;
}
// Confirmation: a person typing the digest, OR bounded automatic confirmation inside limits the person set here.
const AUTO = args.includes('--auto-confirm');
let confirmers: ReturnType<typeof terminalConfirmers>;
if (AUTO) {
  const maxSell = opt('max-sell');
  const minReceive = opt('min-receive');
  if (!maxSell || !minReceive || !/^\d+(\.\d+)?$/.test(maxSell) || !/^\d+(\.\d+)?$/.test(minReceive)) {
    stop('--auto-confirm requires explicit numeric limits: --max-sell <amount of sell asset> --min-receive <amount of buy asset>.', 1);
  }
  const buyAsset = assetBySymbol(to);
  if (!buyAsset) stop(`unknown asset ${to}.`, 1);
  if (parseUnits(maxSell!, sellAsset!.decimals) < amountAtomic) stop('--max-sell is below the amount being converted.', 1);
  confirmers = boundedConfirmers(
    {
      sellSymbol: from,
      sellAsset: sellAsset!.address,
      maxSellAtomic: parseUnits(maxSell!, sellAsset!.decimals),
      minReceiveAtomic: parseUnits(minReceive!, buyAsset!.decimals),
      // the contract this plan approves and swaps through (Textile's reactor or the AMM router), from the plan itself
      spender: plan.allowance!.spender,
      attributionTag: cfg.attributionTag,
      minSecondsRemaining: 10,
    },
    line,
  );
  line(`bounded auto-confirm: at most ${maxSell} ${from} debited, at least ${minReceive} ${to} received; anything else declines.`);
} else {
  if (!stdin.isTTY) stop('an interactive terminal is required to confirm the transactions (or use --auto-confirm with explicit limits).');
  confirmers = terminalConfirmers(line);
}

const swapDeps = createLiveSwapDeps({ cfg, account: wallet!, live, approvalPhase: 'before-quote', dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd, log: line });
// The venue is decided by the authorization, which came from the plan: Textile (firm quote) or an AMM (Mento).
const gates = { confirm: confirmers.confirm, confirmApproval: confirmers.confirmApproval };
const outcome =
  auth.provider === MENTO_PROVIDER ? await runAmmSwap(auth, createMentoVenue(live.client as never), swapDeps, gates) : await runSwap(auth, swapDeps, gates);

if (outcome.kind === 'refused') stop(`refused [${outcome.code}]: ${outcome.message}`);
const r = outcome.record;
line(`\nSTATE: ${outcome.state} (${r.code})`);
line(r.message);
for (const st of r.steps) line(`  ${st.kind}: ${st.status} ${st.hash ?? ''} attribution=${st.attribution?.verified ?? 'n/a'} (${st.attribution?.note ?? ''})`);
line(`balances: ${r.route.sellSymbol} ${r.balances.sellBefore} -> ${r.balances.sellAfter ?? '?'}; ${r.route.buySymbol} ${r.balances.buyBefore} -> ${r.balances.buyAfter ?? '?'}; CELO ${r.balances.nativeBefore} -> ${r.balances.nativeAfter ?? '?'}`);
line(`gas used: ${r.gas.usedUnits} units, cost ${r.gas.costWei ?? 'unknown'} wei`);
line(`textile : ${r.quote.textileStatus ?? 'n/a'} ${r.quote.textileStatusNote ?? ''}`);
if (outcome.state === 'UNCERTAIN') line('Do NOT retry. Inspect the hashes above, then resolve receipts/pending/ by hand.');
process.exit(outcome.state === 'CONFIRMED' ? 0 : outcome.state === 'UNCERTAIN' ? 3 : 2);
