import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import type { Asset } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { AuthorizationRefused, authorizeConversion, planConversion, renderConversionPlan } from '../src/planner.ts';
import type { ConversionDeps } from '../src/planner.ts';
import { DEFAULT_POLICY, policyFromEnv } from '../src/policy.ts';
import type { SpendingPolicy } from '../src/policy.ts';
import type { RouteResult } from '../src/routes.ts';

const NOW = 1_800_000_000_000;
const PAYER: Address = '0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4';
const A = (s: string): Asset => assetBySymbol(s)!;
const ONE_USDT = 1_000_000n;

interface Opts {
  balances?: Record<string, bigint>;
  allowance?: bigint;
  native?: bigint;
  route?: (sell: Asset, buy: Asset, amount: bigint) => RouteResult;
  policy?: Partial<SpendingPolicy>;
  swapExecution?: boolean;
  measured?: bigint | undefined;
  now?: number;
}

const okRoute = (sell: Asset, buy: Asset, amount: bigint, buyAmount = 1_366_408_708n): RouteResult => ({
  kind: 'route',
  provider: 'fake-textile',
  quoteState: 'preview',
  sell,
  buy,
  sellAmount: amount,
  buyAmount,
  feeAmount: 99n,
  takerPays: amount,
  minSellAmount: 1_000_000n,
  availableSellAmount: 46_000_000_000n,
  fetchedAt: NOW,
});

function deps(o: Opts = {}) {
  const lookups = { routes: 0 };
  const d: ConversionDeps = {
    now: () => o.now ?? NOW,
    policy: { ...DEFAULT_POLICY, ...(o.policy ?? {}) },
    async getBalances(_owner, assets) {
      return new Map(assets.map((a) => [a.address.toLowerCase(), o.balances?.[a.symbol] ?? 0n]));
    },
    async getNativeBalance() {
      return o.native ?? 595_000_000_000_000_000n;
    },
    async gasPriceWei() {
      return 202_500_000_000n;
    },
    async getAllowance() {
      return o.allowance ?? 0n;
    },
    ...(o.measured !== undefined ? { measureApproveGas: async () => o.measured! } : {}),
    routes: {
      name: 'fake-textile',
      async findRoute() {
        throw new Error('findRoute must not be used for a standalone conversion');
      },
      async quoteExactInput(r) {
        lookups.routes += 1;
        return (o.route ?? ((s, b, a) => okRoute(s, b, a)))(r.sell, r.buy, r.sellAmount);
      },
    },
    newId: () => 'conv-1',
    ...(o.swapExecution === false ? {} : { swapExecution: true }),
  };
  return { d, lookups };
}
const plan = (o: Opts = {}, sell = 'USDT', buy = 'cNGN', amount = ONE_USDT) => {
  const { d, lookups } = deps(o);
  return planConversion(d, { sell, buy, sellAmountAtomic: amount, payer: PAYER }).then((p) => ({ p, lookups }));
};

// ------------------------------------------------------------------ the happy path (the first live test)
test('USDT -> cNGN with a funded wallet: approval + swap plan, preview-only, exact approval, floor from slippage', async () => {
  const { p } = await plan({ balances: { USDT: 1_100_000n }, measured: 54_194n });
  assert.equal(p.status, 'APPROVAL_REQUIRED', 'conversions need human approval by default');
  assert.equal(p.executable, true);
  assert.deepEqual(p.blockers.map((b) => b.code), ['FIRM_QUOTE_REQUIRED']);
  assert.equal(p.quote?.state, 'preview');
  assert.equal(p.buy.expectedAtomic, 1_366_408_708n);
  assert.equal(p.buy.minAtomic, (1_366_408_708n * 9_900n) / 10_000n, 'floor = expected minus the 100 bps tolerance');
  assert.equal(p.allowance?.spender, TEXTILE_REACTOR);
  assert.equal(p.allowance?.approvalRequired, true);
  assert.equal(p.allowance?.resetRequired, false);
  assert.deepEqual(p.knownTransactions.map((t) => t.kind), ['approve']);
  assert.ok(p.knownTransactions[0]!.description.includes('exactly 1 USDT'));
  assert.equal(p.after?.sellAtomic, 100_000n);
  assert.equal(p.after?.buyAtomic, 1_366_408_708n);
  assert.equal(p.gas?.approveGasMeasured, 54_194n, 'approve gas is a MEASURED figure when available');
  assert.equal(p.gas?.transactions, 2);
});

