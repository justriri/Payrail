// Read-only: plan how a service would be paid for. Executes NOTHING.
// Reads the catalog, makes an UNPAID request for the real price, reads balances, and (if a swap is
// needed) asks Textile for an indicative preview. Signs nothing, sends nothing.
//
//   node scripts/plan.ts --service x.posts.search [--query "text" | --body '{"json":1}' | --body-file path]
//
// Wallet: PAYRAIL_WALLET_ADDRESS (public address). No private key is needed or read.
import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { planPayment, renderPlan } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

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
  console.log('[STOP] set PAYRAIL_WALLET_ADDRESS (a public address) to plan against a wallet.');
  process.exit(1);
}
const serviceId = opt('service');
if (!serviceId) {
  console.log('[STOP] pass --service <id> (see scripts/services.ts for ids).');
  process.exit(1);
}

const policy = policyFromEnv(process.env);
const live = createLive(cfg, policy);
let catalog;
try {
  catalog = await live.catalog.get();
} catch (e) {
  console.log(`[STOP] the service catalog is unavailable (${e instanceof Error ? e.message : String(e)}). Nothing was planned.`);
  process.exit(4);
}
const service = catalog.services.find((s) => s.id === serviceId);
if (!service) {
  console.log(`[STOP] service "${serviceId}" is not in the catalog.`);
  process.exit(2);
}

let body: string;
if (opt('body-file')) body = readFileSync(opt('body-file')!, 'utf8');
else if (opt('body')) body = opt('body')!;
else body = JSON.stringify({ query: opt('query') ?? 'Celo agents', type: 'latest' });

console.log(`wallet : ${cfg.walletAddress}`);
console.log(`service: ${service.id} (${service.title})`);
console.log(`policy : per-payment ${policy.maxPerPaymentMicroUsd} / day ${policy.maxPerDayMicroUsd} / swap ${policy.maxSwapNotionalMicroUsd} micro-USD`);
console.log('');

const plan = await planPayment(live.planDeps, { service, body, payer: cfg.walletAddress });
console.log(renderPlan(plan));
console.log('\nNothing was signed, sent or paid. This is a plan for review only.');
process.exit(plan.status === 'DIRECT_PAY' || plan.status === 'APPROVAL_REQUIRED' || plan.status === 'SWAP_REQUIRED' ? 0 : 2);
