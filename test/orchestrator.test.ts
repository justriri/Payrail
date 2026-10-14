// Orchestrator tests. Everything is faked: no network, no key, no funds. The fakes are STATEFUL (a swap
// runner really changes the fake wallet's balances) so "convert, then re-price, then pay" is exercised end to end.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Address } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import type { Asset } from '../src/assets.ts';
import { normalizeCatalog } from '../src/catalog.ts';
import type { Service } from '../src/catalog.ts';
import type { ExecutionResult } from '../src/executor.ts';
import { executeDirectPayment } from '../src/executor.ts';
import { executeOrder, listOrders, loadOrder, planOrder, reconcileOrder, renderOrderPlan, renderOrderRecord, resumeOrder } from '../src/orchestrator.ts';
import { acquireLock } from '../src/lock.ts';
import { buildReceipt } from '../src/receipt.ts';
import { checkSwapDailyCap, swapNotionalSince } from '../src/swapjournal.ts';
import type { OrderContext, OrderDeps } from '../src/orchestrator.ts';
import type { OrderLink } from '../src/orderstore.ts';
import { listPending, writePending } from '../src/history.ts';
import { planPayment } from '../src/planner.ts';
import type { PlanDeps } from '../src/planner.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type { SpendingPolicy } from '../src/policy.ts';
import type { DiscoveryResult, PaymentOffer } from '../src/requirements.ts';
import type { RouteRequest, RouteResult } from '../src/routes.ts';
import type { SwapOutcome } from '../src/swapexec.ts';
import { newSwapRecord, saveSwapRecord } from '../src/swapjournal.ts';
import type { SwapState } from '../src/swapjournal.ts';
import { BODY, OTHER, PAY_TO, SERVICE_URL, gateway, makeAuth, tempDir, testAccount, verifyDeps } from './support.ts';

const NOW = 1_800_000_000_000;
const A = (s: string): Asset => assetBySymbol(s)!;
const PAYER: Address = '0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4';
const TAG = 'celo_b2fff2ac9413';

const catalog = normalizeCatalog(
  {
    payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, payTo: PAY_TO, tokens: [] },
    capabilities: [
      { id: 'x.posts.search', title: 'Search X posts', method: 'POST', url: SERVICE_URL, available: true, platform: 'x', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } },
      { id: 'other.service', title: 'Some other service', method: 'POST', url: 'https://gateway.usebuy.ai/v1/other', available: true, platform: 'other', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } },
    ],
  },
  NOW,
);
const svc = (id: string): Service => catalog.services.find((s) => s.id === id)!;

function offer(symbol: string, amount = 5000n, over: Partial<PaymentOffer> = {}): PaymentOffer {
  const a = A(symbol);
  return {
    asset: a.address, symbol, known: true, signable: a.x402Signable, decimals: a.decimals, amountAtomic: amount,
    payTo: PAY_TO, network: 'celo', scheme: 'exact', maxTimeoutSeconds: 300, resource: SERVICE_URL, resourceMatches: true, ...over,
  };
}
const required = (offers: PaymentOffer[]): DiscoveryResult => ({ kind: 'payment_required', x402Version: 1, offers, discarded: [], fetchedAt: NOW });

interface World {
  balances: Record<string, bigint>;
  discover: DiscoveryResult;
  /** The venue name the fake route provider reports. */
  venue: string;
  noRoute: boolean;
  policy: Partial<SpendingPolicy>;
  /** What the fake swap runner does when called. */
  swap: 'confirm' | 'failed' | 'uncertain' | 'refused' | 'throw' | 'crash_after_journal' | 'crash_before_journal';
  swapState: SwapState | undefined;
  pay: 'ok' | 'not_sent' | 'in_doubt' | 'throw' | 'unconfirmed' | 'crash_after_receipt' | 'crash_after_journal';
  /** Called after the swap "settles" and before the re-price (to change the service's terms). */
  afterSwap?: (w: World) => void;
  calls: { swap: string[]; pay: number; discover: number };
  links: OrderLink[];
  now: number;
}

