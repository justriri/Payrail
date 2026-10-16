// Payrail web interface (local). Starts a server on 127.0.0.1 and prints its address.
//
// PAYRAIL HAS NO DEMO, TEST-CREDIT OR SIMULATION MODE. Everything this server does is real:
//
//   node --env-file=.env scripts/serve.ts
//       The Buy payment page (read-only until you unlock a keystore). The API MARKETPLACE is OFF.
//
//   PAYRAIL_MARKET_LIVE=1 node --env-file=.env scripts/serve.ts --port 4402 --market-db data/marketplace-live.db
//       The API marketplace in REAL-FUNDS mode: USDT on Celo mainnet. Needs PAYRAIL_DEPOSIT_ADDRESS (an address YOU control)
//       and PAYRAIL_VAULT_KEY. Deposits are credited only after the transfer is verified on-chain. Seller payouts and
//       currency conversion stay disabled unless explicitly enabled and verified (see docs/LIVE-TEST-RUNBOOK.md).
//
// Options: --port <n> (default 4402), --market-db <path> (default data/marketplace-live.db).
// Simulation, test credits, sandbox sellers and the testnet escrow exist only inside the automated test suite.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getTokenBalance } from '@celo/buy-core';
import { ASSETS } from '../src/assets.ts';
import { buildSwapRunners, createChainReader, createConversionVerifier, createFundsAwaiter } from '../src/orderwiring.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { executeDirectPayment } from '../src/executor.ts';
import { KeystoreError, decryptKey } from '../src/keystore.ts';
import type { KeystoreFile } from '../src/keystore.ts';
import { createLive } from '../src/live.ts';
import { boundedConfirmers, createLiveSwapDeps } from '../src/liveswap.ts';
import { createMentoVenue } from '../src/mento.ts';
import type { OrderDeps } from '../src/orchestrator.ts';
import { planPayment } from '../src/planner.ts';
import { policyFromEnv } from '../src/policy.ts';
import { runAmmSwap, runSwap } from '../src/swapexec.ts';
import { createViemReader } from '../src/funding.ts';
import { rpcUrlList } from '../src/chainread.ts';
import type { MarketRuntime } from '../src/market.ts';
import { SetupError, setupMarket } from '../src/marketsetup.ts';
import { createWebServer } from '../src/webapi.ts';
import type { WebRuntime } from '../src/webapi.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('port') ?? 4402);
const line = (s = '') => console.log(s);
function stop(s: string): never {
  line(`[STOP] ${s}`);
  process.exit(1);
}

for (const gone of ['--simulate', '--no-demo', '--escrow-testnet', '--scenario']) {
  if (args.includes(gone)) stop(`${gone} was removed: Payrail has no simulation, demo or testnet mode. The automated tests cover those paths in development only.`);
}

let runtime: WebRuntime;
let live!: ReturnType<typeof createLive>;
let spendingPolicy!: ReturnType<typeof policyFromEnv>;
let cfgChainId = 42220;
let attributionTag = '';

{
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
  spendingPolicy = policy;
  live = createLive(cfg, policy);
  cfgChainId = cfg.chainId;
  attributionTag = cfg.attributionTag;
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

// ---- the API marketplace: REAL FUNDS ONLY (USDT on Celo mainnet). There is no other mode. See src/marketsetup.ts.
let market: MarketRuntime | undefined;
try {
  market = await setupMarket({
    env: process.env,
    dbPath: opt('market-db'),
    configuredChainId: cfgChainId,
    attributionTag,
    readChainId: () => live.client.getChainId(),
    makeReader: () => createViemReader(rpcUrlList(process.env.PAYRAIL_RPC_URL || undefined, undefined)),
    readAllowance: (token, owner, spender) => live.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    buyCatalog: () => runtime.catalog(),
    buyVerify: live.verify,
    readUsdtBalance: (wallet) => live.client.readContract({ address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    buyPolicy: spendingPolicy,
    log: line,
  });
} catch (e) {
  if (e instanceof SetupError) stop(e.message);
  throw e;
}

const { server } = createWebServer(runtime, { ...(market ? { market } : {}) });
server.listen(port, '127.0.0.1', () => {
  line(`\nPayrail is running:  http://127.0.0.1:${port}/`);
  line('Open that address in your browser. Press Ctrl+C to stop.');
});
