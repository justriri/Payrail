// Escrow settlement path against a FAKE escrow client that mirrors the contract's state machine.
// Proves the backend logic. The real contract is exercised separately on Celo Sepolia (scripts/escrow-testnet-flow.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { createDemoNetwork, seedDemo } from '../src/dev/demoapis.ts';
import { RateLimiter } from '../src/egress.ts';
import { EscrowError, executeEscrowRequest, holdIdFor, recoverEscrow } from '../src/escrow.ts';
import type { EscrowClient, OnChainHold } from '../src/escrow.ts';
import { createAccount, verifyLedger } from '../src/ledger.ts';
import { generateMasterKey } from '../src/vault.ts';

const T0 = 1_800_000_000_000;
const mk = generateMasterKey('k1');
const BUYER_WALLET = '0x00000000000000000000000000000000000000b1';
const SELLER_WALLET = '0x00000000000000000000000000000000000000e1';
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${(e as Error).message}`;
  }
};

function fakeEscrow(balance = 1_000_000n, timeout = 86_400) {
  const holds = new Map<string, OnChainHold>();
  const calls: string[] = [];
  let failNext: string | undefined;
  let clock = T0 / 1000;
  const c: EscrowClient & { holds: typeof holds; calls: string[]; failOn(op: string): void; setClock(s: number): void } = {
    holdTimeoutSeconds: timeout,
    holds,
    calls,
    failOn: (op) => (failNext = op),
    setClock: (s) => (clock = s),
    available: async () => balance,
    hold: async (id) => holds.get(id) ?? { state: 'None', buyer: '', seller: '', amount: 0n, createdAt: 0 },
    async placeHold(id, buyer, seller, amount) {
      calls.push('placeHold');
      if (failNext === 'placeHold') { failNext = undefined; throw new Error('rpc timeout'); }
      if (holds.has(id)) throw new EscrowError('HOLD_FAILED', 'exists');
      if (balance < amount) throw new EscrowError('HOLD_FAILED', 'insufficient');
      balance -= amount;
      holds.set(id, { state: 'Held', buyer, seller, amount, createdAt: clock });
      return `0xhold${holds.size}`;
    },
    async capture(id) {
      calls.push('capture');
      if (failNext === 'capture') { failNext = undefined; throw new Error('rpc timeout'); }
      const h = holds.get(id);
      if (!h || h.state !== 'Held') throw new EscrowError('HOLD_FAILED', 'not open');
      h.state = 'Captured';
      return '0xcapture';
    },
    async release(id) {
      calls.push('release');
      const h = holds.get(id);
      if (!h || h.state !== 'Held') throw new EscrowError('HOLD_FAILED', 'not open');
      h.state = 'Released';
      balance += h.amount;
      return '0xrelease';
    },
    async expire(id) {
      calls.push('expire');
      const h = holds.get(id);
      if (!h || h.state !== 'Held' || clock < h.createdAt + timeout) throw new EscrowError('HOLD_FAILED', 'not expired');
      h.state = 'Released';
      balance += h.amount;
      return '0xexpire';
    },
  };
  return c;
}

function setup(withWallets = true) {
  const db = openDb(':memory:');
  const demo = seedDemo(db, mk, () => T0);
  if (withWallets) db.prepare('UPDATE accounts SET wallet_address = ? WHERE id = ?').run(SELLER_WALLET, demo.sellerId);
  const buyer = createAccount(db, { kind: 'buyer', displayName: 'B' }, () => T0);
  if (withWallets) db.prepare("INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES (?, ?, 'sig', 't')").run(BUYER_WALLET, buyer);
  const net = createDemoNetwork(() => T0);
  let upstream = 0;
  const opts = { now: () => T0, demoCall: { limiter: new RateLimiter(1000, 1000), fetchOptions: { resolver: net.resolver, transport: (r: any) => (upstream++, net.transport(r)), timeoutMs: 150 } } };
  return { db, demo, buyer, opts, upstream: () => upstream };
}
const run = (s: ReturnType<typeof setup>, c: EscrowClient, listing: string, input: unknown, key: string) =>
  executeEscrowRequest(s.db, [mk], c, { buyerId: s.buyer, listingId: listing, idempotencyKey: key, input, asset: 'TESTUSDT' }, s.opts);

test('qualifying response: hold placed BEFORE the call, then captured; result carries the fee split and body', async () => {
  const s = setup();
  const c = fakeEscrow();
  const r = await run(s, c, s.demo.priceListingId, { id: 'eth' }, 'esc-key-0001');
  assert.equal(r.state, 'QUALIFIED');
  assert.equal(r.charged, true);
  assert.equal(r.feeAtomic, '600');
  assert.equal(r.sellerAtomic, '19400');
  assert.equal((r.body as any).id, 'eth');
  assert.deepEqual(c.calls, ['placeHold', 'capture']);
  const h = c.holds.get(holdIdFor(r.executionId))!;
  assert.equal(h.state, 'Captured');
  assert.equal(h.buyer, BUYER_WALLET);
  assert.equal(h.seller, SELLER_WALLET);
  assert.equal(h.amount, 20_000n);
  assert.deepEqual(verifyLedger(s.db), { ok: true, problems: [] }, 'escrow executions do not disturb the off-chain ledger checks');
});

test('non-qualifying response releases the hold on-chain; the buyer is not charged', async () => {
  const s = setup();
  const c = fakeEscrow();
  const r = await run(s, c, s.demo.priceListingId, { id: 'eth', scenario: 'stale' }, 'esc-key-0002');
  assert.equal(r.state, 'NOT_QUALIFIED');
  assert.equal(r.body, undefined);
  assert.match(r.reason!, /freshness/);
  assert.deepEqual(c.calls, ['placeHold', 'release']);
  assert.equal(c.holds.get(holdIdFor(r.executionId))!.state, 'Released');
});

test('insufficient escrow balance: nothing is held and the seller is never contacted', async () => {
  const s = setup();
  const c = fakeEscrow(1_000n);
  const r = await run(s, c, s.demo.priceListingId, { id: 'eth' }, 'esc-key-0003');
  assert.equal(r.state, 'NOT_QUALIFIED');
  assert.deepEqual(c.calls, []);
  assert.equal(s.upstream(), 0);
});

test('timeout: stays UNRESOLVED with the hold open; the chain is re-read; after the timeout it is expired back to the buyer', async () => {
  const s = setup();
  const c = fakeEscrow();
  const r = await run(s, c, s.demo.priceListingId, { id: 'eth', scenario: 'hang' }, 'esc-key-0004');
  assert.equal(r.state, 'UNRESOLVED');
  assert.equal(r.held, true);
  assert.equal(c.holds.get(holdIdFor(r.executionId))!.state, 'Held');
  // within the window: unchanged
  assert.deepEqual(await recoverEscrow(s.db, c, () => T0 + 1_000), []);
  // after the window: anyone can expire; the backend does and records it
  c.setClock(T0 / 1000 + 86_401);
  const rec = await recoverEscrow(s.db, c, () => T0 + 86_401_000);
  assert.deepEqual(rec.map((x) => x.to), ['RELEASED_UNRESOLVED']);
  assert.equal(c.holds.get(holdIdFor(r.executionId))!.state, 'Released');
});

test('crash recovery is decided by the chain: a failed settle that actually captured becomes QUALIFIED; a missing hold becomes NOT_QUALIFIED', async () => {
  const s = setup();
  const c = fakeEscrow();
  // capture "fails" client-side (rpc timeout) -> UNRESOLVED
  c.failOn('capture');
  const r = await run(s, c, s.demo.priceListingId, { id: 'eth' }, 'esc-key-0005');
  assert.equal(r.state, 'UNRESOLVED');
  // ...but on-chain it did go through
  c.holds.get(holdIdFor(r.executionId))!.state = 'Captured';
  const rec = await recoverEscrow(s.db, c, () => T0);
  assert.deepEqual(rec.map((x) => x.to), ['QUALIFIED']);

  // placeHold fails client-side and nothing exists on-chain
  c.failOn('placeHold');
  const r2 = await run(s, c, s.demo.priceListingId, { id: 'btc' }, 'esc-key-0006');
  assert.equal(r2.state, 'UNRESOLVED');
  assert.equal(s.upstream(), 1, 'the seller was not contacted without a confirmed hold');
  const rec2 = await recoverEscrow(s.db, c, () => T0);
  assert.deepEqual(rec2.map((x) => x.to), ['NOT_QUALIFIED']);
});

test('idempotent replay, conflict detection, and missing wallets', async () => {
  const s = setup();
  const c = fakeEscrow();
  const a = await run(s, c, s.demo.priceListingId, { id: 'celo' }, 'esc-key-0007');
  const calls = c.calls.length;
  const b = await run(s, c, s.demo.priceListingId, { id: 'celo' }, 'esc-key-0007');
  assert.equal(b.replay, true);
  assert.equal(b.executionId, a.executionId);
  assert.equal(c.calls.length, calls);
  assert.equal(await code(run(s, c, s.demo.priceListingId, { id: 'eth' }, 'esc-key-0007')), 'IDEMPOTENCY_CONFLICT');

  const bare = setup(false);
  assert.equal(await code(run(bare, c, bare.demo.priceListingId, { id: 'eth' }, 'esc-key-0008')), 'NO_FUNDING_WALLET');
  bare.db.prepare("INSERT INTO funding_wallets (address, buyer_id, signature, verified_at) VALUES (?, ?, 'sig', 't')").run(BUYER_WALLET, bare.buyer);
  assert.equal(await code(run(bare, c, bare.demo.priceListingId, { id: 'eth' }, 'esc-key-0009')), 'NO_SELLER_WALLET');
});
