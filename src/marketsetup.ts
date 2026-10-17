// Builds the PRODUCTION marketplace runtime: real funds only (USDT on Celo mainnet). There is no demo or test mode to fall back to.
// It lives here, not inline in scripts/serve.ts, so that the exact startup logic (refusals, limits, what is and is not switched on)
// can be exercised by tests with a fake chain, without a network and without starting a server.
import { ASSETS } from './assets.ts';
import { createBuyerSwapRuntime } from './buyerswap.ts';
import type { BuyerSwapRuntime } from './buyerswap.ts';
import { TEXTILE_REACTOR } from './config.ts';
import { RouteRegistry, seedConversionAssets } from './conversion.ts';
import type { ConversionProvider } from './conversion.ts';
import { openDb } from './db.ts';
import { assertProductionDatabase, stampEnvironment, EnvironmentError } from './envguard.ts';
import { RateLimiter } from './egress.ts';
import { recoverExecutions } from './execute.ts';
import type { ChainReader } from './funding.ts';
import type { MarketRuntime } from './market.ts';
import { recoverAllFunding } from './multifunding.ts';
import type { ConversionRuntime } from './multifunding.ts';
import type { SimProvider } from './dev/simconversion.ts';
import { firmQuote } from './textile.ts';
import { createTextileRouteProvider } from './textileroutes.ts';
import { masterKeyFrom } from './vault.ts';
import { EXPECTED_PAY_TO } from './buy.ts';
import { createBuyPay } from './buypay.ts';
import { createBuyConvert } from './buyconvert.ts';
import type { SpendingPolicy } from './policy.ts';
import type { VerifyDeps } from './verify.ts';
import { isAddress } from 'viem';

export class SetupError extends Error {}

export interface SetupDeps {
  env: Record<string, string | undefined>;
  /** --market-db; defaults to data/marketplace-live.db */
  dbPath: string | undefined;
  /** the chain id from PAYRAIL_CHAIN_ID */
  configuredChainId: number;
  attributionTag: string;
  /** what the RPC itself reports (eth_chainId) */
  readChainId(): Promise<number>;
  makeReader(): ChainReader;
  readAllowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
  buyCatalog: MarketRuntime['buyCatalog'];
  /** needed only for PAYRAIL_BUY_PAYMENTS=1: independent on-chain settlement checks and the spending policy (allowed hosts) */
  buyVerify?: VerifyDeps;
  /** USDT balance of a wallet (read-only). Needed for PAYRAIL_BUY_CONVERSION=1 and used to refuse a payment the wallet cannot cover. */
  readUsdtBalance?(wallet: `0x${string}`): Promise<bigint>;
  /** read-only balance of any ERC-20 and of native CELO (used to refuse a conversion the wallet cannot fund, and to warn about gas) */
  readTokenBalance?(token: `0x${string}`, wallet: `0x${string}`): Promise<bigint>;
  readNativeBalance?(wallet: `0x${string}`): Promise<bigint>;
  buyPolicy?: SpendingPolicy;
  /** tests only: the fetch used for the gateway (production leaves it undefined = the global fetch) */
  buyFetch?: typeof fetch;
  /** tests only: replace the live Textile provider and the buyer-signed swap runtime used for PAYRAIL_BUY_CONVERSION */
  buyConvertOverride?: { provider: ConversionProvider; buyerSwap: BuyerSwapRuntime };
  /** tests only: do not wait between settlement checks */
  buySettleDelayMs?: number;
  log(line: string): void;
}

