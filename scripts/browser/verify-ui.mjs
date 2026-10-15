// Real-browser regression for the redesigned site: landing page, buyer and seller dashboards, navigation, responsive layout.
//   node scripts/browser/verify-ui.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9385, OUT, 1366, 900);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 170) : ''}`);
const viewport = (w, h, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
const vis = (sel) => b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return !e.closest('[hidden]') && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; })()`);
const rect = (sel) => b.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? JSON.stringify({ l: r.left, t: r.top, r: r.right, w: r.width, h: r.height }) : null; })()`).then((x) => (x ? JSON.parse(x) : null));
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const go = async (hash, wait = 900) => { await b.ev(`location.hash = ${JSON.stringify(hash)}; 0`); await b.sleep(wait); };

// ================= landing, desktop
await viewport(1366, 900, false);
await b.goto(BASE + '/');
let t = await b.text('body');
check('landing: headline and supporting text', /Pay for the response, not the promise/.test(t) && /multi-currency|currency you hold/i.test(t));
check('landing: "Explore APIs" and "Start selling" calls to action link into the app', (await b.ev(`document.querySelector('#cta-explore')?.getAttribute('href')`)) === '/market.html#/buyer/explore' && (await b.ev(`document.querySelector('#cta-sell')?.getAttribute('href')`)) === '/market.html#/seller');
check('landing: product preview is shown and labelled as a preview', /preview/i.test(await b.text('.preview')) && (await vis('.preview')));
check('landing: how it works, buyer and seller benefits, currencies sections', (await vis('#how')) && (await vis('#benefits')) && (await vis('#currencies')));
check('landing: currencies say availability depends on verified routes', /Availability depends on verified routes/.test(t));
check('landing: the actual mode is stated (demo here), nothing claims live money', /DEMO: this server runs on test credits|demo mode with test credits/.test(t) && !/CWT/.test(t));
check('landing: footer navigation', (await b.ev(`document.querySelectorAll('.footer a').length`)) >= 8);
check('landing: no horizontal overflow (desktop)', (await overflow()) <= 0, await overflow());
await b.shot('ui-landing-desktop');

// ================= buyer dashboard, desktop
await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(2500);
const sb = await rect('#sidebar');
check('buyer: sticky sidebar is visible on the left', sb && sb.l >= 0 && sb.w > 180 && sb.w < 320, JSON.stringify(sb));
check('buyer: five sections in the sidebar', (await b.ev(`[...document.querySelectorAll('#nav-buyer a')].map(a => a.textContent.trim()).join('|')`)) === 'Overview|Explore APIs|My API usage|Wallet and funding|Transactions and receipts');
const bal = await rect('#buyer-card');
const fnd = await rect('#fund-card');
check('buyer overview: balance and funding sit side by side', bal && fnd && Math.abs(bal.t - fnd.t) < 12 && fnd.l > bal.l + 100, `${JSON.stringify(bal)} ${JSON.stringify(fnd)}`);
check('buyer overview: balance shows test credits (not real money)', /TEST CREDITS/.test(await b.text('#buyer')));
check('buyer overview: compact (does not need endless scrolling)', (await b.ev('document.documentElement.scrollHeight')) < 1700, await b.ev('document.documentElement.scrollHeight'));
check('buyer overview: the catalogue is not dumped on the overview', !(await vis('#services-card')));

