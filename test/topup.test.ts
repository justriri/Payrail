// Pure helpers behind the one-click Pay flow: shortfall maths, limits, calldata. No wallet, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, erc20Abi } from 'viem';

// the file is a classic browser script: run it with a stand-in `window` and read what it publishes
const scope: { PayrailTopUp?: unknown } = {};
new Function('window', readFileSync(fileURLToPath(new URL('../web/topup.js', import.meta.url)), 'utf8'))(scope);
const T = scope.PayrailTopUp as {
  parseUnits6(s: string): bigint | null;
  formatUnits6(a: bigint): string;
  planTopUp(a: { priceAtomic: bigint; availableAtomic: bigint; maxDepositAtomic: bigint }): { needed?: boolean; amountAtomic?: bigint; error?: string };
  transferCalldata(to: string, amount: bigint): string;
  isPendingCode(c: string): boolean;
};

test('parsing and formatting USDT amounts', () => {
  assert.equal(T.parseUnits6('0.5'), 500_000n);
  assert.equal(T.parseUnits6('1'), 1_000_000n);
  assert.equal(T.parseUnits6('0.000001'), 1n);
  assert.equal(T.parseUnits6('0.0000001'), null);
  assert.equal(T.parseUnits6('-1'), null);
  assert.equal(T.parseUnits6('1e3'), null);
  assert.equal(T.parseUnits6(''), null);
  assert.equal(T.formatUnits6(500_000n), '0.5');
  assert.equal(T.formatUnits6(2_000_000n), '2');
  assert.equal(T.formatUnits6(1n), '0.000001');
});

test('top-up is exactly the shortfall, never more, and respects the per-deposit limit', () => {
  const cap = 1_000_000n;
  assert.deepEqual(T.planTopUp({ priceAtomic: 20_000n, availableAtomic: 20_000n, maxDepositAtomic: cap }), { needed: false, amountAtomic: 0n });
  assert.deepEqual(T.planTopUp({ priceAtomic: 20_000n, availableAtomic: 50_000n, maxDepositAtomic: cap }), { needed: false, amountAtomic: 0n });
  assert.deepEqual(T.planTopUp({ priceAtomic: 20_000n, availableAtomic: 0n, maxDepositAtomic: cap }), { needed: true, amountAtomic: 20_000n });
  assert.deepEqual(T.planTopUp({ priceAtomic: 500_000n, availableAtomic: 120_000n, maxDepositAtomic: cap }), { needed: true, amountAtomic: 380_000n });
  const over = T.planTopUp({ priceAtomic: 1_500_000n, availableAtomic: 0n, maxDepositAtomic: cap });
  assert.match(over.error ?? '', /above the per-deposit limit/);
  assert.equal(over.amountAtomic, undefined, 'nothing is planned when the limit would be exceeded');
  assert.ok(T.planTopUp({ priceAtomic: 0n, availableAtomic: 0n, maxDepositAtomic: cap }).error);
});

test('transfer calldata is a standard ERC-20 transfer to the deposit address for exactly the planned amount', () => {
  const to = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
  const data = T.transferCalldata(to, 380_000n) as `0x${string}`;
  const d = decodeFunctionData({ abi: erc20Abi, data });
  assert.equal(d.functionName, 'transfer');
  assert.equal((d.args![0] as string).toLowerCase(), to.toLowerCase());
  assert.equal(d.args![1], 380_000n);
  assert.throws(() => T.transferCalldata('0x1234', 1n));
  assert.throws(() => T.transferCalldata(to, 0n));
});

test('only "not yet" outcomes keep the flow waiting', () => {
  assert.equal(T.isPendingCode('NOT_ENOUGH_CONFIRMATIONS'), true);
  assert.equal(T.isPendingCode('TX_NOT_FOUND'), true);
  assert.equal(T.isPendingCode('NO_MATCHING_TRANSFER'), false);
  assert.equal(T.isPendingCode('TX_REVERTED'), false);
});
