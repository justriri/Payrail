// Browser regression: landing page, buyer and seller workspaces, navigation and responsive layout, in REAL-FUNDS mode
// against a FAKE chain (see harness.mjs).   node scripts/browser/verify-ui.mjs <output dir>
import { generatePrivateKey } from 'viem/accounts';
import { DEMO_WORDS, DEP, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness();
const { check, finish } = makeChecker();
for (const [name, price] of [['Token Price API', '0.02'], ['Weather Lookup API', '0.03'], ['Text Echo API', '0.01'], ['News Headlines API', '0.04']]) await h.publish(name, price, { description: `${name} for the layout checks.` });
const b = await launch(9385, OUT, 1366, 900);
const wallet = await h.wire(b, generatePrivateKey());

const viewport = (w, hh, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 1, mobile });
const vis = (sel) => b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return !e.closest('[hidden]') && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; })()`);
const rect = (sel) => b.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? JSON.stringify({ l: r.left, t: r.top, r: r.right, w: r.width, h: r.height }) : null; })()`).then((x) => (x ? JSON.parse(x) : null));
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const go = async (hash, wait = 1100) => { await b.ev(`location.hash = ${JSON.stringify(hash)}; 0`); await b.sleep(wait); };
const noDemo = async () => { const t = await b.text('body'); return !DEMO_WORDS.test(t) ? '' : (t.match(DEMO_WORDS) || [])[0]; };

// ================= landing, desktop
await viewport(1366, 900, false);
await b.goto(`${h.BASE}/`);
let t = await b.text('body');
check('landing: headline and supporting text', /Pay for the response, not the promise/.test(t) && /currency you hold|multi-currency/i.test(t));
check('landing: "Explore APIs" and "Start selling" calls to action link into the app', (await b.ev(`document.querySelector('#cta-explore')?.getAttribute('href')`)) === '/market.html#/buyer/explore' && (await b.ev(`document.querySelector('#cta-sell')?.getAttribute('href')`)) === '/market.html#/seller');
check('landing: product preview is shown and labelled as a preview', /preview/i.test(await b.text('.preview')) && (await vis('.preview')));
check('landing: how it works, benefits and currencies sections', (await vis('#how')) && (await vis('#benefits')) && (await vis('#currencies')));
check('landing: only USDT is offered; other currencies are "not enabled yet"', /USDT\s+Available now/.test(t) && (t.match(/Not enabled yet/g) || []).length >= 5 && /Availability depends on verified routes/.test(t));
check('landing: the real network and token are stated from the server', /Real funds: USDT on Celo mainnet \(chain 42220\)/.test(await b.text('#mode-note')));
check('landing: no demo / test-credit / simulation language anywhere', (await noDemo()) === '', await noDemo());
check('landing: footer navigation and no horizontal overflow', (await b.ev(`document.querySelectorAll('.footer a').length`)) >= 8 && (await overflow()) <= 0);
await b.shot('ui-landing-desktop');

// ================= buyer workspace, desktop
await b.goto(`${h.BASE}/market.html#/buyer`, 2200);
const sb = await rect('#sidebar');
check('buyer: sticky sidebar on the left with a LIVE pill', sb && sb.l >= 0 && sb.w > 180 && sb.w < 320 && /LIVE · USDT on Celo mainnet/.test(await b.text('#mode-pill')), JSON.stringify(sb));
check('buyer: five sections in the sidebar', (await b.ev(`[...document.querySelectorAll('#nav-buyer a')].map(a => a.textContent.trim()).join('|')`)) === 'Overview|Explore APIs|My API usage|Wallet and funding|Transactions and receipts');
check('buyer: signed out, the only way in is the wallet (no anonymous or test option)', (await vis('#wallet-signin')) && (await noDemo()) === '', await noDemo());
await b.click('#buyer button', 'Sign in with wallet');
await until(async () => (await b.ev(`!!document.querySelector('#real-balance')`)));
check('buyer: wallet sign-in works (signature only) and shows the REAL USDT balance 0 USDT', /0 USDT/.test(await b.text('#real-balance')) && wallet.sends.length === 0 && wallet.signs.some((m) => /Payrail buyer sign-in/.test(m) && /Network: chain 42220/.test(m)), await b.text('#real-balance'));
const bal = await rect('#buyer-card');
const fnd = await rect('#fund-card');
check('buyer overview: balance and funding sit side by side', bal && fnd && Math.abs(bal.t - fnd.t) < 12 && fnd.l > bal.l + 100, `${JSON.stringify(bal)} ${JSON.stringify(fnd)}`);
check('buyer overview: compact and without the catalogue', (await b.ev('document.documentElement.scrollHeight')) < 1700 && !(await vis('#services-card')), await b.ev('document.documentElement.scrollHeight'));
await b.shot('ui-buyer-desktop');

