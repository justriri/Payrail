// Real-browser regression for marketplace funding (SIMULATED conversion). Needs Microsoft Edge.
//   node scripts/browser/verify-funding.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9371, OUT, 1100, 1700);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 170) : ''}`);
const prep = (scenario) => b.ev(`(() => { const sel=document.querySelectorAll('#fund select'); sel[0].value='cNGN'; sel[0].dispatchEvent(new Event('change',{bubbles:true})); document.querySelectorAll('#fund input')[0].value='1364'; document.querySelectorAll('#fund select')[1].value=${JSON.stringify(scenario)}; return 0; })()`);
const fundText = () => b.text('#fund');
const avail = async () => {
  const t = await b.text('#buyer');
  return (/([\d.]+) TESTUSDT available/.exec(t) || [])[1];
};

await b.goto(BASE + '/market.html#/buyer');
check('before a buyer exists the funding card asks to start testing first', /Start testing first/.test(await fundText()));
await b.click('#buyer button', 'Start testing');
await b.sleep(2500);
let t = await fundText();
await b.ev(`(() => { const s=document.querySelector('#fund select'); s.value='cNGN'; s.dispatchEvent(new Event('change',{bubbles:true})); const a=[...document.querySelectorAll('#fund input')][0]; a.value='1364'; return 0; })()`);
t = await fundText();
check('funding card is labelled SIMULATED, with limits and a plain flow', /SIMULATED conversion/.test(t) && /Allowed per operation: 1364 to 95480000 cNGN/.test(t) && /nothing is converted yet/.test(t), t.split('\n').slice(0, 3).join(' | '));
check('simulated funds are badged as test, not real USDT', /SIMULATED \/ TEST/.test(t) && !/REAL USDT/.test(t));
const start = await avail();

// quote: nothing converted, buyer must approve
await b.click('#fund button', 'Get a quote');
await b.sleep(1500);
t = await fundText();
check('quote summary shows amount, rate, fee, estimate, minimum and the credited asset', /You convert\s+1364 cNGN/.test(t) && /1 USDT = 1364 cNGN/.test(t) && /Conversion fee[^\n]*4\.092 cNGN/.test(t) && /Estimated USDT received\s+0\.99/.test(t) && /Guaranteed minimum/.test(t) && /TESTUSDT/.test(t), t.split('\n').slice(4, 14).join(' | '));
check('nothing converted yet: balance unchanged and an explicit Approve button is required', (await avail()) === start && /Quote ready: nothing has been converted/.test(t) && /Approve and convert 1364 cNGN/.test(t));
// a reload must not convert anything and keeps the pending quote
await b.send('Page.reload'); await b.sleep(2500);
t = await fundText();
check('after a page reload the quote is still pending and still not converted', /Approve and convert/.test(t) && (await avail()) === start);

// approve -> credited
await b.click('#fund button', 'Approve and convert');
await b.sleep(2500);
t = await fundText();
const after = await avail();
check('approval converts, verifies and credits the verified amount', /Credited to your balance/.test(t) && /Verified received: 0\.99/.test(t) && after !== start, `${start} -> ${after}`);
check('history shows the credited operation as SIMULATED', /CREDITED/.test(t) && /SIMULATED/.test(t) && /credited 0\.99/.test(t));
await b.click('#fund button', 'Done');
await b.sleep(800);

// failure: reverted -> nothing credited
await prep('reverted');
await b.click('#fund button', 'Get a quote');
await b.sleep(1200);
await b.click('#fund button', 'Approve and convert');
await b.sleep(2500);
t = await fundText();
check('a reverted conversion is shown as failed and credits nothing', /Failed: nothing was credited/.test(t) && (await avail()) === after, t.split('\n').filter((l) => /Failed|REVERTED/.test(l)).slice(0, 2).join(' | '));
await b.click('#fund button', 'Done');
await b.sleep(800);

// wrong token -> needs review, nothing credited
await prep('wrong_token');
await b.click('#fund button', 'Get a quote');
await b.sleep(1200);
await b.click('#fund button', 'Approve and convert');
await b.sleep(2500);
t = await fundText();
check('a wrong-token delivery is not credited and needs review', /Needs review: nothing was credited/.test(t) && (await avail()) === after);
await b.click('#fund button', 'Done');
await b.sleep(800);

// delayed confirmation: not spendable until verified, then credited after re-checks
await prep('slow');
await b.click('#fund button', 'Get a quote');
await b.sleep(1200);
await b.click('#fund button', 'Approve and convert');
await b.sleep(1500);
t = await fundText();
check('delayed confirmation: shown as verifying and NOT spendable', /Verifying on-chain: not spendable yet/.test(t) && /NOT spendable yet/.test(t) && (await avail()) === after);
await b.click('#fund button', 'Check status now');
await b.sleep(1000);
await b.click('#fund button', 'Check status now');
await b.sleep(1500);
t = await fundText();
check('after enough confirmations the balance is credited once', /Credited to your balance/.test(t) && (await avail()) !== after, `${after} -> ${await avail()}`);
const credited2 = await avail();
await b.click('#fund button', 'Done');
await b.sleep(800);

// expired quote cannot be approved is covered by tests; here: spend the funded balance
await b.ev(`(() => { const c=[...document.querySelectorAll('#cat-list .svc')].find(x=>x.innerText.includes('Demo token price')); c.querySelector('button').click(); })()`);
await b.sleep(900);
await b.click('#run-btn', 'Run');
await b.sleep(2000);
const spent = await avail();
check('a funded balance buys an API response through the normal billing (one deduction of 0.02)', /Charged 0\.02/.test(await b.text('#run-result')) && Number(spent) === Number((Number(credited2) - 0.02).toFixed(6)), `${credited2} -> ${spent}`);
await b.shot('funding-final');
console.log(res.join('\n'));
console.log(res.some((x) => x.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
b.close();
process.exit(0);
