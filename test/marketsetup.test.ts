// The PRODUCTION startup logic (src/marketsetup.ts), exercised with a fake chain and a throwaway database file.
// Nothing here opens a network connection; it proves what the real server will and will not switch on.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSETS } from '../src/assets.ts';
import { SetupError, setupMarket } from '../src/marketsetup.ts';
import type { SetupDeps } from '../src/marketsetup.ts';
import { handleMarket } from '../src/market.ts';

const USDT = ASSETS.find((a) => a.symbol === 'USDT')!.address;
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const dir = mkdtempSync(join(tmpdir(), 'payrail-setup-'));
let n = 0;
const goodEnv: Record<string, string | undefined> = { PAYRAIL_MARKET_LIVE: '1', PAYRAIL_DEPOSIT_ADDRESS: DEP, PAYRAIL_VAULT_KEY: 'ab'.repeat(32), PAYRAIL_MAX_DEPOSIT_USD: '1', PAYRAIL_DEPOSIT_CONFIRMATIONS: '20' };

type Over = Partial<Omit<SetupDeps, 'env'>> & { env?: Record<string, string | undefined> };
function deps(over: Over = {}): SetupDeps & { logs: string[] } {
  const logs: string[] = [];
  const { env, ...rest } = over;
  return {
    env: { ...goodEnv, ...(env ?? {}) },
    dbPath: join(dir, `m${++n}.db`),
    configuredChainId: 42220,
    attributionTag: 'celo_b2fff2ac9413',
    readChainId: async () => 42220,
    makeReader: () => ({ blockNumber: async () => 5_000n, receipt: async () => null }),
    readAllowance: async () => 0n,
    buyCatalog: async () => ({ services: [], stale: false }) as never,
    log: (l: string) => logs.push(l),
    ...rest,
    logs,
  };
}
const refuses = async (over: Over, fragment: RegExp) => {
  await assert.rejects(() => setupMarket(deps(over)), (e: unknown) => e instanceof SetupError && fragment.test(e.message));
};
type Rt = NonNullable<Awaited<ReturnType<typeof setupMarket>>>;
const call = async (rt: Rt, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}, bearer?: string) =>
  handleMarket(rt, { method, path, query: new URLSearchParams(), body, bearer });

test('without PAYRAIL_MARKET_LIVE=1 there is no marketplace at all (and no demo fallback)', async () => {
  const d = deps({ env: { PAYRAIL_MARKET_LIVE: undefined } });
  assert.equal(await setupMarket(d), undefined);
  assert.match(d.logs.join('\n'), /Payrail has no demo mode/);
});

test('real-funds mode refuses to start when anything is missing, unsafe or on the wrong chain', async () => {
  await refuses({ env: { PAYRAIL_DEPOSIT_ADDRESS: undefined } }, /needs PAYRAIL_DEPOSIT_ADDRESS/);
  await refuses({ env: { PAYRAIL_DEPOSIT_ADDRESS: 'not-an-address' } }, /needs PAYRAIL_DEPOSIT_ADDRESS/);
  await refuses({ env: { PAYRAIL_DEPOSIT_ADDRESS: `0x${'0'.repeat(40)}` } }, /zero address/);
  await refuses({ env: { PAYRAIL_DEPOSIT_ADDRESS: USDT } }, /not a token or protocol contract/);
  await refuses({ env: { PAYRAIL_VAULT_KEY: undefined } }, /needs PAYRAIL_VAULT_KEY/);
  await refuses({ configuredChainId: 1 }, /Celo mainnet \(42220\) only/);
  await refuses({ dbPath: ':memory:' }, /persistent database file/);
  await refuses({ env: { PAYRAIL_MAX_DEPOSIT_USD: '0' } }, /positive number/);
  await refuses({ env: { PAYRAIL_MAX_DEPOSIT_USD: 'abc' } }, /positive number/);
  await refuses({ env: { PAYRAIL_DEPOSIT_CONFIRMATIONS: '0' } }, /at least 1/);
  await refuses({ readChainId: async () => 1 }, /RPC reports chain 1/);
  await refuses({ readChainId: async () => { throw new Error('connection refused'); } }, /could not read the chain id/);
});