function world(over: Partial<World> = {}) {
  const dir = tempDir();
  const w: World = {
    balances: { cNGN: 1_400_000_000n },
    discover: required([offer('USDT')]),
    venue: 'fake-venue',
    noRoute: false,
    policy: {},
    swap: 'confirm',
    swapState: undefined,
    pay: 'ok',
    calls: { swap: [], pay: 0, discover: 0 },
    links: [],
    now: NOW,
    ...over,
  };
  const planDeps: PlanDeps = {
    now: () => w.now,
    policy: { ...DEFAULT_POLICY, ...w.policy },
    async discover() {
      w.calls.discover += 1;
      return w.discover;
    },
    async getBalances(_o, assets) {
      return new Map(assets.map((a) => [a.address.toLowerCase(), w.balances[a.symbol] ?? 0n]));
    },
    async getNativeBalance() {
      return 500_000_000_000_000_000n;
    },
    async gasPriceWei() {
      return 25_000_000_000n;
    },
    routes: {
      name: w.venue,
      async findRoute(req: RouteRequest): Promise<RouteResult> {
        if (w.noRoute) return { kind: 'none', provider: w.venue, code: 'CORRIDOR_UNAVAILABLE', message: 'no corridor', sell: req.sell, buy: req.buy };
        return {
          kind: 'route', provider: w.venue, quoteState: 'preview', sell: req.sell, buy: req.buy,
          sellAmount: 1_400_000_000n, buyAmount: 1_026_000n, feeAmount: 140_000n, takerPays: 1_400_000_000n,
          minSellAmount: 1_363_000_000n, availableSellAmount: 8_000_000_000_000n, fetchedAt: NOW,
        };
      },
    },
    swapExecution: true,
    spentSince: () => 0n,
  };
  const swapOutcome = (planId: string, state: SwapState, code: string): SwapOutcome => {
    const rec = newSwapRecord({
      planId,
      now: new Date(NOW),
      route: { sellSymbol: 'cNGN', sellAsset: A('cNGN').address, buySymbol: 'USDT', buyAsset: A('USDT').address, provider: w.venue },
      requestedSell: 1_400_000_000n,
      minBuy: 5000n,
      tag: TAG,
    });
    rec.state = state;
    rec.code = code;
    rec.message = `fake ${state}`;
    if (state === 'CONFIRMED') {
      rec.steps.push({ kind: 'swap', to: PAY_TO, hash: '0x' + 'cd'.repeat(32), nonce: 1, status: 'mined', attribution: { verified: true, codes: [TAG], note: '' }, gasUsed: '1' });
      rec.fundsMayHaveMoved = true;
    }
    saveSwapRecord(dir, rec, new Date(NOW));
    return { kind: 'finished', state, record: rec };
  };
  const runner = async (auth: { planId: string }): Promise<SwapOutcome> => {
    w.calls.swap.push(auth.planId);
    if (w.swap === 'throw' || w.swap === 'crash_before_journal') throw new Error('socket hang up');
    if (w.swap === 'crash_after_journal') {
      w.balances.cNGN = 0n;
      w.balances.USDT = (w.balances.USDT ?? 0n) + 1_026_000n;
      swapOutcome(auth.planId, 'CONFIRMED', 'CONFIRMED');
      throw new Error('process died after the swap journal was written');
    }
    if (w.swap === 'refused') return { kind: 'refused', code: 'LOCK_HELD', message: 'another process holds the lock' };
    if (w.swap === 'failed') return swapOutcome(auth.planId, 'FAILED', 'DECLINED');
    if (w.swap === 'uncertain') return swapOutcome(auth.planId, 'UNCERTAIN', 'RECEIPT_TIMEOUT');
    // confirmed: the fake wallet really changes
    w.balances.cNGN = 0n;
    w.balances.USDT = (w.balances.USDT ?? 0n) + 1_026_000n;
    const o = swapOutcome(auth.planId, w.swapState ?? 'CONFIRMED', 'CONFIRMED');
    w.afterSwap?.(w);
    return o;
  };
  const deps: OrderDeps = {
    now: () => w.now,
    receiptDir: dir,
    plan: (ctx) =>
      planPayment(planDeps, { service: ctx.service, body: ctx.body, payer: ctx.payer, ...(ctx.sourceSymbol ? { sourceSymbol: ctx.sourceSymbol } : {}) }),
    swapRunners: { [w.venue]: runner },
    async pay(auth, link): Promise<ExecutionResult> {
      w.calls.pay += 1;
      w.links.push(link);
      if (w.pay === 'throw') throw new Error('network down');
      if (w.pay === 'not_sent') return { kind: 'not_sent', code: 'DAILY_LIMIT', message: 'over the daily limit' };
      if (w.pay === 'in_doubt' || w.pay === 'crash_after_journal') {
        writePending(dir, {
          id: `pending-${w.calls.pay}`, createdAt: new Date(NOW).toISOString(), state: 'in_flight', planId: auth.planId, serviceId: auth.serviceId,
          url: auth.url, payer: auth.payer, asset: auth.payment.asset, payTo: auth.payment.payTo, amountAtomic: auth.payment.amountAtomic.toString(),
          orderId: link.orderId, note: 'test',
        });
        if (w.pay === 'crash_after_journal') throw new Error('process died after the payment journal was written');
        return { kind: 'in_doubt', message: 'authorization may still settle', receiptFile: undefined };
      }
      const confirmed = w.pay === 'ok' || w.pay === 'crash_after_receipt';
      w.balances.USDT = (w.balances.USDT ?? 0n) - auth.payment.amountAtomic;
      const receipt = {
        schemaVersion: 1,
        id: `direct-${w.calls.pay}`,
        planId: auth.planId,
        orderId: link.orderId,
        createdAt: new Date(NOW + w.calls.pay).toISOString(),
        status: confirmed ? 'CONFIRMED' : 'UNCERTAIN',
        statusReason: confirmed ? 'delivered and independently settled' : 'delivered but settlement not proven',
        flow: link.route === 'converted' ? 'converted' : 'direct (no swap needed)',
        conversion: link.route === 'converted' ? link.conversion : null,
        payment: { txHash: '0x' + 'ef'.repeat(32), amountAtomic: auth.payment.amountAtomic.toString(), asset: auth.payment.asset },
        outcome: { delivered: confirmed, httpStatus: 200, responseSha256: 'ab'.repeat(32), responseFile: `responses/direct-${w.calls.pay}.body`, responseSummary: 'JSON keys [capability]', settled: confirmed },
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${receipt.id}.json`), JSON.stringify(receipt));
      if (w.pay === 'crash_after_receipt') throw new Error('process died after the receipt was written');
      return { kind: 'completed', httpStatus: 200, receiptFile: `${receipt.id}.json`, receipt } as unknown as ExecutionResult;
    },
  };
  const ctx = (id = 'x.posts.search'): OrderContext => ({ service: svc(id), serviceProvider: 'buy-gateway', body: BODY, payer: PAYER });
  return { w, dir, deps, ctx };
}

// ------------------------------------------------------------------ planning

test('plan: the wallet holds an accepted asset -> direct, one pay step, nothing converted', async () => {
  const { deps, ctx } = world({ balances: { USDT: 100_000n } });
  const o = await planOrder(deps, ctx());
  assert.equal(o.route, 'direct');
  assert.equal(o.status, 'READY');
  assert.deepEqual(o.steps.map((s) => s.kind), ['pay']);
  assert.equal(o.payment.accepted?.[0]?.symbol, 'USDT');
  assert.equal(o.payment.accepted?.[0]?.heldAtomic, 100_000n);
  assert.equal(o.totals.totalMicroUsd, 5_000n);
  assert.match(renderOrderPlan(o), /step 1: \[pay\]/);
});

test('plan: only a convertible local currency is held -> convert then pay, with total cost and gas', async () => {
  const { deps, ctx } = world();
  const o = await planOrder(deps, ctx());
  assert.equal(o.route, 'swap');
  assert.deepEqual(o.steps.map((s) => s.kind), ['convert', 'pay']);
  assert.equal(o.steps[0]!.provider, 'fake-venue');
  assert.equal(o.executable, true);
  assert.ok(o.totals.conversionFeeMicroUsd !== undefined && o.totals.totalMicroUsd !== undefined);
  assert.ok(o.totals.gasEstimateWei !== undefined);
  assert.ok(o.explanation.some((e) => /accepts: .*USDT/.test(e)), 'the accepted assets are explained');
});

test('plan: a plan for a provider with no registered executor is blocked, not executable', async () => {
  const { deps, ctx } = world();
  const o = await planOrder({ ...deps, swapRunners: {} }, ctx());
  assert.equal(o.status, 'BLOCKED');
  assert.equal(o.executable, false);
  assert.ok(o.blockers.some((b) => b.code === 'NO_CONVERSION_EXECUTOR'));
});

for (const [name, over] of [
  ['policy cap exceeded', { discover: required([offer('USDT', 50_000n)]), balances: { USDT: 1_000_000n } }],
  ['insufficient balance', { balances: {} }],
  ['no conversion route', { noRoute: true }],
] as const) {
  test(`blocked (${name}): planOrder is BLOCKED and executeOrder refuses without touching any executor`, async () => {
    const { w, deps, ctx, dir } = world(over as Partial<World>);
    const o = await planOrder(deps, ctx());
    assert.equal(o.status, 'BLOCKED');
    const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind, 'refused');
    assert.equal(w.calls.swap.length, 0);
    assert.equal(w.calls.pay, 0);
    assert.equal(listOrders(dir).length, 0, 'a refusal leaves no order record');
  });
}

// ------------------------------------------------------------------ direct execution

test('direct: pays once, persists the order, and an order id cannot be executed twice', async () => {
  const { w, deps, ctx, dir } = world({ balances: { USDT: 100_000n } });
  const o = await planOrder(deps, ctx());
  const r = await executeOrder(o, ctx(), deps);
  assert.equal(r.kind, 'finished');
  assert.equal(r.kind === 'finished' && r.state, 'COMPLETED');
  assert.equal(w.calls.pay, 1);
  assert.equal(w.calls.swap.length, 0);
  const saved = loadOrder(dir, o.orderId)!;
  assert.equal(saved.state, 'COMPLETED');
  assert.equal(saved.payment?.status, 'CONFIRMED');
  assert.equal(saved.approved.payTo, PAY_TO);
  assert.ok(existsSync(`${dir}/orders/${o.orderId}.json`));
  assert.match(renderOrderRecord(saved), /COMPLETED/);

  const again = await executeOrder(o, ctx(), deps);
  assert.equal(again.kind === 'refused' && again.code, 'ORDER_ALREADY_PAID');
  assert.equal(w.calls.pay, 1, 'no second payment');
});

test('approval: a service that needs approval is refused without it (no record) and proceeds with it', async () => {
  const { w, deps, ctx, dir } = world({ balances: { USDT: 100_000n } });
  const o = await planOrder(deps, ctx('other.service'));
  assert.equal(o.status, 'APPROVAL_REQUIRED');
  const no = await executeOrder(o, ctx('other.service'), deps);
  assert.equal(no.kind === 'refused' && no.code, 'APPROVAL_REQUIRED');
  assert.equal(w.calls.pay, 0);
  assert.equal(listOrders(dir).length, 0);
  const yes = await executeOrder(o, ctx('other.service'), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(yes.kind === 'finished' && yes.state, 'COMPLETED');
  assert.equal(loadOrder(dir, o.orderId)!.approvedBy, 'human:test');
});

test('guards: stale plan and a different request body are refused before anything starts', async () => {
  const { w, deps, ctx, dir } = world({ balances: { USDT: 100_000n } });
  const o = await planOrder(deps, ctx());
  const bad = await executeOrder(o, { ...ctx(), body: '{"query":"something else"}' }, deps);
  assert.equal(bad.kind === 'refused' && bad.code, 'BODY_MISMATCH');
  w.now = o.validUntilMs + 1;
  const stale = await executeOrder(o, ctx(), deps);
  assert.equal(stale.kind === 'refused' && stale.code, 'PLAN_EXPIRED');
  assert.equal(w.calls.pay, 0);
  assert.equal(listOrders(dir).length, 0);
});

// ------------------------------------------------------------------ convert, then pay

test('convert then pay: the swap runs once, the service is re-priced, then paid; both are recorded', async () => {
  const { w, deps, ctx, dir } = world({ policy: {} });
  const o = await planOrder(deps, ctx());
  const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.state, 'COMPLETED', r.kind === 'finished' ? r.record.message : r.kind === 'refused' ? r.message : '');
  assert.equal(w.calls.swap.length, 1);
  assert.equal(w.calls.pay, 1);
  assert.ok(w.calls.discover >= 2, 'the service was re-priced after the conversion');
  const rec = loadOrder(dir, o.orderId)!;
  assert.equal(rec.conversion?.state, 'CONFIRMED');
  assert.equal(rec.conversion?.provider, 'fake-venue');
  assert.ok(rec.conversion?.txHashes.length === 1);
  assert.equal(rec.payment?.status, 'CONFIRMED');
  assert.deepEqual(rec.steps.map((s) => s.state), ['done', 'done']);
  assert.equal(rec.needsAttention, false);
});

test('a conversion that needs approval by policy is not started without it', async () => {
  const { w, deps, ctx } = world();
  const o = await planOrder(deps, ctx());
  if (!o.approval.required) return; // default policy requires approval for swaps; keep the test honest if it ever changes
  const r = await executeOrder(o, ctx(), deps);
  assert.equal(r.kind === 'refused' && r.code, 'APPROVAL_REQUIRED');
  assert.equal(w.calls.swap.length, 0);
});

for (const [mode, expectState, code] of [
  ['failed', 'STOPPED', 'CONVERSION_FAILED'],
  ['refused', 'STOPPED', 'CONVERSION_REFUSED_LOCK_HELD'],
  ['uncertain', 'UNCERTAIN', 'CONVERSION_UNCERTAIN'],
  ['throw', 'UNCERTAIN', 'CONVERSION_ERROR'],
] as const) {
  test(`conversion ${mode}: the order stops as ${expectState} and the service is never paid`, async () => {
    const { w, deps, ctx, dir } = world({ swap: mode });
    const o = await planOrder(deps, ctx());
    const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind, 'finished');
    if (r.kind !== 'finished') return;
    assert.equal(r.state, expectState);
    assert.equal(r.record.code, code);
    assert.equal(w.calls.pay, 0, 'no payment after an unconfirmed conversion');
    assert.equal(w.calls.swap.length, 1, 'the conversion is never retried');
    assert.equal(loadOrder(dir, o.orderId)!.state, expectState);
  });
}

test('payment fails after a confirmed conversion: STOPPED with the funds noted; resume pays WITHOUT converting again', async () => {
  const { w, deps, ctx, dir } = world({ pay: 'not_sent' });
  const o = await planOrder(deps, ctx());
  const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.state, 'STOPPED');
  assert.equal(r.kind === 'finished' && r.record.code, 'PAYMENT_NOT_SENT_DAILY_LIMIT');
  assert.equal(r.kind === 'finished' && r.record.needsAttention, true);
  assert.match(r.kind === 'finished' ? r.record.message : '', /converted funds remain in the wallet/);
  assert.equal(w.calls.swap.length, 1);

  w.pay = 'ok';
  const resumed = await resumeOrder(o.orderId, ctx(), deps);
  assert.equal(resumed.kind === 'finished' && resumed.state, 'COMPLETED', resumed.kind === 'refused' ? resumed.message : '');
  assert.equal(w.calls.swap.length, 1, 'the conversion was not repeated');
  assert.equal(w.calls.pay, 2);
  assert.equal(loadOrder(dir, o.orderId)!.payment?.status, 'CONFIRMED');
});

test('after conversion: a price rise above the approved ceiling or a changed payee stops before paying', async () => {
  for (const [label, change, code] of [
    ['price rose', (w: World) => { w.discover = required([offer('USDT', 9_000n)]); }, 'PRICE_ROSE'],
    ['payee changed', (w: World) => { w.discover = required([offer('USDT', 5_000n, { payTo: OTHER })]); }, 'PAYMENT_TERMS_CHANGED'],
  ] as const) {
    const { w, deps, ctx } = world({ afterSwap: change });
    const o = await planOrder(deps, ctx());
    const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind === 'finished' && r.record.code, code, label);
    assert.equal(w.calls.pay, 0, label);
    assert.equal(r.kind === 'finished' && r.record.needsAttention, true, label);
  }
});

test('after conversion: a LOWER price is accepted and only that amount is paid', async () => {
  const { w, deps, ctx, dir } = world({ afterSwap: (x) => { x.discover = required([offer('USDT', 4_000n)]); } });
  const o = await planOrder(deps, ctx());
  const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.state, 'COMPLETED');
  assert.equal(w.calls.pay, 1);
  assert.equal(loadOrder(dir, o.orderId)!.approved.amountAtomic, '5000', 'the approved ceiling is unchanged');
});

test('payment outcomes: in doubt and unconfirmed settlement are UNCERTAIN (never retried); a throw is UNCERTAIN', async () => {
  for (const pay of ['in_doubt', 'unconfirmed', 'throw'] as const) {
    const { w, deps, ctx } = world({ balances: { USDT: 100_000n }, pay });
    const o = await planOrder(deps, ctx());
    const r = await executeOrder(o, ctx(), deps);
    assert.equal(r.kind === 'finished' && r.state, 'UNCERTAIN', pay);
    assert.equal(r.kind === 'finished' && r.record.needsAttention, true, pay);
    assert.equal(w.calls.pay, 1, pay);
    // an uncertain order is not resumable
    const again = await resumeOrder(o.orderId, ctx(), deps);
    assert.equal(again.kind, 'refused', pay);
  }
});

test('resume refuses an order whose conversion is not confirmed in the swap journal', async () => {
  const { w, deps, ctx, dir } = world({ pay: 'not_sent', swapState: 'CONFIRMED' });
  const o = await planOrder(deps, ctx());
  await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  // damage the swap journal: the order claims a conversion that the journal does not confirm
  const rec = loadOrder(dir, o.orderId)!;
  rec.conversion!.swapPlanId = 'no-such-swap';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${dir}/orders/${o.orderId}.json`, JSON.stringify(rec));
  w.pay = 'ok';
  const r = await resumeOrder(o.orderId, ctx(), deps);
  assert.equal(r.kind === 'refused' && r.code, 'CONVERSION_NOT_CONFIRMED');
  assert.equal(w.calls.pay, 1);
});

// ------------------------------------------------------------------ extensibility

test('a second conversion venue and a second asset need no orchestrator change', async () => {
  // target accepted only in USDC, converted by a differently named venue
  const { w, deps, ctx } = world({ venue: 'second-venue', discover: required([offer('USDC', 5000n)]) });
  w.balances.cNGN = 1_400_000_000n;
  const o = await planOrder(deps, ctx());
  assert.equal(o.steps[0]!.provider, 'second-venue');
  assert.equal(o.payment.payment?.symbol, 'USDC');
  assert.equal(o.status === 'BLOCKED', false);
  // the fake runner credits USDT, so the re-priced payment is blocked after conversion: the point here is
  // that the right venue's runner was selected by name and the order stopped safely.
  const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind, 'finished');
  assert.deepEqual(w.calls.swap.length, 1);
  assert.equal(w.calls.pay, 0);
});

