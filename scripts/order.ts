// Payrail order: pay for a service in the currency you hold. PLAN-ONLY BY DEFAULT.
//
//   node scripts/order.ts --service x.posts.search [--body '{"query":"Celo agents","type":"latest"}']
//       Discovers the real price and accepted assets, reads balances, decides direct vs convert, totals the
//       cost and explains the route. Needs PAYRAIL_WALLET_ADDRESS (a public address). Signs NOTHING and
//       requests NO firm quote. Prints the PLAN DIGEST: an approval is valid only for that exact plan.
//
//   node --env-file=C:\Users\HP\.payrail\rehearsal.env scripts/order.ts --service ... --execute [--approve-digest <hex>]
//       Runs the plan: preflight -> [convert] -> wait for funds -> re-price -> pay -> verification -> receipts.
//       When policy requires approval you must name the digest you reviewed (--approve-digest, at least 12
//       hex characters). A conversion also asks you to type the digest of the exact transactions (or, for
//       unattended runs, --auto-confirm --max-sell N --min-receive N). Nothing is spent without --execute.
//
//   ... scripts/order.ts --service ... --source cNGN        (pay with the currency you choose; converts if needed)
//   ... scripts/order.ts --reconcile <orderId>
//       Rebuilds an interrupted order's state from the swap journal, the chain and the payment journals.
//       Sends nothing.
//   ... scripts/order.ts --resume <orderId> --service ... [--approve-digest <hex>]
//       Finishes an order that was converted but not paid. The conversion is NOT repeated.
import { stdin } from 'node:process';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getTokenBalance } from '@celo/buy-core';
import { ConfigError, loadConfig } from '../src/config.ts';
import { executeDirectPayment } from '../src/executor.ts';
import { createLive } from '../src/live.ts';
import { createLiveSwapDeps, terminalConfirmers } from '../src/liveswap.ts';
import { createMentoVenue } from '../src/mento.ts';
import { executeOrder, planOrder, reconcileOrder, renderOrderPlan, renderOrderRecord, resumeOrder } from '../src/orchestrator.ts';
import type { OrderDeps } from '../src/orchestrator.ts';
import { SPENDER_BY_PROVIDER, buildSwapRunners, createChainReader, createConversionVerifier, createFundsAwaiter, makeConfirmersFactory, WiringError } from '../src/orderwiring.ts';
import type { ChainReader } from '../src/orderwiring.ts';
import { planPayment } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';
import { createBuyProvider, createRegistry } from '../src/providers.ts';
import { runAmmSwap, runSwap } from '../src/swapexec.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const EXECUTE = args.includes('--execute');
const AUTO = args.includes('--auto-confirm');
const RESUME = opt('resume');
const RECONCILE = opt('reconcile');
const APPROVE_DIGEST = opt('approve-digest');
const SOURCE = opt('source'); // the currency YOU choose to pay with, e.g. cNGN
const line = (s = '') => console.log(s);
function stop(m: string, code = 2): never {
  line(`\n[STOP] ${m}`);
  process.exit(code);
}

line('=== Payrail order ===');
line(EXECUTE || RESUME ? 'MODE: EXECUTE (may convert currency and pay)' : RECONCILE ? 'MODE: RECONCILE (reads journals and the chain; sends nothing)' : 'MODE: PLAN ONLY (nothing requested, signed or sent)');
if (args.includes('--approve') && !APPROVE_DIGEST) {
  stop('--approve alone is no longer accepted: an approval is bound to the exact plan. Run a plan, review it, then pass --approve-digest <digest from the plan>.', 1);
}

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
if ((EXECUTE || RESUME) && !wallet) stop('executing needs the key file loaded with --env-file.', 1);

// ---- read-only chain reader (conversion verification and the converted-funds wait)
const reader: ChainReader = createChainReader(live.client as never, live.getBalance, live.reads);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Service providers: any number can be registered; the service id decides which one owns the service.
const registry = createRegistry();
registry.registerService(createBuyProvider({ policy }));
const serviceId = opt('service') ?? 'x.posts.search';
const body = opt('body') ?? JSON.stringify({ query: 'Celo agents', type: 'latest' });

// Order records are looked up by id for --reconcile, which needs no service.
const confirmersFor = makeConfirmersFactory({
  auto: AUTO,
  maxSell: opt('max-sell'),
  minReceive: opt('min-receive'),
  attributionTag: cfg.attributionTag,
  isTTY: Boolean(stdin.isTTY),
  line,
  terminal: () => terminalConfirmers(line),
});

const swapDepsFor = () =>
  createLiveSwapDeps({ cfg, account: wallet!, live, approvalPhase: 'before-quote', dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd, log: line });

let serviceDiscover: ((s: Parameters<OrderDeps['plan']>[0]['service'], b: string) => ReturnType<typeof live.planDeps.discover>) | undefined;