test('the production runtime is real-funds only: no demo, sandbox, simulation, testnet escrow, conversion or payouts unless explicitly enabled', async () => {
  const d = deps();
  const rt = (await setupMarket(d))!;
  assert.ok(rt.live);
  assert.equal(rt.live.funding.chainId, 42220);
  assert.equal(rt.live.funding.token.toLowerCase(), USDT.toLowerCase());
  assert.equal(rt.live.funding.depositAddress, DEP);
  assert.equal(rt.live.funding.maxDepositAtomic, 1_000_000n);
  assert.equal(rt.live.funding.minConfirmations, 20);
  assert.equal(rt.live.payoutRequestsEnabled, false, 'payout requests are off');
  for (const k of ['dev', 'sandbox', 'escrow', 'funding', 'conversion', 'buySimulated']) assert.equal((rt as unknown as Record<string, unknown>)[k], undefined, `${k} is not set`);
  assert.deepEqual(rt.domain, {}, 'real DNS and well-known checks, no sandbox resolver');
  assert.match(d.logs.join('\n'), /REAL-FUNDS MARKETPLACE: USDT on Celo mainnet.*Seller payouts: DISABLED.*Conversion: DISABLED/);

  // through the real router
  const cfg = (await call(rt, 'GET', '/config')).body as any;
  assert.equal(cfg.realFunds, true);
  assert.equal(cfg.sandbox, false);
  assert.equal(cfg.network.chainId, 42220);
  assert.equal(cfg.network.token.symbol, 'USDT');
  assert.equal(cfg.features.conversion, false);
  assert.equal(cfg.features.payouts, false);
  assert.equal(((await call(rt, 'POST', '/buyer')).body as any).code, 'NOT_AVAILABLE');
  assert.equal(((await call(rt, 'POST', '/credits', { amount: '1' }, 'x')).body as any).code, 'NOT_AVAILABLE');
  assert.equal(((await call(rt, 'POST', '/seller/sandbox/login')).body as any).code, 'SANDBOX_DISABLED');
  const items = ((await call(rt, 'GET', '/catalog')).body as any).items as unknown[];
  assert.deepEqual(items, [], 'a fresh production database offers nothing: there are no seeded demo APIs');

  // a wallet-signed buyer works end to end through this runtime
  const k = privateKeyToAccount(generatePrivateKey());
  const s = (await call(rt, 'POST', '/buyer/login/start', { wallet: k.address, chainId: 42220 })).body as any;
  const c = (await call(rt, 'POST', '/buyer/login/complete', { wallet: k.address, nonce: s.nonce, signature: await k.signMessage({ message: s.message }) })).body as any;
  assert.equal(c.ok, true);
  const me = (await call(rt, 'GET', '/me', {}, c.token)).body as any;
  assert.equal(me.mode, 'real-funds');
  assert.equal(me.live.available, '0');
  assert.equal(me.available, undefined);
});

test('buyer-signed conversion is switched on only by its own flag, and is never a simulated provider', async () => {
  const d = deps({ env: { PAYRAIL_BUYER_SWAP: '1' } });
  const rt = (await setupMarket(d))!;
  assert.ok(rt.conversion);
  assert.equal(rt.conversion.simulated, false);
  assert.ok(rt.conversion.buyerSwap);
  assert.equal(rt.conversion.creditAsset, 'USDT');
  assert.equal(rt.conversion.depositAddress, DEP);
  assert.match(d.logs.join('\n'), /never run on mainnet yet/);
  assert.equal(((await call(rt, 'GET', '/config')).body as any).features.conversion, true);
  assert.equal(rt.live?.payoutRequestsEnabled, false, 'enabling conversion does not enable payouts');
});

// the databases stay open until the process exits (Windows cannot delete open files): remove them best-effort
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder; the OS cleans it */ } });