// ================================================================== STEP 1: order-aware duplicate guard + preflight
// (real executor, fake gateway)

test('guard: a legitimate NEW order is allowed after an earlier receipt; the SAME plan or order is refused', async () => {
  const dir = tempDir();
  const account = testAccount();
  const gw = gateway({ payer: account.address });
  const base = (over: Partial<Parameters<typeof executeDirectPayment>[1]> = {}) => ({
    account, body: BODY, receiptDir: dir, attributionTag: TAG, verify: verifyDeps('settled', account.address),
    getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl, lock: { waitMs: 0 }, ...over,
  });
  const first = await executeDirectPayment(makeAuth(account.address, { planId: 'plan-A' }), base({ order: { orderId: 'order-A', route: 'direct' } }));
  assert.equal(first.kind, 'completed');
  // a new order (new plan, new order id): permitted
  const second = await executeDirectPayment(makeAuth(account.address, { planId: 'plan-B' }), base({ order: { orderId: 'order-B', route: 'direct' } }));
  assert.equal(second.kind, 'completed', second.kind === 'not_sent' ? second.message : '');
  // the same plan again: refused
  const dupPlan = await executeDirectPayment(makeAuth(account.address, { planId: 'plan-A' }), base());
  assert.equal(dupPlan.kind === 'not_sent' && dupPlan.code, 'PRIOR_RECEIPT');
  // the same ORDER under a new plan id: refused
  const dupOrder = await executeDirectPayment(makeAuth(account.address, { planId: 'plan-C' }), base({ order: { orderId: 'order-A', route: 'direct' } }));
  assert.equal(dupOrder.kind === 'not_sent' && dupOrder.code, 'PRIOR_RECEIPT');
  assert.equal(gw.paidCount(), 2, 'exactly the two legitimate orders were paid');
});