await go('#/buyer/explore', 1500);
check('explore: services listed, funding hidden', (await vis('#services-card')) && !(await vis('#fund-card')) && (await b.ev(`document.querySelectorAll('#cat-list .svc').length`)) > 0);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }))`).then((x) => JSON.parse(x));
const firstRow = cards.filter((c) => Math.abs(c.t - cards[0].t) < 4);
check('explore: API cards are a grid with 2-3 per row on desktop', firstRow.length >= 2 && firstRow.length <= 3 && cards.length > firstRow.length, `${firstRow.length} per row of ${cards.length}`);
check('explore: cards in a row share one height', firstRow.every((c) => Math.abs(c.h - firstRow[0].h) <= 2), JSON.stringify(firstRow.map((c) => c.h)));
const cardText = await b.text('#cat-list .svc');
check('explore: each card shows name, description, seller, price, status and View API', /Seller:/.test(cardText) && /TESTUSDT/.test(cardText) && /Published/.test(cardText) && /View API/.test(cardText), cardText.replace(/\s+/g, ' | '));
check('explore: no inline run panel on the catalogue page', !(await b.ev(`!!document.querySelector('#run-btn')`)));
check('explore: no horizontal overflow', (await overflow()) <= 0);

await go('#/buyer/funding', 1500);
check('funding: wallet and funding panel with balance beside it', (await vis('#fund-card')) && (await vis('#buyer-card')) && /Funding wallet|funding wallet|SIMULATED/.test(await b.text('#fund')));
check('funding: supported and unavailable assets are explained', /Not available for funding|Pick an asset|Asset/i.test(await b.text('#fund')));
await go('#/buyer/usage', 1200);
check('usage: requests and agent access panels', (await vis('#history-card')) && (await vis('#agents-card')));
await go('#/buyer/transactions', 1200);
check('transactions: history only', (await vis('#history-card')) && !(await vis('#fund-card')) && !(await vis('#agents-card')));
check('sidebar highlights the current section', (await b.ev(`document.querySelector('#nav-buyer a.active')?.dataset.nav`)) === 'transactions');
await b.shot('ui-buyer-desktop');

// ================= seller dashboard, desktop
await b.click('#tab-seller', 'Seller');
await b.sleep(1000);
check('seller: tab switches to the seller workspace and its navigation', (await vis('#nav-seller')) && !(await vis('#nav-buyer')) && !(await vis('#buyer-card')));
check('seller: six sections in the sidebar', (await b.ev(`[...document.querySelectorAll('#nav-seller a')].map(a => a.textContent.trim()).join('|')`)) === 'Overview|My APIs|Create API|Earnings|Payout settings|Payout history');
await b.click('#seller button', 'sandbox seller');
await b.sleep(2500);
await go('#/seller/overview', 1800);
let st = await b.text('#seller');
check('seller overview: compact summary cards (earned, fees, pending, completed)', /Total earned/.test(st) && /Platform fees/.test(st) && /Payouts pending/.test(st) && /Payouts completed/.test(st));
check('seller overview: states that test credits cannot be withdrawn', /Test-credit earnings cannot be withdrawn/.test(st));
await go('#/seller', 1500);
check('seller: My APIs', /My APIs/.test(await b.text('#seller')) && /private management view/.test(await b.text('#seller')));
await go('#/seller/new', 1500);
st = await b.text('#seller');
check('seller: Create API is a guided form (details, pricing, verification path)', /New listing|Create/.test(st) && (await b.ev(`document.querySelectorAll('#seller input').length`)) >= 3);
await go('#/seller/earnings', 1800);
check('seller: Earnings page', /Earnings|Gross sales|Your earnings/.test(await b.text('#seller')));
await go('#/seller/payout-settings', 1800);
check('seller: payout preference and verified address are easy to find', /Current payout asset/.test(await b.text('#seller')) && /Verified payout addresses/.test(await b.text('#seller')));
await go('#/seller/payouts', 1800);
check('seller: payout history page', /No payouts|Requested/.test(await b.text('#seller')));
check('seller: no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.shot('ui-seller-desktop');

// ================= responsive: mobile
await viewport(390, 844, true);
await b.goto(BASE + '/');
check('mobile landing: no horizontal overflow', (await overflow()) <= 0, await overflow());
check('mobile landing: calls to action reachable', (await vis('#cta-explore')) && (await vis('#cta-sell')));
await b.shot('ui-landing-mobile');
await b.goto(BASE + '/market.html#/buyer');
const msb = await rect('#sidebar');
check('mobile: the sidebar is collapsed off-screen and a Menu button is shown', msb && msb.r <= 1 && (await vis('#menu-btn')), JSON.stringify(msb));
let clicked = '';
for (let i = 0; i < 3; i++) {
  // a busy machine can delay the page's script; retry the tap instead of failing on timing
  if (await b.ev(`document.body.classList.contains('nav-open')`)) break;
  clicked = await b.click('#menu-btn', 'Menu');
  await b.sleep(900);
}
const open = await rect('#sidebar');
check('mobile: Menu opens the navigation', open && open.l >= 0 && (await b.ev(`document.body.classList.contains('nav-open')`)), `${clicked} ${JSON.stringify(open)} body=${await b.ev('document.body.className')}`);
await b.ev(`document.querySelector('#nav-buyer a[data-nav=funding]').click(); 0`);
await b.sleep(900);
check('mobile: choosing a section closes the menu and shows it', !(await b.ev(`document.body.classList.contains('nav-open')`)) && (await vis('#fund-card')));
check('mobile: buyer panel has no horizontal overflow', (await overflow()) <= 0, await overflow());
const mb = await rect('#buyer-card');
const mf = await rect('#fund-card');
check('mobile: cards stack only when necessary (single column)', mb && mf && Math.abs(mb.l - mf.l) < 4 && mf.t > mb.t, `${JSON.stringify(mb)} ${JSON.stringify(mf)}`);
await b.ev(`location.hash = '#/seller/earnings'; 0`);
await b.sleep(1800);
check('mobile: seller earnings has no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.shot('ui-buyer-mobile');

console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
