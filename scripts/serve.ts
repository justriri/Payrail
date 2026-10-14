// Payrail web interface (local). Starts a server on 127.0.0.1 and prints its address.
//
//   node --env-file=.env scripts/serve.ts
//       LIVE, READ-ONLY: inspect services, balances and quotes. Payments are disabled (no key loaded).
//
//   node --env-file=C:\Users\<you>\.payrail\rehearsal.env scripts/serve.ts
//       LIVE, CAN PAY: the key file is loaded by Node (never by the browser). Every payment still needs your
//       explicit approval in the page, and stays inside your spending limits.
//
//   node scripts/serve.ts --simulate [--scenario ok|swap_fails|payment_uncertain|price_rises]
//       SIMULATION: fake balances, fake conversion, fake payment. No network, no money. Clearly labelled.
//
// Options: --port <n> (default 4402).
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { getTokenBalance } from '@celo/buy-core';
import { ASSETS } from '../src/assets.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { executeDirectPayment } from '../src/executor.ts';
import { createLive } from '../src/live.ts';
import { boundedConfirmers, createLiveSwapDeps } from '../src/liveswap.ts';
import { createMentoVenue } from '../src/mento.ts';
import { buildSwapRunners, createChainReader, createConversionVerifier, createFundsAwaiter } from '../src/orderwiring.ts';
import type { OrderDeps } from '../src/orchestrator.ts';
import { planPayment } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';
import { runAmmSwap, runSwap } from '../src/swapexec.ts';
import { createDemoNetwork, seedDemo } from '../src/demoapis.ts';
import { recoverExecutions } from '../src/execute.ts';
import { openDb } from '../src/db.ts';
import { createViemReader } from '../src/funding.ts';
import { rpcUrlList } from '../src/chainread.ts';
import { RateLimiter } from '../src/egress.ts';
import { generateMasterKey, masterKeyFrom } from '../src/vault.ts';
import type { MarketRuntime } from '../src/market.ts';
import { createWebServer } from '../src/webapi.ts';
import type { WebRuntime } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/websim.ts';
import type { SimScenario } from '../src/websim.ts';

void createServer;
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('port') ?? 4402);
const line = (s = '') => console.log(s);

