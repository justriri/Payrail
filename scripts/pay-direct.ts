// Payrail direct pay: plan -> (human) authorization -> executor. No code path pays without a plan.
//
//   node --env-file=C:\Users\HP\.payrail\rehearsal.env scripts/pay-direct.ts                 # DRY RUN (default): signs nothing
//   node --env-file=C:\Users\HP\.payrail\rehearsal.env scripts/pay-direct.ts --pay           # ONE real payment (auto-pay services)
//   ... --service some.id --approve --pay                                                    # a service NOT on the auto-pay list
//   ... --again                                                                              # allow a 2nd payment after a prior receipt
//
// Safety: dry run by default; every limit comes from policy.ts; one attempt, never an automatic retry of a
// paid request; an unresolved/pending payment blocks everything (even --again).
import { privateKeyToAccount } from 'viem/accounts';
import { BuyError, getTokenBalance } from '@celo/buy-core';
import { ConfigError, loadConfig } from '../src/config.ts';
import { executeDirectPayment } from '../src/executor.ts';
import { assertNoPriorPayment, DuplicateGuardError } from '../src/history.ts';
import { createLive } from '../src/live.ts';
import { AuthorizationRefused, authorizeExecution, planPayment, renderPlan } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PAY = args.includes('--pay');
const APPROVE = args.includes('--approve');
const AGAIN = args.includes('--again');

const line = (s = '') => console.log(s);
function stop(msg: string, code = 2): never {
  line(`\n[STOP] ${msg}`);
  process.exit(code);
}

line('=== Payrail direct pay ===');
line(PAY ? 'MODE: PAY (one real payment will be attempted)' : 'MODE: DRY RUN (nothing will be signed or sent)');

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
if (!cfg.privateKey) stop('no PAYRAIL_PRIVATE_KEY configured (load it with --env-file); nothing was contacted.', 1);
const account = privateKeyToAccount(cfg.privateKey);
const policy = policyFromEnv(process.env);
const live = createLive(cfg, policy);
line(`[PASS] configuration valid (tag ${cfg.attributionTag}, chain ${cfg.chainId})`);
line(`wallet: ${account.address}`);

// Fail fast, before any network call, if a payment is pending or a receipt exists.
if (PAY) {
  try {
    assertNoPriorPayment(live.receiptDir, { again: AGAIN });
  } catch (e) {
    if (e instanceof DuplicateGuardError) stop(e.message);
    throw e;
  }
}

let catalog;
try {
  catalog = await live.catalog.get();
} catch (e) {
  stop(`the service catalog is unavailable (${e instanceof Error ? e.message : String(e)}). Nothing was planned or paid.`, 4);
}
const serviceId = opt('service') ?? 'x.posts.search';
const service = catalog.services.find((s) => s.id === serviceId);
if (!service) stop(`service "${serviceId}" is not in the catalog.`);
const body = opt('body') ?? JSON.stringify({ query: 'Celo agents', type: 'latest' });

line('\n--- plan (reads the real price from an unpaid 402; signs nothing) ---');
const plan = await planPayment(live.planDeps, { service, body, payer: account.address });
line(renderPlan(plan));

if (!plan.executable) stop(`plan is ${plan.status}; not executable. Nothing was paid.`);
if (!PAY) {
  line('\nDRY RUN complete. Nothing was signed, sent or spent. Re-run with --pay to make the payment.');
  process.exit(0);
}

let auth;
try {
  auth = authorizeExecution(plan, { now: Date.now(), body, ...(APPROVE ? { approvedBy: 'human:cli --approve' } : {}) });
} catch (e) {
  if (e instanceof AuthorizationRefused) stop(`${e.code}: ${e.message}${e.code === 'APPROVAL_REQUIRED' ? ' (re-run with --approve if you accept it)' : ''}`);
  throw e;
}

line('\n--- paying (single attempt, no automatic retry of the paid request) ---');
const result = await executeDirectPayment(auth, {
  account,
  body,
  receiptDir: live.receiptDir,
  attributionTag: cfg.attributionTag,
  verify: live.verify,
  getBalance: live.getBalance,
  readBalance: getTokenBalance,
  again: AGAIN,
  // the rehearsal CLI keeps the strict one-payment rule unless --again; the order flow uses the order-aware guard
  guard: AGAIN ? 'order' : 'global',
  log: line,
  // re-checked inside the cross-process lock; both are 6-decimal stablecoins so micro-USD == atomic units
  maxPerDayAtomic: policy.maxPerDayMicroUsd,
});

if (result.kind === 'not_sent') stop(`payment was NOT sent [${result.code}]: ${result.message}`);
if (result.kind === 'in_doubt') {
  line(`\n[IN DOUBT] ${result.message}`);
  if (result.receiptFile) line(`receipt: ${result.receiptFile}`);
  line('Do NOT pay again. A pending journal now blocks further payments until you resolve it.');
  process.exit(3);
}

const r = result.receipt;
line(`\nHTTP ${result.httpStatus}; client outcome: ${r.outcome.clientOutcome}`);
line(`on-chain authorization state: ${r.payment.settlement.authorizationState}; transfer verified: ${r.payment.settlement.transferVerified}`);
line(`tx: ${r.payment.txHash ?? 'n/a'}`);
line(`balance: ${r.balances.before} -> ${r.balances.after} (atomic)`);
line(`service response: ${r.outcome.responseSummary}`);
line(`receipt: ${result.receiptFile}`);
line('\n=== RESULT ===');
line(`${r.status}: ${r.statusReason}`);
if (r.status === 'CONFIRMED') {
  line('This does not validate the swap path, attribution, or Build with Buy eligibility.');
  process.exit(0);
}
line('Do NOT pay again until the receipt and the chain have been inspected.');
process.exit(r.retryAllowed ? 0 : 3);
void BuyError;