await go('#/buyer/explore', 1600);
check('explore: catalogue only, as a card grid', (await vis('#services-card')) && !(await vis('#fund-card')) && (await b.ev(`document.querySelectorAll('#cat-list .svc').length`)) === 4);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => { const r = c.getBoundingClientRect(); return { t: Math.round(r.top), h: Math.round(r.height) }; }))`).then(JSON.parse);
const row = cards.filter((c) => Math.abs(c.t - cards[0].t) < 4);
check('explore: 2-3 cards per row, equal heights', row.length >= 2 && row.length <= 3 && row.every((c) => Math.abs(c.h - row[0].h) <= 2), `${row.length} per row`);

await go('#/buyer/funding', 1600);
const fundText = await b.text('#fund');
check('funding: names the network, the token and the deposit address', /Celo mainnet|chain 42220/.test(await b.text('#mode-banner')) && /REAL FUNDS: USDT on chain 42220/.test(fundText) && /No sending wallet verified yet/.test(fundText), fundText.replace(/\s+/g, ' ').slice(0, 160));
await b.click('#fund button', 'Verify my wallet');
await until(async () => /Sending wallet verified: 0x/.test((await b.text('#fund')) || ''));
const fundText2 = await b.text('#fund');
check('funding: wallet verified by signature; deposit details, limit and confirmations are shown', /Sending wallet verified: 0x/.test(fundText2) && fundText2.includes(DEP) && /Limit per deposit\s+1 USDT/.test(fundText2) && /Confirmations needed\s+20|Confirmations needed\s+3/.test(fundText2), fundText2.replace(/\s+/g, ' ').slice(0, 220));
await b.ev(`document.querySelector('#other-currencies').open = true; 0`);
check('funding: other currencies are shown as unavailable, with the reason, and no conversion controls exist', /Not available/.test(await b.text('#other-currencies')) && /executed and verified end to end/.test(await b.text('#other-currencies')) && !(await b.ev(`!!document.querySelector('#fund select')`)));
check('funding: the wallet panel shows no demo language and does not advertise conversion that is not enabled', (await noDemo()) === '' && /Add funds \(USDT\)/.test(await b.text('#fund-card')) && !/through Textile/.test(await b.text('#fund-card')), await noDemo());
await go('#/buyer/usage', 1300);
check('usage: requests and agent access panels', (await vis('#history-card')) && (await vis('#agents-card')) && /real USDT balance/.test(await b.text('#agents')));
await go('#/buyer/transactions', 1300);
check('transactions: history only; sidebar highlights the section', (await vis('#history-card')) && !(await vis('#fund-card')) && (await b.ev(`document.querySelector('#nav-buyer a.active')?.dataset.nav`)) === 'transactions');

// ================= seller workspace, desktop
await b.click('#tab-seller', 'Seller');
await b.sleep(1200);
check('seller: tab switches to the seller workspace and its navigation', (await vis('#nav-seller')) && !(await vis('#nav-buyer')) && !(await vis('#buyer-card')));
check('seller: six sections in the sidebar', (await b.ev(`[...document.querySelectorAll('#nav-seller a')].map(a => a.textContent.trim()).join('|')`)) === 'Overview|My APIs|Create API|Earnings|Payout settings|Payout history');
check('seller: signed out, the only way in is the wallet', (await vis('#seller-signin')) && (await noDemo()) === '', await noDemo());
await b.click('#seller button', 'Sign in with your wallet');
await until(async () => /My APIs/.test((await b.text('#seller')) || ''));
await go('#/seller/overview', 1800);
let st = await b.text('#seller');
check('seller overview: compact summary cards (earned, fees, available, pending, completed)', /Total earned/.test(st) && /Platform fees/.test(st) && /Available to pay out/.test(st) && /Payouts pending/.test(st) && /Payouts completed/.test(st));
check('seller overview: says payouts are disabled and earnings are real USDT', /Payouts:\s*disabled/.test(st) && /real USDT/.test(st), st.replace(/\s+/g, ' ').slice(0, 200));
await go('#/seller', 1500);
check('seller: My APIs (empty for a new seller) with a way to create one', /My APIs/.test(await b.text('#seller')) && /Create your first listing/.test(await b.text('#seller')));
await go('#/seller/new', 1500);
st = await b.text('#seller');
check('seller: Create API is a guided form with real-USDT pricing, no presets or test options', /New listing/.test(st) && /Price per qualifying response \(USDT\)/.test(st) && /real, public https API/.test(st) && (await b.ev(`document.querySelectorAll('#seller input').length`)) >= 4 && (await noDemo()) === '', await noDemo());
await go('#/seller/earnings', 1800);
check('seller: Earnings page states payouts are disabled', /Earnings|Gross sales|Your earnings|No requests yet/.test(await b.text('#seller')) && /Payouts are disabled/.test(await b.text('#seller')));
await go('#/seller/payout-settings', 1500);
st = await b.text('#seller');
check('seller: payout settings say honestly that payouts and conversion are not enabled', /Payouts are not enabled yet/.test(st) && /no conversion route has been verified end to end on mainnet/.test(st) && !(await b.ev(`!!document.querySelector('#seller select')`)));
await go('#/seller/payouts', 1500);
check('seller: payout history page', /No payouts/.test(await b.text('#seller')) && /disabled/.test(await b.text('#seller')));
check('seller: no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.shot('ui-seller-desktop');

// ================= responsive: mobile
await viewport(390, 844, true);
await b.goto(`${h.BASE}/`);
check('mobile landing: no horizontal overflow; calls to action reachable', (await overflow()) <= 0 && (await vis('#cta-explore')) && (await vis('#cta-sell')), await overflow());
await b.shot('ui-landing-mobile');
await b.goto(`${h.BASE}/market.html#/buyer`, 2200);
const msb = await rect('#sidebar');
check('mobile: the sidebar is collapsed off-screen and a Menu button is shown', msb && msb.r <= 1 && (await vis('#menu-btn')), JSON.stringify(msb));
let clicked = '';
for (let i = 0; i < 3; i++) {
  if (await b.ev(`document.body.classList.contains('nav-open')`)) break;
  clicked = await b.click('#menu-btn', 'Menu');
  await b.sleep(900);
}
const open = await rect('#sidebar');
check('mobile: Menu opens the navigation', open && open.l >= 0 && (await b.ev(`document.body.classList.contains('nav-open')`)), `${clicked} ${JSON.stringify(open)}`);
await b.ev(`document.querySelector('#nav-buyer a[data-nav=funding]').click(); 0`);
await b.sleep(1200);
check('mobile: choosing a section closes the menu and shows it', !(await b.ev(`document.body.classList.contains('nav-open')`)) && (await vis('#fund-card')));
check('mobile: no horizontal overflow on the funding panel', (await overflow()) <= 0, await overflow());
const mb = await rect('#buyer-card');
const mf = await rect('#fund-card');
check('mobile: cards stack in a single column', mb && mf && Math.abs(mb.l - mf.l) < 4 && mf.t > mb.t, `${JSON.stringify(mb)} ${JSON.stringify(mf)}`);
await go('#/seller/earnings', 1800);
check('mobile: seller earnings has no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.shot('ui-buyer-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
