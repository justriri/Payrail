// READ-ONLY check of the live funding adapter's QUOTE path. It plans a cNGN -> USDT conversion exactly as marketplace
// funding would (live Textile preview, allowance, gas), prints what the buyer would be shown, and stops.
// It never requests a firm quote, never signs, never sends a transaction, and never calls execute().
//
//   node --env-file=.env scripts/funding-quote-live.ts --amount 1364
import { parseUnits } from 'viem';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLive } from '../src/live.ts';
import { createConversionDeps } from '../src/liveswap.ts';
import { createLiveFundingConverter } from '../src/livefunding.ts';
import { policyFromEnv } from '../src/policy.ts';

const line = (s = '') => console.log(s);
const i = process.argv.indexOf('--amount');
const amount = i >= 0 ? process.argv[i + 1]! : '1364';
if (!/^\d+(\.\d+)?$/.test(amount)) {
  line('[STOP] --amount must be a number of cNGN.');
  process.exit(1);
}
let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) line(`[FAIL] ${p}`);
    process.exit(1);
  }
  throw e;
}
if (!cfg.walletAddress) {
  line('[STOP] set PAYRAIL_WALLET_ADDRESS.');
  process.exit(1);
}
const policy = policyFromEnv(process.env);
const live = createLive(cfg, policy);
const converter = createLiveFundingConverter({
  wallet: cfg.walletAddress,
  planDeps: createConversionDeps(live, policy),
  makeSwapDeps() {
    throw new Error('this script never signs');
  },
  attributionTag: cfg.attributionTag,
});
line('PLAN ONLY: no firm quote, nothing signed, nothing sent.');
try {
  const q = await converter.quote({ sellAtomic: parseUnits(amount, 6) });
  line(`provider      ${q.provider}`);
  line(`rate          ${q.rate}`);
  line(`fee           ${q.feeAtomic} atomic cNGN (inside the amount)`);
  line(`expected USDT ${q.expectedBuyAtomic} atomic`);
  line(`minimum USDT  ${q.minBuyAtomic} atomic`);
  line(`valid until   ${new Date(q.expiresAtMs).toISOString()}`);
  for (const n of q.notes) line(`note          ${n}`);
} catch (e) {
  line(`quote not available: ${(e as Error).message}`);
}
process.exit(0);
