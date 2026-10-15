// Real-browser regression for Stage 1 multi-currency (SIMULATED provider). Needs Microsoft Edge.
//   node scripts/browser/verify-multicurrency.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9381, OUT, 1100, 1900);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 190) : ''}`);
const fundText = () => b.text('#fund');
const sellerText = () => b.text('#seller');
const avail = async () => (/([\d.]+) TESTUSDT available/.exec(await b.text('#buyer')) || [])[1];
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(250); } return false; };
const setSel = (sel, v) => b.ev(`(() => { const s=document.querySelectorAll(${JSON.stringify(sel)}); const e=s[0]; e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('change',{bubbles:true})); return e.value; })()`);

// ================= buyer: asset picker
await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(2500);
let t = await fundText();
const options = await b.ev(`JSON.stringify([...document.querySelector('#fund select').options].map(o=>o.value))`);
check('picker lists USDT and every enabled live asset, nothing else', /USDT/.test(options) && /cNGN/.test(options) && /wARS/.test(options) && /wBRL/.test(options) && !/wMXN|G\$|CWT|IDRX/.test(options), options);
check('unavailable assets are listed with the reason, not hidden', /Not available for funding/.test(t));
await b.ev(`document.querySelector('#fund details').open = true; 0`);
t = await fundText();
check('reasons are specific (no liquidity / not enabled)', /G\$: listed, but with no liquidity/.test(t) && /wCOP: not enabled by the operator/.test(t), t.split('\n').filter((l) => /G\$|wCOP/.test(l)).join(' | '));

// ================= buyer: 18-decimal asset, two-hop funding
const start = await avail();
await setSel('#fund select', 'wARS');
await b.sleep(300);
await b.ev(`document.querySelectorAll('#fund input')[0].value = '1611'; 0`);
await b.click('#fund button', 'Get a quote');
await b.sleep(1500);
t = await fundText();
check('wARS quote shows its own unit, rate, fee and the deposit address', /You convert\s+1611 wARS/.test(t) && /1 USDT = 1611 wARS/.test(t) && /Conversion fee[^\n]*wARS/.test(t) && /Then deposited to/.test(t), t.split('\n').slice(3, 14).join(' | '));
check('nothing converted before approval', (await avail()) === start);
await b.click('#fund button', 'Approve and convert 1611 wARS');
await until(async () => (await avail()) !== start);
t = await fundText();
const afterW = await avail();
check('verified conversion + verified deposit credit the balance once', /Credited to your balance/.test(t) && /Conversion transaction/.test(t) && /Deposit transaction/.test(t) && afterW !== start, `${start} -> ${afterW}`);
await b.click('#fund button', 'Done');
await b.sleep(700);

// ================= buyer: already USDT
await setSel('#fund select', 'USDT');
await b.sleep(300);
await b.ev(`document.querySelectorAll('#fund input')[0].value = '2'; 0`);
await b.click('#fund button', 'Get a quote');
await b.sleep(1200);
t = await fundText();
check('USDT shows a deposit, not a conversion', /You deposit\s+2 USDT/.test(t) && /No conversion needed|1 USDT = 1 USDT/.test(t) && /Approve deposit of 2 USDT/.test(t), t.split('\n').slice(3, 9).join(' | '));
await b.click('#fund button', 'Approve deposit');
await b.sleep(2200);
t = await fundText();
const afterU = await avail();
check('USDT deposit credited exactly 2 with no swap transaction', /Credited to your balance/.test(t) && !/Conversion transaction/.test(t) && Math.abs(Number(afterU) - Number(afterW) - 2) < 1e-9, `${afterW} -> ${afterU}`);
await b.click('#fund button', 'Done');
await b.sleep(700);

// ================= buyer: swap fine, deposit never made -> not credited
await setSel('#fund select', 'cNGN');
await b.sleep(300);
await b.ev(`(() => { document.querySelectorAll('#fund input')[0].value = '1364'; const sc=document.querySelectorAll('#fund select')[1]; sc.value='deposit_missing'; return 0; })()`);
await b.click('#fund button', 'Get a quote');
await b.sleep(1200);
await b.click('#fund button', 'Approve and convert');
await b.sleep(2500);
t = await fundText();
check('a verified swap without a verified deposit is not credited and says where the USDT is', /Needs review: nothing was credited/.test(t) && (await avail()) === afterU);
await b.click('#fund button', 'Done');
await b.sleep(700);

