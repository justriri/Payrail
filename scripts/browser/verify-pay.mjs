// Real-browser regression for the one-click "Pay" flow in REAL-FUNDS mode, against a FAKE chain.
// It starts its own in-process server (live mode, fake chain reader, fake seller API) and drives headless Edge with an
// injected FAKE wallet. Every signature is made by a local TEST key in this process; no real network, key or funds are used.
//   node scripts/browser/verify-pay.mjs <output dir>
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, erc20Abi } from 'viem';
import { openDb } from '../../src/db.ts';
import { seedDemo, createDemoNetwork } from '../../src/demoapis.ts';
import { RateLimiter } from '../../src/egress.ts';
import { TRANSFER_TOPIC } from '../../src/funding.ts';
import { generateMasterKey } from '../../src/vault.ts';
import { createWebServer } from '../../src/webapi.ts';
import { createSimulatedRuntime } from '../../src/websim.ts';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const mk = generateMasterKey('k1');
const SELLER_SECRET = 'sk_pay_regression_secret_0123456789';
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 220) : ''}`);

// ---------------------------------------------------------------- fake chain + live-mode server
const receipts = new Map();
const reader = { blockNumber: async () => 5_000n, receipt: async (h) => receipts.get(h.toLowerCase()) ?? null };
const db = openDb(':memory:');
seedDemo(db, mk);
const demo = createDemoNetwork();
const txt = new Map();
const sellerResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const sellerTransport = async (r) => {
  const ok = r.headers['x-api-key'] === SELLER_SECRET;
  return { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(ok ? { quote: 7, asOf: new Date().toISOString() } : { error: 'bad key' })) };
};
const market = {
  db, keys: [mk], activeKey: mk,
  execute: {
    call: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sellerResolver, transport: sellerTransport } },
    demoCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: demo.resolver, transport: demo.transport, timeoutMs: 500 } },
  },
  testCall: { limiter: new RateLimiter(100, 100), fetchOptions: { resolver: sellerResolver, transport: sellerTransport } },
  domain: { txt: async (name) => (txt.has(name) ? [[txt.get(name)]] : []) },
  live: {
    funding: { chainId: 42220, token: USDT, asset: 'USDT', depositAddress: DEP, minConfirmations: 3, maxDepositAtomic: 1_000_000n, reader },
    payout: { payableAssets: ['USDT'], minAtomic: 10_000n, maxAtomic: 1_000_000n },
  },
};
const { server, token } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'pay-test', market });
await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, { body, bearer } = {}) => {
  const r = await fetch(`${BASE}/api/market${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', 'x-payrail-token': token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
  return r.json();
};

// ---------------------------------------------------------------- a published REAL-USDT listing (price in a few sizes)
const sellerKey = privateKeyToAccount(generatePrivateKey());
const sl = await call('POST', '/seller/login/start', { body: { wallet: sellerKey.address, chainId: 42220 } });
const sc = await call('POST', '/seller/login/complete', { body: { wallet: sellerKey.address, nonce: sl.nonce, signature: await sellerKey.signMessage({ message: sl.message }) } });
async function publish(name, price) {
  const c = await call('POST', '/seller/listings', { bearer: sc.token, body: { name, endpointUrl: `https://api.${name.toLowerCase().replace(/\W+/g, '')}.example/v1/quote`, price, live: true } });
  const l = c.listing;
  await call('POST', `/seller/listing/${l.id}/wallet-proof`, { bearer: sc.token, body: { signature: await sellerKey.signMessage({ message: l.challenge.walletMessage }) } });
  txt.set(l.challenge.dnsRecord.name, l.challenge.dnsRecord.value);
  await call('POST', `/seller/listing/${l.id}/domain-proof`, { bearer: sc.token, body: { method: 'dns_txt' } });
  await call('POST', `/seller/listing/${l.id}/credential`, { bearer: sc.token, body: { label: 'key', headerName: 'X-Api-Key', value: SELLER_SECRET } });
  const sug = await call('POST', `/seller/listing/${l.id}/suggest-contract`, { bearer: sc.token, body: { input: {} } });
  const prop = await call('POST', `/seller/listing/${l.id}/contract`, { bearer: sc.token, body: { contract: sug.suggestion } });
  await call('POST', `/seller/contract/${prop.contract.id}/approve`, { bearer: sc.token });
  const pub = await call('POST', `/seller/listing/${l.id}/publish`, { bearer: sc.token });
  if (!pub.ok) throw new Error('could not publish test listing: ' + JSON.stringify(pub));
  return l.id;
}
const cheapId = await publish('Cheap Quote API', '0.05');
const dearId = await publish('Dear Quote API', '1.5');
const demoId = (await call('GET', '/catalog')).items.find((i) => i.source === 'payrail' && i.demo).id;