test('guard: the strict global mode still refuses any new payment after a receipt', async () => {
  const dir = tempDir();
  const account = testAccount();
  const gw = gateway({ payer: account.address });
  const base = { account, body: BODY, receiptDir: dir, attributionTag: TAG, verify: verifyDeps('settled', account.address), getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl };
  assert.equal((await executeDirectPayment(makeAuth(account.address, { planId: 'p1' }), base)).kind, 'completed');
  const r = await executeDirectPayment(makeAuth(account.address, { planId: 'p2' }), { ...base, guard: 'global' });
  assert.equal(r.kind === 'not_sent' && r.code, 'PRIOR_RECEIPT');
});

test('guard: a pending journal blocks even a brand-new order, and --again does not override it', async () => {
  const dir = tempDir();
  const account = testAccount();
  writePending(dir, {
    id: 'pending-x', createdAt: new Date().toISOString(), state: 'in_flight', planId: 'old', serviceId: 's', url: 'u',
    payer: '0x0', asset: '0x0', payTo: '0x0', amountAtomic: '1', note: 'crashed',
  });
  const gw = gateway({ payer: account.address });
  const r = await executeDirectPayment(makeAuth(account.address, { planId: 'brand-new' }), {
    account, body: BODY, receiptDir: dir, attributionTag: TAG, verify: verifyDeps('settled', account.address),
    getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl, again: true,
  });
  assert.equal(r.kind === 'not_sent' && r.code, 'PENDING_PAYMENT');
  assert.equal(gw.paidCount(), 0);
});

test('guard: an UNCERTAIN receipt for a plan still blocks it; a REJECTED one (proven unsettled) allows a deliberate retry', async () => {
  const account = testAccount();
  for (const [verify, expectCode] of [['unknown', 'PRIOR_RECEIPT'], ['not_settled', undefined]] as const) {
    const dir = tempDir();
    const gw = gateway({ payer: account.address });
    const common = { account, body: BODY, receiptDir: dir, attributionTag: TAG, getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl };
    const first = await executeDirectPayment(makeAuth(account.address, { planId: 'p' }), { ...common, verify: verifyDeps(verify, account.address) });
    assert.equal(first.kind, 'completed');
    // a pending journal from an UNCERTAIN outcome would also block; clear it so the receipt rule is what is tested
    for (const f of listPending(dir)) rmSync(join(dir, 'pending', f));
    const again = await executeDirectPayment(makeAuth(account.address, { planId: 'p' }), { ...common, verify: verifyDeps('settled', account.address) });
    assert.equal(again.kind === 'not_sent' ? again.code : undefined, expectCode, verify);
  }
});

test('preflight: unresolved journal, daily limit and swap cap each stop the order BEFORE anything is converted', async () => {
  // unresolved payment journal
  {
    const { w, deps, ctx, dir } = world();
    writePending(dir, { id: 'pending-z', createdAt: new Date(NOW).toISOString(), state: 'in_flight', planId: 'x', serviceId: 's', url: 'u', payer: '0x0', asset: '0x0', payTo: '0x0', amountAtomic: '1', note: 'n' });
    const o = await planOrder(deps, ctx());
    const r = await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind === 'refused' && r.code, 'PENDING_UNRESOLVED');
    assert.equal(w.calls.swap.length, 0);
  }
  // daily payment limit would be exceeded by the payment that follows the conversion
  {
    const { w, deps, ctx } = world();
    const d = { ...deps, maxPerDayAtomic: 4_000n };
    const o = await planOrder(d, ctx());
    const r = await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind === 'refused' && r.code, 'DAILY_LIMIT');
    assert.equal(w.calls.swap.length, 0, 'no conversion into a position from which payment is refused');
  }
  // per-day swap cap: a swap already counted today plus this one exceeds the cap
  {
    const { w, deps, ctx, dir } = world();
    mkdirSync(join(dir, 'swaps'), { recursive: true });
    writeFileSync(join(dir, 'swaps', 'earlier.json'), JSON.stringify({
      planId: 'earlier', state: 'CONFIRMED', code: 'CONFIRMED', updatedAt: new Date(NOW - 3_600_000).toISOString(), createdAt: new Date(NOW - 3_600_000).toISOString(),
      route: { sellSymbol: 'USDT', buySymbol: 'cNGN', provider: 'x' }, amounts: { requestedSell: '1500000' },
      steps: [{ kind: 'swap', hash: '0x' + '11'.repeat(32), status: 'mined' }], verification: {},
    }));
    const tight = { ...deps, dailySwapCapMicroUsd: 2_000_000n };
    const o = await planOrder(tight, ctx());
    const r = await executeOrder(o, ctx(), tight, { approvedBy: 'human:test', approvedDigest: o.digest });
    assert.equal(r.kind === 'refused' && r.code, 'SWAP_DAILY_CAP');
    assert.equal(w.calls.swap.length, 0);
    // with room under the cap the same order proceeds
    const roomy = { ...deps, dailySwapCapMicroUsd: 3_000_000n };
    const o2 = await planOrder(roomy, ctx());
    const r2 = await executeOrder(o2, ctx(), roomy, { approvedBy: 'human:test', approvedDigest: o2.digest });
    assert.equal(r2.kind === 'finished' && r2.state, 'COMPLETED');
  }
});

test('swap daily cap: counts UNCERTAIN and unresolved swaps, ignores FAILED swaps that sent nothing, and fails closed on unreadable history', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'swaps'), { recursive: true });
  mkdirSync(join(dir, 'pending'), { recursive: true });
  const rec = (planId: string, state: string, requestedSell: string, hash?: string) => ({
    planId, state, code: state, updatedAt: new Date(NOW).toISOString(), createdAt: new Date(NOW).toISOString(),
    route: { sellSymbol: 'USDT', buySymbol: 'cNGN', provider: 'x' }, amounts: { requestedSell },
    steps: hash ? [{ kind: 'swap', hash }] : [], verification: {},
  });
  writeFileSync(join(dir, 'swaps', 'a.json'), JSON.stringify(rec('a', 'CONFIRMED', '1000000', '0x' + 'aa'.repeat(32))));
  writeFileSync(join(dir, 'swaps', 'b.json'), JSON.stringify(rec('b', 'FAILED', '1000000')));
  writeFileSync(join(dir, 'pending', 'swap-c.json'), JSON.stringify(rec('c', 'UNCERTAIN', '500000', '0x' + 'cc'.repeat(32))));
  const n = swapNotionalSince(dir, NOW - 86_400_000);
  assert.equal(n.micro, 1_500_000n);
  assert.equal(n.counted, 2);
  assert.equal(checkSwapDailyCap(dir, { nowMs: NOW, addMicro: 600_000n, capMicro: 2_000_000n }).ok, false);
  assert.equal(checkSwapDailyCap(dir, { nowMs: NOW, addMicro: 400_000n, capMicro: 2_000_000n }).ok, true);
  assert.equal(checkSwapDailyCap(dir, { nowMs: NOW, addMicro: undefined, capMicro: 2_000_000n }).ok, false);
  writeFileSync(join(dir, 'swaps', 'broken.json'), '{not json');
  const c = checkSwapDailyCap(dir, { nowMs: NOW, addMicro: 1n, capMicro: 99_000_000n });
  assert.equal(!c.ok && c.code, 'SWAP_CAP_UNVERIFIABLE');
});

