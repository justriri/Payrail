// Browser regression: buying a SELLER-LISTED API with a wallet that holds no USDT. Textile (SIMULATED here) converts cNGN in the buyer's wallet, the
// USDT top-up is verified on a FAKE chain, the production checkout runs the seller API once and settles through the ledger.
//   node scripts/browser/verify-checkout.mjs <output dir>
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEMO_WORDS, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false, withConversion: true });
const { check, finish } = makeChecker();
const b = await launch(9394, OUT, 1366, 1000);
const key = generatePrivateKey();
const addr = privateKeyToAccount(key).address;
h.usdtBalances.set(addr.toLowerCase(), 0n); // the wallet holds NO USDT
const wallet = await h.wire(b, key);
const until = async (fn, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const id = await h.publish('Quote API', '0.5', { description: 'Returns a quote.' });

await b.goto(`${h.BASE}/api.html?id=${id}`, 2200);
check('the listing page shows the seller listing (not a Buy API), its USDT price and seller', /Quote API/.test(await b.text('#api-name')) && /Seller: /.test(await b.text('#api-seller')) && /0\.5 USDT/.test(await b.text('#api-details')));
await b.set('#run-input', '{}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
await b.click('#run-confirm', 'Confirm');
await until(async () => (await b.ev(`!!document.querySelector('#estimate-btn')`)));
const sh = await b.text('#shortfall');
check('with 0 USDT the page states the server-computed shortfall and that nothing was charged', /costs 0\.5 USDT/.test(sh) && /holds 0 USDT/.test(sh) && /0\.5 USDT short/.test(sh) && /Nothing has been charged/.test(sh), sh);
check('no payment, signature or transaction was requested yet', wallet.sends.length === 0 && wallet.typedSigns.length === 0, `${wallet.sends.length} sends`);
const cards = await b.ev(`JSON.stringify([...document.querySelectorAll('#currency-status .cur')].map(c => ({ sym: c.dataset.symbol, status: c.dataset.status })))`).then(JSON.parse);
check('every currency is listed with its true status; USAT/CELO/G$ unsupported; a simulated provider is never "Live"', cards.some((c) => c.sym === 'cNGN') && cards.filter((c) => ['USAT', 'CELO', 'G$'].includes(c.sym)).every((c) => c.status === 'unsupported') && !cards.some((c) => c.status === 'live'), cards.map((c) => `${c.sym}:${c.status}`).join(' '));
const prod = async () => (await b.text('body')).replace(/SIMULATED route \(development only\): nothing here is real\./g, '').replace(/Simulated/g, ''); // the simulated-provider badge exists only because this test runs a simulated Textile; production never shows it
check('no demo / test language (apart from the simulated-provider badge of this test setup)', !DEMO_WORDS.test(await prod()), (((await prod()).match(DEMO_WORDS)) || [])[0]);
await b.set('#pay-currency', 'cNGN');
await b.click('#estimate-btn', 'Show what it will cost');
await until(async () => (await b.ev(`!!document.querySelector('#estimate-table')`)));
const est = (await b.text('#estimate-table')).replace(/\s+/g, ' ');
check('before approval: API price, amount to spend, minimum swap, fee, expected and minimum USDT, USDT left, quote status and expiry', /0\.5 USDT/.test(est) && /cNGN/.test(await b.text('#est-sell')) && /cNGN/.test(await b.text('#est-min-swap')) && /cNGN/.test(await b.text('#est-fee')) && /never less than/.test(await b.text('#est-receive')) && /at least \d/.test(await b.text('#est-left')) && /INDICATIVE/.test(await b.text('#est-quote-status')) && /valid for/.test(await b.text('#est-expiry')), est.slice(0, 500));
check('the page says the conversion is larger than the price and the rest stays in the wallet', /more than the API costs|more than the API price/.test(await b.text('#estimate-box')) && /stays in your own wallet|Stays in your wallet/.test(await b.text('#estimate-box')));
await b.shot('checkout-estimate');
check('estimating signed and sent nothing', wallet.sends.length === 0 && wallet.typedSigns.length === 0);
await b.click('#convert-btn', 'Approve: convert');
await until(async () => (await b.ev(`!!document.querySelector('#run-headline')`)));
const steps = (await b.text('#pay-steps')).replace(/\s+/g, ' ');
check('the wallet signed the Textile authorization, sent approve + swap, the conversion was verified, then the USDT top-up was verified', wallet.typedSigns.length === 1 && wallet.typedSigns[0].primaryType === 'TakerControl' && /Conversion verified/.test(steps) && /Verified on-chain and credited/.test(steps), steps.slice(-420));
check('3 wallet transactions in order: approval, swap, USDT top-up (each approved explicitly)', wallet.sends.length === 3, `${wallet.sends.length}`);
const res = await b.text('#run-result');
check('the API was paid for only after verification: charged, response and receipt shown', /Charged 0\.5 USDT/.test(res) && /completed and charged/.test(res) && /API response/i.test(res) && /Idempotency key/.test(res), res.replace(/\s+/g, ' ').slice(0, 300));
const rec = (await b.text('#run-result')).replace(/\s+/g, ' ');
check('the purchase record ties price, seller, conversion tx and top-up tx together, and does not call the fee collected from the buyer wallet', /Purchase record/.test(rec) && /CHARGED/.test(rec) && /Authoritative price/.test(rec) && /Currency conversion \(Textile\)/.test(rec) && /USDT top-up transaction/.test(rec) && /Platform fee/.test(rec) && /seller's share/.test(rec), rec.slice(-700));
await b.shot('checkout-receipt');
const row = h.db.prepare("SELECT state, conversion_id, deposit_txs, execution_id FROM listing_checkouts").get();
check('server record: CHARGED, conversion and deposit transaction stored, one execution', row.state === 'CHARGED' && row.conversion_id && JSON.parse(row.deposit_txs).length === 1 && row.execution_id && Number(h.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n) === 1);

// ---- a declined conversion signature: nothing is converted, deposited or charged
wallet.denyTyped = true;
const sendsBefore = wallet.sends.length;
await b.goto(`${h.BASE}/api.html?id=${id}`, 2200);
h.usdtBalances.set(addr.toLowerCase(), 0n);
await b.set('#run-input', '{}');
await b.click('#run-btn', 'Pay and Use API');
await b.sleep(300);
await b.click('#run-confirm', 'Confirm');
await until(async () => (await b.ev(`!!document.querySelector('#estimate-btn')`)), 40000);
// the first purchase left no balance behind (it was captured); a new one needs funds again
await b.set('#pay-currency', 'cNGN');
await b.click('#estimate-btn', 'Show what it will cost');
await until(async () => (await b.ev(`!!document.querySelector('#convert-btn')`)));
await b.click('#convert-btn', 'Approve: convert');
await until(async () => /declined/i.test(await b.text('#pay-steps')));
check('declining the Textile authorization: clear message, nothing sent, nothing charged', /Nothing was sent or converted/.test(await b.text('#pay-steps')) && wallet.sends.length === sendsBefore && Number(h.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n) === 1, await b.text('#pay-steps'));

// ---- mobile
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.sleep(500);
check('mobile: the checkout panel fits the screen', (await overflow()) <= 0, await overflow());
await b.shot('checkout-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
