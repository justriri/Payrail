// Browser regression: API catalogue cards, the dedicated details/purchase page, input validation, billing and receipts,
// in REAL-FUNDS mode against a FAKE chain (see harness.mjs).   node scripts/browser/verify-api.mjs <output dir>
import { generatePrivateKey } from 'viem/accounts';
import { DEMO_WORDS, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness();
const { check, finish } = makeChecker();
const ids = {
  price: await h.publish('Token Price API', '0.02', { description: 'Returns a fresh token price.' }),
  weather: await h.publish('Weather Lookup API', '0.03', { description: 'Weather by city.' }),
  echo: await h.publish('Text Echo API', '0.01', { description: 'Echoes your text.' }),
  news: await h.publish('News Headlines API', '0.04', { description: 'Latest headlines.' }),
};
const b = await launch(9387, OUT, 1366, 900);
const buyerKey = generatePrivateKey();
const buyer = await h.fundedBuyer(buyerKey, 500_000n); // 0.5 USDT, verified on the fake chain by the real server code
const wallet = await h.wire(b, buyerKey);

const viewport = (w, hh, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 1, mobile });
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const until = async (fn, ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const live = async () => (await h.call('GET', '/me', { bearer: buyer.token })).live;
const executions = () => Number(h.db.prepare("SELECT COUNT(*) AS n FROM executions").get().n);
const signIn = () => b.ev(`localStorage.setItem('payrail.buyer', ${JSON.stringify(buyer.token)}); 0`);

// ================= explore: cards -> View API
await viewport(1366, 900, false);
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2200);
await signIn();
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2200);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.id, t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), text: c.innerText }; }))`).then(JSON.parse);
const row = cards.filter((c) => Math.abs(c.t - cards[0].t) < 4);
check('catalogue shows exactly the 4 real listings (no demo rows)', cards.length === 4 && !cards.some((c) => /Demo/i.test(c.text)), cards.map((c) => c.text.split('\n')[2]).join(' | '));
check('cards form a grid with 2-3 per row on desktop, not one long line', row.length >= 2 && row.length <= 3 && cards.length > row.length, `${row.length} per row`);
check('cards in a row share one height', row.every((c) => Math.abs(c.h - row[0].h) <= 2), JSON.stringify(row.map((c) => c.h)));
check('each card shows name, description, seller, price, status and View API', cards.every((c) => /Seller:/.test(c.text) && /USDT/.test(c.text) && /Published/.test(c.text) && /View API/.test(c.text)) && /Returns a fresh token price/.test(cards[0].text), cards[0].text.replace(/\s+/g, ' '));
check('no inline purchase panel on the catalogue page', !(await b.ev(`!!document.querySelector('#run-btn')`)));
check('the explore page carries no demo language', !DEMO_WORDS.test(await b.text('body')), (((await b.text('body')).match(DEMO_WORDS)) || [])[0]);
await b.shot('explore-desktop');

await b.ev(`document.querySelector('#cat-list .svc[data-id=${JSON.stringify(ids.price)}] a.btn').click(); 0`);
await b.sleep(2200);
check('View API opens the dedicated page for that listing', (await b.ev('location.pathname + location.search')) === `/api.html?id=${ids.price}`);

// ================= details page
check('page shows the real listing name, description, seller', /Token Price API/.test(await b.text('#api-name')) && /Returns a fresh token price/.test(await b.text('#api-description')) && /Seller: 0x/.test(await b.text('#api-seller')), await b.text('#api-seller'));
const det = await b.text('#api-details');
check('pricing and billing method come from the listing (0.02 USDT, outcome-based, 3% fee)', /Price per request\s+0\.02 USDT/.test(det) && /Outcome-based/.test(det) && /Platform fee \(3%.*\)\s+0\.0006 USDT/s.test(det) && /Seller receives\s+0\.0194 USDT/.test(det));
check('what the buyer receives, required inputs and limits are shown', /What you receive/i.test(det) && /Required inputs/i.test(det) && /flat JSON object/.test(det) && /Limits and requirements/i.test(det) && /within \d+ ms/.test(det));
check('status badge says Published and the network and token are named', /Published/.test(await b.text('#api-status')) && /Celo mainnet \(chain 42220\) · token USDT 0x4806/.test(await b.text('#network-line')));
check('the details page carries no demo language', !DEMO_WORDS.test(await b.text('body')));
check('opening the page charged nothing (balance still 0.5 USDT, no executions)', (await live()).available === '0.5' && executions() === 0, JSON.stringify(await live()));
const side = await b.ev(`(() => { const a=document.querySelector('#api-details').getBoundingClientRect(), c=document.querySelector('#api-buy').getBoundingClientRect(); return JSON.stringify({ ar:a.right, bl:c.left, at:a.top, bt:c.top }); })()`).then(JSON.parse);
check('details and purchase panel sit side by side on desktop', side.bl > side.ar - 5 && Math.abs(side.at - side.bt) < 20, JSON.stringify(side));
await b.shot('api-details-desktop');

// ================= input validation: nothing is sent, nothing is charged
for (const [label, value, pattern] of [
  ['invalid JSON', '{not json', /not valid JSON/],
  ['nested values', '{"a":{"nested":1}}', /must be text .*number or true\/false/],
  ['invalid field names', '{"bad key":"x"}', /not a valid field name/],
  ['a JSON list', '[1,2]', /must be a JSON object/],
]) {
  await b.set('#run-input', value);
  await b.click('#run-btn', 'Pay and Use API');
  await b.sleep(300);
  check(`${label} is refused with a clear message, no confirmation step`, pattern.test(await b.text('#input-problem')) && !(await b.ev(`!document.querySelector('#run-confirm-row').hidden`)), await b.text('#input-problem'));
}
check('no charge after rejected inputs', (await live()).available === '0.5' && executions() === 0);

// ================= valid input: explicit confirmation first, then billing and receipt
await b.set('#run-input', '{"id":"eth"}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
check('a valid request asks for payment confirmation first; nothing is charged yet', (await b.ev(`!document.querySelector('#run-confirm-row').hidden`)) && /only if the response/.test(await b.text('#run-confirm-row')) && (await live()).available === '0.5');
await b.click('#run-confirm', 'Confirm');
await until(async () => /Idempotency key/.test((await b.text('#run-result')) || ''), 20000);
let r = await b.text('#run-result');
check('qualifying response: charged exactly 0.02, status, response body and receipt', /Charged 0\.02 USDT/.test(r) && /Transaction status:\s*completed and charged/.test(r) && /API response/i.test(r) && /Platform fee\s+0\.0006/.test(r) && /Payrail ledger \(USDT\)/.test(r), r.replace(/\s+/g, ' ').slice(0, 260));
check('the balance covered the price, so the wallet was not asked for a transfer; balance is 0.48', wallet.sends.length === 0 && (await live()).available === '0.48', `${wallet.sends.length} sends, ${JSON.stringify(await live())}`);

// a stale response is not charged
await b.set('#run-input', '{"scenario":"stale"}');
const prev = r;
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
await b.click('#run-confirm', 'Confirm');
await until(async () => { const t = (await b.text('#run-result')) || ''; return t !== prev && /Idempotency key/.test(t); }, 20000);
r = await b.text('#run-result');
check('non-qualifying response: not charged, the reason and the returned amount are shown', /Not charged/.test(r) && /freshness/.test(r) && /Returned to you\s+0\.02/.test(r), r.replace(/\s+/g, ' ').slice(0, 200));
check('balance unchanged by the non-qualifying response (0.48)', (await live()).available === '0.48');

// ================= history and statement agree with the ledger
await b.goto(`${h.BASE}/market.html#/buyer/transactions`, 2200);
const stmt = await b.text('#statement');
check('statement: deposited 0.5, charged 0.02, returned 0.02, available 0.48', /Deposited \/ granted\s+0\.5/.test(stmt) && /Charged for qualifying responses\s+0\.02/.test(stmt) && /Returned \(non-qualifying or expired\)\s+0\.02/.test(stmt) && /Available\s+0\.48/.test(stmt), stmt.replace(/\s+/g, ' '));

