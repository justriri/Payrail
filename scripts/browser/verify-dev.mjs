// Browser regression for the DEVELOPMENT environment (scripts/dev-serve.ts): browse, inspect, fund with test credits, use an API and
// publish a sandbox API, all clearly labelled as development and without any real funds, wallet or chain.
//   node scripts/browser/verify-dev.mjs <output dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevMarket } from '../../src/dev/devmarket.ts';
import { createWebServer } from '../../src/webapi.ts';
import { makeChecker } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'payrail-devui-'));
const devRoot = join(root, 'data', 'dev');
mkdirSync(devRoot, { recursive: true });
const dev = createDevMarket({ dbPath: join(devRoot, 'ui.db'), devRoot, keyFile: join(devRoot, 'ui.key') });
const { server } = createWebServer(dev.runtime, { token: 'dev-ui', market: dev.market, environment: 'development' });
await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${server.address().port}`;
const { check, finish } = makeChecker();
const b = await launch(9393, OUT, 1366, 1100);

const until = async (fn, ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const text = (sel) => b.text(sel);
const go = async (hash, wait = 1200) => { await b.ev(`location.hash = ${JSON.stringify(hash)}; 0`); await b.sleep(wait); };
const body = () => b.text('body');
// things only the PRODUCTION pages say about themselves
const NOT_DEV_CLAIMS = /REAL FUNDS|REAL USDT|LIVE ·|chain 42220|Celo mainnet \(chain|Sending wallet verified|Verify my wallet/;

// ================= landing and shell say DEVELOPMENT
await b.goto(`${BASE}/`);
check('landing: says this is a DEVELOPMENT ENVIRONMENT with no real money', /DEVELOPMENT ENVIRONMENT: test credits and simulated services/.test(await text('#mode-note')), await text('#mode-note'));
await b.goto(`${BASE}/market.html#/buyer`, 2600);
check('dashboard: development banner, DEVELOPMENT pill and [DEV] title', /DEVELOPMENT ENVIRONMENT/.test(await text('#mode-banner')) && /DEVELOPMENT · test credits, no real money/.test(await text('#mode-pill')) && /^\[DEV\]/.test(await b.ev('document.title')), `${await text('#mode-banner')} | ${await text('#mode-pill')}`);
check('dashboard: makes no real-funds, live or on-chain claims', !NOT_DEV_CLAIMS.test(await body()), (((await body()).match(NOT_DEV_CLAIMS)) || [])[0]);
check('the marketplace is available here (not the "marketplace not enabled" message)', !(await b.ev(`!!document.querySelector('#not-enabled')`)));

// ================= a development session with test credits
check('signed out: the buyer can start a development session (no wallet needed)', await b.ev(`!!document.querySelector('#dev-start')`) && /test credits are a ledger entry/.test(await text('#buyer')));
await b.click('#buyer button', 'Start development session');
await until(async () => await b.ev(`!!document.querySelector('#dev-balance')`));
check('the development session shows TEST CREDITS (5 TESTUSDT), clearly not money', /5 TESTUSDT/.test(await text('#dev-balance')) && /TEST CREDITS/.test(await text('#buyer')));

// ================= wallet and funding page: says exactly what exists
await go('#/buyer/funding', 1600);
const fund = await text('#fund');
check('funding page explains that funding is simulated: no wallet, no transaction, nothing on-chain', /funding is simulated with test credits/.test(fund) && /No wallet is connected and no blockchain is used/.test(fund) && /No transaction is sent and none is verified on-chain/.test(fund) && /Nothing on this page means a wallet is funded or that anything happened on-chain/.test(fund), fund.replace(/\s+/g, ' ').slice(0, 200));
check('funding page offers no wallet verification, deposit address or transaction hash box', !/Verify my wallet|deposit address|transaction hash|Sending wallet/i.test(fund) && !(await b.ev(`!!document.querySelector('#fund input')`)));
await b.click('#fund button', 'Add 1 test credit');
await b.sleep(1500);
check('test credits are capped per buyer (a development rule): the balance stays 5 TESTUSDT and the page says why', /5 TESTUSDT/.test(await text('#dev-balance')) && /capped/i.test(await body()), await text('#dev-balance'));

