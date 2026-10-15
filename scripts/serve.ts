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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KeystoreError, decryptKey } from '../src/keystore.ts';
import type { KeystoreFile } from '../src/keystore.ts';
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
import { createDemoNetwork, createSandboxNetwork, seedDemo } from '../src/demoapis.ts';
import { createTestnetEscrow } from '../src/escrowtestnet.ts';
import { createSimFunding } from '../src/simfunding.ts';
import { RouteRegistry, seedConversionAssets } from '../src/conversion.ts';
import { createSimProvider } from '../src/simconversion.ts';
import type { SimProvider } from '../src/simconversion.ts';
import { createBuyerSwapRuntime } from '../src/buyerswap.ts';
import type { BuyerSwapRuntime } from '../src/buyerswap.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';
import { firmQuote } from '../src/textile.ts';
import { erc20Abi } from 'viem';
import { recoverAllFunding } from '../src/multifunding.ts';
import type { ConversionRuntime } from '../src/multifunding.ts';
import { recoverConversionPayouts } from '../src/payoutconv.ts';
import { recoverFunding } from '../src/marketfunding.ts';
import type { FundingConfig as MarketFundingConfig } from '../src/marketfunding.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
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
// buyer-signed conversion: only ever set when BOTH PAYRAIL_MARKET_LIVE=1 and PAYRAIL_BUYER_SWAP=1 (off by default)
let liveBuyerSwap: BuyerSwapRuntime | undefined;
let liveTextile: ReturnType<typeof createTextileRouteProvider> | undefined;
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
  let account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
  const keystorePath = process.env.PAYRAIL_KEYSTORE ?? join(homedir(), '.payrail', 'keystore.json');
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
    // Buyer-signed conversion is a SEPARATE explicit opt-in on top of real-funds mode. The buyer's own wallet signs every
    // transaction; this server holds no buyer key and spends no operator funds on a buyer's behalf.
    if (process.env.PAYRAIL_BUYER_SWAP === '1') {
      liveTextile = createTextileRouteProvider();
      liveBuyerSwap = createBuyerSwapRuntime({
        firmQuote,
        getAllowance: (token, owner, spender) => live.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
        provider: liveTextile,
        chainId: cfg.chainId,
        tag: cfg.attributionTag,
      });
      line('BUYER-SIGNED CONVERSION ENABLED: buyers convert with their own wallets (Textile firm quotes validated server-side).');
    }
    line(`REAL-FUNDS MARKETPLACE ENABLED: deposits to ${depositAddress} are credited after ${liveMarket.funding.minConfirmations} confirmations (cap ${cap / 1_000_000n} USDT each). Payouts need operator approval via scripts/payouts.ts.`);
  }
  const reader = createChainReader(live.client as never, live.getBalance, live.reads);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  runtime = {
    mode: 'live',
    wallet,
    get signing() {
      return account !== undefined;
    },
    signer: {
      canUnlock: () => account === undefined && existsSync(keystorePath),
      async unlock(passphrase) {
        try {
          const file = JSON.parse(readFileSync(keystorePath, 'utf8')) as KeystoreFile;
          if (file.address.toLowerCase() !== wallet.toLowerCase()) return { ok: false, message: 'This keystore belongs to a different wallet than the one configured.' };
          account = privateKeyToAccount(decryptKey(file, passphrase));
          return { ok: true };
        } catch (e) {
          return { ok: false, message: e instanceof KeystoreError && e.code === 'BAD_PASSPHRASE' ? 'Wrong passphrase.' : 'The keystore could not be opened.' };
        }
      },
      lock() {
        account = undefined;
      },
    },
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

// ---- marketplace (TEST CREDITS ONLY unless real-funds mode was explicitly enabled above; independent of the Buy flow)
const dbPath = opt('market-db') ?? (args.includes('--simulate') ? ':memory:' : 'data/marketplace.db');
const marketDb = openDb(dbPath);
let vaultKey;
if (process.env.PAYRAIL_VAULT_KEY) {
  vaultKey = masterKeyFrom(process.env.PAYRAIL_VAULT_KEY_ID ?? 'k1', process.env.PAYRAIL_VAULT_KEY);
} else if (dbPath !== ':memory:' && !liveMarket) {
  // Test-credit mode with a persistent database: keep a local vault key file next to the database (gitignored, owner-only)
  // so stored seller credentials survive restarts. Real-funds mode must supply PAYRAIL_VAULT_KEY explicitly.
  const keyFile = join(dirname(dbPath), 'vault.key');
  let hex: string;
  if (existsSync(keyFile)) {
    hex = readFileSync(keyFile, 'utf8').trim();
  } else {
    hex = generateMasterKey('file1').key.toString('hex');
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${hex}\n`, { mode: 0o600 });
    line(`Marketplace vault key: created ${keyFile} (keep it with the database; it decrypts stored seller credentials).`);
  }
  vaultKey = masterKeyFrom('file1', hex);
} else {
  vaultKey = generateMasterKey('ephemeral');
  line('Marketplace vault key: none set (PAYRAIL_VAULT_KEY), using a temporary one. Seller credentials saved now cannot be read after a restart.');
}
// demo APIs are labelled DEMO everywhere; turn them off with --no-demo
const seeded = !args.includes('--no-demo');
if (seeded) seedDemo(marketDb, vaultKey);
const sandbox = createSandboxNetwork(marketDb);
const demoNet = createDemoNetwork();
const rec = recoverExecutions(marketDb, { staleHeldMs: 5 * 60_000, unresolvedMs: 60 * 60_000 });
if (rec.interrupted || rec.released) line(`Marketplace recovery: ${rec.interrupted} interrupted call(s) marked unresolved, ${rec.released} released to buyers.`);

// Testnet escrow (Celo Sepolia, mock token). Only with --escrow-testnet AND the testnet deployer key loaded.
let escrow: MarketRuntime['escrow'];
if (args.includes('--escrow-testnet')) {
  const k = process.env.TESTNET_DEPLOYER_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    line('[STOP] --escrow-testnet needs TESTNET_DEPLOYER_KEY (load it with --env-file=<testnet-deployer.env>).');
    process.exit(1);
  }
  escrow = createTestnetEscrow({ operatorKey: k as `0x${string}` });
  // the demo seller needs a payee address on the testnet escrow path: use the testnet operator (it can claim)
  marketDb.prepare("UPDATE accounts SET wallet_address = ? WHERE id = 'seller_demo' AND wallet_address IS NULL").run(escrow.testnet!.wallet.toLowerCase());
  line(`Testnet escrow enabled: ${escrow.testnet!.escrow} on Celo Sepolia (mock token, no real value).`);
}
const limiter = () => new RateLimiter(60, 10);
// Marketplace funding: SIMULATED conversion in test-credit mode (credits the test asset, labelled simulated).
// A live Textile converter exists (src/livefunding.ts) but is deliberately NOT wired here: it needs real-funds mode.
const usdtAddress = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const simFunding = createSimFunding({ usdt: usdtAddress, reactor: TEXTILE_REACTOR, autoAdvanceOnRead: true });
const fundingCfg: MarketFundingConfig = {
  converter: simFunding.converter,
  reader: simFunding.reader,
  usdt: usdtAddress,
  reactor: TEXTILE_REACTOR,
  chainId: 42220,
  minConfirmations: 3,
  limits: { minSellAtomic: 100_000_000n, maxSellAtomic: 7_000_000_000n, maxPerDaySellAtomic: 14_000_000_000n, maxOpenOps: 3 },
  creditAsset: 'TESTUSDT',
};
await recoverFunding(marketDb, fundingCfg);

// Stage 1 multi-currency (SIMULATED provider): route discovery, any-enabled-asset funding, payout preferences, payout conversion.
seedConversionAssets(marketDb);
const simProvider = createSimProvider({ reactor: TEXTILE_REACTOR, confirmedDepth: 12, autoAdvanceOnRead: true });
const SIM_CUSTODY = `0x${'0'.repeat(34)}c0570d`;
const SIM_DEPOSIT = `0x${'0'.repeat(34)}dec051`;
const conversion: ConversionRuntime = {
  registry: new RouteRegistry(marketDb, [simProvider]),
  provider: simProvider,
  reader: simProvider.reader,
  reactor: TEXTILE_REACTOR,
  usdt: usdtAddress,
  chainId: 42220,
  minConfirmations: 3,
  creditAsset: 'TESTUSDT',
  depositAddress: SIM_DEPOSIT,
  maxPerDayBuyAtomic: 10_000_000_000n,
  simulated: true,
  payout: undefined,
};
conversion.payout = {
  registry: conversion.registry,
  provider: simProvider,
  reader: simProvider.reader,
  reactor: TEXTILE_REACTOR,
  custody: SIM_CUSTODY,
  minConfirmations: 3,
  policy: { payableAssets: ['TESTUSDT'], minAtomic: 1n, maxAtomic: 1_000_000_000_000n },
};
if (process.env.PAYRAIL_BUYER_SWAP === '1' && !liveBuyerSwap) {
  line('[STOP] PAYRAIL_BUYER_SWAP=1 requires PAYRAIL_MARKET_LIVE=1 (real-funds mode). Buyer-signed conversion is never available in simulation.');
  process.exit(1);
}
let conversionRt: ConversionRuntime = conversion;
if (liveMarket && liveBuyerSwap && liveTextile) {
  // REAL conversion runtime: Textile route discovery (read-only), the real chain reader, buyer-signed transactions.
  // Payout conversion stays off (payouts remain operator-approved USDT only).
  conversionRt = {
    registry: new RouteRegistry(marketDb, [liveTextile]),
    provider: liveTextile as unknown as SimProvider,
    reader: liveMarket.funding.reader,
    reactor: TEXTILE_REACTOR,
    usdt: usdtAddress,
    chainId: liveMarket.funding.chainId,
    minConfirmations: liveMarket.funding.minConfirmations,
    creditAsset: 'USDT',
    depositAddress: liveMarket.funding.depositAddress,
    maxPerDayBuyAtomic: liveMarket.funding.maxDepositAtomic * 5n,
    simulated: false,
    buyerSwap: liveBuyerSwap,
  };
  await recoverAllFunding(marketDb, conversionRt, Date.now);
} else {
  await recoverAllFunding(marketDb, conversion, Date.now, { atStartup: true });
  await recoverConversionPayouts(marketDb, conversion.payout, Date.now, { atStartup: true });
}
const market: MarketRuntime = {
  db: marketDb,
  keys: [vaultKey],
  activeKey: vaultKey,
  sandbox: !liveMarket,
  buySimulated: args.includes('--simulate'),
  execute: {
    call: { limiter: limiter(), fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport, timeoutMs: 8_000 } },
    demoCall: { limiter: limiter(), fetchOptions: { resolver: demoNet.resolver, transport: demoNet.transport, timeoutMs: 3_000 } },
  },
  funding: fundingCfg,
  conversion: conversionRt,
  testCall: { limiter: limiter(), fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport, timeoutMs: 8_000 } },
  domain: { txt: sandbox.txt, fetchOptions: { resolver: sandbox.resolver, transport: sandbox.transport } },
  buyCatalog: () => runtime.catalog(),
  ...(liveMarket ? { live: liveMarket } : {}),
  ...(escrow ? { escrow } : {}),
};
line(`Marketplace: ${liveMarket ? 'REAL FUNDS' : 'test credits only'}${seeded ? ', demo APIs seeded' : ''}${market.sandbox ? ', sandbox sellers enabled' : ''} (page: /market.html).`);

const { server } = createWebServer(runtime, { market });
server.listen(port, '127.0.0.1', () => {
  line(`\nPayrail is running:  http://127.0.0.1:${port}/`);
  line('Open that address in your browser. Press Ctrl+C to stop.');
});