test('existing allowance that covers the amount: no approval transaction is planned', async () => {
  const { p } = await plan({ balances: { USDT: 1_100_000n }, allowance: ONE_USDT });
  assert.equal(p.allowance?.approvalRequired, false);
  assert.deepEqual(p.knownTransactions, []);
  assert.equal(p.gas?.transactions, 1);
});

test('a partial non-zero allowance of a USDT-style token is reset to zero first', async () => {
  const { p } = await plan({ balances: { USDT: 1_100_000n }, allowance: 1n });
  assert.equal(p.allowance?.resetRequired, true);
  assert.deepEqual(p.knownTransactions.map((t) => t.kind), ['approve_reset', 'approve']);
  assert.equal(p.gas?.transactions, 3);
});

// ------------------------------------------------------------------ blockers
test('the CURRENT real situation: 0.625 USDT cannot convert 1 USDT; the shortfall is exact', async () => {
  const { p } = await plan({ balances: { USDT: 624_915n } });
  assert.equal(p.status, 'INSUFFICIENT_BALANCE');
  assert.equal(p.executable, false);
  assert.ok(p.blockers.some((b) => b.code === 'INSUFFICIENT_BALANCE' && b.message.includes('375085')));
  assert.equal(p.after, null);
});

test('an amount below the corridor minimum is reported as such, not as a balance problem', async () => {
  const { p } = await plan({
    balances: { USDT: 1_100_000n },
    route: (s, b) => ({ kind: 'none', provider: 'fake', code: 'BELOW_MINIMUM', message: 'below minimum', sell: s, buy: b, minSellAmount: 1_000_000n }),
  }, 'USDT', 'cNGN', 500_000n);
  assert.equal(p.status, 'NEEDS_REVIEW');
  assert.ok(p.blockers.some((b) => b.code === 'BELOW_MINIMUM'));
});

test('no live corridor -> NO_SUPPORTED_ROUTE; provider failure -> NEEDS_REVIEW', async () => {
  const none = await plan({ balances: { USDT: 2_000_000n }, route: (s, b) => ({ kind: 'none', provider: 'f', code: 'CORRIDOR_UNAVAILABLE', message: 'x', sell: s, buy: b }) });
  assert.equal(none.p.status, 'NO_SUPPORTED_ROUTE');
  const err = await plan({ balances: { USDT: 2_000_000n }, route: (s, b) => ({ kind: 'none', provider: 'f', code: 'PROVIDER_ERROR', message: 'x', sell: s, buy: b }) });
  assert.equal(err.p.status, 'NEEDS_REVIEW');
});

test('a pair that policy does not allow is blocked before any provider call', async () => {
  const { p, lookups } = await plan({ balances: { USDC: 2_000_000n } }, 'USDC', 'USDT');
  assert.equal(p.status, 'POLICY_BLOCKED');
  assert.equal(lookups.routes, 0);
  assert.equal(p.executable, false);
});

test('a conversion larger than the swap limit is blocked by policy', async () => {
  const { p } = await plan({ balances: { USDT: 10_000_000n }, policy: { maxSwapNotionalMicroUsd: 500_000n } });
  assert.equal(p.status, 'POLICY_BLOCKED');
  assert.ok(p.policy.blocked.some((b) => b.includes('exceeds the limit')));
});

