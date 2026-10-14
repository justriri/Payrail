// Mock tests for the Mento (AMM) conversion venue. Nothing here touches a network or real funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { assetBySymbol } from '../src/assets.ts';
import type { Asset } from '../src/assets.ts';
import { mintSwapAuthorization } from '../src/authorization.ts';
import type { SwapAuthorization } from '../src/authorization.ts';
import { listPending } from '../src/history.ts';
import {
  MENTO_FACTORY, MENTO_PROVIDER, MENTO_ROUTER, createMentoRouteProvider, createMentoVenue, mentoRouterAbi,
} from '../src/mento.ts';
import type { ReadClient } from '../src/mento.ts';
import { AuthorizationRefused, authorizeConversion, planConversion } from '../src/planner.ts';
import type { ConversionDeps } from '../src/planner.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { createCompositeRouteProvider } from '../src/routes.ts';
import type { RouteProvider, RouteResult } from '../src/routes.ts';
import { runAmmSwap } from '../src/swapexec.ts';
import type { SwapOutcome } from '../src/swapexec.ts';
import { tempDir } from './support.ts';
import { MAKER, MockChain, NOW, OTHER, PAYER, TAG, approveNo, approveYes, harness } from './swapsupport.ts';

const USDM = assetBySymbol('USDm')!;
const USDT = assetBySymbol('USDT')!;
const CNGN = assetBySymbol('cNGN')!;
const SELL = 1_015_267_685_224_275_700n; // 1.0152676852... USDm (18 decimals)
const QUOTE = 1_016_319n; // 1.016319 USDT (6 decimals)
const MIN_BUY = 1_000_000n; // the plan's floor: at least 1.0 USDT

function ammAuth(over: Partial<{ planId: string; provider: string; minBuy: bigint; slippageBps: number; payer: Address }> = {}): SwapAuthorization {
  return mintSwapAuthorization({
    planId: over.planId ?? 'plan-amm-1',
    route: 'swap',
    serviceId: 'convert:USDm->USDT',
    payer: over.payer ?? PAYER,
    chainId: 42220,
    provider: over.provider ?? MENTO_PROVIDER,
    sell: { asset: USDM.address, symbol: 'USDm', decimals: 18, sellAmountAtomic: SELL, maxTakerPaysAtomic: SELL },
    buy: { asset: USDT.address, symbol: 'USDT', minBuyAtomic: over.minBuy ?? MIN_BUY, expectedBuyAtomic: QUOTE },
    slippageBps: over.slippageBps ?? 100,
    createdAtMs: NOW,
    expiresAtMs: NOW + 600_000,
    approvedBy: 'test',
  });
}

function readClient(quote: () => bigint | Error): ReadClient & { calls: number } {
  const c = {
    calls: 0,
    async readContract() {
      c.calls += 1;
      const q = quote();
      if (q instanceof Error) throw q;
      return [SELL, q] as readonly bigint[];
    },
  };
  return c as ReadClient & { calls: number };
}

const POOL = getAddress('0x0FEBa760d93423D127DE1B6ABECdB60E5253228D');
function chainFor(extra: ConstructorParameters<typeof MockChain>[0] = {}, allowance: bigint | undefined = 0n) {
  const chain = new MockChain({
    effect: { sellToken: USDM.address, sellAmount: SELL, buyToken: USDT.address, buyAmount: QUOTE, counterparty: POOL, fill: false },
    ...extra,
  });
  chain.balances.set(USDM.address.toLowerCase(), SELL);
  chain.balances.set(USDT.address.toLowerCase(), 624_915n);
  if (allowance !== undefined) chain.allowances.set(`${USDM.address}:${MENTO_ROUTER}`.toLowerCase(), allowance);
  return chain;
}

