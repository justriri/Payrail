// Browser regression: a seller creates, verifies, tests and publishes a REAL-USDT API through the dashboard, using a wallet.
// REAL-FUNDS mode against a FAKE chain and a fake seller API (see harness.mjs).   node scripts/browser/verify-seller.mjs <output dir>
import { generatePrivateKey } from 'viem/accounts';
import { DEMO_WORDS, SELLER_SECRET, makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness();
const { check, finish } = makeChecker();
const b = await launch(9351, OUT, 1366, 1500);
await h.wire(b, generatePrivateKey());

const bar = () => b.ev(`document.getElementById('seller-status').hidden ? '' : document.getElementById('seller-status').innerText`);
const seller = () => b.text('#seller');
const until = async (fn, ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const field = (placeholder) => `#seller input[placeholder=${JSON.stringify(placeholder)}]`;
const URL_OK = 'https://api.myquotes.example/v1/quote';

await b.goto(`${h.BASE}/market.html#/seller`, 2200);
check('signed-out seller: the only way in is a wallet signature (no sandbox seller, no presets)', (await b.ev(`!!document.querySelector('#seller-signin')`)) && !DEMO_WORDS.test(await b.text('body')));
await b.click('#seller button', 'Sign in with your wallet');
await until(async () => /My APIs/.test((await seller()) || ''));
let t = await seller();
check('after the wallet signature, My APIs is the default page and says it is private', /My APIs/.test(t) && /\d+ APIs? · \d+ published/.test(t) && /private management view/.test(t) && /REAL USDT/.test(t), t.split('\n').slice(0, 4).join(' | '));

// ---- the form keeps its values across navigation and reload; a failed submit keeps every entry
await b.click('#seller a', 'New listing');
await b.sleep(700);
await b.set(field('e.g. Token price API'), 'My Quote API');
await b.set(field('What does it return?'), 'typed by hand');
await b.set('#seller input[type=url]', URL_OK);
await b.click('#seller a', 'My APIs');
await b.sleep(600);
await b.click('#seller a', 'New listing');
await b.sleep(700);
check('unsubmitted form survives navigation', (await b.ev(`document.querySelector('#seller input[type=url]').value`)) === URL_OK && (await b.ev(`document.querySelector('#seller input[placeholder="What does it return?"]').value`)) === 'typed by hand');
await b.send('Page.reload');
await b.sleep(2600);
check('unsubmitted form survives a page reload', (await b.ev(`document.querySelector('#seller input[type=url]')?.value`)) === URL_OK);
await b.set(field('e.g. 0.02'), 'not-a-number');
await b.click('#seller button', 'Submit listing');
await b.sleep(1300);
check('a failed submit shows the reason and keeps every entry', /Could not submit/.test(await bar()) && (await b.ev(`document.querySelector('#seller input[type=url]')?.value`)) === URL_OK, await bar());

// ---- a sandbox endpoint cannot be listed as a real service
await b.set('#seller input[type=url]', 'https://my-abc123.sandbox.payrail.example/v1/price');
await b.set(field('e.g. 0.02'), '0.02');
await b.click('#seller button', 'Submit listing');
await b.sleep(1300);
check('a sandbox endpoint is refused: only real, public APIs can be listed', /real, public https API|sandbox endpoints cannot be listed|NOT_A_REAL_ENDPOINT/.test(await bar()), await bar());

// ---- a real endpoint: submit
await b.set('#seller input[type=url]', URL_OK);
await b.click('#seller button', 'Submit listing');
await b.sleep(2000);
t = await seller();
check('after submit the seller lands on the editor with the saved details; the listing is a private Draft in USDT', /My Quote API/.test(t) && /Listing details/.test(t) && /Draft/.test(t) && !/USDT.*TEST/.test(t), await bar());
check('before ownership proofs the editor says what is missing and Publish is not offered', /Credentials, testing, contracts and publishing unlock after both ownership proofs/.test(t));

// ---- ownership proofs: wallet signature + DNS TXT (the harness plays DNS)
await b.click('#seller button', 'Sign with wallet');
await until(async () => /Wallet proof: done/.test((await seller()) || ''));
t = await seller();
check('wallet proof is recorded from a real signature', /Wallet proof: done/.test(t), t.split('\n').filter((l) => /Wallet proof/.test(l)).join(' | '));
const dns = await b.ev(`document.querySelector('#seller pre')?.textContent`);
const m = /DNS TXT\s+(\S+)\s*\n\s*=\s*(\S+)/.exec(dns || '');
check('the page shows the DNS record and well-known file the seller must publish', !!m && /payrail/.test(dns), dns);
await b.click('#seller button', 'Check DNS');
await b.sleep(1300);
check('the domain proof FAILS while the record is not published (nothing is verified on trust)', /Domain proof: not done/.test(await seller()) && /DOMAIN_PROOF_FAILED|could not read|does not contain/.test(await bar()), await bar());
h.txt.set(m[1], m[2]);
await b.click('#seller button', 'Check DNS');
await until(async () => /Domain proof: done/.test((await seller()) || ''));
check('after the record is published the domain proof succeeds', /Domain proof: done \(DNS record\)/.test(await seller()), await bar());
await b.shot('seller-verified');

// ---- credential (write-only), test, contract, publish
await b.set('#seller input[placeholder="Header name, e.g. Authorization"]', 'X-Api-Key');
await b.set('#seller input[type=password]', SELLER_SECRET);
await b.click('#seller button', 'Save credential');
await until(async () => /X-Api-Key v1/.test((await seller()) || ''));
t = await seller();
check('the credential is stored encrypted and its value is never shown again', /X-Api-Key v1/.test(t) && !t.includes(SELLER_SECRET) && (await b.ev(`document.querySelector('#seller input[type=password]').value`)) === '');
await b.click('#seller button', 'Run test');
await until(async () => /RESPONDED/.test((await seller()) || ''));
check('the endpoint test calls the real (fake-network) API and no buyer is charged', /RESPONDED/.test(await seller()) && Number(h.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n) === 0, (await seller()).split('\n').filter((l) => /RESPONDED/.test(l)).join(' | '));
await b.click('#seller button', 'Suggest a contract from a sample call');
await until(async () => /Suggested contract/.test((await seller()) || ''));
await b.click('#seller button', 'Propose this contract');
await until(async () => /proposed/.test((await seller()) || ''));
check('Publish is still blocked until the contract is approved', await b.ev(`(() => { const p=[...document.querySelectorAll('#seller button')].find(x => x.textContent === 'Publish'); return !!p && p.disabled; })()`) && /Not ready to publish yet/.test(await seller()));
await b.click('#seller button', 'Approve');
await until(async () => /All requirements are met/.test((await seller()) || ''));
check('after approving, the listing shows it is ready to publish and keeps its details', /All requirements are met/.test(await seller()) && (await b.ev(`document.querySelector('#seller details input')?.value`)) === 'My Quote API');
check('the listing is still private before publishing (buyers cannot find it)', !(await h.call('GET', '/catalog')).items.some((i) => i.title === 'My Quote API'));
await b.click('#seller button', 'Publish');
await until(async () => /Published/.test((await bar()) || ''));
check('publish confirms in the status bar and the status updates', /Published at/.test(await bar()) && /Published/.test(await seller()), await bar());
const cat = (await h.call('GET', '/catalog')).items.find((i) => i.title === 'My Quote API');
check('the published API is in the public catalogue priced in real USDT with its seller', cat && cat.pricing.asset === 'USDT' && cat.pricing.usd === '0.02' && cat.available && /0x/.test(cat.seller), JSON.stringify(cat && { p: cat.pricing, s: cat.seller }));
await b.send('Page.reload');
await b.sleep(2600);
await b.click('#seller a', 'My APIs');
await b.sleep(1200);
check('after a real page reload My APIs still shows it as Published (data comes from the database)', /Published/.test(await seller()) && /My Quote API/.test(await seller()));
check('the whole seller flow never showed demo, sandbox or test-credit language', !DEMO_WORDS.test(await b.text('body')), (((await b.text('body')).match(DEMO_WORDS)) || [])[0]);

// ---- the published API is purchasable only through the real payment path
const sold = await h.call('POST', '/execute', { bearer: (await h.fundedBuyer(generatePrivateKey(), 100_000n)).token, body: { listingId: cat.id, input: {}, idempotencyKey: 'seller-flow-sale-1' } });
check('a funded buyer can buy it; the seller earns price minus the 3% fee', sold.ok && sold.result.charged === true && (await h.call('GET', '/me', { bearer: h.sellerToken })).ok, JSON.stringify(sold.result && { charged: sold.result.charged, asset: sold.result.asset }));

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
