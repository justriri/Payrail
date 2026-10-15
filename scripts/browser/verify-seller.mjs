// Real-browser regression for the seller dashboard (needs Microsoft Edge). Usage: node scripts/browser/verify-seller.mjs http://127.0.0.1:4402 <output dir>
// Real-browser regression for the seller dashboard fixes (headless Edge via CDP).
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9351, OUT, 1100, 1500);
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const bar = () => b.ev(`document.getElementById('seller-status').hidden ? '' : document.getElementById('seller-status').innerText`);
const seller = () => b.text('#seller');
const vals = () => b.ev(`JSON.stringify([...document.querySelectorAll('#seller .editor input, #seller > div input, #seller input')].map(i=>i.value))`);

await b.goto(BASE + '/market.html#/seller');
// ---- sign in (sandbox) — returns the same seller across restarts
await b.click('#seller button', 'sandbox seller');
await b.sleep(1500);
let t = await seller();
check('My APIs is the default seller page', /My APIs/.test(t) && /\d+ APIs? · \d+ published/.test(t), t.split('\n').filter((l) => /My APIs|Published|private/i.test(l)).slice(0, 4).join(' | '));
check('private vs public is explained', /private management view/.test(t));

// ---- new listing form keeps its values across navigation and across actions on other listings
await b.click('#seller a', 'New listing');
await b.sleep(600);
await b.click('#seller button', 'Echo API');
await b.sleep(400);
await b.set('#seller input[placeholder="What does it return?"]', 'typed by hand');
const urlBefore = await b.ev(`document.querySelector('#seller input[type=url]').value`);
await b.click('#seller a', 'My APIs');
await b.sleep(700);
// perform an action on an existing listing (open it, run a test)
await b.click('#seller a', 'Manage');
await b.sleep(900);
await b.click('#seller button', 'Run test');
await b.sleep(1500);
await b.click('#seller a', 'New listing');
await b.sleep(700);
const urlAfter = await b.ev(`document.querySelector('#seller input[type=url]').value`);
const descAfter = await b.ev(`document.querySelector('#seller input[placeholder="What does it return?"]').value`);
check('unsubmitted form survives navigation and an action on another listing', urlBefore !== '' && urlAfter === urlBefore && descAfter === 'typed by hand', `${urlBefore} -> ${urlAfter}; desc=${descAfter}`);
// ... and a page reload
await b.send('Page.reload'); await b.sleep(2500);
const urlReload = await b.ev(`document.querySelector('#seller input[type=url]')?.value`);
check('unsubmitted form survives a page reload', urlReload === urlBefore, urlReload);

// ---- a failing submit keeps the form and says why
await b.set('#seller input[placeholder="e.g. 0.02"]', 'not-a-number');
await b.click('#seller button', 'Submit listing');
await b.sleep(1200);
const failBar = await bar();
const afterFailUrl = await b.ev(`document.querySelector('#seller input[type=url]')?.value`);
check('failed submit shows an error and keeps every entry', /Could not submit/.test(failBar) && afterFailUrl === urlBefore, failBar);

// ---- successful submit: appears in My APIs immediately, with its details
await b.set('#seller input[placeholder="e.g. 0.02"]', '0.02');
await b.set('#seller input[placeholder="e.g. Token price API"]', 'Browser flow echo API');
await b.click('#seller button', 'Submit listing');
await b.sleep(1800);
t = await seller();
check('after submit the seller lands on the listing editor with the saved details', /Browser flow echo API/.test(t) && /Listing details/.test(t), (await bar()));
await b.click('#seller a', 'My APIs');
await b.sleep(900);
t = await seller();
check('new listing is in My APIs immediately as Draft and private', /Browser flow echo API/.test(t) && /Draft/.test(t) && /Private: only you can see it/.test(t));

// ---- publish is blocked with reasons until requirements are met
await b.ev(`(() => { const c=[...document.querySelectorAll('#seller .svc')].find(x=>x.innerText.includes('Browser flow echo API')); c.querySelector('a.btn').click(); })()`);
await b.sleep(900);
t = await seller();
check('before ownership proofs the editor says what is missing (no silent dead button)', /Credentials, testing, contracts and publishing unlock after both ownership proofs/.test(t));
await b.click('#seller button', 'Sign (sandbox wallet)');
await b.sleep(1200);
await b.click('#seller button', 'Check file');
await b.sleep(1500);
t = await seller();
check('verification updates the status from persisted state', /Verified: needs a response contract/.test(t), await bar());
check('publish is disabled and lists the missing contract', /Not ready to publish yet/.test(t) && /No response contract is approved/.test(t) && (await b.ev(`[...document.querySelectorAll('#seller button')].find(x=>x.textContent==='Publish').disabled`)) === true);

// ---- test, contract, approve, publish
await b.click('#seller button', 'Run test');
await b.sleep(1500);
check('test result is shown and kept', /RESPONDED 200/.test(await seller()));
await b.click('#seller button', 'Suggest a contract');
await b.sleep(1800);
check('suggested contract is shown inline (no popup)', /Suggested contract/.test(await seller()));
await b.click('#seller button', 'Propose this contract');
await b.sleep(1500);
await b.click('#seller button', 'Approve');
await b.sleep(1500);
t = await seller();
check('after approving, the listing shows "Contract approved: ready to publish" and keeps its details', /Contract approved: ready to publish/.test(t) && /Browser flow echo API/.test(t) && /All requirements are met/.test(t), (await bar()));
const inputsAfterApprove = await b.ev(`JSON.stringify([...document.querySelectorAll('#seller .editor input')].map(i=>i.value).slice(0,3))`);
check('details inputs still hold the saved values after approving', /Browser flow echo API/.test(inputsAfterApprove) && /0\.02/.test(inputsAfterApprove), inputsAfterApprove);
await b.click('#seller button', 'Publish');
await b.sleep(1800);
const pubBar = await bar();
t = await seller();
check('publish shows a confirmation in the status bar and updates the status', /Published at/.test(pubBar) && /Published/.test(t) && /Public: buyers can find and run it/.test(t), pubBar);

// ---- appears in My APIs and in the buyer marketplace (no reload)
await b.click('#seller a', 'My APIs');
await b.sleep(900);
t = await seller();
check('My APIs shows it as Published and public', /Browser flow echo API/.test(t) && /Public: buyers can find/.test(t));
await b.ev(`document.getElementById('tab-buyer').click(); 0`);
await b.sleep(1500);
const cat = await b.text('#cat-list');
check('the published API appears in the public Buyer catalog', /Browser flow echo API/.test(cat) && /SANDBOX/.test(cat));

// ---- reload keeps everything
await b.send('Page.reload'); await b.sleep(2500);
const barAfterReload = await bar();
t = await seller();
check('after a TRUE page reload My APIs still shows the listing as Published (status bar cleared, data from the database)', /Browser flow echo API/.test(t) && /Public: buyers can find/.test(t) && barAfterReload === '', 'bar=' + JSON.stringify(barAfterReload));
await b.shot('seller-final');
console.log(results.join('\n'));
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