// ================= seller: preference, address, payout conversion
await b.goto(BASE + '/market.html#/seller/payout-settings');
await b.click('#seller button', 'sandbox seller');
await b.sleep(2000);
let st = await sellerText();
check('payout settings default to USDT, are labelled simulated and explain the rules', /Current payout asset: USDT/.test(st) && /SIMULATED conversion/.test(st) && /How it works/.test(st) && /Prices, balances, fees and earnings stay in USDT/.test(st));
const popts = await b.ev(`JSON.stringify([...document.querySelector('#seller select').options].map(o=>o.value))`);
check('payout picker offers only live and enabled assets', /USDT/.test(popts) && /cNGN/.test(popts) && /wBRL/.test(popts) && !/wMXN|G\$|CELO/.test(popts), popts);
await b.ev(`document.querySelector('#seller details').open = true; 0`);
st = await sellerText();
check('asymmetric / shallow payout routes are explained', /wMXN: no market makers are quoting/.test(st) && /CELO: not enabled/.test(st), st.split('\n').filter((l) => /wMXN|CELO/.test(l)).join(' | '));
await setSel('#seller select', 'cNGN');
await b.click('#seller button', 'Save preference');
await b.sleep(1500);
st = await sellerText();
check('preference saved with a version', /Current payout asset: cNGN \(version 1/.test(st), st.split('\n').find((l) => /Current payout asset/.test(l)));
await b.click('#seller button', 'sandbox wallet as payout address');
await b.sleep(1500);
check('payout address verified', /chain 42220: 0x/.test(await sellerText()));

// give this seller earnings by selling to the buyer through the normal flow (API calls from the page)
const sellerToken = await b.ev(`localStorage.getItem('payrail.seller')`);
const buyerToken = await b.ev(`localStorage.getItem('payrail.buyer')`);
const seed = await b.ev(`localStorage.getItem('payrail.sandboxSeed')`);
const setup = await b.ev(`(async () => {
  const tok = document.querySelector('meta[name=payrail-token]').content;
  const j = async (path, t, body) => (await fetch('/api/market' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + t, ...(body ? { 'content-type': 'application/json', 'x-payrail-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  const host = 'mc-' + Math.random().toString(36).slice(2, 8);
  const c = await j('/seller/listings', ${JSON.stringify(sellerToken)}, { name: 'Payout check API', description: 'x', endpointUrl: 'https://' + host + '.sandbox.payrail.example/v1/price', method: 'GET', price: '2' });
  const id = c.listing.id;
  await j('/seller/listing/' + id + '/wallet-proof', ${JSON.stringify(sellerToken)}, { sandbox: true, seed: ${JSON.stringify(seed)} });
  await j('/seller/listing/' + id + '/domain-proof', ${JSON.stringify(sellerToken)}, { method: 'dns_txt' });
  const s = await j('/seller/listing/' + id + '/suggest-contract', ${JSON.stringify(sellerToken)}, { input: { id: 'eth' } });
  const p = await j('/seller/listing/' + id + '/contract', ${JSON.stringify(sellerToken)}, { contract: s.suggestion });
  await j('/seller/contract/' + p.contract.id + '/approve', ${JSON.stringify(sellerToken)}, {});
  await j('/seller/listing/' + id + '/publish', ${JSON.stringify(sellerToken)}, {});
  let ok = 0;
  for (let i = 0; i < 3; i++) { const e = await j('/execute', ${JSON.stringify(buyerToken)}, { listingId: id, input: { id: 'eth' }, idempotencyKey: 'mc-sale-' + Date.now() + '-' + i }); if (e.ok && e.result.charged) ok++; }
  return ok;
})()`);
check('setup: three qualifying sales made earnings', Number(setup) === 3, setup);

await b.goto(BASE + '/market.html#/seller/earnings');
await b.sleep(2000);
st = await sellerText();
check('earnings page offers a payout in the preferred asset, in USDT terms', /Request a payout in cNGN/.test(st) && /Your earnings are in USDT/.test(st));
await b.ev(`document.querySelectorAll('#seller input')[0].value = '3'; 0`);
await b.click('#seller button', 'Get a payout quote');
await b.sleep(2000);
st = await sellerText();
check('quote shows rate, expected amount, minimum, fee and delivery address before anything is converted', /3 TESTUSDT → cNGN/.test(st) && /Rate\s+1 USDT = 1364 cNGN/.test(st) && /Expected to receive\s+[\d.]+ cNGN/.test(st) && /Guaranteed minimum/.test(st) && /Delivered to\s+0x/.test(st) && /Quote ready: confirm it to continue/.test(st), st.split('\n').slice(0, 1).join(''));
check('no operator action or execution is available yet', !/Execute conversion/.test(st) && !/Simulate operator approval/.test(st));
await b.click('#seller button', 'Confirm this quote');
await b.sleep(1800);
st = await sellerText();
check('after confirmation it waits for the operator (no conversion yet)', /waiting for operator approval/i.test(st) && !/Execute conversion/.test(st));
await b.click('#seller button', 'Simulate operator approval');
await b.sleep(1500);
await b.click('#seller button', 'Execute conversion (simulated)');
await b.sleep(2500);
st = await sellerText();
check('delivered and verified: payout complete with verified amount', /Delivered and verified/.test(st) && /Verified received\s+[\d.]+ cNGN/.test(st) && /confirmed/.test(st), st.split('\n').filter((l) => /Delivered|Verified received/.test(l)).join(' | '));

// failure: delivery missing -> not returned, then retry delivers
await b.ev(`document.querySelectorAll('#seller input')[0].value = '2'; 0`);
await b.click('#seller button', 'Get a payout quote');
await b.sleep(2000);
const cards = await b.ev(`document.querySelectorAll('#seller .notice').length`);
const confirmBtns = await b.ev(`[...document.querySelectorAll('#seller button')].filter(x=>x.textContent==='Confirm this quote').length`);
check('a second payout quote appears as its own card', Number(confirmBtns) === 1, `cards=${cards}`);
await b.click('#seller button', 'Confirm this quote');
await b.sleep(1500);
await b.click('#seller button', 'Simulate operator approval');
await b.sleep(1500);
await b.ev(`[...document.querySelectorAll('#seller select')].find(s => [...s.options].some(o => o.value === 'delivery_missing')).value = 'delivery_missing'; 0`);
await b.click('#seller button', 'Execute conversion (simulated)');
await b.sleep(2500);
st = await sellerText();
check('swapped-but-undelivered is shown honestly and USDT is not returned', /NOT delivered yet/.test(st) && /Retry delivery/.test(st));
await b.click('#seller button', 'Retry delivery');
await until(async () => ((await sellerText()).match(/Delivered and verified/g) || []).length >= 2, 12000);
st = await sellerText();
check('retrying delivery completes without a second swap', (st.match(/Delivered and verified/g) || []).length >= 2, (st.match(/Delivered and verified/g) || []).length);
await b.shot('multicurrency-final');
console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
