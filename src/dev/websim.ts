// SIMULATED runtime for the web interface: fake catalog, fake balances, fake conversion and fake payment.
// It exists so the complete user journey (and its failure states) can be demonstrated and tested without funds
// or a blockchain. It is labelled "simulated" in every API answer and in the UI, and its transactions are not
// real. It uses the REAL planner, policy, orchestrator, journals and order records, so what it exercises is the
// production decision logic, not a mock of it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { ASSETS, assetBySymbol } from '../assets.ts';
import type { Asset } from '../assets.ts';
import { normalizeCatalog } from '../catalog.ts';
import type { Catalog } from '../catalog.ts';
import type { OrderDeps } from '../orchestrator.ts';
import { planPayment } from '../planner.ts';
import type { PlanDeps } from '../planner.ts';
import { DEFAULT_POLICY } from '../policy.ts';
import type { SpendingPolicy } from '../policy.ts';
import type { DiscoveryResult, PaymentOffer } from '../requirements.ts';
import type { RouteRequest, RouteResult } from '../routes.ts';
import type { SwapOutcome } from '../swapexec.ts';
import { newSwapRecord, saveSwapRecord } from '../swapjournal.ts';
import type { WebRuntime } from '../webapi.ts';

export type SimScenario = 'ok' | 'swap_fails' | 'payment_uncertain' | 'price_rises';

const SIM_WALLET: Address = getAddress('0x000000000000000000000000000000000051aa11');
const PAY_TO: Address = getAddress('0x20faaca5f980e29639a0fcc6dca6988e18ed333b');
const SERVICE_URL = 'https://gateway.usebuy.ai/v1/social/x/posts/search';
const hex = (n: number) => '0x' + n.toString(16).padStart(64, '0');

