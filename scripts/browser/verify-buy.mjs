// Browser regression: the Buy AI catalogue, a Buy API page, and the buyer-signed purchase, in the PRODUCTION environment
// against a FAKE Buy gateway and a FAKE chain (see harness.mjs and test/fakebuy.ts).   node scripts/browser/verify-buy.mjs <output dir>
import { generatePrivateKey } from 'viem/accounts';
import { DEMO_WORDS, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false });
const { check, finish } = makeChecker();
const b = await launch(9391, OUT, 1366, 900);
const key = generatePrivateKey();
const wallet = await h.wire(b, key);
const until = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const viewport = (w, hh, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 1, mobile });

// ================= catalogue: what Buy lists, nothing else
await viewport(1366, 900, false);
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2400);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => ({ id: c.dataset.id, text: c.innerText })))`).then(JSON.parse);
check('the catalogue shows exactly the 3 services Buy lists, none local or seeded', cards.length === 3 && cards.every((c) => /Buy AI/.test(c.text)), cards.map((c) => c.id).join(','));
check('cards show platform, status and an indicative price', cards.some((c) => /\bx\b/i.test(c.text) && /Available/.test(c.text) && /0\.005 USDT/.test(c.text)) && cards.some((c) => /Unavailable/.test(c.text)), cards[0] && cards[0].text.replace(/\s+/g, ' '));
check('the status line names Buy as the source and when it was fetched', /from Buy AI, fetched \d{4}-/.test(await b.text('#cat-status')), await b.text('#cat-status'));
const platforms = await b.ev(`[...document.querySelectorAll('#platform option')].map(o => o.value).join(',')`);
check('the platform filter lists the platforms Buy reports', platforms === ',instagram,x', platforms);
await b.set('#platform', 'instagram');
await b.ev(`document.querySelector('#platform').dispatchEvent(new Event('change')); 0`);
await b.sleep(300);
check('filtering by platform narrows the list', (await b.ev(`document.querySelectorAll('#cat-list .svc').length`)) === 1);
check('no demo / test language in the buyer catalogue', !DEMO_WORDS.test(await b.text('body')), (((await b.text('body')).match(DEMO_WORDS)) || [])[0]);
await b.shot('buy-catalogue');

// ================= details page
await b.goto(`${h.BASE}/api.html?src=buy&id=x.posts.search`, 2000);
check('the Buy page shows title, provider and the schema from Buy', /X posts search/.test(await b.text('#api-name')) && /Buy AI/.test(await b.text('#api-seller')) && /query/.test(await b.text('#schema-table')));
const facts = await b.text('#pay-facts');
check('payment facts: Celo, USDT address, pinned payee, exact price comes from Buy', /42220/.test(facts) && /0x4806/.test(facts) && /0x20fa/i.test(facts), facts.replace(/\s+/g, ' '));
check('the 3% fee is stated honestly as not collected', /not collected|NOT collected/i.test(await b.text('#fee-note')), await b.text('#fee-note'));
check('the real USDT badge is shown', /REAL USDT/.test(await b.text('#mode-badge')));
check('the page carries no demo language', !DEMO_WORDS.test(await b.text('body')), (((await b.text('body')).match(DEMO_WORDS)) || [])[0]);
await b.shot('buy-details');

// ================= quote -> sign -> pay -> receipt
await b.set('#run-input', '{"query":"celo"}');
await b.click('#quote-btn', 'Get the exact price');
await until(async () => (await b.ev(`!!document.querySelector('#sign-btn')`)));
check('the wallet signed in (message only) and a quote with the exact price appeared; nothing was sent or paid', wallet.sends.length === 0 && /0\.005 USDT/.test(await b.text('#exact-price')) && h.buyGateway.paidRequests === 0, `${await b.text('#exact-price')} paid=${h.buyGateway.paidRequests}`);
await b.click('#sign-btn', 'Sign and pay');
await until(async () => (await b.ev(`!!document.querySelector('#run-headline')`)));
const rcpt = await b.text('#run-result');
check('the wallet was asked for a typed-data signature (no transaction): to = Buy payee, USDT, chain 42220', wallet.typedSigns.length === 1 && wallet.sends.length === 0 && wallet.typedSigns[0].message.to.toLowerCase() === '0x20faaca5f980e29639a0fcc6dca6988e18ed333b' && wallet.typedSigns[0].domain.chainId === 42220 && wallet.typedSigns[0].domain.verifyingContract.toLowerCase() === '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e');
check('exactly one paid request reached the gateway', h.buyGateway.paidRequests === 1, String(h.buyGateway.paidRequests));
check('receipt: verified on-chain, transaction link, API response', /settled and verified on-chain/.test(rcpt) && (await b.ev(`!!document.querySelector('#tx-link')`)) && /hello from the fake gateway/.test(await b.text('#api-response')), rcpt.replace(/\s+/g, ' ').slice(0, 260));
check('receipt states the fee as due and not collected', /not.collected/i.test(await b.text('#receipt')), (await b.text('#receipt')).replace(/\s+/g, ' '));
await b.shot('buy-receipt');

// history
await b.goto(`${h.BASE}/market.html#/buyer/transactions`, 2400);
check('the purchase appears in "Buy AI purchases" as CONFIRMED', /CONFIRMED/.test(await b.text('#buy-orders')) && /x.posts.search/.test(await b.text('#buy-orders')), (await b.text('#buy-orders')) + ' / ' + (await b.text('#history')));

// ================= declined signature: nothing happens
wallet.denyTyped = true;
await b.goto(`${h.BASE}/api.html?src=buy&id=instagram.profile`, 2000);
await b.set('#run-input', '{"username":"celo"}');
await b.click('#quote-btn', 'Get the exact price');
await until(async () => (await b.ev(`!!document.querySelector('#sign-btn')`)));
await b.click('#sign-btn', 'Sign and pay');
await until(async () => /declined/i.test(await b.text('#pay-steps')), 20000);
check('declining the signature: clear message, nothing sent to Buy, nothing charged', /Nothing was sent or charged/.test(await b.text('#pay-steps')) && h.buyGateway.paidRequests === 1, await b.text('#pay-steps'));

// ================= an unavailable Buy API cannot be bought
await b.goto(`${h.BASE}/api.html?src=buy&id=down.api`, 2000);
check('an API Buy reports as unavailable cannot be bought', await b.ev(`document.querySelector('#quote-btn').disabled`) && /Unavailable/.test(await b.text('#api-status')));
await b.goto(`${h.BASE}/api.html?src=buy&id=no.such`, 1800);
check('an unknown Buy API shows a clear not-available page', /not available|not exist|No such|no such/i.test(await b.text('body')));

// ================= mobile
await viewport(390, 844, true);
await b.goto(`${h.BASE}/market.html#/buyer/explore`, 2400);
check('mobile catalogue: no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.goto(`${h.BASE}/api.html?src=buy&id=x.posts.search`, 2000);
check('mobile Buy page: no horizontal overflow', (await overflow()) <= 0, await overflow());
await b.shot('buy-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