// ---------------------------------------------------------------- browser with an injected FAKE wallet
const buyerKey = privateKeyToAccount(generatePrivateKey());
const sends = [];
let sendMode = 'ok'; // ok | decline | short
let hashN = 0x10;
const b = await launch(9390, OUT, 1366, 900);
await b.send('Runtime.enable');
await b.send('Runtime.addBinding', { name: '__wallet' });
b.on('Runtime.bindingCalled', async (p) => {
  if (p.name !== '__wallet') return;
  const { id, kind, payload } = JSON.parse(p.payload);
  let out;
  try {
    if (kind === 'sign') out = { ok: true, value: await buyerKey.signMessage({ message: payload.message }) };
    else if (kind === 'send') {
      const tx = payload;
      sends.push(tx);
      if (sendMode === 'decline') out = { ok: false, error: 'User rejected the request.' };
      else {
        const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        let amount = d.args[1];
        if (sendMode === 'short') amount = amount / 2n;
        const hash = `0x${(++hashN).toString(16).padStart(64, '0')}`;
        const pad = (a) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
        // the receipt reflects what the PAGE actually asked the wallet to send (token, sender, recipient, amount)
        receipts.set(hash, { status: 'success', blockNumber: 4_990n, logs: [{ address: tx.to, topics: [TRANSFER_TOPIC, pad(tx.from), pad(d.args[0])], data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 1 }] });
        out = { ok: true, value: hash };
      }
    }
  } catch (e) { out = { ok: false, error: String(e.message || e) }; }
  await b.ev(`window.__walletResult(${JSON.stringify(id)}, ${JSON.stringify(out)}); 0`);
});
const FAKE_WALLET = `(() => {
  const pending = new Map(); let n = 0;
  window.__walletResult = (id, out) => { const p = pending.get(id); if (!p) return; pending.delete(id); out.ok ? p.resolve(out.value) : p.reject(new Error(out.error)); };
  const ask = (kind, payload) => new Promise((resolve, reject) => { const id = 'w' + (++n); pending.set(id, { resolve, reject }); window.__wallet(JSON.stringify({ id, kind, payload })); });
  window.__payrailPollMs = 150;
  window.ethereum = { isFakeTestWallet: true, request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['${buyerKey.address}'];
    if (method === 'eth_chainId') return '0xa4ec';
    if (method === 'personal_sign') return ask('sign', { message: params[0] });
    if (method === 'eth_sendTransaction') return ask('send', params[0]);
    throw new Error('unsupported method ' + method);
  } };
})();`;
const steps = () => b.ev(`JSON.stringify([...document.querySelectorAll('#pay-steps li')].map(li => ({ k: li.dataset.step, s: li.dataset.state, t: li.lastChild.textContent })))`).then((x) => JSON.parse(x || '[]'));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const pay = async (id, input = '{}') => {
  await b.goto(`${BASE}/api.html?id=${id}`, 1800);
  await b.set('#run-input', input);
  await b.click('#run-btn', 'Pay and Use API');
  await b.sleep(250);
  await b.click('#run-confirm', 'Confirm');
};
const buyerLive = async (tokenValue) => (await call('GET', '/me', { bearer: tokenValue })).live;
const buyerToken = () => b.ev(`localStorage.getItem('payrail.buyer')`);

// ================= 0. the pages say, and behave like, REAL-FUNDS mode
await b.goto(`${BASE}/`, 1500);
check('landing page states LIVE mode from the server config', /LIVE: this server is in real-funds mode/.test(await b.text('#mode-note')), await b.text('#mode-note'));
await b.goto(`${BASE}/market.html#/buyer`, 2200);
check('dashboard shows a LIVE pill, not DEMO', /LIVE · real USDT/.test(await b.text('#mode-pill')) && /REAL FUNDS MODE/.test(await b.text('#mode-banner')), `${await b.text('#mode-pill')} | ${await b.text('#mode-banner')}`);
check('signed-out buyer is offered wallet sign-in first; test credits are a collapsed demo option', (await b.ev(`!!document.querySelector('#wallet-signin')`)) && /REAL FUNDS/.test(await b.text('#buyer')) && (await b.ev(`document.querySelector('#buyer details')?.open === false`)));
await b.goto(`${BASE}/market.html#/buyer/explore`, 2000);
let names = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc h4')].map(h => h.textContent))`).then(JSON.parse);
check('explore lists the real-USDT APIs and hides demo APIs by default', names.includes('Cheap Quote API') && !names.some((n) => /Demo token price/.test(n)), JSON.stringify(names));
await b.ev(`document.querySelector('#show-demo').click(); 0`);
await b.sleep(1200);
names = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc h4')].map(h => h.textContent))`).then(JSON.parse);
check('"Show demo APIs" reveals them, clearly labelled DEMO', names.some((n) => /Demo token price/.test(n)) && /DEMO/.test(await b.text('#cat-list')), JSON.stringify(names).slice(0, 160));
await b.ev(`document.querySelector('#show-demo').click(); 0`);

