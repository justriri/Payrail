// Real-browser regression for the API catalogue cards and the dedicated API details/purchase page (SIMULATED server).
//   node scripts/browser/verify-api.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9387, OUT, 1366, 900);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 180) : ''}`);
const viewport = (w, h, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const until = async (fn, ms = 7000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const balance = async () => (/Available balance: ([\d.]+)/.exec(await b.text('#api-balance')) || [])[1];

// ================= explore: cards -> View API
await viewport(1366, 900, false);
await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(2500);
await b.goto(BASE + '/market.html#/buyer/explore');
await b.sleep(1500);
const demo = await b.ev(`(() => { const c=[...document.querySelectorAll('#cat-list .svc')].find(x=>x.innerText.includes('Demo token price')); return c ? JSON.stringify({ id: c.dataset.id, href: c.querySelector('a.btn')?.getAttribute('href'), text: c.innerText }) : null; })()`).then((x) => (x ? JSON.parse(x) : null));
check('catalogue card exists and links to its details page by id', demo && demo.href === `/api.html?id=${encodeURIComponent(demo.id)}`, demo && demo.href);
await b.ev(`document.querySelector('#cat-list .svc[data-id=${JSON.stringify(demo?.id)}] a.btn').click(); 0`);
await b.sleep(2200);

// ================= details page
const url = await b.ev('location.pathname + location.search');
check('View API opens the dedicated page for that listing', url === `/api.html?id=${demo.id}`, url);
const name = await b.text('#api-name');
check('page shows the actual listing name, description and seller', /Demo token price/.test(name) && (await b.text('#api-description')).length > 5 && /Seller: /.test(await b.text('#api-seller')), `${name} | ${await b.text('#api-seller')}`);
const det = await b.text('#api-details');
check('pricing and billing method are shown from the listing (0.02 TESTUSDT, outcome-based)', /Price per request\s+0\.02 TESTUSDT/.test(det) && /Outcome-based/.test(det) && /Platform fee \(3%/.test(det));
check('what the buyer receives, required inputs and limits are shown', /What you receive/i.test(det) && /Required inputs/i.test(det) && /flat JSON object/.test(det) && /Limits and requirements/i.test(det) && /within \d+ ms/.test(det));
check('status badge says Published', /Published/.test(await b.text('#api-status')));
const price = await balance();
check('opening the page did not charge the buyer (5 test credits untouched)', price === '5', price);
await b.shot('api-details-desktop');
const side = await b.ev(`(() => { const a=document.querySelector('#api-details').getBoundingClientRect(), c=document.querySelector('#api-buy').getBoundingClientRect(); return JSON.stringify({ al:a.left, ar:a.right, bl:c.left, at:a.top, bt:c.top }); })()`).then(JSON.parse);
check('details and purchase panel sit side by side on desktop', side.bl > side.ar - 5 && Math.abs(side.at - side.bt) < 20, JSON.stringify(side));

// ================= input validation (no request is sent, nothing charged)
await b.set('#run-input', '{not json');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('invalid JSON is refused with a clear message and no confirmation step', /not valid JSON/.test(await b.text('#input-problem')) && !(await b.ev(`!document.querySelector('#run-confirm-row').hidden`)));
await b.set('#run-input', '{"a":{"nested":1}}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('nested values are refused client-side', /must be text .*number or true\/false/.test(await b.text('#input-problem')));
await b.set('#run-input', '{"bad key":"x"}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('invalid field names are refused', /not a valid field name/.test(await b.text('#input-problem')));
await b.set('#run-input', '[1,2]');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('a JSON list is refused', /must be a JSON object/.test(await b.text('#input-problem')));
check('no charge after rejected inputs', (await balance()) === '5');

// ================= valid input: explicit confirmation, then billing and receipt
await b.set('#run-input', '{"id":"eth"}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('a valid request asks for payment confirmation first and charges nothing yet', (await b.ev(`!document.querySelector('#run-confirm-row').hidden`)) && /only if the response/.test(await b.text('#run-confirm-row')) && (await balance()) === '5');
await b.click('#run-confirm', 'Confirm');
await until(async () => /Idempotency key/.test(await b.text('#run-result')), 9000);
let r = await b.text('#run-result');
check('qualifying response: charged exactly 0.02, status, response body and receipt', /Charged 0\.02 TESTUSDT/.test(r) && /Transaction status:\s*completed and charged/.test(r) && /API response/i.test(r) && /Receipt/.test(r) && /Platform fee\s+0\.0006/.test(r), r.split('\n').slice(0, 3).join(' | '));
await until(async () => (await balance()) === '4.98');
check('balance dropped by exactly the price (4.98)', (await balance()) === '4.98', await balance());

// not charged: stale response
await b.set('#run-input', '{"id":"eth","scenario":"stale"}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
const before = r;
await b.click('#run-confirm', 'Confirm');
await until(async () => { const t = await b.text('#run-result'); return t !== before && /Idempotency key/.test(t); }, 9000);
r = await b.text('#run-result');
check('non-qualifying response: not charged, reason and receipt shown', /Not charged/.test(r) && /freshness/.test(r) && /Returned to you\s+0\.02/.test(r), r.split('\n').slice(0, 3).join(' | '));
check('balance unchanged by a non-qualifying response', (await balance()) === '4.98', await balance());

// ================= back to the marketplace
await b.click('#back-link', 'Back to the marketplace');
await b.sleep(2000);
check('returning to the marketplace opens the Explore APIs page', /\/market\.html/.test(await b.ev('location.pathname')) && /explore/.test(await b.ev('location.hash')) && (await b.ev(`document.querySelectorAll('#cat-list .svc').length`)) > 0);

// ================= unknown / unpublished listing
await b.goto(BASE + '/api.html?id=does-not-exist');
check('an unknown API shows a clear not-available page, not a blank or a fake listing', /API not available/.test(await b.text('#api-root')) && /does not exist or is not published/.test(await b.text('#api-error')));
await b.goto(BASE + '/api.html');
check('a missing id is handled', /No API was specified/.test(await b.text('#api-error')));

// ================= mobile
await viewport(390, 844, true);
await b.goto(BASE + `/api.html?id=${demo.id}`);
check('mobile details page: no horizontal overflow', (await overflow()) <= 0, await overflow());
const ms = await b.ev(`(() => { const a=document.querySelector('#api-details').getBoundingClientRect(), c=document.querySelector('#api-buy').getBoundingClientRect(); return JSON.stringify({ al:a.left, bl:c.left, at:a.top, bt:c.top }); })()`).then(JSON.parse);
check('mobile: panels stack in one column', Math.abs(ms.al - ms.bl) < 4 && ms.bt > ms.at, JSON.stringify(ms));
await b.shot('api-details-mobile');
await b.goto(BASE + '/market.html#/buyer/explore');
await b.sleep(1500);
const mc = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), r: Math.round(r.right) }; }))`).then(JSON.parse);
check('mobile cards: one column, inside the screen, no overflow', mc.length > 0 && mc.every((c) => c.l >= 0 && c.r <= 390 && Math.abs(c.l - mc[0].l) < 3) && (await overflow()) <= 0, JSON.stringify(mc.slice(0, 2)));
await b.shot('explore-mobile');

console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
