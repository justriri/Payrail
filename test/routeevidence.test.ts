// Route evidence labels and the read-only live route provider (with injected ladder/preview: no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.ts';
import { TEXTILE_REACTOR } from '../src/config.ts';
import { RouteRegistry, seedConversionAssets, setAssetEnabled } from '../src/conversion.ts';
import { openDb } from '../src/db.ts';
import { evidenceFor } from '../src/routeevidence.ts';
import { createSimProvider } from '../src/dev/simconversion.ts';
import { createTextileRouteProvider } from '../src/textileroutes.ts';
import type { LadderPair } from '../src/textile.ts';

const addr = (s: string) => ASSETS.find((a) => a.symbol === s)!.address;
const pair = (sell: string, buy: string, levels: Array<[bigint, bigint]>): LadderPair =>
  ({ sellToken: sell as `0x${string}`, buyToken: buy as `0x${string}`, levels: levels.map(([sellAmount, buyAmount]) => ({ sellAmount, buyAmount })) }) as LadderPair;

test('a simulated route is labelled simulated, never live; the settlement asset needs no conversion', async () => {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const reg = new RouteRegistry(db, [createSimProvider({ reactor: TEXTILE_REACTOR })]);
  const f = await reg.routes('funding');
  const p = await reg.routes('payout');
  const by = (rs: typeof f, s: string, dir: 'funding' | 'payout') => rs.find((r) => (dir === 'funding' ? r.from : r.to).symbol === s)!;
  for (const r of [...f, ...p].filter((x) => !x.passthrough && x.provider !== 'none')) assert.equal(r.evidence.level, 'simulated', `${r.from.symbol}->${r.to.symbol}`);
  assert.match(by(f, 'wARS', 'funding').evidence.basis, /not current liquidity/);
  // our own mainnet executions are recorded as facts about the SNAPSHOT's origin, not as proof the simulation is live
  assert.match(by(f, 'cNGN', 'funding').evidence.basis, /executed this direction once on mainnet/);
  assert.equal(by(f, 'cNGN', 'funding').evidence.executableLive, false);
  assert.match(by(p, 'wMXN', 'payout').evidence.basis, /no makers/);
  assert.equal(f.find((r) => r.passthrough)!.evidence.level, 'live-executed');
  // CWT is not a route at all
  assert.equal(await reg.find('funding', 'CWT'), undefined);
  assert.equal(evidenceFor('funding', 'CWT', { providerSimulated: false }).level, 'none');
});

test('live read-only provider: funding and payout are separate entries; empty ladders are unavailable; unknown tokens are not offered', async () => {
  const usdt = addr('USDT');
  const cngn = addr('cNGN');
  const wars = addr('wARS');
  const unknown = '0x00000000000000000000000000000000000000aa';
  const provider = createTextileRouteProvider({
    now: () => 1_800_000_000_000,
    getLadder: async () => ({
      asOf: '2026-10-15T00:00:00.000Z',
      pairs: [
        pair(cngn, usdt, [[1_360_000_000n, 998_000n], [90_000_000_000n, 70_000_000_000n]]),
        pair(usdt, cngn, [[1_000_000n, 1_363_000_000n], [3_000_000_000n, 4_000_000_000_000n]]),
        pair(wars, usdt, [[1_611n * 10n ** 18n, 999_000n]]),
        pair(usdt, wars, []), // listed, no liquidity: reverse direction unavailable although the forward one works
        pair(unknown, usdt, [[1n, 1n]]), // cannot be named or sized: ignored
      ],
    }),
    preview: async ({ sellAmount }) => ({ kind: 'preview', sellAmount, buyAmount: sellAmount / 1000n, feeAmount: sellAmount / 10_000n, takerPays: sellAmount, rateRay: '1', availableSellAmount: undefined, requestId: 'r1', rateRemaining: undefined }),
  });
  const f = (await provider.discover('funding')).routes;
  const p = (await provider.discover('payout')).routes;
  assert.deepEqual(f.map((r) => r.from.symbol).sort(), ['cNGN', 'wARS']);
  assert.deepEqual(p.map((r) => r.to.symbol).sort(), ['cNGN', 'wARS']);
  assert.equal(f.find((r) => r.from.symbol === 'wARS')!.available, true);
  const warsPayout = p.find((r) => r.to.symbol === 'wARS')!;
  assert.equal(warsPayout.available, false, 'wARS -> USDT working says nothing about USDT -> wARS');
  assert.equal(warsPayout.unavailableReason, 'no_levels');
  const cn = f.find((r) => r.from.symbol === 'cNGN')!;
  assert.equal(cn.minInputAtomic, 1_360_000_000n);
  assert.equal(cn.maxInputAtomic, 90_000_000_000n);
  assert.equal(provider.simulated, false);
  assert.equal(('execute' in provider), false, 'the live route provider can never execute');

  const q = await provider.quote({ direction: 'funding', from: cn.from, to: cn.to, inputAtomic: 2_000_000_000n });
  assert.equal(q.minOutputAtomic, q.expectedOutputAtomic - q.expectedOutputAtomic / 100n);
  assert.match(q.notes.join(' '), /INDICATIVE/);
});

test('live route provider refuses incoherent previews instead of showing them', async () => {
  const mk = (r: object) => createTextileRouteProvider({ getLadder: async () => ({ asOf: undefined, pairs: [] }), preview: async () => r as never });
  const a = { chainId: 42220, address: addr('cNGN'), symbol: 'cNGN', decimals: 6 };
  const u = { chainId: 42220, address: addr('USDT'), symbol: 'USDT', decimals: 6 };
  const args = { direction: 'funding' as const, from: a, to: u, inputAtomic: 1_000_000n };
  await assert.rejects(() => mk({ kind: 'no_quote', reason: 'no_makers_online', requestId: undefined }).quote(args), /no quote/);
  await assert.rejects(() => mk({ kind: 'preview', sellAmount: 1n, buyAmount: 0n, feeAmount: 0n, takerPays: 1n }).quote(args), /zero output/);
  await assert.rejects(() => mk({ kind: 'preview', sellAmount: 1n, buyAmount: 5n, feeAmount: 9n, takerPays: 1n }).quote(args), /implausible fee/);
  await assert.rejects(() => mk({ kind: 'preview', sellAmount: 1_000_000n, buyAmount: 5n, feeAmount: 1n, takerPays: 9_000_000n }).quote(args), /more than the requested/);
});

test('enabling an asset does not create liquidity: a disabled-but-live route and an enabled-but-dead route are both unusable', async () => {
  const db = openDb(':memory:');
  seedConversionAssets(db);
  const reg = new RouteRegistry(db, [createSimProvider({ reactor: TEXTILE_REACTOR })]);
  const wmxn = (await reg.find('payout', 'wMXN'))!;
  setAssetEnabled(db, wmxn.to.chainId, wmxn.to.address, 'payout', true, 'op');
  const after = (await reg.find('payout', 'wMXN'))!;
  assert.equal(after.enabled, true);
  assert.equal(after.usable, false);
  const wcop = (await reg.find('funding', 'wCOP'))!;
  assert.equal(wcop.available, true);
  assert.equal(wcop.usable, false);
});
