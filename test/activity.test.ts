import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listActivity, renderSwapRecord } from '../src/activity.ts';
import { createBuyProvider, createRegistry, RegistryError } from '../src/providers.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { createTextileRouteProvider } from '../src/routes.ts';
import { newSwapRecord } from '../src/swapjournal.ts';
import { tempDir } from './support.ts';

function swapRecord(over: Partial<ReturnType<typeof newSwapRecord>> = {}) {
  const r = newSwapRecord({
    planId: 'p1',
    now: new Date('2026-10-13T10:00:00Z'),
    route: { sellSymbol: 'USDT', sellAsset: '0xa', buySymbol: 'cNGN', buyAsset: '0xb', provider: 'textile-fx-v2' },
    requestedSell: 1_000_000n,
    minBuy: 1_352_000_000n,
    tag: 'celo_b2fff2ac9413',
  });
  return Object.assign(r, over);
}

test('activity: merges payments (legacy and v1) and swaps, newest first, flags unresolved work', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'swaps'), { recursive: true });
  mkdirSync(join(dir, 'pending'), { recursive: true });
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', createdAt: '2026-10-12T16:00:00Z', payment: { amountAtomic: '5000', txHash: '0xaa' }, input: { token: 'USDT' }, service: { capability: 'x.posts.search' }, outcome: { settled: true } }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ id: 'b', createdAt: '2026-10-13T09:00:00Z', status: 'UNCERTAIN', payment: { amountAtomic: '5000' }, input: { token: 'USDT' }, service: { capability: 'x.posts.search' } }));
  writeFileSync(join(dir, 'swaps', 'p1.json'), JSON.stringify(swapRecord({ state: 'CONFIRMED', code: 'CONFIRMED', updatedAt: '2026-10-13T11:00:00Z' })));
  writeFileSync(join(dir, 'pending', 'swap-p2.json'), JSON.stringify(swapRecord({ planId: 'p2', state: 'UNCERTAIN', code: 'RECEIPT_TIMEOUT', updatedAt: '2026-10-13T12:00:00Z' })));
  writeFileSync(join(dir, 'pending', 'pending-x.json'), '{}');
  writeFileSync(join(dir, 'broken.json'), '{ nope');

  const { items, warnings } = listActivity(dir);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.startsWith('broken.json'));
  const ids = items.filter((i) => i.at).map((i) => i.id);
  assert.deepEqual(ids, ['p2', 'p1', 'b', 'a'], 'newest first');
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.a!.status, 'CONFIRMED (legacy receipt)');
  assert.equal(byId.a!.unresolved, false);
  assert.equal(byId.b!.unresolved, true);
  assert.equal(byId.p1!.unresolved, false);
  assert.equal(byId.p2!.unresolved, true);
  assert.equal(items.filter((i) => i.unresolved).length, 3, 'uncertain payment + unresolved swap + in-flight payment journal');
});

test('activity: an empty or missing folder is not an error', () => {
  assert.deepEqual(listActivity(join(tempDir(), 'nope')), { items: [], warnings: [] });
});

test('rendered swap receipt states only what the evidence supports', () => {
  const r = swapRecord({ state: 'UNCERTAIN', code: 'RECEIPT_TIMEOUT' });
  r.steps.push({ kind: 'swap', to: '0xr', hash: '0xh', nonce: 5, status: 'broadcast', attribution: { verified: false, codes: null, note: 'verifyTx found no attribution' }, gasUsed: undefined });
  const text = renderSwapRecord(r);
  assert.ok(text.includes('NOT verified: verifyTx found no attribution'));
  assert.ok(text.includes('do NOT retry'));
  assert.ok(!text.includes('VERIFIED by verifyTx'));
  const ok = swapRecord({ state: 'CONFIRMED' });
  ok.steps.push({ kind: 'swap', to: '0xr', hash: '0xh', nonce: 5, status: 'mined', attribution: { verified: true, codes: ['celo_b2fff2ac9413'], note: 'ok' }, gasUsed: '300000' });
  assert.ok(renderSwapRecord(ok).includes('VERIFIED by verifyTx'));
});

// ------------------------------------------------------------------ provider adapters
const fakeService = (id: string, provider: string) => ({
  id: provider,
  async catalog() {
    return {
      fetchedAt: 0,
      source: 'x',
      stale: false,
      rejected: [],
      payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, payTo: undefined, tokens: [] },
      services: id ? [{ id, title: id, description: '', platform: 'p', provider: undefined, method: 'POST', url: 'https://gateway.usebuy.ai/x', available: true, price: undefined, inputSchema: undefined }] : [],
    };
  },
  async discover() {
    return { kind: 'no_payment_required' as const, httpStatus: 200 };
  },
});

test('registry: finds a service across providers, isolates a failing provider, refuses ambiguity and duplicates', async () => {
  const reg = createRegistry();
  reg.registerService(fakeService('svc.a', 'prov-1'));
  reg.registerService({
    id: 'prov-down',
    async catalog() {
      throw new Error('503');
    },
    async discover() {
      return { kind: 'no_payment_required' as const, httpStatus: 200 };
    },
  });
  reg.registerService(fakeService('svc.b', 'prov-2'));

  const hit = await reg.findService('svc.b');
  assert.equal(hit.found?.provider.id, 'prov-2');
  assert.equal(hit.errors.length, 1, 'the failing provider is reported, not fatal');
  assert.equal(hit.errors[0]!.provider, 'prov-down');
  assert.equal((await reg.findService('missing')).found, undefined);

  assert.throws(() => reg.registerService(fakeService('x', 'prov-1')), RegistryError);
  reg.registerService(fakeService('svc.a', 'prov-3')); // same id under another provider
  await assert.rejects(reg.findService('svc.a'), /several providers/);
});

test('registry: conversion providers are registered by name; the real adapters satisfy the interfaces', () => {
  const reg = createRegistry();
  const textile = createTextileRouteProvider();
  reg.registerConversion(textile);
  assert.equal(reg.conversion('textile-fx-v2'), textile);
  assert.throws(() => reg.conversion('nope'), RegistryError);
  assert.throws(() => reg.registerConversion(textile), RegistryError);
  assert.equal(typeof textile.quoteExactInput, 'function');
  const buy = createBuyProvider({ policy: DEFAULT_POLICY });
  assert.equal(buy.id, 'buy-gateway');
  reg.registerService(buy);
  assert.equal(reg.serviceProviders().length, 1);
});
