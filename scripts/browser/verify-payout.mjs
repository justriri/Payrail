// Real-browser regression for the seller payout lifecycle in USDT (SIMULATED provider, test credits only).
//   node scripts/browser/verify-payout.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9384, OUT, 1100, 2000);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 190) : ''}`);
const sellerText = () => b.text('#seller');
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(250); } return false; };

// buyer exists (needed to buy), seller sandbox
await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(2000);
await b.goto(BASE + '/market.html#/seller/payout-settings');
await b.click('#seller button', 'sandbox seller');
await b.sleep(2000);
let st = await sellerText();
check('payout settings open with USDT preference, labelled simulated', /Current payout asset: USDT/.test(st) && /SIMULATED conversion/.test(st) && /Test-credit earnings cannot be paid out/.test(st));
const opts = await b.ev(`JSON.stringify([...document.querySelector('#seller select').options].map(o=>o.value))`);
check('supported payout preferences display (USDT, cNGN, wBRL; no CWT)', /USDT/.test(opts) && /cNGN/.test(opts) && /wBRL/.test(opts) && !/CWT/.test(opts), opts);
check('address state is clear before verification', /None yet\. A converted payout is only ever delivered to an address you prove you control/.test(st));
await b.click('#seller button', 'sandbox wallet as payout address');
await b.sleep(1500);
check('address shows as verified', /chain 42220: 0x/.test(await sellerText()));

const sellerToken = await b.ev(`localStorage.getItem('payrail.seller')`);
const buyerToken = await b.ev(`localStorage.getItem('payrail.buyer')`);
const seed = await b.ev(`localStorage.getItem('payrail.sandboxSeed')`);
const setup = await b.ev(`(async () => {
  const tok = document.querySelector('meta[name=payrail-token]').content;
  const j = async (path, t, body) => (await fetch('/api/market' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + t, ...(body ? { 'content-type': 'application/json', 'x-payrail-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  const host = 'po-' + Math.random().toString(36).slice(2, 8);
  const c = await j('/seller/listings', ${JSON.stringify(sellerToken)}, { name: 'Payout lifecycle API', description: 'x', endpointUrl: 'https://' + host + '.sandbox.payrail.example/v1/price', method: 'GET', price: '2' });
  const id = c.listing.id;
  await j('/seller/listing/' + id + '/wallet-proof', ${JSON.stringify(sellerToken)}, { sandbox: true, seed: ${JSON.stringify(seed)} });
  await j('/seller/listing/' + id + '/domain-proof', ${JSON.stringify(sellerToken)}, { method: 'dns_txt' });
  const s = await j('/seller/listing/' + id + '/suggest-contract', ${JSON.stringify(sellerToken)}, { input: { id: 'eth' } });
  const p = await j('/seller/listing/' + id + '/contract', ${JSON.stringify(sellerToken)}, { contract: s.suggestion });
  await j('/seller/contract/' + p.contract.id + '/approve', ${JSON.stringify(sellerToken)}, {});
  await j('/seller/listing/' + id + '/publish', ${JSON.stringify(sellerToken)}, {});
  let ok = 0;
  for (let i = 0; i < 3; i++) { const e = await j('/execute', ${JSON.stringify(buyerToken)}, { listingId: id, input: { id: 'eth' }, idempotencyKey: 'po-sale-' + Date.now() + '-' + i }); if (e.ok && e.result.charged) ok++; }
  const real = await fetch('/api/market/seller/payouts', { method: 'POST', headers: { authorization: 'Bearer ' + ${JSON.stringify(sellerToken)}, 'content-type': 'application/json', 'x-payrail-token': tok }, body: JSON.stringify({ amount: '1' }) });
  return JSON.stringify({ ok, realStatus: real.status, realBody: (await real.json()).error });
})()`);
const su = JSON.parse(setup);
check('setup: qualifying sales made earnings', su.ok >= 2, setup);
check('test-credit earnings cannot be withdrawn as a real payout (server refuses)', su.realStatus === 409 && /LIVE_DISABLED/.test(JSON.stringify(su.realBody)) || su.realStatus === 409, setup);

await b.goto(BASE + '/market.html#/seller/earnings');
await b.sleep(2000);
st = await sellerText();
check('earnings page offers a SIMULATED USDT payout and says payouts are disabled for real', /Request a payout in USDT \(SIMULATED demo\)/.test(st) && /payouts: disabled \(test credits cannot be paid out\)/.test(st));

const run = async (amount, scenario) => {
  await b.ev(`document.querySelectorAll('#seller input')[0].value = ${JSON.stringify(amount)}; 0`);
  await b.click('#seller button', 'Get a payout quote');
  await b.sleep(1800);
  await b.click('#seller button', 'Confirm this quote');
  await b.sleep(1500);
  await b.click('#seller button', 'Simulate operator approval');
  await b.sleep(1500);
  if (scenario) await b.ev(`[...document.querySelectorAll('#seller select')].find(s => [...s.options].some(o => o.value === 'refused')).value = ${JSON.stringify(scenario)}; 0`);
  await b.click('#seller button', 'Send payout (simulated)');
  await b.sleep(2500);
  return sellerText();
};
// 1: short delivery -> review-required, never completed, not refunded
st = await run('1', 'short');
check('short delivery shows review-required and "not marked paid"', /review-required/.test(st) && /Needs operator review: not marked paid/.test(st), st.split('\n').filter((l) => /review/i.test(l)).slice(0, 2).join(' | '));
check('USDT quote showed no conversion fee/rate surprises (1 USDT = 1 USDT)', /1 USDT = 1 USDT/.test(st));
// 2: refused -> failed, earnings restored
const bal = (t) => (/available to pay out ([\d.]+) · payout pending ([\d.]+)/.exec(t) || []).slice(1).join('/');
const before = bal(st);
st = await run('1', 'refused');
check('a refused transfer shows failed and available/pending are unchanged (earnings restored)', /failed/.test(st) && before !== '' && bal(st) === before, `${before} -> ${bal(st)}`);
// 3: ok -> completed
st = await run('1', 'ok');
check('a verified delivery shows completed and Delivered and verified', /completed/.test(st) && /Delivered and verified/.test(st));
check('every card is labelled SIMULATED, none REAL', /SIMULATED, no real funds/.test(st) && !/\bREAL\b/.test(st.replace(/real funds/g, '')));
await b.shot('payout-final');
console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