const finished = (o: SwapOutcome) => {
  assert.equal(o.kind, 'finished', o.kind === 'refused' ? `${o.code}: ${o.message}` : '');
  return o.kind === 'finished' ? o : (undefined as never);
};
const setup = (o: { extra?: ConstructorParameters<typeof MockChain>[0]; allowance?: bigint; quote?: () => bigint | Error } = {}) => {
  const chain = chainFor(o.extra, o.allowance ?? 0n);
  const h = harness({ dir: tempDir(), chainObj: chain });
  const rc = readClient(o.quote ?? (() => QUOTE));
  const venue = createMentoVenue(rc);
  return { chain, h, venue, rc };
};
const swapData = (chain: MockChain) => {
  const b = chain.broadcasts.find((x) => x.kind === 'swap')!;
  // strip the 35-byte attribution suffix to decode the original call
  const untagged = (b.data.slice(0, b.data.length - 70)) as Hex;
  return decodeFunctionData({ abi: mentoRouterAbi, data: untagged });
};

// ------------------------------------------------------------------ happy path
test('USDm -> USDT: approve exactly the input to the Router, then a tagged single-hop swap, fully verified', async () => {
  const { chain, h, venue } = setup();
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.state, 'CONFIRMED', o.record.message);
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['approve', 'swap']);
  const approveTx = chain.broadcasts.find((b) => b.kind === 'approve')!;
  const approval = decodeFunctionData({ abi: erc20Abi, data: approveTx.data as Hex });
  assert.equal(approval.functionName, 'approve');
  assert.equal(getAddress(approval.args![0] as Address), getAddress(MENTO_ROUTER), 'approved to the router');
  assert.equal(approval.args![1], SELL, 'approved exactly the input');
  assert.equal(o.record.residualAllowance, '0', 'the exact approval was fully consumed by the swap');
  for (const b of chain.broadcasts) assert.ok(b.data.toLowerCase().endsWith('80218021802180218021802180218021'), 'every transaction is tagged');
  assert.ok(o.record.steps.every((s) => s.attribution?.verified === true));
  assert.equal(o.record.verification.sellDebited, SELL.toString());
  assert.equal(o.record.verification.buyReceived, QUOTE.toString());
  assert.equal(o.record.balances.buyAfter, (624_915n + QUOTE).toString());
  assert.equal(o.record.route.provider, MENTO_PROVIDER);
  assert.equal(listPending(h.deps.receiptDir).length, 0);
});

test('the swap calldata carries the exact input, the slippage floor, a single hop and the wallet as recipient', async () => {
  const { chain, h, venue } = setup();
  await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes });
  const d = swapData(chain);
  assert.equal(d.functionName, 'swapExactTokensForTokens');
  const [amountIn, amountOutMin, routes, to, deadline] = d.args as readonly [bigint, bigint, readonly { from: Address; to: Address; factory: Address }[], Address, bigint];
  assert.equal(amountIn, SELL);
  assert.equal(amountOutMin, (QUOTE * 9_900n) / 10_000n, '1% below the live quote, which is above the plan floor');
  assert.equal(routes.length, 1);
  assert.deepEqual([routes[0]!.from, routes[0]!.to, routes[0]!.factory], [USDM.address, USDT.address, MENTO_FACTORY]);
  assert.equal(to.toLowerCase(), PAYER.toLowerCase());
  assert.equal(deadline, BigInt(Math.floor(NOW / 1000) + 300));
});

test('a plan floor above the slippage floor wins: amountOutMin is never below what the human authorized', async () => {
  const { chain, h, venue } = setup();
  await runAmmSwap(ammAuth({ minBuy: 1_012_000n }), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes });
  const [, amountOutMin] = swapData(chain).args as unknown as readonly [bigint, bigint];
  assert.equal(amountOutMin, 1_012_000n);
});

test('with a sufficient allowance there is no approval step and no approval prompt', async () => {
  let prompted = false;
  const { chain, h, venue } = setup({ allowance: SELL });
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: async () => ((prompted = true), { approved: true }) }));
  assert.equal(o.state, 'CONFIRMED');
  assert.equal(prompted, false);
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['swap']);
});

// ------------------------------------------------------------------ gates
test('declining the approval sends nothing and never asks the venue for a quote', async () => {
  const { chain, h, venue, rc } = setup();
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveNo }));
  assert.equal(o.record.code, 'DECLINED');
  assert.equal(chain.prepared, 0);
  assert.equal(rc.calls, 0);
});

