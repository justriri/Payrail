// Shared harness for the browser regressions. DEVELOPMENT ONLY.
//
// It starts the REAL web server and the REAL marketplace modules in REAL-FUNDS mode, but against a FAKE chain reader and a fake
// seller API, and gives headless Edge a FAKE wallet whose signatures are made by a local TEST key in this process. Nothing here
// touches a network, a real key or real funds, and none of it is reachable from the production server (scripts/serve.ts).
// The point is to exercise the production code paths (wallet sign-in, on-chain verification, outcome billing) end to end.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, erc20Abi } from 'viem';
import { openDb } from '../../src/db.ts';
import { seedDemo, createDemoNetwork } from '../../src/dev/demoapis.ts';
import { RateLimiter } from '../../src/egress.ts';
import { TRANSFER_TOPIC, fundingMessage } from '../../src/funding.ts';
import { generateMasterKey } from '../../src/vault.ts';
import { createWebServer } from '../../src/webapi.ts';
import { createSimulatedRuntime } from '../../src/dev/websim.ts';

export const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
export const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
export const SELLER_SECRET = 'sk_browser_regression_secret_0123456789';
const pad = (a) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;

export async function startHarness({ seedLegacyDemoRows = true, capAtomic = 1_000_000n, minConfirmations = 3 } = {}) {
  const mk = generateMasterKey('k1');
  const db = openDb(':memory:');
  // the legacy demo rows exist in the database (as in an old marketplace file): production must still never show or sell them
  if (seedLegacyDemoRows) seedDemo(db, mk);
  const demo = createDemoNetwork();
  const receipts = new Map();
  const reader = { blockNumber: async () => 5_000n, receipt: async (h) => receipts.get(h.toLowerCase()) ?? null };
  const txt = new Map();
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const transport = async (r) => {
    const ok = r.headers['x-api-key'] === SELLER_SECRET;
    const scenario = /[?&]scenario=([a-z0-9]+)/.exec(r.path)?.[1];
    const asOf = scenario === 'stale' ? new Date(Date.now() - 3_600_000).toISOString() : new Date().toISOString();
    if (ok && scenario === 'http500') return { status: 500, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"boom"}') };
    return { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(ok ? { quote: 7, asOf } : { error: 'bad key' })) };
  };
  const market = {
    db, keys: [mk], activeKey: mk,
    execute: {
      call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport } },
      demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 500 } },
    },
    testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver, transport } },
    domain: { txt: async (name) => (txt.has(name) ? [[txt.get(name)]] : []) },
    live: {
      funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: DEP, minConfirmations, maxDepositAtomic: capAtomic, reader },
      payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: capAtomic },
    },
  };
  const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'harness', market });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, bearer } = {}) => {
    const r = await fetch(`${BASE}/api/market${path}`, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return r.json();
  };

  // ---- a seller (signed in through the real wallet-signature protocol) who can publish real-USDT listings
  const sellerKey = privateKeyToAccount(generatePrivateKey());
  const sl = await call('POST', '/seller/login/start', { body: { wallet: sellerKey.address, chainId: 42220 } });
  const sc = await call('POST', '/seller/login/complete', { body: { wallet: sellerKey.address, nonce: sl.nonce, signature: await sellerKey.signMessage({ message: sl.message }) } });
  async function publish(name, price, { description = '' } = {}) {
    const slug = name.toLowerCase().replace(/\W+/g, '');
    const c = await call('POST', '/seller/listings', { bearer: sc.token, body: { name, description, endpointUrl: `https://api.${slug}.example/v1/quote`, price } });
    if (!c.ok) throw new Error('could not create listing: ' + JSON.stringify(c));
    const l = c.listing;
    await call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: sc.token, body: { signature: await sellerKey.signMessage({ message: l.challenge.walletMessage }) } });
    txt.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
    await call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: sc.token, body: { method: 'dns_txt' } });
    await call('POST', `/seller/listing/${l.id}/credential`, { bearer: sc.token, body: { label: 'key', headerName: 'X-Api-Key', value: SELLER_SECRET } });
    const sug = await call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: sc.token, body: { input: {} } });
    const prop = await call('POST', `/seller/listing/${l.id}/contract`, { bearer: sc.token, body: { contract: sug.suggestion } });
    await call('POST', `/seller/contract/${prop.contract.id}/approve`, { bearer: sc.token });
    const pub = await call('POST', `/seller/listing/${l.id}/publish`, { bearer: sc.token });
    if (!pub.ok) throw new Error('could not publish listing: ' + JSON.stringify(pub));
    return l.id;
  }
  const demoIds = db.prepare('SELECT id FROM listings WHERE demo = 1').all().map((r) => r.id);

  // ---- the fake wallet for one browser
  let hashN = 0x1000;
  async function wire(b, key, { poll = 150 } = {}) {
    const acct = privateKeyToAccount(key);
    const wallet = { address: acct.address, sends: [], signs: [], sendMode: 'ok', denySign: false };
    await b.send('Runtime.enable');
    await b.send('Runtime.addBinding', { name: '__wallet' });
    b.on('Runtime.bindingCalled', async (p) => {
      if (p.name !== '__wallet') return;
      const { id, kind, payload } = JSON.parse(p.payload);
      let out;
      try {
        if (kind === 'sign') {
          wallet.signs.push(payload.message);
          out = wallet.denySign ? { ok: false, error: 'User rejected the request.' } : { ok: true, value: await acct.signMessage({ message: payload.message }) };
        } else if (kind === 'send') {
          const tx = payload;
          wallet.sends.push(tx);
          if (wallet.sendMode === 'decline') out = { ok: false, error: 'User rejected the request.' };
          else {
            const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
            let amount = d.args[1];
            if (wallet.sendMode === 'short') amount = amount / 2n;
            const hash = `0x${(++hashN).toString(16).padStart(64, '0')}`;
            // the receipt reflects what the PAGE asked the wallet to send (token, sender, recipient, amount)
            receipts.set(hash, { status: 'success', blockNumber: 4_990n, logs: [{ address: tx.to, topics: [TRANSFER_TOPIC, pad(tx.from), pad(d.args[0])], data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 1 }] });
            out = { ok: true, value: hash };
          }
        }
      } catch (e) { out = { ok: false, error: String(e.message || e) }; }
      await b.ev(`window.__walletResult(${JSON.stringify(id)}, ${JSON.stringify(out)}); 0`);
    });
    const source = `(() => {
      const pending = new Map(); let n = 0;
      window.__walletResult = (id, out) => { const p = pending.get(id); if (!p) return; pending.delete(id); out.ok ? p.resolve(out.value) : p.reject(new Error(out.error)); };
      const ask = (kind, payload) => new Promise((resolve, reject) => { const id = 'w' + (++n); pending.set(id, { resolve, reject }); window.__wallet(JSON.stringify({ id, kind, payload })); });
      window.__payrailPollMs = ${poll};
      window.ethereum = { isFakeTestWallet: true, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['${acct.address}'];
        if (method === 'eth_chainId') return '0xa4ec';
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'personal_sign') return ask('sign', { message: params[0] });
        if (method === 'eth_sendTransaction') return ask('send', params[0]);
        throw new Error('unsupported method ' + method);
      } };
    })();`;
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source });
    return wallet;
  }

  /** sign a buyer in with a wallet key (real protocol) and fund it from a verified on-chain USDT transfer on the fake chain */
  async function fundedBuyer(key, atomic) {
    const acct = privateKeyToAccount(key);
    const s1 = await call('POST', '/buyer/login/start', { body: { wallet: acct.address, chainId: 42220 } });
    const c = await call('POST', '/buyer/login/complete', { body: { wallet: acct.address, nonce: s1.nonce, signature: await acct.signMessage({ message: s1.message }) } });
    const reg = await call('POST', '/funding/wallet', { bearer: c.token, body: { wallet: acct.address, signature: await acct.signMessage({ message: fundingMessage(c.accountId, acct.address) }) } });
    if (!reg.ok && reg.code !== 'WALLET_TAKEN') throw new Error('could not verify the funding wallet: ' + JSON.stringify(reg));
    if (atomic > 0n) {
      const hash = `0x${(++hashN).toString(16).padStart(64, '0')}`;
      receipts.set(hash, { status: 'success', blockNumber: 4_990n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(acct.address), pad(DEP)], data: `0x${atomic.toString(16).padStart(64, '0')}`, logIndex: 1 }] });
      const conf = await call('POST', '/funding/confirm', { bearer: c.token, body: { txHash: hash } });
      if (!conf.ok) throw new Error('could not credit the test deposit: ' + JSON.stringify(conf));
    }
    return { token: c.token, accountId: c.accountId };
  }

  return {
    BASE, token, db, call, receipts, txt, publish, demoIds, wire, fundedBuyer, sellerKey, sellerToken: sc.token,
    newKey: () => generatePrivateKey(),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export const makeChecker = () => {
  const res = [];
  const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 220) : ''}`);
  const finish = () => {
    console.log(res.join('\n'));
    const failed = res.some((x) => x.startsWith('FAIL'));
    console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
    return failed;
  };
  return { check, finish, res };
};

/** words that must never appear on a production page */
export const DEMO_WORDS = /\b(demo|test credits?|start testing|sandbox|simulat\w*|testnet|mock token)\b/i;