test('gas is not ignored: no CELO and no fee token -> INSUFFICIENT_BALANCE with INSUFFICIENT_GAS', async () => {
  const { p } = await plan({ balances: { USDT: 1_000_000n }, native: 0n });
  // the only fee-capable stablecoin held is the SELL asset, which does not count as spare gas money
  assert.equal(p.status, 'INSUFFICIENT_BALANCE');
  assert.ok(p.blockers.some((b) => b.code === 'INSUFFICIENT_GAS'));
});

test('the swap-executor flag controls the NOT_IMPLEMENTED blocker', async () => {
  const off = (await plan({ balances: { USDT: 1_100_000n }, swapExecution: false })).p;
  assert.ok(off.blockers.some((b) => b.code === 'SWAP_EXECUTION_NOT_IMPLEMENTED'));
  assert.equal(off.executable, false);
  assert.throws(() => authorizeConversion(off, { now: NOW, approvedBy: 'x' }), AuthorizationRefused);
});

// ------------------------------------------------------------------ authorization
test('authorizeConversion: needs approval, a fresh plan and an executable status; mints a bounded authorization', async () => {
  const { p } = await plan({ balances: { USDT: 1_100_000n } });
  assert.throws(() => authorizeConversion(p, { now: NOW }), (e) => e instanceof AuthorizationRefused && e.code === 'APPROVAL_REQUIRED');
  assert.throws(() => authorizeConversion(p, { now: p.validUntilMs + 1, approvedBy: 'x' }), (e) => e instanceof AuthorizationRefused && e.code === 'PLAN_EXPIRED');
  const a = authorizeConversion(p, { now: NOW, approvedBy: 'human:test' });
  assert.equal(a.serviceId, 'convert:USDT->cNGN');
  assert.equal(a.sell.sellAmountAtomic, ONE_USDT);
  assert.equal(a.sell.maxTakerPaysAtomic, ONE_USDT, 'the quote may never debit more than the planned amount');
  assert.equal(a.buy.minBuyAtomic, p.buy.minAtomic);
  assert.equal(a.buy.expectedBuyAtomic, p.buy.expectedAtomic);
  assert.equal(a.approvedBy, 'human:test');

  const blocked = (await plan({ balances: { USDT: 624_915n } })).p;
  assert.throws(() => authorizeConversion(blocked, { now: NOW, approvedBy: 'x' }), AuthorizationRefused);
});

// ------------------------------------------------------------------ rendering + env policy
test('the rendered plan states amount, expected output, rate, fee, approval, gas and what is unknown', async () => {
  const { p } = await plan({ balances: { USDT: 1_100_000n }, measured: 54_194n });
  const text = renderConversionPlan(p);
  for (const needle of ['convert : 1 USDT -> cNGN', 'INDICATIVE', 'floor', 'fee', 'after', 'approve(', 'exactly 1 USDT', 'MEASURED', 'ASSUMED', 'FIRM_QUOTE_REQUIRED']) {
    assert.ok(text.includes(needle), `missing "${needle}"`);
  }
});

test('policyFromEnv: conversion pairs and slippage are parsed strictly', () => {
  const p = policyFromEnv({ PAYRAIL_ALLOWED_CONVERSIONS: 'USDT:cNGN', PAYRAIL_CONVERSION_SLIPPAGE_BPS: '50' }, DEFAULT_POLICY);
  assert.deepEqual(p.allowedConversions.map((c) => c.join('>')), ['USDT>cNGN']);
  assert.equal(p.conversionSlippageBps, 50);
  assert.throws(() => policyFromEnv({ PAYRAIL_ALLOWED_CONVERSIONS: 'USDT' }, DEFAULT_POLICY));
  assert.throws(() => policyFromEnv({ PAYRAIL_ALLOWED_CONVERSIONS: 'A:B:C' }, DEFAULT_POLICY));
  assert.throws(() => policyFromEnv({ PAYRAIL_CONVERSION_SLIPPAGE_BPS: '5000' }, DEFAULT_POLICY));
  assert.throws(() => policyFromEnv({ PAYRAIL_CONVERSION_SLIPPAGE_BPS: 'abc' }, DEFAULT_POLICY));
});