test('declining the swap after the approval leaves a standing allowance and says so', async () => {
  const { chain, h, venue } = setup();
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveNo, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'DECLINED');
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['approve']);
  assert.ok(o.record.message.includes('An approval remains'));
});

test('an authorization for another venue, a forged one or a mismatched wallet is refused', async () => {
  const { chain, h, venue } = setup();
  const code = async (a: SwapAuthorization) => {
    const o = await runAmmSwap(a, venue, h.deps, { confirm: approveYes, confirmApproval: approveYes });
    return o.kind === 'refused' ? o.code : `finished:${o.state}`;
  };
  assert.equal(await code(ammAuth({ provider: 'textile-fx-v2' })), 'PROVIDER_MISMATCH');
  assert.equal(await code({ ...ammAuth() }), 'NOT_AUTHORIZED');
  assert.equal(await code(ammAuth({ payer: OTHER })), 'PAYER_MISMATCH');
  assert.equal(chain.prepared, 0);
});

// ------------------------------------------------------------------ price / simulation / execution failures
test('if the live price has moved below the authorized floor, the swap is not sent', async () => {
  const { chain, h, venue } = setup({ quote: () => 990_000n });
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.state, 'FAILED');
  assert.equal(o.record.code, 'PRICE_MOVED');
  assert.deepEqual(chain.broadcasts.map((b) => b.kind), ['approve'], 'only the approval went out');
  assert.equal(o.record.residualAllowance, SELL.toString());
});

test('a quote failure is reported, not guessed', async () => {
  const { chain, h, venue } = setup({ quote: () => new Error('PoolDoesNotExist') });
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'QUOTE_UNAVAILABLE');
  assert.ok(!chain.broadcasts.some((b) => b.kind === 'swap'));
});

test('a tagged swap that fails simulation is NOT sent and the tag is not removed', async () => {
  const { chain, h, venue } = setup({
    allowance: SELL,
    extra: { simulate: (_d, _t, tagged) => (tagged ? { ok: false, error: 'FXMarketClosed' } : { ok: true, returnData: '0x01', gas: 1n }) },
  });
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'TAGGED_SIMULATION_FAILED');
  assert.equal(chain.prepared, 0, 'no untagged fallback was ever prepared');
});

