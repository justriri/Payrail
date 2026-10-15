// Real-browser check of quote, receipt, account summary, earnings page (headless Edge).
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9361, OUT, 1100, 1600);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).slice(0, 160) : ''}`);

await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(1500);
await b.ev(`(() => { const c=[...document.querySelectorAll('#cat-list .svc')].find(x=>x.innerText.includes('Demo token price')); c.querySelector('button').click(); })()`);
await b.sleep(1000);
let q = await b.text('#run-quote');
check('quote shows what the buyer pays', /You pay.*0\.02 TESTUSDT/s.test(q), q.split('\n').slice(0, 2).join(' | '));
check('quote shows the 3% fee and seller earnings before purchase', /Platform fee \(3%.*0\.0006/s.test(q) && /Seller earns\s+0\.0194/s.test(q));
check('quote lists the qualifying conditions incl. freshness', /Freshness.*60 seconds/.test(q) && /non-empty JSON object/.test(q) && /HTTP status must be 200/.test(q));
check('quote explains non-qualifying/unknown outcomes and that validation is not truth', /does not and cannot verify that the data is true/.test(q));

await b.click('#run-btn', 'Run');
await b.sleep(2000);
let r = await b.text('#run-result');
check('qualifying result explains the charge and shows a receipt', /Charged 0\.02 TESTUSDT/.test(r) && /Receipt/.test(r) && /Ledger entries: .*hold.*capture/.test(r) && /Qualified means the response matched/.test(r), r.split('\n').slice(0, 3).join(' | '));
check('receipt shows fee, seller earnings and settlement path', /Platform fee\s+0\.0006 TESTUSDT/.test(r) && /Seller earned\s+0\.0194/.test(r) && /Payrail ledger/.test(r));

await b.set('#run-input', '{"id":"eth","scenario":"stale"}');
await b.click('#run-btn', 'Run');
await b.sleep(2000);
r = await b.text('#run-result');
check('stale response is not charged and the reason is shown', /Not charged/.test(r) && /freshness/.test(r) && /Returned to you\s+0\.02/.test(r), r.split('\n').slice(0, 3).join(' | '));

await b.set('#run-input', '{"id":"eth","scenario":"hang"}');
await b.click('#run-btn', 'Run');
await b.sleep(4500);
r = await b.text('#run-result');
check('timeout is shown as unresolved: held, not charged', /Outcome unknown/.test(r) && /Held \(not charged\)\s+0\.02/.test(r) && /Charged\s+0 TESTUSDT/.test(r), r.split('\n').slice(0, 2).join(' | '));

// history and the statement live in the Transactions panel of the redesigned dashboard
await b.ev(`location.hash = '#/buyer/transactions'; 0`);
await b.sleep(1500);
const hist = await b.text('#history');
const stmt = await b.text('#statement');
check('history lists all three requests with plain outcomes', /charged 0\.02/.test(hist) && /not charged/.test(hist) && /outcome unknown, not charged/.test(hist));
check('account summary reconciles (granted 5, charged 0.02, held 0.02, available 4.96)', /Deposited \/ granted\s+5/.test(stmt) && /Charged for qualifying responses\s+0\.02/.test(stmt) && /Held \(outcome unknown\)\s+0\.02/.test(stmt) && /Available\s+4\.96/.test(stmt), stmt.replace(/\n+/g, ' | '));
// open a history row to load its receipt
await b.ev(`document.querySelector('#history details').open = true; 0`);
await b.sleep(900);
check('history rows open into full receipts', /Receipt\s/.test(await b.text('#history')));

// seller side: sandbox seller sells the buyer one request
await b.goto(BASE + '/market.html#/seller');
await b.click('#seller button', 'sandbox seller');
await b.sleep(1500);
const sellerToken = await b.ev(`localStorage.getItem('payrail.seller')`);
const buyerToken = await b.ev(`localStorage.getItem('payrail.buyer')`);
const seed = await b.ev(`localStorage.getItem('payrail.sandboxSeed')`);
const setup = await b.ev(`(async () => {
  const H = (t, post) => ({ authorization: 'Bearer ' + t, ...(post ? { 'content-type': 'application/json', 'x-payrail-token': document.querySelector('meta[name=payrail-token]').content } : {}) });
  const j = async (path, t, body) => (await fetch('/api/market' + path, { method: body ? 'POST' : 'GET', headers: H(t, !!body), body: body ? JSON.stringify(body) : undefined })).json();
  const c = await j('/seller/listings', ${JSON.stringify(sellerToken)}, { name: 'Billing check price API', description: 'for the earnings page', endpointUrl: 'https://bill-' + Math.random().toString(36).slice(2, 8) + '.sandbox.payrail.example/v1/price', method: 'GET', price: '0.1' });
  const id = c.listing.id;
  await j('/seller/listing/' + id + '/wallet-proof', ${JSON.stringify(sellerToken)}, { sandbox: true, seed: ${JSON.stringify(seed)} });
  await j('/seller/listing/' + id + '/domain-proof', ${JSON.stringify(sellerToken)}, { method: 'dns_txt' });
  const s = await j('/seller/listing/' + id + '/suggest-contract', ${JSON.stringify(sellerToken)}, { input: { id: 'eth' } });
  const p = await j('/seller/listing/' + id + '/contract', ${JSON.stringify(sellerToken)}, { contract: s.suggestion });
  await j('/seller/contract/' + p.contract.id + '/approve', ${JSON.stringify(sellerToken)}, {});
  const pub = await j('/seller/listing/' + id + '/publish', ${JSON.stringify(sellerToken)}, {});
  const e1 = await j('/execute', ${JSON.stringify(buyerToken)}, { listingId: id, input: { id: 'eth' }, idempotencyKey: 'billing-check-1-' + Date.now() });
  const e2 = await j('/execute', ${JSON.stringify(buyerToken)}, { listingId: id, input: { id: 'eth', scenario: 'stale' }, idempotencyKey: 'billing-check-2-' + Date.now() });
  return JSON.stringify([pub.ok, e1.result.state, e2.result.state]);
})()`);
check('setup: sandbox listing published and sold once, once refunded', setup === '["true","QUALIFIED","NOT_QUALIFIED"]' || /true.*QUALIFIED.*NOT_QUALIFIED/.test(String(setup)), setup);
await b.goto(BASE + '/market.html#/seller/earnings');
await b.sleep(2000);
const e = await b.text('#seller');
check('earnings page: gross, 3% fee, seller earnings, refunds, recent sale', /Gross sales[^\n]*\s+0\.1/.test(e) && /Platform fees \(3%\)\s+0\.003/.test(e) && /Your earnings\s+0\.097/.test(e) && /Returned to buyers[^\n]*\s+0\.1/.test(e) && /Billing check price API/.test(e), e.replace(/\n+/g, ' | ').slice(0, 400));
check('earnings page separates direct and escrow settlement and explains payouts', /Direct settlement \(Payrail ledger\)/.test(e) && /cannot be paid out/.test(e));
await b.shot('billing-earnings');
console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
