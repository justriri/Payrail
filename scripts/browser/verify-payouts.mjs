// Browser regression: a seller with real (fake-chain) earnings requests a payout in the app. The request reserves earnings; nothing is "paid"
// until a transfer from the payout wallet is seen on the (FAKE) chain. The web server sends nothing.   node scripts/browser/verify-payouts.mjs <out dir>
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';
import { TRANSFER_TOPIC } from '../../src/funding.ts';
import { approvePayout, markSent } from '../../src/payouts.ts';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false });
const { check, finish } = makeChecker();
const b = await launch(9395, OUT, 1366, 1200);
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
const DEP = '0x707AFF45f3c09C03973F6E0074Ab01C43cC7e0eA';
const pad = (a) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const go = async (hash, wait = 1200) => { await b.ev(`location.hash = ${JSON.stringify(hash)}; 0`); await b.sleep(wait); };
const overflow = () => b.ev('document.documentElement.scrollWidth - window.innerWidth');
const id = await h.publish('Payout API', '0.5', { description: 'earns' });
// two qualifying purchases by a funded buyer: the seller earns 2 x 0.485
const buyerKey = generatePrivateKey();
const buyer = await h.fundedBuyer(buyerKey, 1_000_000n);
for (let i = 0; i < 2; i++) {
  const r = await h.call('POST', '/execute', { bearer: buyer.token, body: { listingId: id, input: {}, idempotencyKey: `earn-${i}-${Date.now()}` } });
  if (!r.ok || !r.result.charged) throw new Error('could not create earnings: ' + JSON.stringify(r));
}
const wallet = await h.wire(b, h.sellerPk);
b.on('Runtime.exceptionThrown', (e) => console.log('EXC', JSON.stringify(e.exceptionDetails).slice(0, 500)));
const sellerAddr = h.sellerKey.address;

await b.goto(`${h.BASE}/market.html#/seller`, 2200);
await b.click('#seller button', 'Sign in with your wallet');
await until(async () => /My APIs/.test((await b.text('#seller')) || ''));
await go('#/seller/payout-settings', 1800);
await until(async () => (await b.ev(`!!document.querySelector('#payout-summary')`)));
const sum = (await b.text('#payout-summary')).replace(/\s+/g, ' ');
check('the seller sees earned, held, pending, available and paid out, computed by the server', /Earned 0\.97/.test(sum) && /Available to pay out 0\.97/.test(sum) && /Pending payouts 0/.test(sum) && /Paid out 0/.test(sum) && /Held \(outcome unknown\) 0/.test(sum), sum);
check('the 3% platform fee is shown as booked by Payrail and never paid to the seller', /0\.03 USDT was booked as the 3% platform fee/.test(await b.text('#payout-fee-note')), await b.text('#payout-fee-note'));
check('the destination is the seller\'s verified wallet', (await b.text('#payout-destination')).toLowerCase() === sellerAddr.toLowerCase(), await b.text('#payout-destination'));
check('how it works says an operator sends it and that it is paid only after on-chain verification', /operator/i.test(await b.text('#payout-how')) && /verified on-chain/.test(await b.text('#payout-how')), await b.text('#payout-how'));
check('the request button is disabled until the amount AND the confirmation are given', await b.ev(`document.querySelector('#payout-request').disabled`));
await b.set('#payout-amount', '0.3');
check('an amount alone does not enable it', await b.ev(`document.querySelector('#payout-request').disabled`));
await b.ev(`document.querySelector('#payout-confirm').click(); 0`);
await b.sleep(200);
check('amount + confirmation enable it', !(await b.ev(`document.querySelector('#payout-request').disabled`)));
await b.shot('payout-form');
await b.click('#payout-request', 'Request payout');
await until(async () => (await b.ev(`!!document.querySelector('#payout-history')`)));
await b.sleep(500);
const hist = (await b.text('#payout-history')).replace(/\s+/g, ' ');
check('the payout is listed as REQUESTED and NOT paid, with no transaction', /0\.3 USDT/.test(hist) && /Requested: waiting for operator approval/.test(hist) && /not sent yet/.test(hist) && !/Paid:/.test(hist), hist);
const row = h.db.prepare("SELECT id, state, destination, request_key FROM payouts").get();
check('server record: one requested payout to the verified wallet with an idempotency key', row.state === 'requested' && row.destination.toLowerCase() === sellerAddr.toLowerCase() && !!row.request_key && Number(h.db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n) === 1);
await go('#/seller/payout-settings', 1800);
await until(async () => (await b.ev(`!!document.querySelector('#payout-summary')`)));
const sum2 = (await b.text('#payout-summary')).replace(/\s+/g, ' ');
check('after the request: available 0.67, pending 0.3, still nothing paid out', /Available to pay out 0\.67/.test(sum2) && /Pending payouts 0\.3/.test(sum2) && /Paid out 0 /.test(sum2), sum2);

// a requested payout can be cancelled by the seller and returns to available
await b.click('#payout-history button', 'Cancel');
await until(async () => /Cancelled: returned/.test((await b.text('#payout-history')) || ''));
check('cancelling returns the reserved amount to available', /Cancelled: returned to your available balance/.test(await b.text('#payout-history')) && /Available to pay out 0\.97/.test((await b.text('#payout-summary')).replace(/\s+/g, ' ')));

// ---- request again, then play the operator: approve, send (hash recorded), and the FAKE chain shows the transfer
await b.set('#payout-amount', '0.4');
await b.ev(`document.querySelector('#payout-confirm').click(); 0`);
await b.click('#payout-request', 'Request payout');
await until(async () => (h.db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE state = 'requested'").get().n) > 0);
await b.sleep(700);
const p = h.db.prepare("SELECT id FROM payouts WHERE state = 'requested'").get();
approvePayout(h.db, p.id, 'operator');
const tx = `0x${(0xabc000 + 1).toString(16).padStart(64, '0')}`;
markSent(h.db, p.id, tx, 'operator');
await go('#/seller/payouts', 1800);
await until(async () => (await b.ev(`!!document.querySelector('#payout-history')`)));
const sent = (await b.text('#payout-history')).replace(/\s+/g, ' ');
check('SENT but not on-chain: shown as "NOT paid yet", the transaction link is there, and nothing is returned or paid', /Sent: waiting for on-chain confirmation \(NOT paid yet\)/.test(sent) && sent.includes(tx.slice(0, 12)) && !/Paid:/.test(sent), sent);
await b.shot('payout-sent');
h.receipts.set(tx, { status: 'success', blockNumber: 4_990n, logs: [{ address: USDT, topics: [TRANSFER_TOPIC, pad(DEP), pad(sellerAddr)], data: `0x${(400_000n).toString(16).padStart(64, '0')}`, logIndex: 1 }] });
await go('#/seller/payout-settings', 1800);
await until(async () => /Paid: confirmed on-chain/.test((await b.text('#payout-history')) || ''));
const done = (await b.text('#payout-history')).replace(/\s+/g, ' ');
check('once the chain shows the exact transfer the payout is Paid, exactly once', /Paid: confirmed on-chain/.test(done) && /Paid out 0\.4/.test((await b.text('#payout-summary')).replace(/\s+/g, ' ')) && /Pending payouts 0 /.test((await b.text('#payout-summary')).replace(/\s+/g, ' ')), done);
await b.shot('payout-paid');

// ---- mobile
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.sleep(500);
check('mobile: the payout page fits the screen', (await overflow()) <= 0, await overflow());
await b.shot('payout-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
