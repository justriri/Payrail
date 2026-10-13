import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { PaymentRequirements } from '@celo/buy-core';
import { assertTagged, withTag } from '../src/attribution.ts';
import { checkChallenge, checkPolicy } from '../src/buy.ts';
import { ConfigError, OFFICIAL_ATTRIBUTION_TAG, loadConfig } from '../src/config.ts';
import { readHistory, spentSince } from '../src/history.ts';
import { classifyPayment } from '../src/receipt.ts';
import { isSettled, verifySettlement } from '../src/verify.ts';
import type { PaymentRecord, SettlementEvidence } from '../src/verify.ts';
import { toDataSuffix } from '@celo/attribution-tags';
import { OTHER, PAY_TO, SERVICE_URL, TX, USDT, tempDir } from './support.ts';

const TAG = 'celo_b2fff2ac9413';

// ------------------------------------------------------------------ attribution gate
test('attribution: the official tag is exactly celo_b2fff2ac9413', () => {
  assert.equal(OFFICIAL_ATTRIBUTION_TAG, TAG);
});

test('attribution gate accepts exactly one correct tag at the end', () => {
  const tagged = withTag('0x095ea7b3' + '00'.repeat(64) as `0x${string}`, TAG);
  assertTagged(tagged, TAG);
});

test('attribution gate rejects missing, wrong, multiple, malformed and misplaced suffixes', () => {
  const stub = ('0x095ea7b3' + '00'.repeat(64)) as `0x${string}`;
  const sfx = (c: string | string[]) => toDataSuffix(c).slice(2);
  const bad: Array<[string, string]> = [
    ['missing', stub],
    ['wrong code', stub + sfx('celo_000000000000')],
    ['stacked tags', stub + sfx(TAG) + sfx(TAG)],
    ['two codes in one suffix', stub + sfx([TAG, 'minipay'])],
    ['malformed', stub + '1234' + '80218021802180218021802180218021'],
    ['tag not at the end', stub + sfx(TAG) + '00'],
    ['empty', '0x'],
    ['not hex', 'hello'],
  ];
  for (const [label, data] of bad) {
    assert.throws(() => assertTagged(data, TAG), `${label} must be rejected`);
  }
});

// ------------------------------------------------------------------ config gate
test('config: refuses a missing or altered tag', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ PAYRAIL_ATTRIBUTION_TAG: 'celo_b2fff2ac9414' }), ConfigError);
  assert.throws(() => loadConfig({ PAYRAIL_ATTRIBUTION_TAG: TAG.toUpperCase() }), ConfigError);
  assert.equal(loadConfig({ PAYRAIL_ATTRIBUTION_TAG: TAG }).attributionTag, TAG);
});

test('config: refuses wrong chain, non-https RPC and unverified token overrides', () => {
  const base = { PAYRAIL_ATTRIBUTION_TAG: TAG };
  assert.throws(() => loadConfig({ ...base, PAYRAIL_CHAIN_ID: '1' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, PAYRAIL_RPC_URL: 'http://localhost:8545' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, PAYRAIL_USDT_ADDRESS: OTHER }), ConfigError);
  assert.doesNotThrow(() => loadConfig({ ...base, PAYRAIL_USDT_ADDRESS: USDT.toLowerCase() }));
});

test('config: a malformed private key is reported without echoing the value', () => {
  const secret = '0xnot-a-real-key-but-must-not-appear-in-errors';
  try {
    loadConfig({ PAYRAIL_ATTRIBUTION_TAG: TAG, PAYRAIL_PRIVATE_KEY: secret });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!JSON.stringify(e.problems).includes('not-a-real-key'));
  }
});

// ------------------------------------------------------------------ challenge policy
function req(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'celo',
    maxAmountRequired: '5000',
    resource: SERVICE_URL,
    description: 'x',
    mimeType: 'application/json',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDT,
    ...over,
  };
}
const expected = { resource: SERVICE_URL, asset: USDT, payTo: PAY_TO, maxAtomic: 5000n };

test('challenge check: exact match passes; each deviation is a problem', () => {
  assert.deepEqual(checkChallenge(req(), expected), []);
  assert.ok(checkChallenge(req({ scheme: 'upto' }), expected).length > 0);
  assert.ok(checkChallenge(req({ network: 'base' }), expected).length > 0);
  assert.ok(checkChallenge(req({ resource: 'https://evil.example/x' }), expected).length > 0);
  assert.ok(checkChallenge(req({ asset: OTHER }), expected).length > 0);
  assert.ok(checkChallenge(req({ payTo: OTHER }), expected).length > 0);
  assert.ok(checkChallenge(req({ maxAmountRequired: '5001' }), expected).length > 0);
  assert.ok(checkChallenge(req({ maxAmountRequired: '5e3' }), expected).length > 0);
});

test('original single-service policy still behaves as before (cap, pinned payTo, catalog payTo)', () => {
  const facts = { expectedAsset: USDT, catalogPayTo: PAY_TO };
  assert.deepEqual(checkPolicy(req(), facts), []);
  assert.ok(checkPolicy(req({ maxAmountRequired: '10001' }), facts).length > 0);
  assert.ok(checkPolicy(req({ payTo: OTHER }), facts).length > 0);
  assert.ok(checkPolicy(req(), { expectedAsset: USDT, catalogPayTo: OTHER as Address }).length > 0);
});

// ------------------------------------------------------------------ settlement verification
const payer = getAddress('0x652c9023626d1a00ad0d130c9cdc5c5f3644d2a4');
const record: PaymentRecord = {
  asset: USDT,
  amountAtomic: 5000n,
  payer,
  payTo: PAY_TO,
  txHash: TX,
  authorization: { from: payer, nonce: '0x' + '11'.repeat(32), validAfter: '0', validBefore: '9999999999' },
  timestamp: new Date().toISOString(),
};
const okLogs = { status: 'success', logs: [{ address: USDT, from: payer, to: PAY_TO, value: 5000n }] };
const unknown = async () => ({ state: 'unknown' as const, detail: 'x' });

