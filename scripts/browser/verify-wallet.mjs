// Real-browser regression for the buyer wallet panel (SIMULATED server; the DEMO wallet stands in for an extension).
//   node scripts/browser/verify-wallet.mjs http://127.0.0.1:4402 <output dir>
import { launch } from './cdp.mjs';
const BASE = process.argv[2];
const OUT = process.argv[3];
const b = await launch(9383, OUT, 1100, 1700);
const res = [];
const check = (n, ok, d = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).replace(/\s+/g, ' ').slice(0, 190) : ''}`);
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(250); } return false; };

await b.goto(BASE + '/market.html#/buyer');
await b.click('#buyer button', 'Start testing');
await b.sleep(2500);
let t = await b.text('#fund');
check('no wallet is connected at first', /No funding wallet connected yet/.test(t));
check('it says connecting never gives access to funds', /never gives Payrail access to your funds/.test(t));
check('authorization check is not offered before a wallet exists', !/Check transaction authorization/.test(t));
await b.click('#fund button', 'Use a DEMO wallet');
check('demo wallet connects and is chain-bound', await until(async () => /Funding wallet verified: 0x[0-9a-fA-F]{40}/.test(await b.text('#fund')) && /chain 42220/.test(await b.text('#fund'))), (await b.text('#fund')).slice(0, 160));
await b.click('#fund button', 'Check transaction authorization');
check('authorization check verifies and states that nothing was sent', await until(async () => /Verified: this wallet can authorize/.test(await b.text('#fund')) && /Nothing was sent to Textile/.test(await b.text('#fund'))));
console.log(res.join('\n'));
console.log(res.every((r) => r.startsWith('PASS')) ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
await b.close?.();
process.exit(res.every((r) => r.startsWith('PASS')) ? 0 : 1);
