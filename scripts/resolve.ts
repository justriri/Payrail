// Resolve an UNCERTAIN (or crashed) swap by RE-VERIFYING it from the chain. Sends nothing, signs nothing.
//   node scripts/resolve.ts --swap <planId>
//   node scripts/resolve.ts --payment <receiptId>     (an UNCERTAIN payment; see below)
//
// It promotes a swap to CONFIRMED only if every on-chain check passes (receipts, mined transactions, logged
// transfers, exact-block balances); a reverted transaction resolves to FAILED; missing evidence leaves it
// UNCERTAIN with the reason. This replaces hand-deleting files in receipts/pending/.
import { verifyTx } from '@celo/attribution-tags';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { renderSwapRecord } from '../src/activity.ts';
import { ConfigError, TEXTILE_REACTOR, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { MENTO_PROVIDER, MENTO_ROUTER } from '../src/mento.ts';
import { policyFromEnv } from '../src/policy.ts';
import { createSwapChain } from '../src/swapchain.ts';
import { resolveSwapRecord } from '../src/swapexec.ts';
import { loadSwapRecord } from '../src/swapjournal.ts';

const args = process.argv.slice(2);
// ---- an UNCERTAIN payment: re-verify it from the chain (read-only; writes a separate resolution record)
//   node scripts/resolve.ts --payment <receiptId>
const pi = args.indexOf('--payment');
if (pi >= 0) {
  const receiptId = args[pi + 1];
  if (!receiptId) {
    console.log('[STOP] pass --payment <receiptId> (see scripts/history.ts).');
    process.exit(1);
  }
  const { loadConfig: lc, ConfigError: CE } = await import('../src/config.ts');
  const { createLive: cl } = await import('../src/live.ts');
  const { resolvePayment } = await import('../src/paymentresolve.ts');
  const { policyFromEnv: pfe } = await import('../src/policy.ts');
  let c;
  try {
    c = lc(process.env);
  } catch (e) {
    if (e instanceof CE) {
      for (const p of e.problems) console.log(`[FAIL] ${p}`);
      process.exit(1);
    }
    throw e;
  }
  const lv = cl(c, pfe(process.env));
  const r = await resolvePayment(lv.receiptDir, receiptId, { verify: lv.verify, now: () => new Date() });
  if (r.kind === 'refused') {
    console.log(`[STOP] ${r.code}: ${r.message}`);
    process.exit(2);
  }
  if (r.kind === 'still_uncertain') {
    console.log(`STILL UNCERTAIN: ${r.message}`);
    for (const n of r.evidence.notes) console.log(`  - ${n}`);
    console.log('Nothing was changed. Do NOT pay again.');
    process.exit(3);
  }
  const res = r.kind === 'resolved' ? r.resolution : r.resolution;
  console.log(`${r.kind === 'already_resolved' ? 'ALREADY RESOLVED' : 'RESOLVED'}: ${res.outcome}`);
  console.log(`  ${res.note}`);
  console.log(`  authorization state: ${res.evidence.authorizationState}; transfer verified: ${res.evidence.transferVerified}; tx: ${res.evidence.txHash ?? 'n/a'}`);
  if (r.kind === 'resolved' && r.clearedPending.length > 0) console.log(`  cleared payment journal: ${r.clearedPending.join(', ')}`);
  console.log('The receipt itself was not modified. Re-run `scripts/order.ts --reconcile <orderId>` to update the order.');
  process.exit(0);
}

const i = args.indexOf('--swap');
const planId = i >= 0 ? args[i + 1] : undefined;
if (!planId) {
  console.log('[STOP] pass --swap <planId> (see scripts/history.ts for unresolved items).');
  process.exit(1);
}

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

const live = createLive(cfg, policyFromEnv(process.env));
const before = loadSwapRecord(live.receiptDir, planId);
if (!before) {
  console.log(`[STOP] no swap record for ${planId}.`);
  process.exit(2);
}
console.log(`resolving ${planId} (currently ${before.state}: ${before.code})`);

// A read-only chain: the throwaway in-memory key is never used (prepare() refuses unvalidated steps anyway).
const chain = createSwapChain({ account: privateKeyToAccount(generatePrivateKey()), rpcFallbackUrls: cfg.rpcFallbackUrls, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
const result = await resolveSwapRecord({
  dir: live.receiptDir,
  planId,
  payer: cfg.walletAddress,
  chain,
  verifyAttribution: (hash) => verifyTx({ client: live.client, hash }),
  attributionTag: cfg.attributionTag,
  expectSwapTarget: before.route.provider === MENTO_PROVIDER ? MENTO_ROUTER : TEXTILE_REACTOR,
});

console.log(`\nRESULT: ${result.state}${result.resolved ? ' (resolved; pending journal cleared)' : ' (NOT resolved)'}`);
for (const n of result.notes) console.log(`note: ${n}`);
console.log('\n' + renderSwapRecord(result.record));
console.log('\nNothing was sent or signed.');
process.exit(result.state === 'CONFIRMED' ? 0 : result.resolved ? 2 : 3);