// ================= browse and inspect APIs (demo listings are visible here)
await go('#/buyer/explore', 1800);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#cat-list .svc')].map(c => ({ id: c.dataset.id, text: c.innerText })))`).then(JSON.parse);
const demoCards = cards.filter((c) => /DEMO/.test(c.text));
check('explore lists the demo APIs, labelled DEMO, with View API; the simulated Buy services are labelled SIMULATED', demoCards.length >= 2 && demoCards.every((c) => /View API/.test(c.text) && /Seller:/.test(c.text)) && cards.filter((c) => !/DEMO/.test(c.text)).every((c) => /SIMULATED/i.test(c.text)), cards.map((c) => c.text.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
const price = cards.find((c) => /Demo token price/.test(c.text));
await b.ev(`document.querySelector('#cat-list .svc[data-id=${JSON.stringify(price.id)}] a.btn').click(); 0`);
await b.sleep(2600);
check('View API opens the details page for that listing', (await b.ev('location.pathname + location.search')) === `/api.html?id=${price.id}`);
const det = await text('#api-details');
check('details show the listing, price in TESTUSDT, billing method and inputs', /Demo token price/.test(await text('#api-name')) && /Price per request\s+0\.02 TESTUSDT/.test(det) && /Outcome-based/.test(det) && /Required inputs/i.test(det), det.replace(/\s+/g, ' ').slice(0, 160));
check('details page is labelled DEVELOPMENT with test credits and claims no network or wallet', /DEVELOPMENT · TEST CREDITS/.test(await text('#mode-badge')) && /no wallet, no blockchain, no real transaction/.test(await text('#network-line')) && !NOT_DEV_CLAIMS.test(await body()), await text('#network-line'));
check('opening the page charged nothing', /Test-credit balance: 5 TESTUSDT/.test(await text('#api-balance')), await text('#api-balance'));

// ================= use the API with test credits
await b.set('#run-input', '{"id":"eth"}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
await b.click('#run-confirm', 'Confirm');
await until(async () => /Idempotency key/.test((await text('#run-result')) || ''), 20000);
const r = await text('#run-result');
check('the request is billed in test credits: charged 0.02 TESTUSDT, receipt says development test credits, no wallet steps', /Charged 0\.02 TESTUSDT/.test(r) && /Platform fee\s+0\.0006/.test(r) && /development test credits/.test(r) && !(await b.ev(`!!document.querySelector('#pay-steps li')`)), r.replace(/\s+/g, ' ').slice(0, 220));
check('balance dropped by exactly the price (4.98)', /4\.98 TESTUSDT/.test(await text('#api-balance')), await text('#api-balance'));
await b.set('#run-input', '{"id":"eth","scenario":"stale"}');
const before = r;
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
await b.click('#run-confirm', 'Confirm');
await until(async () => { const t = (await text('#run-result')) || ''; return t !== before && /Idempotency key/.test(t); }, 20000);
check('a failing response is not charged even in development', /Not charged/.test(await text('#run-result')) && /4\.98 TESTUSDT/.test(await text('#api-balance')));

// ================= usage / transactions pages work
await b.goto(`${BASE}/market.html#/buyer/transactions`, 2400);
check('transactions: the statement reconciles in test credits', /Deposited \/ granted\s+5/.test(await text('#statement')) && /Charged for qualifying responses\s+0\.02/.test(await text('#statement')), (await text('#statement')).replace(/\s+/g, ' '));
await go('#/buyer/usage', 1400);
check('usage: agent keys are described in test credits', /test credits/i.test(await text('#agents')));

// ================= seller: sandbox seller publishes a sandbox API
await b.click('#tab-seller', 'Seller');
await b.sleep(1200);
check('seller signed out: development sandbox seller is offered and labelled', await b.ev(`!!document.querySelector('#dev-sandbox-seller')`) && /sandbox seller is a test wallet derived by this server/.test(await text('#seller')));
await b.click('#seller button', 'Use the sandbox seller');
await until(async () => /My APIs/.test((await text('#seller')) || ''));
await go('#/seller/new', 1500);
check('create form has development sandbox presets and prices in test credits', /Development sandbox presets/.test(await text('#seller')) && /test credits, development only/.test(await text('#seller')));
await b.click('#seller button', 'Price API');
await b.sleep(700);
await b.click('#seller button', 'Submit listing');
await until(async () => /Listing details/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Sign (sandbox wallet');
await until(async () => /Wallet proof: done/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Check DNS');
await until(async () => /Domain proof: done/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Suggest a contract from a sample call');
await until(async () => /Suggested contract/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Propose this contract');
await until(async () => /proposed/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Approve');
await until(async () => /All requirements are met/.test((await text('#seller')) || ''));
await b.click('#seller button', 'Publish');
await until(async () => /Published at/.test((await b.ev(`document.getElementById('seller-status').hidden ? '' : document.getElementById('seller-status').innerText`)) || ''));
const cat = await (await fetch(`${BASE}/api/market/catalog`)).json();
const mine = cat.items.find((i) => i.title === 'My sandbox price API');
check('the sandbox seller published an API that buyers can find, priced in TESTUSDT and labelled SANDBOX', mine && mine.pricing.asset === 'TESTUSDT' && mine.origin === 'payrail-sandbox', JSON.stringify(mine && { a: mine.pricing.asset, o: mine.origin }));

// ================= mobile: the same development pages fit
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.goto(`${BASE}/market.html#/buyer/explore`, 2400);
check('mobile: development pages have no horizontal overflow', (await b.ev('document.documentElement.scrollWidth - window.innerWidth')) <= 0);
await b.shot('dev-mobile');

const failedAny = finish();
b.close();
await new Promise((r2) => server.close(() => r2()));
try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(failedAny ? 1 : 0);