// ================= 1. no wallet installed
await pay(cheapId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
let st = await steps();
check('no wallet installed: clear message, nothing sent, nothing charged', st[0]?.k === 'wallet' && st[0]?.s === 'failed' && /No browser wallet found/.test(st[0].t) && sends.length === 0, JSON.stringify(st));
check('the real-USDT API page labels itself REAL USDT', /REAL USDT/.test(await b.text('#mode-badge')));

// ================= 2. inject the wallet, then the happy path
await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_WALLET });
await pay(cheapId);
await until(async () => /Charged/.test((await b.text('#run-result')) || ''), 25000);
st = await steps();
const keys = st.map((s) => `${s.k}:${s.s}`).join(' ');
check('one click: connect, sign in, verify wallet, check balance, send, confirm all succeed in order', st.map((s) => s.k).join(',') === 'wallet,login,verify,plan,send,confirm' && st.every((s) => s.s === 'done'), keys);
check('the page asked the wallet for exactly one USDT transfer of the shortfall (0.05) to the deposit address', sends.length === 1 && sends[0].to.toLowerCase() === USDT.toLowerCase() && decodeFunctionData({ abi: erc20Abi, data: sends[0].data }).args[1] === 50_000n && decodeFunctionData({ abi: erc20Abi, data: sends[0].data }).args[0].toLowerCase() === DEP.toLowerCase(), JSON.stringify(sends[0]));
const r = await b.text('#run-result');
check('the API ran only after the verified credit: charged 0.05 USDT with a receipt', /Charged 0\.05 USDT/.test(r) && /Receipt/.test(r) && /Platform fee\s+0\.0015/.test(r), r.replace(/\s+/g, ' ').slice(0, 200));
let tok = await buyerToken();
const after = await buyerLive(tok);
check('ledger: buyer balance is 0 after the charge (top-up credited then spent exactly once)', after && after.available === '0', JSON.stringify(after));
const sellerMe = await call('GET', '/me', { bearer: sc.token });
check('seller earned price minus the 3% fee (0.0485 USDT)', sellerMe.live && sellerMe.live.earnings === '0.0485', JSON.stringify(sellerMe.live));
check('no request was charged by merely opening pages (single charged execution)', db.prepare("SELECT COUNT(*) AS n FROM executions WHERE state = 'QUALIFIED'").get().n === 1n || Number(db.prepare("SELECT COUNT(*) AS n FROM executions WHERE state = 'QUALIFIED'").get().n) === 1);
await b.shot('pay-success');

// ================= 3. the wallet declines the transaction
sendMode = 'decline';
const sendsBefore = sends.length;
await pay(cheapId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
st = await steps();
const failed = st.find((s) => s.s === 'failed');
check('wallet declines the transfer: clear failure, nothing charged, no credit', failed && failed.k === 'send' && /not sent/.test(failed.t) && sends.length === sendsBefore + 1 && (await buyerLive(tok)).available === '0', JSON.stringify(st.slice(-2)));

// ================= 4. a short transfer: only what really arrived is credited, and the request is not run for free
sendMode = 'short';
await pay(cheapId);
await until(async () => (await steps()).some((x) => x.s === 'failed'), 25000);
const rs = JSON.stringify(await steps());
const bal = await buyerLive(tok);
check('short transfer: credited only the 0.025 that arrived; the 0.05 request was not run or charged', bal.available === '0.025' && /less than the price/.test(rs) && !/Charged/.test((await b.text('#run-result')) || ''), `${JSON.stringify(bal)} | ${rs.slice(0, 220)}`);

// ================= 5. price above the per-deposit limit: refuse before sending anything
sendMode = 'ok';
const s5 = sends.length;
await pay(dearId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
st = await steps();
check('above the 1 USDT per-deposit limit: refused with the reason before any transaction', st.some((s) => s.k === 'plan' && s.s === 'failed' && /per-deposit limit/.test(s.t)) && sends.length === s5, JSON.stringify(st.slice(-1)));

// ================= 6. demo listing stays on test credits, no wallet flow
await b.goto(`${BASE}/api.html?id=${demoId}`, 1800);
check('demo API stays clearly separate: TEST CREDITS badge, test-credit start, no wallet steps', /TEST CREDITS/.test(await b.text('#mode-badge')) && (await b.ev(`!!document.querySelector('#api-balance')`)) && (await steps()).length === 0);

console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
await new Promise((r2) => server.close(() => r2()));
process.exit(0);
