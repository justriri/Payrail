// A FAKE Buy AI gateway and a FAKE chain, for tests and browser regressions only (never imported by production code).
// The fake gateway enforces what the real one does: it answers HTTP 402 with an x402 challenge until a valid X-PAYMENT authorization
// (EIP-3009, signed by the payer over the exact payee and amount) arrives; then it "settles" on the fake chain and answers 200.
import { verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';
import { normalizeCatalog } from '../src/catalog.ts';
import type { VerifyDeps } from '../src/verify.ts';

export const USDT: Address = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
export const USDC: Address = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const PAY_TO: Address = '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B';
export const URL1 = 'https://gateway.usebuy.ai/v1/social/x/posts/search';
export const URL2 = 'https://gateway.usebuy.ai/v1/instagram/profile';
export const FAKE_TX = `0x${'ab'.repeat(32)}` as Hex;

export const buyCatalog = (now: number) =>
  normalizeCatalog(
    {
      payment: { protocol: 'x402', x402Version: 1, network: 'celo', chainId: 42220, payTo: PAY_TO, tokens: [{ symbol: 'USDT', asset: USDT, decimals: 6 }] },
      capabilities: [
        { id: 'x.posts.search', title: 'X posts search', description: 'Search posts on X', method: 'POST', url: URL1, available: true, platform: 'x', provider: 'Buy', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] },
          inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'What to search for' } } } },
        { id: 'instagram.profile', title: 'Instagram profile', description: 'Fetch a public profile', method: 'POST', url: URL2, available: true, platform: 'instagram', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] },
          inputSchema: { type: 'object', required: ['username'], properties: { username: { type: 'string' } } } },
        { id: 'down.api', title: 'Unavailable API', description: 'Buy reports this one as down', method: 'POST', url: 'https://gateway.usebuy.ai/v1/down', available: false, platform: 'x', price: { usd: '0.005', atomic: '5000', tokens: ['USDT'] } },
      ],
    },
    now,
  );

export type FakeMode = 'ok' | 'http402' | 'http500' | 'throw' | 'ok_unsettled' | 'ok_failed_flag';
export interface FakeBuyOptions {
  price?: string;
  offers?: 'usdt' | 'usdc-only' | 'wrong-payto' | 'wrong-network';
  mode?: FakeMode;
  chain?: 'wrong-amount' | 'wrong-payee';
  now: () => number;
}

export function createFakeBuy(o: FakeBuyOptions) {
  const gateway = { paidRequests: 0, unpaidRequests: 0, mode: (o.mode ?? 'ok') as FakeMode, lastAuth: undefined as undefined | { from: string; to: string; value: string; nonce: string } };
  const settled = new Set<string>();
  const transfers = new Map<string, { from: string; to: string; value: bigint; asset: string }>();
  const challenge = (url: string) => {
    const base = {
      scheme: 'exact', network: o.offers === 'wrong-network' ? 'base' : 'celo', maxAmountRequired: o.price ?? '5000', resource: url, description: 'x', mimeType: 'application/json',
      payTo: o.offers === 'wrong-payto' ? '0x00000000000000000000000000000000000000ee' : PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDT', version: '1' },
    };
    const accepts = o.offers === 'usdc-only' ? [{ ...base, asset: USDC }] : [{ ...base, asset: USDC }, { ...base, asset: USDT }];
    return new Response(JSON.stringify({ x402Version: 1, accepts, error: 'payment required' }), { status: 402, headers: { 'content-type': 'application/json' } });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const hdr = (init?.headers ?? {}) as Record<string, string>;
    const xp = hdr['X-PAYMENT'];
    if (!xp) {
      gateway.unpaidRequests++;
      return challenge(url);
    }
    gateway.paidRequests++;
    const payload = JSON.parse(Buffer.from(xp, 'base64').toString('utf8')) as { payload: { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } } };
    const a = payload.payload.authorization;
    gateway.lastAuth = { from: a.from, to: a.to, value: a.value, nonce: a.nonce };
    const good = await verifyTypedData({
      address: a.from,
      domain: { name: 'USDT', version: '1', chainId: 42220, verifyingContract: USDT },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: payload.payload.signature,
    });
    if (!good || a.to.toLowerCase() !== PAY_TO.toLowerCase()) return challenge(url);
    if (gateway.mode === 'throw') throw new Error('socket hang up');
    if (gateway.mode === 'http500') return new Response('{"error":"upstream failed"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (gateway.mode === 'http402') return challenge(url);
    if (gateway.mode !== 'ok_unsettled') {
      // what ends up on the fake chain; a buggy or hostile gateway could report a settlement that does not match the order
      if (o.chain === 'wrong-amount') transfers.set(FAKE_TX, { from: a.from, to: a.to, value: 1n, asset: USDT });
      else if (o.chain === 'wrong-payee') transfers.set(FAKE_TX, { from: a.from, to: '0x00000000000000000000000000000000000000ee', value: BigInt(a.value), asset: USDT });
      else {
        settled.add(a.nonce);
        transfers.set(FAKE_TX, { from: a.from, to: a.to, value: BigInt(a.value), asset: USDT });
      }
    }
    const pr = Buffer.from(JSON.stringify({ success: gateway.mode !== 'ok_failed_flag', transaction: FAKE_TX, network: 'celo', payer: a.from })).toString('base64');
    return new Response('{"posts":[{"id":1,"text":"hello from the fake gateway"}]}', { status: 200, headers: { 'content-type': 'application/json', 'x-payment-response': pr } });
  }) as typeof fetch;
  const verify: VerifyDeps = {
    resolveAuthorization: async (p) => (settled.has(p.authorization.nonce) ? { state: 'settled', txHash: FAKE_TX } : { state: 'not_settled', detail: 'nonce unused' }),
    getTransferLogs: async (tx) => {
      const t = transfers.get(tx);
      return t ? { status: 'success', logs: [{ address: t.asset as Address, from: t.from as Address, to: t.to as Address, value: t.value }] } : { status: 'success', logs: [] };
    },
  };
  return { catalog: buyCatalog(o.now()), fetchImpl, verify, gateway, settled, transfers };
}

/** the wallet side: sign the typed data exactly as eth_signTypedData_v4 would */
export const signAuthorization = (acct: { signTypedData: (a: any) => Promise<Hex> }, td: any) =>
  acct.signTypedData({
    domain: td.domain,
    types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: { from: td.message.from, to: td.message.to, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore), nonce: td.message.nonce },
  });