// ================================================================== STEP 2: receipts record the actual route
test('receipts: a converted payment records its real route and conversion; a direct one stays direct', () => {
  const direct = buildReceipt({
    now: new Date(NOW), auth: makeAuth(PAYER, { planId: 'p' }), payment: { txHash: undefined, authorization: undefined }, evidence: undefined,
    httpStatus: 200, clientOutcome: 'confirmed', delivered: true, responseSummary: 's', balances: { before: 1n, after: 0n }, attributionTag: TAG,
  });
  assert.equal(direct.flow, 'direct (no swap needed)');
  assert.equal(direct.conversion, null);
  assert.equal(direct.orderId, null);
  const converted = buildReceipt({
    now: new Date(NOW), auth: makeAuth(PAYER, { planId: 'p' }), payment: { txHash: undefined, authorization: undefined }, evidence: undefined,
    httpStatus: 200, clientOutcome: 'confirmed', delivered: true, responseSummary: 's', balances: { before: 1n, after: 0n }, attributionTag: TAG,
    order: {
      orderId: 'ord-1', route: 'converted',
      conversion: { provider: 'mento-router-v3', swapPlanId: 'swap-1', state: 'CONFIRMED', txHashes: ['0xabc'], sellSymbol: 'USDm', sellAmountAtomic: '1015267685224275700', buySymbol: 'USDT', receivedAtomic: '1016308' },
    },
  });
  assert.match(converted.flow, /converted via mento-router-v3, then paid directly/);
  assert.equal(converted.orderId, 'ord-1');
  assert.equal(converted.conversion?.swapPlanId, 'swap-1');
  assert.deepEqual(converted.conversion?.txHashes, ['0xabc']);
  assert.equal(converted.conversion?.sell?.symbol, 'USDm');
  assert.equal(converted.conversion?.buy?.receivedAtomic, '1016308');
});

test('order record links conversion plan + txs, payment tx and the delivery result; outcomes stay distinct', async () => {
  const { w, deps, ctx, dir } = world();
  const o = await planOrder(deps, ctx());
  await executeOrder(o, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o.digest });
  const rec = loadOrder(dir, o.orderId)!;
  assert.equal(rec.payment?.route, 'converted');
  assert.equal(rec.conversion?.swapPlanId, w.calls.swap[0]);
  assert.equal(rec.conversion?.sellSymbol, 'cNGN');
  assert.equal(rec.conversion?.buySymbol, 'USDT');
  assert.equal(rec.payment?.txHash, '0x' + 'ef'.repeat(32));
  assert.equal(rec.payment?.delivery?.delivered, true);
  assert.equal(rec.payment?.delivery?.responseSha256, 'ab'.repeat(32));
  assert.equal(w.links[0]!.route, 'converted', 'the pay step was told the actual route');
  assert.equal(w.links[0]!.conversion?.swapPlanId, w.calls.swap[0]);

  // the three payment outcomes map to three different order states
  const states: string[] = [];
  for (const pay of ['ok', 'unconfirmed', 'in_doubt'] as const) {
    const x = world({ balances: { USDT: 100_000n }, pay });
    const p = await planOrder(x.deps, x.ctx());
    const r = await executeOrder(p, x.ctx(), x.deps);
    states.push(r.kind === 'finished' ? `${r.state}/${r.record.payment?.status}` : 'refused');
  }
  assert.deepEqual(states, ['COMPLETED/CONFIRMED', 'UNCERTAIN/UNCERTAIN', 'UNCERTAIN/IN_DOUBT']);
});

// ================================================================== STEP 4: crash recovery
test('recovery: crash after the swap journal was written -> CONVERTING order is reconciled from journal + chain, then resumed without converting again', async () => {
  const { w, deps, ctx, dir } = world({ swap: 'crash_after_journal' });
  const verified = { ...deps, verifyConversionOnChain: async () => ({ established: true, detail: 'swap tx success, 1026000 USDT credited' }) };
  const o = await planOrder(verified, ctx());
  const r = await executeOrder(o, ctx(), verified, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.state, 'UNCERTAIN');
  assert.equal(r.kind === 'finished' && r.record.code, 'CONVERSION_ERROR');
  assert.equal(loadOrder(dir, o.orderId)!.conversion, undefined, 'the order file never learned the conversion result');
  assert.equal(w.calls.pay, 0);

  const rc = await reconcileOrder(o.orderId, verified);
  assert.equal(rc.kind, 'updated');
  const rec = loadOrder(dir, o.orderId)!;
  assert.equal(rec.state, 'STOPPED', 'converted, and no payment was ever started');
  assert.equal(rec.code, 'PAYMENT_NOT_STARTED');
  assert.equal(rec.conversion?.state, 'CONFIRMED');
  assert.ok(rec.recovery?.some((n) => /established from the chain/.test(n)), 'the recovery notes record how the conversion was established');
  assert.equal(w.calls.swap.length, 1);
  assert.equal(w.calls.pay, 0, 'reconcile never pays');

  const done = await resumeOrder(o.orderId, ctx(), verified);
  assert.equal(done.kind === 'finished' && done.state, 'COMPLETED', done.kind === 'refused' ? done.message : '');
  assert.equal(w.calls.swap.length, 1, 'the conversion was never repeated');
  assert.equal(w.calls.pay, 1);
});

test('recovery: without independent on-chain establishment the order is NOT promoted and cannot be resumed', async () => {
  for (const [label, verifier] of [
    ['no verifier wired', undefined],
    ['chain does not establish it', async () => ({ established: false, detail: 'no success receipt' })],
  ] as const) {
    const { w, deps, ctx, dir } = world({ swap: 'crash_after_journal' });
    const d = { ...deps, ...(verifier ? { verifyConversionOnChain: verifier } : {}) };
    const o = await planOrder(d, ctx());
    await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    const rc = await reconcileOrder(o.orderId, d);
    if (verifier) {
      assert.equal(rc.kind === 'updated' && rc.record.code, 'CONVERSION_NOT_ESTABLISHED', label);
    } else {
      assert.equal(rc.kind === 'refused' && rc.code, 'CONVERSION_NOT_VERIFIED', label);
    }
    const r = await resumeOrder(o.orderId, ctx(), d);
    assert.equal(r.kind, 'refused', label);
    assert.equal(w.calls.pay, 0, label);
    assert.equal(w.calls.swap.length, 1, label);
    assert.equal(loadOrder(dir, o.orderId)!.conversion?.state === 'CONFIRMED' && loadOrder(dir, o.orderId)!.steps[0]!.state === 'done', false, label);
  }
});