let runtime: WebRuntime;
let liveMarket: MarketRuntime['live'];
if (args.includes('--simulate')) {
  const scenario = (opt('scenario') ?? 'ok') as SimScenario;
  if (!['ok', 'swap_fails', 'payment_uncertain', 'price_rises'].includes(scenario)) {
    line(`[STOP] unknown scenario ${scenario}`);
    process.exit(1);
  }
  runtime = createSimulatedRuntime({ scenario });
  line(`SIMULATION MODE (scenario: ${scenario}). No real money or blockchain is used.`);
} else {
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
    line('[STOP] set PAYRAIL_WALLET_ADDRESS (public address) or load your key file with --env-file.');
    process.exit(1);
  }
  const wallet = cfg.walletAddress;
  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
  const policy = policyFromEnv(process.env);
  const live = createLive(cfg, policy);
  // Real-funds marketplace is OFF unless explicitly enabled. Deposits are only ever credited after on-chain verification;
  // payouts are never sent by this server (operator CLI only).
  if (process.env.PAYRAIL_MARKET_LIVE === '1') {
    const depositAddress = process.env.PAYRAIL_DEPOSIT_ADDRESS;
    const usdt = ASSETS.find((a) => a.symbol === 'USDT')!;
    if (!depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) {
      line('[STOP] PAYRAIL_MARKET_LIVE=1 needs PAYRAIL_DEPOSIT_ADDRESS (a 0x address you control).');
      process.exit(1);
    }
    const cap = BigInt(Math.round(Number(process.env.PAYRAIL_MAX_DEPOSIT_USD ?? '5') * 1_000_000));
    liveMarket = {
      funding: {
        chainId: cfg.chainId,
        token: usdt.address,
        asset: 'USDT',
        depositAddress,
        minConfirmations: Number(process.env.PAYRAIL_DEPOSIT_CONFIRMATIONS ?? '20'),
        maxDepositAtomic: cap,
        reader: createViemReader(rpcUrlList(cfg.rpcUrl, cfg.rpcFallbackUrls)),
      },
      payout: { payableAssets: ['USDT'], minAtomic: 1_000_000n, maxAtomic: cap },
    };
    line(`REAL-FUNDS MARKETPLACE ENABLED: deposits to ${depositAddress} are credited after ${liveMarket.funding.minConfirmations} confirmations (cap ${cap / 1_000_000n} USDT each). Payouts need operator approval via scripts/payouts.ts.`);
  }
  const reader = createChainReader(live.client as never, live.getBalance, live.reads);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  runtime = {
    mode: 'live',
    wallet,
    signing: account !== undefined,
    attributionTag: cfg.attributionTag,
    chainId: cfg.chainId,
    policy,
    receiptDir: live.receiptDir,
    catalog: () => live.catalog.get(),
    async balances() {
      const shown = ASSETS.filter((a) => ['cNGN', 'USDT', 'USDC', 'USAT', 'wARS', 'wBRL', 'IDRX'].includes(a.symbol));
      const m = await live.planDeps.getBalances(wallet, shown);
      return {
        nativeWei: await live.client.getBalance({ address: wallet }),
        tokens: shown.map((a) => ({ asset: a, atomic: m.get(a.address.toLowerCase()) ?? 0n })),
      };
    },
    orderDeps({ bounds, log, body }): OrderDeps {
      const out = log ?? (() => undefined);
      const confirmersFor = (spender: `0x${string}`, sellSymbol: string) => {
        if (!bounds) throw new Error('no approved limits for this conversion: refusing');
        const sell = ASSETS.find((a) => a.symbol === sellSymbol)!;
        // The ONLY thing that can approve the swap is "the human clicked Approve in the page" -> these exact bounds.
        return boundedConfirmers(
          {
            sellSymbol,
            sellAsset: sell.address,
            maxSellAtomic: bounds.maxSellAtomic,
            minReceiveAtomic: bounds.minReceiveAtomic,
            spender,
            attributionTag: cfg.attributionTag,
            minSecondsRemaining: 10,
          },
          out,
        );
      };
      return {
        now: () => Date.now(),
        receiptDir: live.receiptDir,
        plan: (c) =>
          planPayment(live.planDeps, { service: c.service, body: c.body, payer: c.payer, ...(c.sourceSymbol ? { sourceSymbol: c.sourceSymbol } : {}) }),
        swapRunners: buildSwapRunners({
          makeSwapDeps: () => {
            if (!account) throw new Error('no wallet key loaded');
            return createLiveSwapDeps({ cfg, account, live, approvalPhase: 'before-quote', dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd, log: out });
          },
          makeMentoVenue: () => createMentoVenue(live.client as never),
          runTextile: (auth, d, g) => runSwap(auth, d, g),
          runMento: (auth, venue, d, g) => runAmmSwap(auth, venue, d, g),
          confirmersFor,
        }),
        async pay(auth, link) {
          if (!account) throw new Error('no wallet key loaded');
          return executeDirectPayment(auth, {
            account,
            body: body ?? '',
            receiptDir: live.receiptDir,
            attributionTag: cfg.attributionTag,
            verify: live.verify,
            getBalance: live.getBalance,
            readBalance: getTokenBalance,
            order: link,
            guard: 'order',
            log: out,
            maxPerDayAtomic: policy.maxPerDayMicroUsd,
          });
        },
        maxPerDayAtomic: policy.maxPerDayMicroUsd,
        dailySwapCapMicroUsd: policy.maxSwapPerDayMicroUsd,
        awaitConvertedFunds: createFundsAwaiter(reader, { sleep }),
        verifyConversionOnChain: createConversionVerifier(reader, wallet),
        log: out,
      };
    },
    now: () => Date.now(),
    explorerTx: (h) => `https://celoscan.io/tx/${h}`,
  };
  line(account ? 'LIVE MODE: payments enabled (key loaded from the file you supplied; it is never shown).' : 'LIVE MODE (read-only): no key loaded, payments disabled.');
}

// ---- marketplace (TEST CREDITS ONLY; independent of the Buy payment flow above)
const dbPath = opt('market-db') ?? (args.includes('--simulate') ? ':memory:' : 'data/marketplace.db');
const marketDb = openDb(dbPath);
let vaultKey;
if (process.env.PAYRAIL_VAULT_KEY) {
  vaultKey = masterKeyFrom(process.env.PAYRAIL_VAULT_KEY_ID ?? 'k1', process.env.PAYRAIL_VAULT_KEY);
} else {
  vaultKey = generateMasterKey('ephemeral');
  line('Marketplace vault key: none set (PAYRAIL_VAULT_KEY), using a temporary one. Seller credentials saved now cannot be read after a restart.');
}
const seeded = args.includes('--demo') || args.includes('--simulate');
if (seeded) seedDemo(marketDb, vaultKey);
const demoNet = createDemoNetwork();
const rec = recoverExecutions(marketDb, { staleHeldMs: 5 * 60_000, unresolvedMs: 60 * 60_000 });
if (rec.interrupted || rec.released) line(`Marketplace recovery: ${rec.interrupted} interrupted call(s) marked unresolved, ${rec.released} released to buyers.`);
const market: MarketRuntime = {
  db: marketDb,
  keys: [vaultKey],
  activeKey: vaultKey,
  execute: { demoCall: { limiter: new RateLimiter(60, 10), fetchOptions: { resolver: demoNet.resolver, transport: demoNet.transport, timeoutMs: 3_000 } } },
  buyCatalog: () => runtime.catalog(),
  ...(liveMarket ? { live: liveMarket } : {}),
};
line(`Marketplace: test credits only${seeded ? ', demo APIs seeded' : ''} (page: /market.html).`);

const { server } = createWebServer(runtime, { market });
server.listen(port, '127.0.0.1', () => {
  line(`\nPayrail is running:  http://127.0.0.1:${port}/`);
  line('Open that address in your browser. Press Ctrl+C to stop.');
});