/** returns undefined when the marketplace is simply not switched on; throws SetupError when it is switched on but unsafe or incomplete */
export async function setupMarket(d: SetupDeps): Promise<MarketRuntime | undefined> {
  const env = d.env;
  if (env.PAYRAIL_MARKET_LIVE !== '1') {
    d.log('Marketplace: OFF. Payrail has no demo mode; set PAYRAIL_MARKET_LIVE=1 (with PAYRAIL_DEPOSIT_ADDRESS and PAYRAIL_VAULT_KEY) to run the real-funds marketplace.');
    return undefined;
  }
  const depositAddress = env.PAYRAIL_DEPOSIT_ADDRESS;
  if (!depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) throw new SetupError('PAYRAIL_MARKET_LIVE=1 needs PAYRAIL_DEPOSIT_ADDRESS (a 0x address you control).');
  if (/^0x0{40}$/.test(depositAddress)) throw new SetupError('PAYRAIL_DEPOSIT_ADDRESS must not be the zero address.');
  const usdt = ASSETS.find((a) => a.symbol === 'USDT')!;
  if ([usdt.address, TEXTILE_REACTOR].some((a) => a.toLowerCase() === depositAddress.toLowerCase())) throw new SetupError('PAYRAIL_DEPOSIT_ADDRESS must be a wallet you control, not a token or protocol contract.');
  if (!env.PAYRAIL_VAULT_KEY) throw new SetupError('PAYRAIL_MARKET_LIVE=1 needs PAYRAIL_VAULT_KEY (64 hex characters): it encrypts stored seller credentials and must survive restarts.');
  if (d.configuredChainId !== 42220) throw new SetupError(`PAYRAIL_CHAIN_ID is ${d.configuredChainId}; the marketplace runs on Celo mainnet (42220) only.`);
  const dbPath = d.dbPath ?? 'data/marketplace-live.db';
  if (dbPath === ':memory:') throw new SetupError('a real-funds marketplace needs a persistent database file, not :memory:.');
  const capUsd = Number(env.PAYRAIL_MAX_DEPOSIT_USD ?? '5');
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new SetupError('PAYRAIL_MAX_DEPOSIT_USD must be a positive number.');
  const confirmations = Number(env.PAYRAIL_DEPOSIT_CONFIRMATIONS ?? '20');
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new SetupError('PAYRAIL_DEPOSIT_CONFIRMATIONS must be a whole number of at least 1.');

  // the RPC must really be Celo mainnet before anything is verified against it
  let rpcChain: number;
  try {
    rpcChain = await d.readChainId();
  } catch (e) {
    throw new SetupError(`could not read the chain id from the RPC: ${(e as Error).message.slice(0, 100)}`);
  }
  if (rpcChain !== 42220) throw new SetupError(`the RPC reports chain ${rpcChain}, not Celo mainnet (42220).`);

  const vaultKey = masterKeyFrom(env.PAYRAIL_VAULT_KEY_ID ?? 'k1', env.PAYRAIL_VAULT_KEY);
  const reader = d.makeReader();
  const cap = BigInt(Math.round(capUsd * 1_000_000));
  const live: NonNullable<MarketRuntime['live']> = {
    funding: { chainId: 42220, token: usdt.address, asset: 'USDT', depositAddress, minConfirmations: confirmations, maxDepositAtomic: cap, reader },
    payout: { payableAssets: ['USDT'], minAtomic: 1_000_000n, maxAtomic: cap },
    // seller payouts stay refused over HTTP until the secure payout architecture is built and reviewed
    payoutRequestsEnabled: false,
  };
  try {
    assertProductionDatabase(dbPath); // read-only checks; a development or test-credit database is refused before anything is written
  } catch (e) {
    if (e instanceof EnvironmentError) throw new SetupError(e.message);
    throw e;
  }
  const db = openDb(dbPath);
  try {
    stampEnvironment(db, 'production');
  } catch (e) {
    if (e instanceof EnvironmentError) throw new SetupError(e.message);
    throw e;
  }
  const rec = recoverExecutions(db, { staleHeldMs: 5 * 60_000, unresolvedMs: 60 * 60_000 });
  if (rec.interrupted || rec.released) d.log(`Marketplace recovery: ${rec.interrupted} interrupted call(s) marked unresolved, ${rec.released} released to buyers.`);
  const limiter = () => new RateLimiter(60, 10);

  // Buyer-signed conversion is a SEPARATE explicit opt-in. The buyer's own wallet signs every transaction; this server holds no buyer
  // key and spends no operator funds on a buyer's behalf. It has never been run against mainnet: leave it off until it has.
  let conversion: ConversionRuntime | undefined;
  if (env.PAYRAIL_BUYER_SWAP === '1') {
    seedConversionAssets(db);
    const textile = createTextileRouteProvider();
    conversion = {
      registry: new RouteRegistry(db, [textile]),
      provider: textile as unknown as SimProvider,
      reader,
      reactor: TEXTILE_REACTOR,
      usdt: usdt.address,
      chainId: 42220,
      minConfirmations: confirmations,
      creditAsset: 'USDT',
      depositAddress,
      maxPerDayBuyAtomic: cap * 5n,
      simulated: false,
      buyerSwap: createBuyerSwapRuntime({ firmQuote, getAllowance: d.readAllowance, provider: textile, chainId: 42220, tag: d.attributionTag }),
    };
    await recoverAllFunding(db, conversion, Date.now);
    d.log('BUYER-SIGNED CONVERSION ENABLED (never run on mainnet yet): buyers convert with their own wallets; Textile firm quotes are validated server-side.');
  }

  // Buy AI purchases paid directly by the buyer's own wallet (x402 / EIP-3009): its own explicit opt-in, off by default
  let buy: ReturnType<typeof createBuyPay> | undefined;
  if (env.PAYRAIL_BUY_PAYMENTS === '1') {
    if (!d.buyVerify || !d.buyPolicy || !d.buyCatalog) throw new SetupError('PAYRAIL_BUY_PAYMENTS=1 needs the Buy catalogue, a spending policy and on-chain verification.');
    const buyCapUsd = Number(env.PAYRAIL_BUY_MAX_USD ?? '0.05');
    if (!Number.isFinite(buyCapUsd) || buyCapUsd <= 0) throw new SetupError('PAYRAIL_BUY_MAX_USD must be a positive number.');
    const buyPayTo = env.PAYRAIL_BUY_PAYTO ?? EXPECTED_PAY_TO;
    if (!isAddress(buyPayTo)) throw new SetupError('PAYRAIL_BUY_PAYTO must be an address.');
    const getCatalog = d.buyCatalog;
    buy = createBuyPay({
      db, catalog: { get: async () => getCatalog() }, policy: d.buyPolicy, verify: d.buyVerify, chainId: 42220, usdt: usdt.address, payTo: buyPayTo as `0x${string}`,
      maxPerPaymentAtomic: BigInt(Math.round(buyCapUsd * 1_000_000)), feeBps: 300, ...(d.readUsdtBalance ? { usdtBalance: d.readUsdtBalance } : {}), ...(d.buyFetch ? { fetchImpl: d.buyFetch } : {}), ...(d.buySettleDelayMs !== undefined ? { settleDelayMs: d.buySettleDelayMs } : {}),
    });
    const interrupted = buy.recoverInterrupted();
    d.log(`BUY PAYMENTS ENABLED: buyers pay Buy AI directly from their own wallet in USDT on Celo (limit ${buyCapUsd} USDT per payment, payee ${buyPayTo}). Platform fee: recorded as due, NOT collected.${interrupted ? ` ${interrupted} interrupted order(s) marked UNRESOLVED.` : ''}`);
  }

  // Paying a Buy API with cNGN etc.: Textile converts in the BUYER's wallet, then Buy is paid in USDT. Its own opt-in, off by default,
  // and never started without Buy payments (the conversion has no purpose without them). It has not been run on mainnet through this path.
  let buyConvert: ReturnType<typeof createBuyConvert> | undefined;
  if (env.PAYRAIL_BUY_CONVERSION === '1') {
    if (!buy) throw new SetupError('PAYRAIL_BUY_CONVERSION=1 needs PAYRAIL_BUY_PAYMENTS=1: a conversion only exists to fund a Buy purchase.');
    if (!d.readUsdtBalance) throw new SetupError('PAYRAIL_BUY_CONVERSION=1 needs a way to read wallet USDT balances.');
    const maxUsd = Number(env.PAYRAIL_BUY_CONVERT_MAX_USD ?? '2');
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new SetupError('PAYRAIL_BUY_CONVERT_MAX_USD must be a positive number.');
    seedConversionAssets(db);
    const textile: ConversionProvider = d.buyConvertOverride?.provider ?? createTextileRouteProvider();
    buyConvert = createBuyConvert({
      db, registry: new RouteRegistry(db, [textile]), provider: textile,
      buyerSwap: d.buyConvertOverride?.buyerSwap ?? createBuyerSwapRuntime({ firmQuote, getAllowance: d.readAllowance, provider: textile, chainId: 42220, tag: d.attributionTag }),
      reader, usdt: usdt.address, reactor: TEXTILE_REACTOR, chainId: 42220, minConfirmations: confirmations, maxUsdtAtomic: BigInt(Math.round(maxUsd * 1_000_000)),
      ...(d.readTokenBalance ? { tokenBalance: d.readTokenBalance } : {}), ...(d.readNativeBalance ? { nativeBalance: d.readNativeBalance } : {}),
    });
    d.log(`BUY CONVERSION ENABLED (not yet run on mainnet): buyers convert cNGN etc. to USDT with Textile in their own wallet (up to ${maxUsd} USDT per conversion), then pay Buy. Platform fee: none added here.`);
  }

  const market: MarketRuntime = {
    db,
    keys: [vaultKey],
    activeKey: vaultKey,
    // seller APIs and DNS/well-known proofs go over the REAL internet through the SSRF-safe egress gateway
    execute: { call: { limiter: limiter(), fetchOptions: { timeoutMs: 8_000 } } },
    testCall: { limiter: limiter(), fetchOptions: { timeoutMs: 8_000 } },
    domain: {},
    ...(d.buyCatalog ? { buyCatalog: d.buyCatalog } : {}),
    live,
    ...(buy ? { buy } : {}),
    ...(buyConvert ? { buyConvert } : {}),
    ...(conversion ? { conversion } : {}),
  };
  d.log(`REAL-FUNDS MARKETPLACE: USDT on Celo mainnet. Deposits to ${depositAddress} are credited after ${confirmations} confirmations (cap ${cap / 1_000_000n} USDT each). Seller payouts: DISABLED. Conversion: ${conversion ? 'buyer-signed (unverified on mainnet)' : 'DISABLED'}. Database: ${dbPath}.`);
  return market;
}

