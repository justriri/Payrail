// Browser regression: the one-click Pay flow and the production surface, in REAL-FUNDS mode against a FAKE chain (see harness.mjs).
//   node scripts/browser/verify-pay.mjs <output dir>
import { decodeFunctionData, erc20Abi } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { DEMO_WORDS, DEP, USDT, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness();
const { check, finish } = makeChecker();
const cheapId = await h.publish('Cheap Quote API', '0.05', { description: 'A real-USDT listing priced at five cents' });
const dearId = await h.publish('Dear Quote API', '1.5');
const b = await launch(9390, OUT, 1366, 900);

const steps = () => b.ev(`JSON.stringify([...document.querySelectorAll('#pay-steps li')].map(li => ({ k: li.dataset.step, s: li.dataset.state, t: li.lastChild.textContent })))`).then((x) => JSON.parse(x || '[]'));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const pay = async (id, input = '{}') => {
  await b.goto(`${h.BASE}/api.html?id=${id}`, 1800);
  await b.set('#run-input', input);
  await b.click('#run-btn', 'Pay and Use API');
  await b.sleep(250);
  await b.click('#run-confirm', 'Confirm');
};
const live = async (token) => (await h.call('GET', '/me', { bearer: token })).live;
const buyerToken = () => b.ev(`localStorage.getItem('payrail.buyer')`);
const count = (table, where = '1=1') => Number(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n);

// ================= 0. the production surface: real mode, no demo anywhere
await b.goto(`${h.BASE}/`, 1500);
let t = await b.text('body');
check('landing page states the real network and token from the server config', /Real funds: USDT on Celo mainnet \(chain 42220\)/.test(await b.text('#mode-note')), await b.text('#mode-note'));
check('landing page has no demo / test-credit / simulation language', !DEMO_WORDS.test(t), (t.match(DEMO_WORDS) || [])[0]);
await b.goto(`${h.BASE}/market.html#/buyer`, 2200);
t = await b.text('body');
check('dashboard shows a LIVE pill and the real network', /LIVE · USDT on Celo mainnet/.test(await b.text('#mode-pill')) && /REAL FUNDS · Celo mainnet \(chain 42220\) · pay in USDT · 3% platform fee/.test(await b.text('#mode-banner')), `${await b.text('#mode-pill')} | ${await b.text('#mode-banner')}`);
check('signed-out buyer sees wallet sign-in only: no test credits, no demo option', (await b.ev(`!!document.querySelector('#wallet-signin')`)) && !DEMO_WORDS.test(t), (t.match(DEMO_WORDS) || [])[0]);
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2000);
const names = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc h4')].map(x => x.textContent))`).then(JSON.parse);
t = await b.text('body');
check('explore lists only the real listings; no demo toggle exists', names.includes('Cheap Quote API') && names.includes('Dear Quote API') && !names.some((n) => /Demo/i.test(n)) && !(await b.ev(`!!document.querySelector('#show-demo')`)), JSON.stringify(names));
check('explore page has no demo language', !DEMO_WORDS.test(t), (t.match(DEMO_WORDS) || [])[0]);
for (const id of h.demoIds) {
  await b.goto(`${h.BASE}/api.html?id=${id}`, 1500);
  if (!/API not available/.test(await b.text('#api-root'))) { check('a legacy demo listing is not purchasable', false, id); break; }
}
check('legacy demo listings that still exist in the database are unreachable through their pages', h.demoIds.length >= 2);