test('recovery: swap journal absent / FAILED / UNCERTAIN map to STOPPED / STOPPED / UNCERTAIN and are never resumed', async () => {
  const cases = [
    ['crash_before_journal', 'STOPPED', 'CONVERSION_NOT_STARTED'],
    ['failed', 'STOPPED', 'CONVERSION_FAILED'],
    ['uncertain', 'UNCERTAIN', 'CONVERSION_UNRESOLVED'],
  ] as const;
  for (const [swap, state, code] of cases) {
    const { w, deps, ctx, dir } = world({ swap });
    const d = { ...deps, verifyConversionOnChain: async () => ({ established: true, detail: 'x' }) };
    const o = await planOrder(d, ctx());
    await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    // simulate the crash window: the order file is stuck at CONVERTING with no conversion recorded
    const rec = loadOrder(dir, o.orderId)!;
    rec.state = 'CONVERTING';
    rec.code = 'STARTED';
    delete rec.conversion;
    writeFileSync(join(dir, 'orders', `${o.orderId}.json`), JSON.stringify(rec));
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.state, state, swap);
    assert.equal(rc.kind === 'updated' && rc.record.code, code, swap);
    const r = await resumeOrder(o.orderId, ctx(), d);
    assert.equal(r.kind, 'refused', swap);
    assert.equal(w.calls.pay, 0, swap);
  }
});

test('recovery: crash after the payment receipt was written -> COMPLETED from the receipt, never paid twice', async () => {
  const { w, deps, ctx, dir } = world({ pay: 'crash_after_receipt' });
  const d = { ...deps, verifyConversionOnChain: async () => ({ established: true, detail: 'x' }) };
  const o = await planOrder(d, ctx());
  const r = await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.state, 'UNCERTAIN');
  const rc = await reconcileOrder(o.orderId, d);
  assert.equal(rc.kind === 'updated' && rc.record.state, 'COMPLETED');
  assert.equal(loadOrder(dir, o.orderId)!.payment?.status, 'CONFIRMED');
  assert.equal(loadOrder(dir, o.orderId)!.payment?.route, 'converted');
  assert.equal(w.calls.pay, 1);
  const again = await resumeOrder(o.orderId, ctx(), d);
  assert.equal(again.kind, 'refused');
  assert.equal(w.calls.pay, 1, 'no second payment');
});

test('recovery: crash after the payment journal was written -> stays UNCERTAIN and blocks; crash before it -> payable exactly once on resume', async () => {
  {
    const { w, deps, ctx } = world({ pay: 'crash_after_journal' });
    const d = { ...deps, verifyConversionOnChain: async () => ({ established: true, detail: 'x' }) };
    const o = await planOrder(d, ctx());
    await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.code, 'PAYMENT_UNRESOLVED');
    const r = await resumeOrder(o.orderId, ctx(), d);
    assert.equal(r.kind, 'refused');
    assert.equal(w.calls.pay, 1);
    assert.equal(w.calls.swap.length, 1);
  }
  {
    const { w, deps, ctx, dir } = world({ pay: 'throw' });
    const d = { ...deps, verifyConversionOnChain: async () => ({ established: true, detail: 'x' }) };
    const o = await planOrder(d, ctx());
    await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.code, 'PAYMENT_NOT_STARTED');
    w.pay = 'ok';
    const r = await resumeOrder(o.orderId, ctx(), d);
    assert.equal(r.kind === 'finished' && r.state, 'COMPLETED', r.kind === 'refused' ? r.message : '');
    assert.equal(w.calls.swap.length, 1);
    assert.equal(w.calls.pay, 2);
    assert.equal(loadOrder(dir, o.orderId)!.state, 'COMPLETED');
  }
});

// ================================================================== STEP 5: order lock, approval digest, funds wait
test('order lock: a second order cannot interleave with a running one, nor start while the lock is held', async () => {
  const { w, deps, ctx, dir } = world();
  // hold the order lock from outside (another process)
  const held = await acquireLock(dir, { name: 'order' });
  const o0 = await planOrder(deps, ctx());
  const blocked = await executeOrder(o0, ctx(), deps, { approvedBy: 'human:test', approvedDigest: o0.digest });
  assert.equal(blocked.kind === 'refused' && blocked.code, 'ORDER_LOCK_HELD');
  assert.equal(w.calls.swap.length, 0);
  held.release();

  // a running order (conversion in progress) excludes a concurrent one
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: OrderDeps = {
    ...deps,
    swapRunners: { 'fake-venue': async (a) => { await gate; return deps.swapRunners['fake-venue']!(a); } },
  };
  const o1 = await planOrder(slow, ctx());
  const running = executeOrder(o1, ctx(), slow, { approvedBy: 'human:test', approvedDigest: o1.digest });
  await new Promise((r) => setTimeout(r, 50));
  const o2 = await planOrder(slow, ctx());
  const second = await executeOrder(o2, ctx(), slow, { approvedBy: 'human:test', approvedDigest: o2.digest });
  assert.equal(second.kind === 'refused' && second.code, 'ORDER_LOCK_HELD');
  release();
  const first = await running;
  assert.equal(first.kind === 'finished' && first.state, 'COMPLETED');
  assert.equal(w.calls.swap.length, 1);
  assert.ok(!existsSync(join(dir, 'locks', 'order.lock')), 'the order lock is released');
});

test('approval digest: required, must match the exact plan, is stable for an unchanged plan, and rejects a tampered plan', async () => {
  const { w, deps, ctx } = world();
  const a = await planOrder(deps, ctx());
  const b = await planOrder(deps, ctx());
  assert.notEqual(a.orderId, b.orderId);
  assert.equal(a.digest, b.digest, 'an unchanged situation has the same digest');
  assert.equal(a.approval.required, true);

  const none = await executeOrder(a, ctx(), deps, { approvedBy: 'human:test' });
  assert.equal(none.kind === 'refused' && none.code, 'APPROVAL_DIGEST_REQUIRED');
  const wrong = await executeOrder(a, ctx(), deps, { approvedBy: 'human:test', approvedDigest: 'f'.repeat(64) });
  assert.equal(wrong.kind === 'refused' && wrong.code, 'APPROVAL_DIGEST_MISMATCH');
  const short = await executeOrder(a, ctx(), deps, { approvedBy: 'human:test', approvedDigest: a.digest.slice(0, 6) });
  assert.equal(short.kind === 'refused' && short.code, 'APPROVAL_DIGEST_MISMATCH', 'a prefix shorter than 12 characters is not accepted');
  assert.equal(w.calls.swap.length, 0);

  // a plan that changed after approval (price moved) has a different digest
  const w2 = world({ discover: required([offer('USDT', 6_000n)]) });
  const c = await planOrder(w2.deps, w2.ctx());
  assert.notEqual(c.digest, a.digest);
  const stale = await executeOrder(c, w2.ctx(), w2.deps, { approvedBy: 'human:test', approvedDigest: a.digest });
  assert.equal(stale.kind === 'refused' && stale.code, 'APPROVAL_DIGEST_MISMATCH');

  // editing the plan object after it was digested is detected
  const t = await planOrder(deps, ctx());
  (t.payment.payment as { amountAtomic: bigint }).amountAtomic = 1n;
  const tam = await executeOrder(t, ctx(), deps, { approvedBy: 'human:test', approvedDigest: t.digest });
  assert.equal(tam.kind === 'refused' && tam.code, 'PLAN_TAMPERED');

  // the right digest (a 12-character prefix is enough) proceeds
  const ok = await executeOrder(a, ctx(), deps, { approvedBy: 'human:test', approvedDigest: a.digest.slice(0, 12) });
  assert.equal(ok.kind === 'finished' && ok.state, 'COMPLETED');
});

