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
  const live = (symbol, extra = {}) => ({ symbol, status: 'live', statusLabel: 'Live', reason: null, statusDetail: 'live', thinLiquidity: false, liquidityNote: null, ...extra });
  const OFFICIAL = ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX'];
  const LANDING = [live('cNGN'), live('wARS'), live('wBRL'), live('USDC', { thinLiquidity: true, liquidityNote: 'Thin liquidity: only about 1.12 USDT can be converted at once right now, so a large amount may not fill.' }), live('IDRX')];
  const NOT_OFFICIAL = ['USAT', 'wCOP', 'WETH', 'wMXN', 'CELO', 'G$'].map((symbol) => ({ symbol, status: 'unsupported', statusLabel: 'Unsupported', reason: 'not in the official Textile list', statusDetail: '' }));
  const FIX = { ok: true, enabled: true, checkedAt: '2026-10-21T12:00:00.000Z', officialList: { symbols: OFFICIAL, source: 'official-page' }, landing: LANDING, currencies: [...LANDING, ...NOT_OFFICIAL] };
  const FIX_DOWN = { ...FIX, landing: LANDING.map((c) => (c.symbol === 'USDC' ? { ...c, status: 'temporarily_unavailable', statusLabel: 'Temporarily unavailable', reason: 'Textile has no market makers online for USDC -> USDT right now.', thinLiquidity: false } : c)) };
  window.fetch = (u, i) => {
    const mode = sessionStorage.getItem('routes-mode') || 'real';
    if (String(u).includes('/api/market/buy/currencies') && mode !== 'real') {
      const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
      if (mode === 'fixture') return json(FIX);
      if (mode === 'usdcdown') return json(FIX_DOWN);
      if (mode === 'legacy') { const { landing, ...old } = FIX; return json(old); }
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
const FIVE = ['cNGN', 'wARS', 'wBRL', 'USDC', 'IDRX'];
const NOT_FIVE = ['USAT', 'wCOP', 'WETH', 'wMXN', 'CELO', 'G$'];
check('real response: exactly the five official currencies are shown (plus the USDT settlement card)', cs.filter((c) => c.sym !== 'USDT').map((c) => c.sym).sort().join() === [...FIVE].sort().join(), cs.map((c) => `${c.sym}:${c.status}`).join(' '));
check('real response: no unsupported currency appears in the section', !cs.some((c) => NOT_FIVE.includes(c.sym)) && !(await b.ev(`!!document.querySelector('#asset-cards .routes-group')`)), cs.map((c) => c.sym).join(' '));
check('real response: each of the five shows its status (SIMULATED here because this harness runs a simulated Textile; LIVE in production)', FIVE.every((x) => new RegExp(`^${x} SIMULATED`).test(cs.find((c) => c.sym === x).text)), cs.map((c) => c.text).join(' | '));
check('real response: the page says it was checked live', /Textile's official Celo corridors, checked live at \d{4}-/.test(await b.text('#routes-meta')), await b.text('#routes-meta'));
await b.shot('landing-routes-real');

// ---- success with the production labels: LIVE under each of the five, USDC marked thin, nothing else
await mode('fixture');
await until(async () => (await state()) === 'ready');
cs = await cards();
check('success: the five currencies are shown and nothing else (no unsupported currency, no group headings)', cs.filter((c) => c.sym !== 'USDT').map((c) => c.sym).join() === FIVE.join() && !cs.some((c) => NOT_FIVE.includes(c.sym)) && !(await b.ev(`!!document.querySelector('#asset-cards .routes-group')`)), cs.map((c) => c.sym).join(' '));
check('success: LIVE is shown underneath each of the five', FIVE.every((x) => /^\S+ LIVE/.test(cs.find((c) => c.sym === x).text) && cs.find((c) => c.sym === x).status === 'live'), cs.map((c) => c.text).join(' | '));
check('success: USDC is still LIVE and is clearly marked as thin liquidity; the others carry no such note', /^USDC LIVE Thin liquidity: only about 1\.12 USDT/.test(cs.find((c) => c.sym === 'USDC').text) && FIVE.filter((x) => x !== 'USDC').every((x) => cs.find((c) => c.sym === x).text === `${x} LIVE`), cs.find((c) => c.sym === 'USDC').text);
check('success: USDT is shown as the settlement currency', cs.some((c) => c.sym === 'USDT' && /Settlement currency/.test(c.text)));
const vis = await b.ev(`(() => { const s = document.getElementById('currencies'); const r = s.getBoundingClientRect(); const cards = [...s.querySelectorAll('.asset')].map((c) => c.getBoundingClientRect()); return JSON.stringify({ sectionVisible: r.height > 100 && getComputedStyle(s).display !== 'none', cardsVisible: cards.every((c) => c.width > 100 && c.height > 30), live: getComputedStyle(s.querySelector('.badge-line.live')).backgroundColor }); })()`).then(JSON.parse);
check('success: the section is visible and styled (LIVE badge has its green background)', vis.sectionVisible && vis.cardsVisible && vis.live !== 'rgba(0, 0, 0, 0)' && vis.live !== 'rgb(238, 242, 246)', JSON.stringify(vis));
await b.shot('landing-routes-fixture');

// ---- honesty: a currency that is NOT live right now is never labelled LIVE
await mode('usdcdown');
await until(async () => (await state()) === 'ready');
cs = await cards();
check('honest: when USDC has no market makers it says so (TEMPORARILY UNAVAILABLE with the reason), the other four stay LIVE', /^USDC TEMPORARILY UNAVAILABLE/.test(cs.find((c) => c.sym === 'USDC').text) && !/LIVE/.test(cs.find((c) => c.sym === 'USDC').text) && /no market makers/.test(cs.find((c) => c.sym === 'USDC').text) && ['cNGN', 'wARS', 'wBRL', 'IDRX'].every((x) => /LIVE/.test(cs.find((c) => c.sym === x).text)), cs.find((c) => c.sym === 'USDC').text);

// ---- an older server that sends no `landing` list: the page still shows only the official five
await mode('legacy');
await until(async () => (await state()) === 'ready');
cs = await cards();
check('fallback: without a landing list the page filters to the official five itself; unsupported currencies stay out', cs.filter((c) => c.sym !== 'USDT').map((c) => c.sym).sort().join() === [...FIVE].sort().join() && !cs.some((c) => NOT_FIVE.includes(c.sym)), cs.map((c) => c.sym).join(' '));

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