// ================= 1. no wallet installed
await pay(cheapId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
let st = await steps();
check('no wallet installed: clear message, nothing sent, nothing charged', st[0]?.k === 'wallet' && st[0]?.s === 'failed' && /No browser wallet found/.test(st[0].t), JSON.stringify(st));
check('the API page labels itself REAL USDT and names the network and token', /REAL USDT/.test(await b.text('#mode-badge')) && /Celo mainnet \(chain 42220\)/.test(await b.text('#network-line')) && (await b.text('#network-line')).includes(USDT), await b.text('#network-line'));

// ================= 2. install the fake wallet; the happy path
const buyerKey = generatePrivateKey();
const wallet = await h.wire(b, buyerKey);
await pay(cheapId);
await until(async () => /Charged/.test((await b.text('#run-result')) || ''), 25000);
st = await steps();
check('one click: connect, sign in, verify wallet, check balance, send, confirm all succeed in order', st.map((s) => s.k).join(',') === 'wallet,login,verify,plan,send,confirm' && st.every((s) => s.s === 'done'), st.map((s) => `${s.k}:${s.s}`).join(' '));
const dec = wallet.sends[0] && decodeFunctionData({ abi: erc20Abi, data: wallet.sends[0].data });
check('the page asked the wallet for exactly one USDT transfer of the shortfall (0.05) to the deposit address', wallet.sends.length === 1 && wallet.sends[0].to.toLowerCase() === USDT.toLowerCase() && dec.args[1] === 50_000n && dec.args[0].toLowerCase() === DEP.toLowerCase(), JSON.stringify(wallet.sends[0]));
const r = await b.text('#run-result');
check('the API ran only after the verified credit: charged 0.05 USDT, receipt with the 3% fee', /Charged 0\.05 USDT/.test(r) && /Receipt/.test(r) && /Platform fee\s+0\.0015/.test(r), r.replace(/\s+/g, ' ').slice(0, 200));
let tok = await buyerToken();
check('ledger: the top-up was credited then spent exactly once (balance 0)', (await live(tok)).available === '0', JSON.stringify(await live(tok)));
check('seller earned price minus the 3% fee (0.0485 USDT)', (await h.call('GET', '/me', { bearer: h.sellerToken })).live.earnings === '0.0485');
const dep = h.db.prepare('SELECT * FROM chain_deposits').get();
check('the stored deposit carries hash, network, token, recipient, confirmations and verification status', dep && /^0x[0-9a-f]{64}$/.test(dep.tx_hash) && Number(dep.chain_id) === 42220 && dep.token === USDT.toLowerCase() && dep.to_address === DEP.toLowerCase() && Number(dep.confirmations) >= 3 && dep.verification === 'verified', JSON.stringify(dep));
check('exactly one successful purchase exists', count('executions', "state = 'QUALIFIED'") === 1);

// ================= 3. a non-qualifying response is never charged
await h.call('POST', '/funding/confirm', { bearer: tok, body: { txHash: '0x' + '0'.repeat(64) } }); // no-op probe: must be refused
wallet.sendMode = 'ok';
await pay(cheapId, '{"scenario":"stale"}');
await until(async () => /Idempotency key/.test((await b.text('#run-result')) || ''), 25000);
const rs = await b.text('#run-result');
check('a stale response is not charged: the reason and a receipt are shown', /Not charged/.test(rs) && /freshness/.test(rs) && /Returned to you\s+0\.05/.test(rs), rs.replace(/\s+/g, ' ').slice(0, 180));
check('the top-up for that attempt stays in the balance (verified deposit), nothing was charged', (await live(tok)).available === '0.05' && count('executions', "state = 'QUALIFIED'") === 1, JSON.stringify(await live(tok)));

// ================= 4. wallet declines the transaction
wallet.sendMode = 'decline';
// spend the balance first so a top-up is needed again
await pay(cheapId);
await until(async () => /Charged/.test((await b.text('#run-result')) || ''), 25000);
check('with a sufficient balance no new transfer is requested (balance covers the price)', wallet.sends.length === 2 && (await live(tok)).available === '0', `${wallet.sends.length} sends (the first purchase and the stale attempt each needed one top-up)`);
const before = wallet.sends.length;
await pay(cheapId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
st = await steps();
const failed = st.find((s) => s.s === 'failed');
check('wallet declines the transfer: clear failure, nothing charged, no credit', failed && failed.k === 'send' && /not sent/.test(failed.t) && wallet.sends.length === before + 1 && (await live(tok)).available === '0', JSON.stringify(st.slice(-2)));

// ================= 5. a short transfer: only what arrived is credited; the request is not run
wallet.sendMode = 'short';
const qBefore = count('executions', "state = 'QUALIFIED'");
await pay(cheapId);
await until(async () => (await steps()).some((x) => x.s === 'failed'), 25000);
const short = JSON.stringify(await steps());
check('short transfer: credited only the 0.025 that arrived; the API was not run or charged', (await live(tok)).available === '0.025' && /less than the price/.test(short) && count('executions', "state = 'QUALIFIED'") === qBefore, `${JSON.stringify(await live(tok))}`);

// ================= 6. above the per-deposit limit: refused before anything is sent
wallet.sendMode = 'ok';
const s6 = wallet.sends.length;
await pay(dearId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
st = await steps();
check('above the 1 USDT per-deposit limit: refused with the reason before any transaction', st.some((s) => s.k === 'plan' && s.s === 'failed' && /per-deposit limit/.test(s.t)) && wallet.sends.length === s6, JSON.stringify(st.slice(-1)));

// ================= 7. refused signature
wallet.denySign = true;
await b.ev(`localStorage.removeItem('payrail.buyer'); 0`);
await pay(cheapId);
await until(async () => (await steps()).some((s) => s.s === 'failed'));
st = await steps();
check('declining the sign-in signature stops the flow with a clear message and sends nothing', st.some((s) => s.k === 'login' && s.s === 'failed' && /declined/.test(s.t)) && wallet.sends.length === s6);
wallet.denySign = false;

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