// ================= back to the marketplace
await b.goto(`${h.BASE}/api.html?id=${ids.price}`, 1800);
await b.click('#back-link', 'Back to the marketplace');
await b.sleep(2200);
check('returning to the marketplace opens Explore APIs with the catalogue', /\/market\.html/.test(await b.ev('location.pathname')) && /explore/.test(await b.ev('location.hash')) && (await b.ev(`document.querySelectorAll('#cat-list .svc').length`)) === 4);

// ================= unknown listing / missing id
await b.goto(`${h.BASE}/api.html?id=does-not-exist`);
check('an unknown API shows a clear not-available page, not a blank or a fake listing', /API not available/.test(await b.text('#api-root')) && /does not exist or is not published/.test(await b.text('#api-error')));
await b.goto(`${h.BASE}/api.html`);
check('a missing id is handled', /No API was specified/.test(await b.text('#api-error')));

// ================= mobile
await viewport(390, 844, true);
await b.goto(`${h.BASE}/api.html?id=${ids.price}`);
check('mobile details page: no horizontal overflow', (await overflow()) <= 0, await overflow());
const ms = await b.ev(`(() => { const a=document.querySelector('#api-details').getBoundingClientRect(), c=document.querySelector('#api-buy').getBoundingClientRect(); return JSON.stringify({ al:a.left, bl:c.left, at:a.top, bt:c.top }); })()`).then(JSON.parse);
check('mobile: purchase and details stack in one column', Math.abs(ms.al - ms.bl) < 4 && ms.bt > ms.at, JSON.stringify(ms));
await b.shot('api-details-mobile');
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2200);
const mc = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; }))`).then(JSON.parse);
check('mobile cards: one column, inside the screen, no horizontal overflow', mc.length === 4 && mc.every((c) => c.l >= 0 && c.r <= 390 && Math.abs(c.l - mc[0].l) < 3) && (await overflow()) <= 0, JSON.stringify(mc.slice(0, 2)));
await b.shot('explore-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