test('converted funds must be visible (exact-block wait) before the re-price; otherwise stop with the funds noted', async () => {
  const seen: unknown[] = [];
  const late = world();
  const dLate: OrderDeps = {
    ...late.deps,
    awaitConvertedFunds: async (req) => {
      seen.push(req);
      return { ok: false, detail: 'balance at block 100 is 0 after 5 attempts' };
    },
  };
  const o = await planOrder(dLate, late.ctx());
  const r = await executeOrder(o, late.ctx(), dLate, { approvedBy: 'human:test', approvedDigest: o.digest });
  assert.equal(r.kind === 'finished' && r.record.code, 'CONVERTED_FUNDS_NOT_VISIBLE');
  assert.equal(late.w.calls.pay, 0);
  assert.equal(late.w.calls.discover, 1, 'no re-price against an unconfirmed balance');
  const req = seen[0] as { minAtomic: bigint; txHashes: string[]; asset: string };
  assert.equal(req.minAtomic, 5_000n);
  assert.equal(req.txHashes.length, 1);

  const fine = world();
  const dOk: OrderDeps = { ...fine.deps, awaitConvertedFunds: async () => ({ ok: true, detail: 'visible at block 123' }) };
  const o2 = await planOrder(dOk, fine.ctx());
  const r2 = await executeOrder(o2, fine.ctx(), dOk, { approvedBy: 'human:test', approvedDigest: o2.digest });
  assert.equal(r2.kind === 'finished' && r2.state, 'COMPLETED');
});

// ================================================================== PHASE 3: recovery edge cases
const established = async () => ({ established: true, detail: 'ok' });

test('recovery: a transient chain-read failure changes NOTHING and can be retried (previously it stranded the order)', async () => {
  const { w, deps, ctx, dir } = world({ swap: 'crash_after_journal' });
  let reachable = false;
  const d: OrderDeps = {
    ...deps,
    verifyConversionOnChain: async () => (reachable ? { established: true, detail: 'ok' } : { established: false, retryable: true, detail: 'RPC timeout' }),
  };
  const o = await planOrder(d, ctx());
  await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
  const before = JSON.stringify(loadOrder(dir, o.orderId));

  const r1 = await reconcileOrder(o.orderId, d);
  assert.equal(r1.kind === 'refused' && r1.code, 'CONVERSION_VERIFICATION_UNAVAILABLE');
  assert.equal(JSON.stringify(loadOrder(dir, o.orderId)), before, 'the order file was not touched');
  const r2 = await resumeOrder(o.orderId, ctx(), d);
  assert.equal(r2.kind, 'refused');
  assert.equal(w.calls.pay, 0);

  reachable = true; // the node is back
  const r3 = await resumeOrder(o.orderId, ctx(), d);
  assert.equal(r3.kind === 'finished' && r3.state, 'COMPLETED', r3.kind === 'refused' ? r3.message : '');
  assert.equal(w.calls.swap.length, 1, 'the conversion was never repeated');
  assert.equal(w.calls.pay, 1);
});

test('recovery: "chain does not establish it" is re-checked next time (never frozen as CONFIRMED) and can later be promoted', async () => {
  const { w, deps, ctx, dir } = world({ swap: 'crash_after_journal' });
  let ok = false;
  const d: OrderDeps = { ...deps, verifyConversionOnChain: async () => ({ established: ok, detail: ok ? 'now visible' : 'no success receipt yet' }) };
  const o = await planOrder(d, ctx());
  await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
  const a = await reconcileOrder(o.orderId, d);
  assert.equal(a.kind === 'updated' && a.record.code, 'CONVERSION_NOT_ESTABLISHED');
  assert.notEqual(loadOrder(dir, o.orderId)!.conversion?.state, 'CONFIRMED', 'an unestablished conversion is never recorded as CONFIRMED');
  assert.equal((await resumeOrder(o.orderId, ctx(), d)).kind, 'refused');

  ok = true;
  const b = await reconcileOrder(o.orderId, d);
  assert.equal(b.kind, 'updated');
  assert.equal(loadOrder(dir, o.orderId)!.conversion?.state, 'CONFIRMED');
  const c = await resumeOrder(o.orderId, ctx(), d);
  assert.equal(c.kind === 'finished' && c.state, 'COMPLETED');
  assert.equal(w.calls.swap.length, 1);
  assert.equal(w.calls.pay, 1);
});

test('recovery: a swap that delivered a different asset, or ran through a different venue, is refused for this order', async () => {
  for (const [label, edit] of [
    ['different asset', (r: Record<string, any>) => { r.approved.asset = assetBySymbol('USDC')!.address; }],
    ['different venue', (r: Record<string, any>) => { r.approved.conversionProvider = 'some-other-venue'; }],
  ] as const) {
    const { w, deps, ctx, dir } = world({ swap: 'crash_after_journal' });
    const d = { ...deps, verifyConversionOnChain: established };
    const o = await planOrder(d, ctx());
    await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    const f = join(dir, 'orders', `${o.orderId}.json`);
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    edit(rec);
    writeFileSync(f, JSON.stringify(rec));
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.code, 'CONVERSION_MISMATCH', label);
    assert.equal((await resumeOrder(o.orderId, ctx(), d)).kind, 'refused', label);
    assert.equal(w.calls.pay, 0, label);
  }
});

test('recovery: crash before the swap plan id was even saved -> STOPPED, nothing converted, nothing paid', async () => {
  const { w, deps, ctx, dir } = world({ balances: { USDT: 100_000n } });
  const o = await planOrder(deps, ctx());
  await executeOrder(o, ctx(), deps);
  const f = join(dir, 'orders', `${o.orderId}.json`);
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  rec.state = 'CONVERTING';
  rec.code = 'STARTED';
  rec.steps = [{ kind: 'convert', state: 'pending' }, { kind: 'pay', state: 'pending' }];
  delete rec.conversion;
  delete rec.payment;
  writeFileSync(f, JSON.stringify(rec));
  rmSync(join(dir, 'direct-1.json')); // as if the payment had never been written
  const rc = await reconcileOrder(o.orderId, deps);
  assert.equal(rc.kind === 'updated' && rc.record.code, 'CONVERSION_NOT_STARTED');
  assert.equal(w.calls.swap.length, 0);
});

