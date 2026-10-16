// Browser regression: paying for a Buy API with cNGN. Textile (SIMULATED here) converts in the buyer's wallet, then Buy (FAKE gateway) is paid in USDT.
// Production code paths for quotes, firm-quote handling, receipts and verification run; the chain and both providers are fakes.
//   node scripts/browser/verify-convert.mjs <output dir>
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEMO_WORDS, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false, withConversion: true });
const { check, finish } = makeChecker();
const b = await launch(9392, OUT, 1366, 900);
const key = generatePrivateKey();
const addr = privateKeyToAccount(key).address;
h.usdtBalances.set(addr.toLowerCase(), 0n); // the wallet holds NO USDT: the only way to buy is to convert
const wallet = await h.wire(b, key);
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');

await b.goto(`${h.BASE}/api.html?src=buy&id=x.posts.search`, 2000);
await b.set('#run-input', '{"query":"celo"}');
await b.click('#quote-btn', 'Get the exact price');
await until(async () => (await b.ev(`!!document.querySelector('#convert-panel')`)));
await until(async () => (await b.ev(`!!document.querySelector('#pay-currency')`)));
check('with 0 USDT the page says so and does NOT offer to sign a Buy payment', /holds 0 USDT/.test(await b.text('#wallet-usdt')) && !(await b.ev(`!!document.querySelector('#sign-btn')`)) && /0\.005 USDT/.test(await b.text('#shortfall')) && /Nothing has been charged/.test(await b.text('#shortfall')), await b.text('#shortfall'));
const options = await b.ev(`[...document.querySelectorAll('#pay-currency option')].map(o => o.value).filter(Boolean).join(',')`);
check('only currencies with a Textile route into USDT are offered (cNGN yes; CWT, G$ never)', /cNGN/.test(options) && !/CWT/.test(options) && !/G\$/.test(options), options);
check('no demo / test language', !DEMO_WORDS.test(await b.text('body')), (((await b.text('body')).match(DEMO_WORDS)) || [])[0]);
await b.set('#pay-currency', 'cNGN');
await b.ev(`document.querySelector('#pay-currency').dispatchEvent(new Event('change')); 0`);
check('the chosen currency states what is known about its route', /cNGN -> USDT on Textile/.test(await b.text('#currency-evidence')), await b.text('#currency-evidence'));
await b.click('#estimate-btn', 'Show what it will cost');
await until(async () => (await b.ev(`!!document.querySelector('#estimate-table')`)));
const est = (await b.text('#estimate-table')).replace(/\s+/g, ' ');
check('estimate shows the API price, the amount of cNGN, the conversion cost, USDT received and what stays in the wallet', /0\.005 USDT/.test(est) && /1364 cNGN|\d[\d,.]* cNGN/.test(est) && /Conversion cost/.test(est) && /never less than/.test(est) && /at least \d/.test(est) && /3% platform fee/.test(est) && /adds nothing to the conversion/.test(est), est);
check('the page explains why the swap is bigger than the API price', /about 1 USD/.test(await b.text('#est-why')));
check('nothing has been signed, sent or charged yet', wallet.sends.length === 0 && wallet.typedSigns.length === 0 && h.buyGateway.paidRequests === 0, `${wallet.sends.length} sends ${wallet.typedSigns.length} signs`);
await b.shot('convert-estimate');

await b.click('#convert-btn', 'Approve: convert');
await until(async () => (await b.ev(`!!document.querySelector('#conversion-done')`)));
const steps = (await b.text('#pay-steps')).replace(/\s+/g, ' ');
check('the wallet signed the Textile authorization (typed data, no funds), then sent exactly the validated approve + swap transactions', wallet.typedSigns.length === 1 && wallet.typedSigns[0].primaryType === 'TakerControl' && wallet.sends.length === 2, `${wallet.typedSigns.map((t) => t.primaryType)} sends=${wallet.sends.length}`);
check('the page waited for on-chain verification before saying converted', /Conversion verified/.test(steps) && /Converted: .*verified on-chain/.test(await b.text('#conversion-done')), (await b.text('#conversion-done')) + ' // ' + String(/Conversion verified/.test(steps)));
check('after the conversion a fresh Buy quote is shown and no payment has been made yet', (await b.ev(`!!document.querySelector('#sign-btn')`)) && h.buyGateway.paidRequests === 0);
await b.shot('convert-verified');

await b.click('#sign-btn', 'Sign and pay');
await until(async () => (await b.ev(`!!document.querySelector('#run-headline')`)));
const rc = (await b.text('#receipt')).replace(/\s+/g, ' ');
check('Buy was paid in USDT after the conversion: CONFIRMED, one paid request', /CONFIRMED/.test(rc) && h.buyGateway.paidRequests === 1 && wallet.typedSigns.length === 2, rc.slice(0, 200));
check('the receipt shows the Textile conversion (amounts and transaction) as well as the Buy payment', /Currency conversion \(Textile\)/.test(rc) && /sold .* cNGN, received .* USDT; tx 0x/.test(rc) && /Conversion fee \(Textile\)/.test(rc), rc);
check('the fee is shown as due, not collected', /not collected/i.test(rc));
check('the API response is shown', /hello from the fake gateway/.test(await b.text('#api-response')));
await b.shot('convert-receipt');

// a declined swap leaves everything unchanged
h.usdtBalances.set(addr.toLowerCase(), 0n);
const sendsBefore = wallet.sends.length;
const paidBefore = h.buyGateway.paidRequests;
await b.goto(`${h.BASE}/api.html?src=buy&id=instagram.profile`, 2000);
await b.set('#run-input', '{"username":"celo"}');
await b.click('#quote-btn', 'Get the exact price');
await until(async () => (await b.ev(`!!document.querySelector('#pay-currency')`)));
await b.set('#pay-currency', 'cNGN');
await b.click('#estimate-btn', 'Show what it will cost');
await until(async () => (await b.ev(`!!document.querySelector('#convert-btn')`)));
wallet.denyTyped = true;
await b.click('#convert-btn', 'Approve: convert');
await until(async () => /declined/i.test(await b.text('#pay-steps')));
check('declining the Textile authorization: nothing converted, nothing sent, Buy not contacted', /Nothing was sent or converted/.test(await b.text('#pay-steps')) && wallet.sends.length === sendsBefore && h.buyGateway.paidRequests === paidBefore, await b.text('#pay-steps'));

// mobile
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.goto(`${h.BASE}/api.html?src=buy&id=x.posts.search`, 2000);
check('mobile: no horizontal overflow', (await overflow()) <= 0, await overflow());

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