export function createSimulatedRuntime(opts: { scenario?: SimScenario; delayMs?: number; receiptDir?: string; startingBalances?: Record<string, bigint> } = {}): WebRuntime & { dir: string } {
  const scenario = opts.scenario ?? 'ok';
  const delay = opts.delayMs ?? 700;
  const dir = opts.receiptDir ?? mkdtempSync(join(tmpdir(), 'payrail-sim-'));
  let clock = Date.now();
  const now = () => (clock = Math.max(clock, Date.now()));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let txCounter = 0xa000;

  const balances: Record<string, bigint> = {
    cNGN: 1_365_928_991n, // 1,365.928991 cNGN (6 decimals)
    USDT: 636_223n, // 0.636223 USDT
    USDC: 0n,
    USAT: 0n,
    ...(opts.startingBalances ?? {}),
  };
  let nativeWei = 373_000_000_000_000_000n;
  let priced = 0; // discovery calls so far (the 'price_rises' scenario raises the price from the 2nd call on)

  const policy: SpendingPolicy = { ...DEFAULT_POLICY };

  const catalog: Catalog = normalizeCatalog(
    {
      payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, payTo: PAY_TO, tokens: [] },
      capabilities: [
        {
          id: 'x.posts.search', title: 'Search X posts (simulated)', method: 'POST', url: SERVICE_URL, available: true, platform: 'x',
          description: 'Search recent posts. This is a SIMULATED copy of the real service listing.',
          price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] },
          inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['latest', 'top'] } }, required: ['query'] },
        },
        {
          id: 'instagram.profile', title: 'Instagram profile (simulated)', method: 'POST', url: 'https://gateway.usebuy.ai/v1/social/instagram/profile', available: true, platform: 'instagram',
          description: 'Look up a public profile. SIMULATED listing.', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] },
          inputSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
        },
        {
          id: 'flights.search', title: 'Flight search (simulated)', method: 'POST', url: 'https://gateway.usebuy.ai/v1/flights/search', available: true, platform: 'flights',
          description: 'Live flight offers. SIMULATED listing priced above the default per-payment limit.', price: { usd: '0.05', atomic: '50000', tokens: ['USDT'] },
          inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
        },
        {
          id: 'reddit.posts.search', title: 'Reddit search (simulated, unavailable)', method: 'POST', url: 'https://gateway.usebuy.ai/v1/social/reddit/posts/search', available: false, platform: 'reddit',
          description: 'Temporarily unavailable. SIMULATED listing.', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] },
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
    },
    now(),
  );

  const offer = (symbol: string, priceAtomic: bigint): PaymentOffer => {
    const a = assetBySymbol(symbol)!;
    return {
      asset: a.address, symbol, known: true, signable: a.x402Signable, decimals: a.decimals, amountAtomic: priceAtomic, payTo: PAY_TO,
      network: 'celo', scheme: 'exact', maxTimeoutSeconds: 300, resource: SERVICE_URL, resourceMatches: true,
    };
  };

  const planDeps: PlanDeps = {
    now,
    policy,
    async discover(): Promise<DiscoveryResult> {
      const price = scenario === 'price_rises' && priced > 0 ? 9_000n : 5_000n;
      priced += 1;
      return { kind: 'payment_required', x402Version: 1, offers: [offer('USDT', price), offer('USDC', price), offer('USAT', price)], discarded: [], fetchedAt: now() };
    },
    async getBalances(_o, assets: readonly Asset[]) {
      return new Map(assets.map((a) => [a.address.toLowerCase(), balances[a.symbol] ?? 0n]));
    },
    getNativeBalance: async () => nativeWei,
    gasPriceWei: async () => 202_500_000_000n,
    routes: {
      name: 'simulated-textile',
      async findRoute(req: RouteRequest): Promise<RouteResult> {
        // indicative numbers modelled on the live cNGN->USDT ladder (1 USDT ~ 1,364.58 cNGN; ~1 bp fee; 1,363.578 minimum)
        if (req.sell.symbol !== 'cNGN' || req.buy.symbol !== 'USDT') {
          return { kind: 'none', provider: 'simulated-textile', code: 'CORRIDOR_UNAVAILABLE', message: 'only cNGN -> USDT is simulated', sell: req.sell, buy: req.buy };
        }
        const min = 1_363_578_000n;
        if (req.maxSellAmount < min) {
          return { kind: 'none', provider: 'simulated-textile', code: 'EXCEEDS_BALANCE', message: 'below the corridor minimum', sell: req.sell, buy: req.buy, minSellAmount: min };
        }
        return {
          kind: 'route', provider: 'simulated-textile', quoteState: 'preview', sell: req.sell, buy: req.buy,
          sellAmount: min, buyAmount: 998_869n, feeAmount: 136_000n, takerPays: min, minSellAmount: min, availableSellAmount: 63_000_000_000_000n, fetchedAt: now(),
        };
      },
    },
    swapExecution: true,
    spentSince: () => 0n,
  };

  const orderDeps = (o: { bounds?: { maxSellAtomic: bigint; minReceiveAtomic: bigint }; log?: (l: string) => void }): OrderDeps => {
    const log = o.log ?? (() => undefined);
    const swap = async (auth: { planId: string; sell: { symbol: string; sellAmountAtomic: bigint }; buy: { symbol: string } }): Promise<SwapOutcome> => {
      log(`[simulated] converting ${auth.sell.sellAmountAtomic} atomic ${auth.sell.symbol}`);
      await sleep(delay);
      const rec = newSwapRecord({
        planId: auth.planId,
        now: new Date(now()),
        route: {
          sellSymbol: auth.sell.symbol, sellAsset: assetBySymbol(auth.sell.symbol)!.address,
          buySymbol: auth.buy.symbol, buyAsset: assetBySymbol(auth.buy.symbol)!.address, provider: 'simulated-textile',
        },
        requestedSell: auth.sell.sellAmountAtomic,
        minBuy: 5_000n,
        tag: 'celo_b2fff2ac9413',
      });
      if (scenario === 'swap_fails') {
        rec.state = 'FAILED';
        rec.code = 'QUOTE_INVALID';
        rec.message = '[simulated] the venue declined the quote';
        saveSwapRecord(dir, rec, new Date(now()));
        return { kind: 'finished', state: 'FAILED', record: rec };
      }
      balances[auth.sell.symbol] = (balances[auth.sell.symbol] ?? 0n) - auth.sell.sellAmountAtomic;
      balances[auth.buy.symbol] = (balances[auth.buy.symbol] ?? 0n) + 998_869n;
      nativeWei -= 60_000_000_000_000_000n;
      rec.state = 'CONFIRMED';
      rec.code = 'CONFIRMED';
      rec.message = '[simulated] conversion confirmed';
      rec.amounts.takerPays = auth.sell.sellAmountAtomic.toString();
      rec.verification.buyReceived = '998869';
      rec.steps.push(
        { kind: 'approve', to: assetBySymbol(auth.sell.symbol)!.address, hash: hex(txCounter++), nonce: 1, status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'], note: 'simulated' }, gasUsed: '54000' },
        { kind: 'swap', to: PAY_TO, hash: hex(txCounter++), nonce: 2, status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'], note: 'simulated' }, gasUsed: '240000' },
      );
      rec.fundsMayHaveMoved = true;
      saveSwapRecord(dir, rec, new Date(now()));
      log('[simulated] conversion confirmed');
      return { kind: 'finished', state: 'CONFIRMED', record: rec };
    };
    const dep: OrderDeps = {
      now,
      receiptDir: dir,
      plan: (c) =>
        planPayment(planDeps, { service: c.service, body: c.body, payer: c.payer, ...(c.sourceSymbol ? { sourceSymbol: c.sourceSymbol } : {}) }),
      swapRunners: { 'simulated-textile': (auth) => swap(auth) },
      async pay(auth, link) {
        log(`[simulated] paying ${auth.payment.amountAtomic} atomic ${auth.payment.symbol} to ${auth.payment.payTo}`);
        await sleep(delay);
        const id = `direct-sim-${now()}`;
        const uncertain = scenario === 'payment_uncertain';
        const txHash = hex(txCounter++);
        const body = JSON.stringify({ simulated: true, note: 'This is a fake response produced by Payrail simulation mode.', capability: auth.serviceId, results: [{ text: 'Example post about Celo agents' }, { text: 'Another example post' }] }, null, 2);
        mkdirSync(join(dir, 'responses'), { recursive: true });
        const responseFile = `responses/${id}.body`;
        writeFileSync(join(dir, responseFile), body);
        const receipt = {
          schemaVersion: 1, id, planId: auth.planId, orderId: link.orderId, createdAt: new Date(now()).toISOString(),
          status: uncertain ? 'UNCERTAIN' : 'CONFIRMED',
          statusReason: uncertain ? '[simulated] settlement could not be confirmed' : '[simulated] delivered and settled',
          flow: link.route === 'converted' ? 'converted (simulated)' : 'direct (simulated)',
          conversion: link.route === 'converted' ? link.conversion : null,
          payment: { txHash, amountAtomic: auth.payment.amountAtomic.toString(), asset: auth.payment.asset, payer: auth.payer, payTo: auth.payment.payTo },
          outcome: { delivered: !uncertain, httpStatus: 200, responseSha256: 'a1'.repeat(32), responseFile, responseSummary: 'simulated', settled: !uncertain },
        };
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(receipt));
        if (!uncertain) balances[auth.payment.symbol] = (balances[auth.payment.symbol] ?? 0n) - auth.payment.amountAtomic;
        return { kind: 'completed', httpStatus: 200, receiptFile: `${id}.json`, receipt } as never;
      },
      verifyConversionOnChain: async () => ({ established: true, detail: '[simulated] established' }),
      log,
    };
    void o.bounds;
    return dep;
  };

  return {
    mode: 'simulated',
    wallet: SIM_WALLET,
    signing: true,
    attributionTag: 'celo_b2fff2ac9413',
    chainId: 42220,
    policy,
    receiptDir: dir,
    dir,
    catalog: async () => catalog,
    balances: async () => ({
      nativeWei,
      tokens: ASSETS.filter((a) => ['cNGN', 'USDT', 'USDC', 'USAT'].includes(a.symbol)).map((a) => ({ asset: a, atomic: balances[a.symbol] ?? 0n })),
    }),
    orderDeps,
    now,
    explorerTx: (h) => `https://celoscan.io/tx/${h}#simulated`,
  };
}