test('recovery: concurrent resumes pay at most once (order lock + payment guard)', async () => {
  const { w, deps, ctx } = world({ pay: 'throw' });
  const d = { ...deps, verifyConversionOnChain: established };
  const o = await planOrder(d, ctx());
  await executeOrder(o, ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
  w.pay = 'ok';
  const results = await Promise.all([resumeOrder(o.orderId, ctx(), d), resumeOrder(o.orderId, ctx(), d), resumeOrder(o.orderId, ctx(), d)]);
  assert.equal(results.filter((r) => r.kind === 'finished' && r.state === 'COMPLETED').length, 1);
  assert.equal(w.calls.pay, 2, 'the failed first attempt plus exactly one resumed payment');
  assert.equal(w.calls.swap.length, 1);
});

test('payment resolution: SETTLED stays blocked-from-repeat and counts as spent; NOT_SETTLED allows a deliberate retry; unknown changes nothing', async () => {
  const { resolvePayment } = await import('../src/paymentresolve.ts');
  const { readHistory, assertNoPriorPayment, spentSince } = await import('../src/history.ts');
  const account = testAccount();

  for (const outcome of ['settled', 'not_settled', 'unknown'] as const) {
    const dir = tempDir();
    const gw = gateway({ payer: account.address });
    const plan = makeAuth(account.address, { planId: `plan-${outcome}` });
    const first = await executeDirectPayment(plan, {
      account, body: BODY, receiptDir: dir, attributionTag: TAG, verify: verifyDeps('unknown', account.address),
      getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl,
      order: { orderId: `order-${outcome}`, route: 'direct' },
    });
    assert.equal(first.kind, 'completed');
    const rcpt = first.kind === 'completed' ? first.receipt : (undefined as never);
    assert.equal(rcpt.status, 'UNCERTAIN');
    assert.equal(listPending(dir).length, 1, 'the payment journal blocks');
    assert.throws(() => assertNoPriorPayment(dir, { again: false, scope: { planId: 'other' } }), /in flight|unresolved/i);

    const r = await resolvePayment(dir, rcpt.id, { verify: verifyDeps(outcome, account.address), now: () => new Date(NOW) });
    if (outcome === 'unknown') {
      assert.equal(r.kind, 'still_uncertain');
      assert.equal(listPending(dir).length, 1, 'nothing changed');
      assert.equal(existsSync(join(dir, 'resolutions')), false);
      continue;
    }
    assert.equal(r.kind, 'resolved');
    assert.equal(listPending(dir).length, 0, 'the payment journal is cleared once the outcome is decided');
    assert.equal(JSON.parse(readFileSync(join(dir, `${rcpt.id}.json`), 'utf8')).status, 'UNCERTAIN', 'the receipt itself is untouched');
    const h = readHistory(dir);
    if (outcome === 'settled') {
      assert.equal(h.receipts[0]!.resolution, 'SETTLED');
      assert.equal(spentSince(h, 0), 5_000n, 'settled money counts as spent');
      assert.throws(() => assertNoPriorPayment(dir, { again: false, scope: { planId: `plan-${outcome}` } }), /already paid/);
    } else {
      assert.equal(h.receipts[0]!.status, 'REJECTED');
      assert.equal(spentSince(h, 0), 0n, 'nothing was charged');
      assert.doesNotThrow(() => assertNoPriorPayment(dir, { again: false, scope: { planId: `plan-${outcome}`, orderId: `order-${outcome}` } }));
    }
    const again = await resolvePayment(dir, rcpt.id, { verify: verifyDeps('unknown', account.address), now: () => new Date(NOW + 1) });
    assert.equal(again.kind, 'already_resolved', 'idempotent, never overwrites');
  }
});

test('payment resolution: refuses a CONFIRMED receipt, a missing receipt, an unsafe id, and a receipt with no recorded authorization', async () => {
  const { resolvePayment } = await import('../src/paymentresolve.ts');
  const account = testAccount();
  const dir = tempDir();
  const gw = gateway({ payer: account.address });
  const ok = await executeDirectPayment(makeAuth(account.address, { planId: 'p-ok' }), {
    account, body: BODY, receiptDir: dir, attributionTag: TAG, verify: verifyDeps('settled', account.address), getBalance: async () => 600_000n, fetchImpl: gw.fetchImpl,
  });
  const deps = { verify: verifyDeps('settled', account.address), now: () => new Date(NOW) };
  const id = ok.kind === 'completed' ? ok.receipt.id : '';
  const code = async (rid: string) => {
    const r = await resolvePayment(dir, rid, deps);
    return r.kind === 'refused' ? r.code : r.kind;
  };
  assert.equal(await code(id), 'NOT_UNCERTAIN');
  assert.equal(await code('nope'), 'RECEIPT_NOT_FOUND');
  assert.equal(await code('../../etc/passwd'), 'BAD_ID');
  writeFileSync(join(dir, 'direct-x.json'), JSON.stringify({
    id: 'direct-x', createdAt: new Date(NOW).toISOString(), status: 'UNCERTAIN',
    payment: { amountAtomic: '5000', asset: '0x0', payer: '0x0', payTo: '0x0', authorization: null },
  }));
  assert.equal(await code('direct-x'), 'NO_AUTHORIZATION_RECORDED');
});

test('recovery: a resolution closes the loop for an order (NOT_SETTLED -> resumable and paid once; SETTLED undelivered -> stays UNCERTAIN, never repaid)', async () => {
  const mk = async () => {
    const x = world({ pay: 'unconfirmed' });
    const d = { ...x.deps, verifyConversionOnChain: established };
    const o = await planOrder(d, x.ctx());
    await executeOrder(o, x.ctx(), d, { approvedBy: 'human:test', approvedDigest: o.digest });
    return { ...x, d, o };
  };
  const writeRes = (dir: string, outcome: 'SETTLED' | 'NOT_SETTLED') => {
    mkdirSync(join(dir, 'resolutions'), { recursive: true });
    writeFileSync(join(dir, 'resolutions', 'direct-1.json'), JSON.stringify({ receiptId: 'direct-1', outcome }));
  };
  {
    const { w, d, o, dir, ctx } = await mk();
    writeRes(dir, 'NOT_SETTLED');
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.code, 'PAYMENT_REJECTED');
    w.pay = 'ok';
    const r = await resumeOrder(o.orderId, ctx(), d);
    assert.equal(r.kind === 'finished' && r.state, 'COMPLETED', r.kind === 'refused' ? r.message : '');
    assert.equal(w.calls.swap.length, 1, 'the conversion was not repeated');
    assert.equal(w.calls.pay, 2);
  }
  {
    const { w, d, o, dir, ctx } = await mk();
    writeRes(dir, 'SETTLED');
    const rc = await reconcileOrder(o.orderId, d);
    assert.equal(rc.kind === 'updated' && rc.record.code, 'PAYMENT_SETTLED_DELIVERY_UNCONFIRMED');
    assert.equal((await resumeOrder(o.orderId, ctx(), d)).kind, 'refused');
    assert.equal(w.calls.pay, 1);
  }
});

// ================================================================== user-chosen funding currency
test('source currency: a user who holds USDT AND cNGN can choose cNGN and gets a convert-then-pay plan; USDT stays direct', async () => {
  const { w, deps, ctx } = world({ balances: { USDT: 100_000n, cNGN: 1_400_000_000n } });
  const auto = await planOrder(deps, ctx());
  assert.equal(auto.route, 'direct', 'unchosen: the planner pays directly');

  const viaCngn = await planOrder(deps, { ...ctx(), sourceSymbol: 'cNGN' });
  assert.equal(viaCngn.route, 'swap');
  assert.deepEqual(viaCngn.steps.map((s) => s.kind), ['convert', 'pay']);
  assert.equal(viaCngn.payment.funding?.kind === 'swap' && viaCngn.payment.funding.sellSymbol, 'cNGN');
  assert.notEqual(viaCngn.digest, auto.digest, 'the choice changes the plan the approval is bound to');

  const viaUsdt = await planOrder(deps, { ...ctx(), sourceSymbol: 'USDT' });
  assert.equal(viaUsdt.route, 'direct');
  assert.equal(w.calls.swap.length, 0, 'planning never converts');

  // and the whole order runs end to end from the chosen currency
  const done = await executeOrder(viaCngn, ctx(), deps, { approvedBy: 'human:test', approvedDigest: viaCngn.digest });
  assert.equal(done.kind === 'finished' && done.state, 'COMPLETED');
  assert.equal(w.calls.swap.length, 1);
  assert.equal(w.links[0]!.route, 'converted');
});

test('source currency: an unaffordable chosen currency does NOT silently fall back to another; unsupported ones are refused', async () => {
  const { deps, ctx } = world({ balances: { USDT: 100_000n, cNGN: 0n } });
  const noCngn = await planOrder(deps, { ...ctx(), sourceSymbol: 'cNGN' });
  assert.equal(noCngn.status, 'BLOCKED');
  assert.equal(noCngn.route, null, 'it did not quietly pay with USDT instead');

  // this fake service accepts only USDT, so USDC is neither accepted nor a conversion source
  const noUsdc = await planOrder(deps, { ...ctx(), sourceSymbol: 'USDC' });
  assert.equal(noUsdc.status, 'BLOCKED');
  assert.ok(noUsdc.payment.blockers.some((b) => b.code === 'SOURCE_NOT_SUPPORTED'));

  // an ACCEPTED asset the wallet does not hold is reported as insufficient funds, not swapped around
  const accepted = world({ balances: { cNGN: 1_400_000_000n }, discover: required([offer('USDT'), offer('USDC')]) });
  const noUsdt = await planOrder(accepted.deps, { ...accepted.ctx(), sourceSymbol: 'USDC' });
  assert.equal(noUsdt.status, 'BLOCKED');
  assert.ok(noUsdt.payment.blockers.some((b) => b.code === 'NO_FUNDS'));

  const nonsense = await planOrder(deps, { ...ctx(), sourceSymbol: 'DOGE' });
  assert.equal(nonsense.status, 'BLOCKED');
  assert.ok(nonsense.payment.blockers.some((b) => b.code === 'SOURCE_NOT_SUPPORTED'));
});
