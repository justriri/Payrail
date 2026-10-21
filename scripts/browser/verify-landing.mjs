// Browser regression: the landing page's currency routes section can never silently disappear. Real server response (simulated Textile) plus
// controlled responses for every state: loading, success with Live / Temporarily unavailable / Unsupported, empty, not enabled, and errors.
//   node scripts/browser/verify-landing.mjs <output dir>
import { makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false, withConversion: true });
const { check, finish } = makeChecker();
const b = await launch(9396, OUT, 1366, 1000);
await b.send('Network.enable');
await b.send('Network.setCacheDisabled', { cacheDisabled: true });
const overflow = () => b.ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(150); } return false; };

// a page-load hook so the route request can be controlled per test (mode kept in sessionStorage; 'real' = untouched)
await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const real = window.fetch.bind(window);
  const FIX = { ok: true, enabled: true, checkedAt: '2026-10-21T12:00:00.000Z', officialList: { symbols: ['cNGN','USDC','wARS','wBRL','IDRX'], source: 'official-page' }, currencies: [
    { symbol: 'cNGN', status: 'live', statusLabel: 'Live', minSell: '1360', minUsdt: '0.998', reason: null, statusDetail: 'live' },
    { symbol: 'wBRL', status: 'live', statusLabel: 'Live', minSell: '5.03', minUsdt: '0.9995', reason: null, statusDetail: 'live' },
    { symbol: 'USDC', status: 'temporarily_unavailable', statusLabel: 'Temporarily unavailable', minSell: null, minUsdt: null, reason: 'Textile has no market makers online for USDC -> USDT right now.', statusDetail: '' },
    { symbol: 'USAT', status: 'unsupported', statusLabel: 'Unsupported', minSell: null, minUsdt: null, reason: 'not in the official Textile list', statusDetail: '' },
  ] };
  window.fetch = (u, i) => {
    const mode = sessionStorage.getItem('routes-mode') || 'real';
    if (String(u).includes('/api/market/buy/currencies') && mode !== 'real') {
      const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
      if (mode === 'fixture') return json(FIX);
      if (mode === 'empty') return json({ ok: true, enabled: true, currencies: [] });
      if (mode === 'disabled') return json({ ok: true, enabled: false, currencies: [], note: 'Paying with another currency is not enabled on this server. Only USDT on Celo can be used.' });
      if (mode === 'servererror') return json({ ok: true, enabled: true, error: 'The route status could not be read just now (Textile unreachable).', currencies: [] });
      if (mode === 'http500') return json({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' }, 500);
      if (mode === 'netfail') return Promise.reject(new TypeError('Failed to fetch'));
      if (mode === 'slow') return new Promise((res) => setTimeout(() => res(json(FIX)), 2500));
    }
    return real(u, i);
  };
})();` });

const mode = async (m) => { await b.goto(`${h.BASE}/`, 200); await b.ev(`sessionStorage.setItem('routes-mode', ${JSON.stringify(m)}); 0`); await b.goto(`${h.BASE}/`, 1500); };
const state = () => b.ev(`document.getElementById('asset-cards')?.dataset.state || ''`);
const cards = () => b.ev(`JSON.stringify([...document.querySelectorAll('#asset-cards [data-symbol]')].map(c => ({ sym: c.dataset.symbol, status: c.dataset.status || '', text: c.innerText.replace(/\\s+/g, ' ') })))`).then(JSON.parse);

// ---- the REAL server response (simulated Textile in this harness)
await mode('real');
await until(async () => (await state()) === 'ready');
let cs = await cards();
check('real response: the section is visible with every currency the server knows (nothing hidden)', (await state()) === 'ready' && ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX'].every((x) => cs.some((c) => c.sym === x)) && cs.some((c) => c.sym === 'USAT'), cs.map((c) => `${c.sym}:${c.status}`).join(' '));
check('real response: unsupported currencies (USAT, CELO, G$...) are shown as Unsupported with a reason; simulated routes are labelled Simulated, never Live', cs.filter((c) => ['USAT', 'wCOP', 'WETH', 'wMXN', 'CELO'].includes(c.sym)).every((c) => c.status === 'unsupported' && /Unsupported/.test(c.text)) && cs.filter((c) => ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX'].includes(c.sym)).every((c) => c.status === 'simulated' && /Simulated/.test(c.text)) && !cs.some((c) => c.status === 'live'), cs.map((c) => `${c.sym}:${c.status}`).join(' '));
check('real response: selectable routes show their smallest swap', cs.filter((c) => c.status === 'simulated').every((c) => /Smallest swap [\d.,]+ \S+/.test(c.text)), cs.find((c) => c.status === 'simulated')?.text);
check('real response: the page says it was checked live and names the official list', /Checked live at \d{4}-/.test(await b.text('#routes-meta')), await b.text('#routes-meta'));
await b.shot('landing-routes-real');

// ---- a response with every status: grouping, badges, min swap, reasons
await mode('fixture');
await until(async () => (await state()) === 'ready');
cs = await cards();
const groups = await b.ev(`JSON.stringify([...document.querySelectorAll('#asset-cards .routes-group')].map(g => g.dataset.group + ':' + g.textContent))`).then(JSON.parse);
check('success: Live, Temporarily unavailable and Unsupported are separate, labelled groups', groups.join('|') === 'live:Live (2)|temporarily_unavailable:Temporarily unavailable (1)|unsupported:Unsupported (1)', groups.join('|'));
check('success: Live cards show the minimum swap and USDT worth; temporary and unsupported cards show the reason instead', /Live/.test(cs.find((c) => c.sym === 'cNGN').text) && /Smallest swap 1360 cNGN \(about 0\.998 USDT\)/.test(cs.find((c) => c.sym === 'cNGN').text) && /no market makers online/.test(cs.find((c) => c.sym === 'USDC').text) && !/Smallest swap/.test(cs.find((c) => c.sym === 'USDC').text) && /not in the official Textile list/.test(cs.find((c) => c.sym === 'USAT').text));
check('success: a route is only Live when the server says Live (USDC stays Temporarily unavailable here)', cs.find((c) => c.sym === 'USDC').status === 'temporarily_unavailable' && cs.filter((c) => c.status === 'live').map((c) => c.sym).join() === 'cNGN,wBRL');
check('success: USDT is always shown as the settlement currency', cs.some((c) => c.sym === 'USDT' && /Settlement currency/.test(c.text)));
await b.shot('landing-routes-fixture');

// ---- the other states are explicit, never an empty hole
await mode('empty');
await until(async () => (await state()) === 'empty');
check('empty: says there is nothing to show and offers Retry; nothing is shown as supported', /No currencies to show/.test(await b.text('#routes-note')) && (await b.ev(`!!document.getElementById('routes-retry')`)) && (await cards()).every((c) => c.sym === 'USDT'));
await mode('disabled');
await until(async () => (await state()) === 'disabled');
check('not enabled: says other currencies are not switched on (with the server\'s own note) and shows only USDT', /not switched on/.test(await b.text('#routes-note')) && /Only USDT on Celo/.test(await b.text('#routes-note')) && (await cards()).every((c) => c.sym === 'USDT'));
for (const [m, re] of [['servererror', /could not be read just now/], ['http500', /answered 500/], ['netfail', /request failed/]]) {
  await mode(m);
  await until(async () => (await state()) === 'error');
  check(`error (${m}): a clear message and a Retry button, never silent, nothing shown as supported`, re.test(await b.text('#routes-note')) && (await b.ev(`!!document.getElementById('routes-retry')`)) && (await cards()).every((c) => c.sym === 'USDT'), await b.text('#routes-note'));
}
// Retry recovers
await b.ev(`sessionStorage.setItem('routes-mode', 'fixture'); document.getElementById('routes-retry').click(); 0`);
await until(async () => (await state()) === 'ready');
check('Retry reloads the status and the section recovers', (await state()) === 'ready' && (await cards()).some((c) => c.sym === 'cNGN' && c.status === 'live'));
await b.shot('landing-routes-error-recovered');

// ---- loading state is visible while the request is slow
await b.goto(`${h.BASE}/`, 200);
await b.ev(`sessionStorage.setItem('routes-mode', 'slow'); 0`);
await b.send('Page.navigate', { url: `${h.BASE}/` });
await b.sleep(900);
check('loading: a loading card is visible while the status is being read', /Loading each currency/.test((await b.text('#asset-loading')) || '') && (await state()) === 'loading', await state());
await until(async () => (await state()) === 'ready');
check('loading ends in the real answer', (await state()) === 'ready');

// ---- mobile
await b.ev(`sessionStorage.setItem('routes-mode', 'fixture'); 0`);
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.goto(`${h.BASE}/`, 1800);
await until(async () => (await state()) === 'ready');
const mc = await b.ev(`JSON.stringify([...document.querySelectorAll('#asset-cards .asset')].map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; }))`).then(JSON.parse);
check('mobile: the route cards stay inside the screen with no horizontal overflow', mc.length >= 5 && mc.every((c) => c.l >= 0 && c.r <= 390) && (await overflow()) <= 0, `${JSON.stringify(mc.slice(0, 3))} overflow=${await overflow()}`);
await b.shot('landing-routes-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