test('a tag that changes the simulated outcome is treated as incompatible', async () => {
  const { chain, h, venue } = setup({
    allowance: SELL,
    extra: { simulate: (_d, _t, tagged) => ({ ok: true, returnData: tagged ? '0x02' : '0x01', gas: 1n }) },
  });
  const o = finished(await runAmmSwap(ammAuth(), venue, h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(o.record.code, 'TAG_CHANGES_BEHAVIOR');
  assert.equal(chain.prepared, 0);
});

test('a reverted swap is a resolved FAILED; an ambiguous broadcast is UNCERTAIN and blocks everything', async () => {
  const reverted = setup({ allowance: SELL, extra: { receipt: () => 'reverted' } });
  const a = finished(await runAmmSwap(ammAuth(), reverted.venue, reverted.h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(a.record.code, 'SWAP_REVERTED');
  assert.equal(listPending(reverted.h.deps.receiptDir).length, 0);

  const unsure = setup({ allowance: SELL, extra: { broadcast: () => 'throw' } });
  const b = finished(await runAmmSwap(ammAuth(), unsure.venue, unsure.h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(b.state, 'UNCERTAIN');
  assert.equal(unsure.chain.prepared, 1);
  assert.equal(listPending(unsure.h.deps.receiptDir).length, 1);
  const again = await runAmmSwap(ammAuth({ planId: 'plan-amm-2' }), unsure.venue, unsure.h.deps, { confirm: approveYes, confirmApproval: approveYes });
  assert.equal(again.kind === 'refused' && again.code, 'PENDING_UNRESOLVED');
});

test('wrong on-chain effects or an unexplained balance change are UNCERTAIN, never CONFIRMED', async () => {
  const bad = setup({ allowance: SELL, extra: { badEffects: true } });
  const a = finished(await runAmmSwap(ammAuth(), bad.venue, bad.h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(a.state, 'UNCERTAIN');
  assert.equal(a.record.code, 'VERIFICATION_MISMATCH');

  const drift = setup({ allowance: SELL, extra: { extraDebit: 3n } });
  const b = finished(await runAmmSwap(ammAuth(), drift.venue, drift.h.deps, { confirm: approveYes, confirmApproval: approveYes }));
  assert.equal(b.state, 'UNCERTAIN');
  assert.equal(b.record.code, 'RECONCILIATION_MISMATCH');
});

test('insufficient input balance and a single-use plan are enforced', async () => {
  const poor = setup({ allowance: SELL });
  poor.chain.balances.set(USDM.address.toLowerCase(), 1n);
  const o = await runAmmSwap(ammAuth(), poor.venue, poor.h.deps, { confirm: approveYes, confirmApproval: approveYes });
  assert.equal(o.kind === 'refused' && o.code, 'INSUFFICIENT_BALANCE');

  const s = setup({ allowance: SELL });
  await runAmmSwap(ammAuth(), s.venue, s.h.deps, { confirm: approveYes, confirmApproval: approveYes });
  const again = await runAmmSwap(ammAuth(), s.venue, s.h.deps, { confirm: approveYes, confirmApproval: approveYes });
  assert.equal(again.kind === 'refused' && again.code, 'ALREADY_EXECUTED');
});

// ------------------------------------------------------------------ independent calldata validation
test('validateSwap rejects calldata that deviates from the authorization', () => {
  const venue = createMentoVenue(readClient(() => QUOTE));
  const base = { amountIn: SELL, amountOutMin: 1_006_000n, sell: USDM.address, buy: USDT.address, to: PAYER, deadline: BigInt(Math.floor(NOW / 1000) + 300) };
  const expect = { amountIn: SELL, minOut: MIN_BUY, sell: USDM.address, buy: USDT.address, recipient: PAYER, nowSec: Math.floor(NOW / 1000), maxDeadlineSec: 360 };
  assert.deepEqual(venue.validateSwap(venue.encodeSwap(base), expect), []);
  const bad = (o: Partial<typeof base>, fragment: string) => {
    const p = venue.validateSwap(venue.encodeSwap({ ...base, ...o }), expect);
    assert.ok(p.some((x) => x.includes(fragment)), `${fragment}: ${JSON.stringify(p)}`);
  };
  bad({ amountIn: SELL + 1n }, 'amountIn');
  bad({ amountOutMin: MIN_BUY - 1n }, 'below the authorized floor');
  bad({ to: OTHER }, 'not the wallet');
  bad({ buy: CNGN.address }, 'not the buy token');
  bad({ sell: CNGN.address }, 'not the sell token');
  bad({ deadline: BigInt(Math.floor(NOW / 1000) - 1) }, 'already passed');
  bad({ deadline: BigInt(Math.floor(NOW / 1000) + 10_000) }, 'further out');
  assert.ok(venue.validateSwap('0xdeadbeef', expect).length > 0);
});

// ------------------------------------------------------------------ route provider + composite + planning
test('Mento route provider: a live quote names the Router as spender; failures are classified honestly', async () => {
  const ok = createMentoRouteProvider({ client: readClient(() => QUOTE), now: () => NOW });
  const r = await ok.quoteExactInput!({ chainId: 42220, sell: USDM, buy: USDT, sellAmount: SELL });
  assert.equal(r.kind, 'route');
  if (r.kind === 'route') {
    assert.equal(r.provider, MENTO_PROVIDER);
    assert.equal(r.spender, MENTO_ROUTER);
    assert.equal(r.buyAmount, QUOTE);
    assert.equal(r.quoteState, 'preview');
    assert.ok(r.note?.includes('embedded'));
  }
  const code = async (e: Error | bigint) => {
    const p = createMentoRouteProvider({ client: readClient(() => e) });
    const x = await p.quoteExactInput!({ chainId: 42220, sell: USDM, buy: CNGN, sellAmount: SELL });
    return x.kind === 'none' ? x.code : 'route';
  };
  assert.equal(await code(new Error('PoolDoesNotExist()')), 'CORRIDOR_UNAVAILABLE');
  assert.equal(await code(new Error('FXMarketClosed()')), 'NO_LIQUIDITY');
  assert.equal(await code(0n), 'NO_LIQUIDITY');
  assert.equal(await code(new Error('socket hang up')), 'PROVIDER_ERROR');
  const noReason = new Error('The contract function "getAmountsOut" reverted with the following signature:\n\nContract Call:\n  address: 0x4861');
  assert.equal(await code(noReason), 'CORRIDOR_UNAVAILABLE', 'a reason-less revert from the router means no route for the pair');
  const other = await ok.quoteExactInput!({ chainId: 1, sell: USDM, buy: USDT, sellAmount: SELL });
  assert.equal(other.kind === 'none' && other.code, 'CORRIDOR_UNAVAILABLE');
});

// rate-aware fake: 18-decimal USDm in, 6-decimal USDT out at `rateBps`/10000 (0.99 = a 1% pool fee)
function rateClient(rateBps: bigint): ReadClient & { amounts: bigint[] } {
  const c = {
    amounts: [] as bigint[],
    async readContract(a: { args?: readonly unknown[] }) {
      const amountIn = a.args![0] as bigint;
      c.amounts.push(amountIn);
      return [amountIn, (amountIn / 10n ** 12n * rateBps) / 10_000n] as readonly bigint[];
    },
  };
  return c as unknown as ReadClient & { amounts: bigint[] };
}

test('Mento findRoute: finds an input whose own quote covers the service price, within the wallet balance', async () => {
  const price = 5_000n; // 0.005 USDT
  const p = createMentoRouteProvider({ client: rateClient(9_900n), now: () => NOW });
  const r = await p.findRoute({ chainId: 42220, sell: USDM, buy: USDT, minBuyAmount: price, maxSellAmount: SELL });
  assert.equal(r.kind, 'route');
  if (r.kind !== 'route') return;
  assert.ok(r.buyAmount >= price, 'the router quote covers the price');
  assert.ok(r.sellAmount <= SELL, 'never more than the wallet holds');
  assert.equal(r.takerPays, r.sellAmount);
  assert.equal(r.spender, MENTO_ROUTER);
  // not wildly over-selling: within ~3% of the exact need at this rate
  const exact = (price * 10_000n * 10n ** 12n) / 9_900n;
  assert.ok(r.sellAmount <= (exact * 103n) / 100n, `sell ${r.sellAmount} vs exact ${exact}`);
});

test('Mento findRoute: more than the wallet holds -> EXCEEDS_BALANCE (with the amount needed); wrong chain; zero quote', async () => {
  const p = createMentoRouteProvider({ client: rateClient(9_900n) });
  const big = await p.findRoute({ chainId: 42220, sell: USDM, buy: USDT, minBuyAmount: 5_000_000n, maxSellAmount: 10n ** 18n });
  assert.equal(big.kind === 'none' && big.code, 'EXCEEDS_BALANCE');
  assert.ok(big.kind === 'none' && big.neededSellAmount !== undefined && big.neededSellAmount > 10n ** 18n);
  const wrong = await p.findRoute({ chainId: 1, sell: USDM, buy: USDT, minBuyAmount: 1n, maxSellAmount: SELL });
  assert.equal(wrong.kind === 'none' && wrong.code, 'CORRIDOR_UNAVAILABLE');
  const dead = createMentoRouteProvider({ client: rateClient(0n) });
  const z = await dead.findRoute({ chainId: 42220, sell: USDM, buy: USDT, minBuyAmount: 1_000n, maxSellAmount: SELL });
  assert.equal(z.kind === 'none' && z.code, 'NO_LIQUIDITY');
});

const fakeProvider = (name: string, r: (sell: Asset, buy: Asset) => RouteResult): RouteProvider => ({
  name,
  async findRoute(q) {
    return r(q.sell, q.buy);
  },
  async quoteExactInput(q) {
    return r(q.sell, q.buy);
  },
});
const none = (code: 'CORRIDOR_UNAVAILABLE' | 'NO_LIQUIDITY' | 'PROVIDER_ERROR', provider: string) => (s: Asset, b: Asset): RouteResult => ({ kind: 'none', provider, code, message: code, sell: s, buy: b });
const route = (provider: string) => (s: Asset, b: Asset): RouteResult => ({
  kind: 'route', provider, quoteState: 'preview', sell: s, buy: b, sellAmount: 1n, buyAmount: 1n, feeAmount: 0n, takerPays: 1n, minSellAmount: 0n, availableSellAmount: undefined, fetchedAt: NOW,
});

test('composite: first live route wins; otherwise the most informative failure; outages are not "no route"', async () => {
  const q = { chainId: 42220, sell: USDM, buy: USDT, sellAmount: 1n };
  const c1 = createCompositeRouteProvider([fakeProvider('a', none('CORRIDOR_UNAVAILABLE', 'a')), fakeProvider('b', route('b'))]);
  const r1 = await c1.quoteExactInput!(q);
  assert.equal(r1.kind === 'route' && r1.provider, 'b');
  const c2 = createCompositeRouteProvider([fakeProvider('a', none('CORRIDOR_UNAVAILABLE', 'a')), fakeProvider('b', none('NO_LIQUIDITY', 'b'))]);
  const r2 = await c2.quoteExactInput!(q);
  assert.equal(r2.kind === 'none' && r2.code, 'NO_LIQUIDITY');
  const c3 = createCompositeRouteProvider([fakeProvider('a', none('PROVIDER_ERROR', 'a')), fakeProvider('b', none('CORRIDOR_UNAVAILABLE', 'b'))]);
  const r3 = await c3.quoteExactInput!(q);
  assert.equal(r3.kind === 'none' && r3.code, 'PROVIDER_ERROR');
  const empty = await createCompositeRouteProvider([]).quoteExactInput!(q);
  assert.equal(empty.kind, 'none');
});

function planDeps(routes: RouteProvider, over: Partial<ConversionDeps> = {}): ConversionDeps {
  return {
    now: () => NOW,
    policy: DEFAULT_POLICY,
    async getBalances(_o, assets) {
      return new Map(assets.map((a) => [a.address.toLowerCase(), a.symbol === 'USDm' ? SELL : 0n]));
    },
    async getNativeBalance() {
      return 595_000_000_000_000_000n;
    },
    async gasPriceWei() {
      return 202_500_000_000n;
    },
    async getAllowance() {
      return 0n;
    },
    routes,
    swapExecution: true,
    newId: () => 'conv-amm',
    ...over,
  };
}

test('planning USDm -> USDT: the approval targets the Router (not the Textile reactor) and the authorization names the venue', async () => {
  const mento = createMentoRouteProvider({ client: readClient(() => QUOTE), now: () => NOW });
  const p = await planConversion(planDeps(mento), { sell: 'USDm', buy: 'USDT', sellAmountAtomic: SELL, payer: PAYER });
  assert.equal(p.status, 'APPROVAL_REQUIRED');
  assert.equal(p.executable, true);
  assert.equal(p.allowance?.spender, MENTO_ROUTER);
  assert.ok(p.knownTransactions[0]!.description.includes(MENTO_ROUTER));
  assert.ok(p.uncertainties.some((u) => u.includes('embedded')));
  const a = authorizeConversion(p, { now: NOW, approvedBy: 'human:test' });
  assert.equal(a.provider, MENTO_PROVIDER);
  assert.equal(a.sell.symbol, 'USDm');
  assert.equal(a.buy.minBuyAtomic, (QUOTE * 9_900n) / 10_000n);
});

test('policy: USDm -> USDT is permitted by default; USDm -> cNGN is not', async () => {
  const mento = createMentoRouteProvider({ client: readClient(() => QUOTE), now: () => NOW });
  const blocked = await planConversion(planDeps(mento), { sell: 'USDm', buy: 'cNGN', sellAmountAtomic: SELL, payer: PAYER });
  assert.equal(blocked.status, 'POLICY_BLOCKED');
  assert.throws(() => authorizeConversion(blocked, { now: NOW, approvedBy: 'x' }), AuthorizationRefused);
  void MAKER;
  void TAG;
});
