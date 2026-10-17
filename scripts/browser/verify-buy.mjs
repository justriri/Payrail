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

// ================= a LONG receipt (long hashes, a very large API response with an unbroken token) stays inside its box
wallet.denyTyped = false;
const BIG = JSON.stringify({ token: 'A'.repeat(4000), url: `https://example.com/${'path/'.repeat(80)}${'x'.repeat(600)}`, posts: Array.from({ length: 400 }, (_, i) => ({ id: i, text: `post ${i} ${'lorem ipsum '.repeat(25)}`, hash: `0x${'ab'.repeat(32)}` })), END_MARKER: 'THE-VERY-LAST-FIELD' });
h.buyGateway.responseBody = BIG;
const checkReceiptFits = async (label) => {
  const m = await b.ev(`(() => {
    const box = document.querySelector('#run-result').getBoundingClientRect();
    const bad = [];
    for (const e of document.querySelectorAll('#run-result *')) {
      const r = e.getBoundingClientRect();
      if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) bad.push(e.tagName + '#' + (e.id || '') + ' ' + Math.round(r.right) + '>' + Math.round(box.right));
    }
    const pre = document.querySelector('#api-response');
    const rc = document.querySelector('#receipt').getBoundingClientRect();
    return JSON.stringify({ bad: bad.slice(0, 5), pageOverflow: document.documentElement.scrollWidth - window.innerWidth, preScrollsSideways: pre.scrollWidth > pre.clientWidth + 1, preH: Math.round(pre.getBoundingClientRect().height), vh: window.innerHeight, preFull: pre.textContent.includes('THE-VERY-LAST-FIELD') && pre.textContent.includes('A'.repeat(4000)), receiptRight: Math.round(rc.right), boxRight: Math.round(box.right), hasTx: document.querySelector('#receipt').innerText.includes('${'0x' + 'ab'.repeat(32)}'), sha: /Response SHA-256: [0-9a-f]{64}/.test(document.querySelector('#run-result').innerText.replace(/\s+/g, '')) || /[0-9a-f]{64}/.test(document.querySelector('#run-result').innerText.replace(/\s+/g, '')) });
  })()`).then(JSON.parse);
  check(`${label}: nothing in the receipt extends beyond its box and the page does not scroll sideways`, m.bad.length === 0 && m.pageOverflow <= 0 && m.receiptRight <= m.boxRight + 1, JSON.stringify(m));
  check(`${label}: the API response wraps (no sideways scrolling), is scrollable vertically within 70% of the screen, and holds the complete content`, !m.preScrollsSideways && m.preH <= m.vh * 0.7 + 2 && m.preFull, JSON.stringify(m));
  check(`${label}: the transaction hash and the response SHA-256 are still shown in full`, m.hasTx && m.sha, JSON.stringify(m));
};
await viewport(1366, 900, false);
await b.goto(`${h.BASE}/api.html?src=buy&id=instagram.profile`, 2000);
await b.set('#run-input', '{"username":"celo"}');
await b.click('#quote-btn', 'Get the exact price');
await until(async () => (await b.ev(`!!document.querySelector('#sign-btn')`)));
await b.click('#sign-btn', 'Sign and pay');
await until(async () => (await b.ev(`!!document.querySelector('#run-headline')`)), 30000);
check('the large purchase was paid and verified as before (status, one more paid request)', /settled and verified on-chain/.test(await b.text('#run-result')) && h.buyGateway.paidRequests === 2, String(h.buyGateway.paidRequests));
await checkReceiptFits('desktop');
await b.shot('buy-receipt-long-desktop');
for (const [w, hh] of [[1100, 800], [900, 800], [768, 900]]) {
  await viewport(w, hh, false);
  await b.sleep(400);
  await checkReceiptFits(`${w}px wide`);
}
await viewport(390, 844, true);
await b.sleep(400);
await checkReceiptFits('mobile');
await b.shot('buy-receipt-long-mobile');
h.buyGateway.responseBody = undefined;
await viewport(1366, 900, false);

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