test('verification: matching Transfer event in a successful receipt is verified', async () => {
  const ev = await verifySettlement(record, { resolveAuthorization: unknown, getTransferLogs: async () => okLogs });
  assert.equal(ev.transferVerified, true);
  assert.equal(isSettled(ev), true);
});

test('verification: wrong amount, wrong recipient, or reverted tx is NOT verified', async () => {
  const cases = [
    { status: 'success', logs: [{ address: USDT, from: payer, to: PAY_TO, value: 4999n }] },
    { status: 'success', logs: [{ address: USDT, from: payer, to: OTHER, value: 5000n }] },
    { status: 'reverted', logs: okLogs.logs },
  ];
  for (const logs of cases) {
    const ev = await verifySettlement(record, { resolveAuthorization: unknown, getTransferLogs: async () => logs });
    assert.equal(isSettled(ev), false);
  }
});

test('verification: RPC failures degrade to "not settled", never to success', async () => {
  const ev = await verifySettlement(record, {
    resolveAuthorization: async () => {
      throw new Error('rpc down');
    },
    getTransferLogs: async () => {
      throw new Error('rpc down');
    },
  });
  assert.equal(ev.authorizationState, 'error');
  assert.equal(isSettled(ev), false);
});

// ------------------------------------------------------------------ receipt status
test('classification: only delivered + independently settled is CONFIRMED', () => {
  const settled: SettlementEvidence = { authorizationState: 'settled', txHash: TX, transferVerified: true, notes: [] };
  const unknownEv: SettlementEvidence = { authorizationState: 'unknown', txHash: undefined, transferVerified: false, notes: [] };
  const expired: SettlementEvidence = { authorizationState: 'not_settled', txHash: undefined, transferVerified: false, notes: [] };
  assert.equal(classifyPayment({ delivered: true, evidence: settled }).status, 'CONFIRMED');
  assert.equal(classifyPayment({ delivered: false, evidence: settled }).status, 'UNCERTAIN');
  assert.equal(classifyPayment({ delivered: true, evidence: unknownEv }).status, 'UNCERTAIN');
  assert.equal(classifyPayment({ delivered: true, evidence: undefined }).status, 'UNCERTAIN');
  const r = classifyPayment({ delivered: false, evidence: expired });
  assert.deepEqual([r.status, r.retryAllowed], ['REJECTED', true]);
  for (const c of [settled, unknownEv]) assert.equal(classifyPayment({ delivered: true, evidence: c }).retryAllowed, false);
});

// ------------------------------------------------------------------ history
test('history: the legacy receipt format (first verified payment) still reads; bad files are reported', () => {
  const dir = tempDir();
  const legacy = {
    id: 'direct-2026-10-12T16-02-41-922Z',
    createdAt: '2026-10-12T16:02:41.922Z',
    flow: 'direct (no swap needed)',
    payment: { asset: USDT, amountAtomic: '5000', txHash: TX },
    outcome: { delivered: true, settled: true },
  };
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify(legacy));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  const h = readHistory(dir);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.schemaVersion, undefined);
  assert.equal(h.receipts[0]!.amountAtomic, 5000n);
  assert.equal(h.invalid.length, 1);
});

test('history: spend totals count settled legacy and UNCERTAIN receipts, never REJECTED, respect the window', () => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const mk = (name: string, ageMs: number, extra: Record<string, unknown>, amount = '5000') =>
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ id: name, createdAt: new Date(now - ageMs).toISOString(), payment: { amountAtomic: amount }, ...extra }),
    );
  mk('legacy-settled', 1000, { outcome: { settled: true } });
  mk('confirmed', 1000, { schemaVersion: 1, status: 'CONFIRMED' });
  mk('uncertain', 1000, { schemaVersion: 1, status: 'UNCERTAIN' });
  mk('rejected', 1000, { schemaVersion: 1, status: 'REJECTED' });
  mk('old', 3 * 86_400_000, { schemaVersion: 1, status: 'CONFIRMED' });
  const total = spentSince(readHistory(dir), now - 86_400_000);
  assert.equal(total, 15000n); // legacy + confirmed + uncertain; not rejected; not the 3-day-old one
});

// ------------------------------------------------------------------ structural: no authorization bypass
test('authorization minting is confined to the modules that own each gate (no execution bypass)', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  // function name -> the ONLY files allowed to call it (outside tests)
  const allowed: Record<string, string[]> = {
    mintAuthorization: ['src/planner.ts', 'src/authorization.ts'],
    mintSwapAuthorization: ['src/planner.ts', 'src/authorization.ts'],
    mintBroadcastAuthorization: ['src/swapexec.ts'],
  };
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        const rel = relative(root, p).replace(/\\/g, '/');
        for (const [fn, files] of Object.entries(allowed)) {
          if (new RegExp(`\\b${fn}\\s*\\(`).test(text) && !files.includes(rel)) offenders.push(`${rel} calls ${fn}`);
        }
      }
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'scripts'));
  assert.deepEqual(offenders, []);
});

test('only the validated-sequence adapter can sign: createSwapChain.prepare refuses an unvalidated step', async () => {
  const { createSwapChain } = await import('../src/swapchain.ts');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const account = privateKeyToAccount(generatePrivateKey());
  const chain = createSwapChain({ account });
  await assert.rejects(
    chain.prepare({ kind: 'swap', to: account.address, data: '0x', taggedData: '0x', value: 0n }, account.address),
    /not a validated/,
  );
});
