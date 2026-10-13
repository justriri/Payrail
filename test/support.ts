// Shared test helpers: a fake x402 gateway, ephemeral accounts, and temp directories.
// No network, no real key: accounts are generated in memory for each test run.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mintAuthorization } from '../src/authorization.ts';
import type { ExecutionAuthorization } from '../src/authorization.ts';
import { sha256Hex } from '../src/executor.ts';
import type { VerifyDeps } from '../src/verify.ts';

export const USDT: Address = getAddress('0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e');
export const PAY_TO: Address = getAddress('0x20faaca5f980e29639a0fcc6dca6988e18ed333b');
export const OTHER: Address = getAddress('0x00000000000000000000000000000000000000aa');
export const SERVICE_URL = 'https://gateway.usebuy.ai/v1/social/x/posts/search';
export const BODY = '{"query":"Celo agents","type":"latest"}';
export const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'payrail-test-'));
}

export function testAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export function makeAuth(
  payer: Address,
  over: Partial<{ amount: bigint; max: bigint; expiresAtMs: number; body: string; payTo: Address; planId: string }> = {},
): ExecutionAuthorization {
  const amount = over.amount ?? 5000n;
  return mintAuthorization({
    planId: over.planId ?? 'plan-test',
    route: 'direct',
    serviceId: 'x.posts.search',
    method: 'POST',
    url: SERVICE_URL,
    bodyHash: sha256Hex(over.body ?? BODY),
    payment: { network: 'celo', chainId: 42220, asset: USDT, symbol: 'USDT', payTo: over.payTo ?? PAY_TO, amountAtomic: amount },
    maxAmountAtomic: over.max ?? amount,
    payer,
    createdAtMs: 1_000,
    expiresAtMs: over.expiresAtMs ?? Date.now() + 60_000,
    approvedBy: 'test',
  });
}

export type GatewayMode = 'ok' | 'server_error' | 'network_error' | 'repeat_402' | 'no_challenge';

/** A fake Buy gateway. Records every request so tests can assert exactly what was (not) sent. */
export function gateway(
  opts: { mode?: GatewayMode; payTo?: Address; amount?: string; payer?: Address; delayMs?: number } = {},
) {
  const calls: Array<{ paid: boolean }> = [];
  /** Wall-clock windows during which a PAID request was in progress (to prove non-overlap across processes). */
  const windows: Array<{ start: number; end: number }> = [];
  const envelope = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'celo',
        maxAmountRequired: opts.amount ?? '5000',
        resource: SERVICE_URL,
        description: 'Search X posts through buy-gateway',
        mimeType: 'application/json',
        payTo: opts.payTo ?? PAY_TO,
        maxTimeoutSeconds: 300,
        asset: USDT,
        extra: { name: 'Tether USD', version: '1' },
      },
    ],
    error: '',
  };
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const paid = headers.has('X-PAYMENT');
    calls.push({ paid });
    const mode = opts.mode ?? 'ok';
    if (mode === 'no_challenge') return new Response('{"ok":true}', { status: 200 });
    if (!paid || mode === 'repeat_402') {
      return new Response(JSON.stringify(envelope), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'network_error') throw new Error('socket hang up');
    if (mode === 'server_error') return new Response('{"error":"settle_uncertain"}', { status: 500 });
    const start = Date.now();
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    windows.push({ start, end: Date.now() });
    const proof = Buffer.from(JSON.stringify({ success: true, transaction: TX, network: 'celo', payer: opts.payer })).toString('base64');
    return new Response(JSON.stringify({ capability: 'x.posts.search', output: { posts: [1, 2, 3] } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'X-PAYMENT-RESPONSE': proof },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    windows,
    paidCount: () => calls.filter((c) => c.paid).length,
  };
}

export function verifyDeps(kind: 'settled' | 'unknown' | 'not_settled', payer: Address, amount = 5000n): VerifyDeps {
  return {
    async resolveAuthorization() {
      if (kind === 'settled') return { state: 'settled', txHash: TX };
      if (kind === 'not_settled') return { state: 'not_settled', detail: 'authorization expired unused' };
      return { state: 'unknown', detail: 'cannot tell' };
    },
    async getTransferLogs() {
      if (kind !== 'settled') throw new Error('receipt unavailable');
      return { status: 'success', logs: [{ address: USDT, from: payer, to: PAY_TO, value: amount }] };
    },
  };
}