const deps: OrderDeps = {
  now: () => Date.now(),
  receiptDir: live.receiptDir,
  plan: (c) =>
    planPayment(
      { ...live.planDeps, ...(serviceDiscover ? { discover: serviceDiscover } : {}) },
      { service: c.service, body: c.body, payer: c.payer, ...(c.sourceSymbol ? { sourceSymbol: c.sourceSymbol } : {}) },
    ),
  swapRunners: buildSwapRunners({
    makeSwapDeps: swapDepsFor,
    makeMentoVenue: () => createMentoVenue(live.client as never),
    runTextile: (auth, d, g) => runSwap(auth, d, g),
    runMento: (auth, venue, d, g) => runAmmSwap(auth, venue, d, g),
    confirmersFor,
  }),
  async pay(auth, link) {
    return executeDirectPayment(auth, {
      account: wallet!,
      body,
      receiptDir: live.receiptDir,
      attributionTag: cfg.attributionTag,
      verify: live.verify,
      getBalance: live.getBalance,
      readBalance: getTokenBalance,
      order: link,
      guard: 'order',
      log: line,
      // re-checked inside the cross-process lock; both are 6-decimal stablecoins so micro-USD == atomic units
      maxPerDayAtomic: policy.maxPerDayMicroUsd,
    });
  },
  maxPerDayAtomic: policy.maxPerDayMicroUsd,
  dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd,
  awaitConvertedFunds: createFundsAwaiter(reader, { sleep }),
  verifyConversionOnChain: createConversionVerifier(reader, payer as Address),
  log: line,
};

if (RECONCILE) {
  const r = await reconcileOrder(RECONCILE, deps);
  if (r.kind === 'refused') stop(`cannot reconcile [${r.code}]: ${r.message}`);
  line('\n' + renderOrderRecord(r.record));
  if (r.kind === 'updated') for (const c of r.changes) line(`  changed: ${c}`);
  else line(`  ${r.message}`);
  process.exit(0);
}

let found;
try {
  const r = await registry.findService(serviceId);
  for (const e of r.errors) line(`[WARN] service provider ${e.provider} unavailable: ${e.message}`);
  found = r.found;
} catch (e) {
  stop(e instanceof Error ? e.message : String(e), 1);
}
if (!found) stop(`service "${serviceId}" was not found in any registered provider (or the catalog is unavailable).`, 4);
const { provider: serviceProvider, service } = found!;
serviceDiscover = (s, b) => serviceProvider.discover(s, b);
const ctx = { service, serviceProvider: serviceProvider.id, body, payer: payer!, ...(SOURCE ? { sourceSymbol: SOURCE } : {}) };
const approval = APPROVE_DIGEST ? { approvedBy: 'human:cli --approve-digest', approvedDigest: APPROVE_DIGEST } : {};

try {
  if (RESUME) {
    line(`\nresuming order ${RESUME}: reconciled first; the conversion is not repeated; the service is re-priced.`);
    const r = await resumeOrder(RESUME, ctx, deps, APPROVE_DIGEST ? { approvedBy: 'human:cli --approve-digest' } : {});
    if (r.kind === 'refused') stop(`refused [${r.code}]: ${r.message}`);
    line('\n' + renderOrderRecord(r.record));
    process.exit(r.state === 'COMPLETED' ? 0 : r.state === 'UNCERTAIN' ? 3 : 2);
  }

  line('\n--- plan (reads the real price from an unpaid 402; signs nothing) ---');
  const order = await planOrder(deps, ctx);
  line(renderOrderPlan(order));

  if (!EXECUTE) {
    line('\nPLAN ONLY. Nothing was requested, signed, converted or paid. Re-run with --execute to run this plan.');
    if (order.approval.required) line(`If you accept this plan: --execute --approve-digest ${order.digest.slice(0, 16)}`);
    process.exit(order.executable ? 0 : 2);
  }
  if (!order.executable) stop(`the order is ${order.status}; not executable. Nothing was spent.`);

  // Validate the confirmation gate BEFORE anything starts (a wiring problem must not surface mid-order).
  const f = order.payment.funding;
  if (order.route === 'swap' && f?.kind === 'swap') {
    const spender = SPENDER_BY_PROVIDER[f.provider];
    if (!spender) stop(`no known spender for conversion provider ${f.provider}.`, 1);
    confirmersFor(spender!, f.sellSymbol, f.receiveSymbol);
  }

  const result = await executeOrder(order, ctx, deps, approval);
  if (result.kind === 'refused') stop(`refused [${result.code}]: ${result.message}`);
  line('\n' + renderOrderRecord(result.record));
  if (result.state === 'UNCERTAIN') line(`\nDo NOT retry. Rebuild the order's state with:  node ... scripts/order.ts --reconcile ${result.record.orderId}`);
  if (result.state === 'STOPPED' && result.record.needsAttention) {
    line(`\nThe conversion is done but the service was not paid. Finish it with:  node ... scripts/order.ts --resume ${result.record.orderId} --service ${serviceId}`);
  }
  process.exit(result.state === 'COMPLETED' ? 0 : result.state === 'UNCERTAIN' ? 3 : 2);
} catch (e) {
  if (e instanceof WiringError) stop(e.message, 1);
  throw e;
}
