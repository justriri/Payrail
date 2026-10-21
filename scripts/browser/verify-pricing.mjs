// Browser regression: the seller form (pricing currency chosen from the server's Textile routes, USDT preview, honest problem labels)
// and the domain-verification feedback (temporary DNS failure vs failed ownership proof, with instructions).
// REAL-FUNDS mode against a FAKE chain, a SIMULATED Textile and a fake DNS (see harness.mjs).   node scripts/browser/verify-pricing.mjs <output dir>
import { generatePrivateKey } from 'viem/accounts';
import { makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false, withConversion: true });
const { check, finish } = makeChecker();
const b = await launch(9393, OUT, 1366, 1500);
await h.wire(b, generatePrivateKey());
const bar = () => b.ev(`document.getElementById('seller-status').hidden ? '' : document.getElementById('seller-status').innerText`);
const seller = () => b.text('#seller');
const until = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const field = (placeholder) => `#seller input[placeholder=${JSON.stringify(placeholder)}]`;
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');

await b.goto(`${h.BASE}/market.html#/seller`, 2200);
await b.click('#seller button', 'Sign in with your wallet');
await until(async () => /My APIs/.test((await seller()) || ''));
await b.click('#seller a', 'New listing');
await until(async () => (await b.ev(`document.querySelectorAll('#price-currency option').length`)) > 1);

// ---- the currency selector is filled from the server
const opts = await b.ev(`JSON.stringify([...document.querySelectorAll('#price-currency option')].map(o => ({ v: o.value, t: o.textContent, d: o.disabled })))`).then(JSON.parse);
const sel = opts.filter((o) => !o.d).map((o) => o.v).sort().join(',');
check('selectable pricing currencies are USDT plus the Textile routes the server enables (cNGN, wARS, wBRL, USDC, IDRX)', sel === 'IDRX,USDC,USDT,cNGN,wARS,wBRL', sel);
check('unusable currencies are listed but disabled, with their status (USAT is not in Textile\'s official Celo list)', opts.some((o) => o.v === 'USAT' && o.d && /not usable/.test(o.t)) && !opts.some((o) => o.v === 'CWT'), JSON.stringify(opts.filter((o) => o.d).map((o) => o.t)));

// ---- price preview: original price kept, USDT shown, limitations stated
await b.set(field('e.g. 0.02'), '50');
await b.set('#price-currency', 'cNGN');
await b.ev(`document.querySelector('#price-currency').dispatchEvent(new Event('change')); 0`);
await b.click('#price-preview-btn', 'Show the USDT price');
await until(async () => (await b.ev(`!!document.querySelector('#price-table')`)));
const pt = (await b.text('#price-preview')).replace(/\s+/g, ' ');
check('the preview shows the seller price in cNGN, the USDT buyers are billed, the rate, the source and the time', /50 cNGN/.test(await b.text('#price-yours')) && /0\.0\d+ USDT/.test(await b.text('#price-usdt')) && /Textile indicative preview/.test(pt) && /Quoted at/.test(pt), pt.slice(0, 300));
check('limitations are stated before publishing (indicative rate, Textile minimum, one-hour validity)', /INDICATIVE/.test(pt) && /unused USDT/.test(pt) && /older than an hour/.test(pt), pt.slice(300, 900));
await b.shot('seller-price-preview');

// ---- pricing problems are labelled
await b.set(field('e.g. 0.02'), 'abc');
await b.click('#price-preview-btn', 'Show the USDT price');
await b.sleep(400);
check('an invalid amount is labelled "Missing or invalid pricing information"', /Missing or invalid pricing information/.test(await b.text('#price-preview')));
await b.set(field('e.g. 0.02'), '50');

// ---- endpoint problems are labelled
await b.set(field('e.g. Token price API'), 'My cNGN API');
await b.set('#seller input[type=url]', 'http://api.priceco.example/v1/price');
await b.click('#seller button', 'Submit listing');
await b.sleep(1500);
check('a non-https endpoint is labelled "Invalid endpoint URL" and the form keeps its entries', /Invalid endpoint URL/.test(await bar()) && (await b.ev(`document.querySelector('#price-amount').value`)) === '50', await bar());
await b.set('#seller input[type=url]', 'https://api.priceco.example/v1/price');
await b.click('#seller button', 'Submit listing');
await until(async () => /Listing details/.test((await seller()) || ''));
const t = await seller();
check('submitted: the listing is saved as a private Draft, priced in cNGN with its USDT bill, and says it is NOT published', /My cNGN API/.test(t) && /Draft/.test(t) && /Listed as 50 cNGN/.test(t) && /rate 1 cNGN = /.test(t), (await bar()).slice(0, 200));
check('the status bar says the listing is not published yet', /NOT published yet/.test(await bar()), await bar());
check('the editor explains that only a domain the seller controls can be listed', /domain you control/.test(await b.text('#domain-help')) && /third-party API/.test(await b.text('#domain-help')), await b.text('#domain-help'));

// ---- ownership proof feedback
await b.click('#seller button', 'Sign with wallet');
await until(async () => /Wallet proof: done/.test((await seller()) || ''));
h.dns.mode = 'refused';
await b.click('#seller button', 'Check DNS');
await b.sleep(1500);
check('an unreachable DNS service is "temporarily unavailable" and explicitly NOT a failed proof', /DNS lookup temporarily unavailable/.test(await bar()) && /neither confirmed nor rejected/.test(await bar()) && !/Domain ownership not verified/.test(await bar()), await bar());
h.dns.mode = 'ok';
await b.click('#seller button', 'Check DNS');
await b.sleep(1500);
check('with DNS reachable but no record, it is "Domain ownership not verified" with the exact record to add', /Domain ownership not verified/.test(await bar()) && /_payrail-challenge\.api\.priceco\.example/.test(await bar()) && /domain you control/.test(await bar()), await bar());
const dns = await b.ev(`document.querySelector('#seller pre')?.textContent`);
const m = /DNS TXT\s+(\S+)\s*\n\s*=\s*(\S+)/.exec(dns || '');
h.txt.set(m[1], m[2]);
await b.click('#seller button', 'Check DNS');
await until(async () => /Domain proof: done/.test((await seller()) || ''));
check('after the record is published the domain proof succeeds and the price is still shown in both currencies', /Domain proof: done \(DNS record\)/.test(await seller()) && /Listed as 50 cNGN/.test(await seller()));
await b.shot('seller-pricing-verified');

// ---- mobile
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.goto(`${h.BASE}/market.html#/seller/new`, 2200);
await until(async () => (await b.ev(`!!document.querySelector('#price-currency')`)));
check('mobile: the seller form with the currency selector fits the screen', (await overflow()) <= 0, await overflow());
await b.shot('seller-form-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
