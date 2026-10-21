// Landing page: state the real network and token this server uses (read from the server, never assumed).
(async () => {
  try {
    const env = await (await fetch('/api/environment')).json();
    const r = await fetch('/api/market/config');
    const d = await r.json();
    const note = document.getElementById('mode-note');
    if (!note) return;
    if (env.environment === 'development') {
      document.title = '[DEV] Payrail';
      note.textContent = 'DEVELOPMENT ENVIRONMENT: test credits and simulated services. Nothing here is real money or a real transaction.';
    } else if (d.ok && d.realFunds && d.network) {
      note.textContent = `Real funds: ${d.network.token.symbol} on ${d.network.name} (chain ${d.network.chainId}), paid from your own wallet. Every deposit is verified on-chain before it is credited; the platform fee is ${d.network.platformFeePercent}%.`;
    } else {
      note.textContent = 'The API marketplace is not enabled on this server right now.';
    }
  } catch { /* the static text stays */ }
})();

// Landing page: the currency routes come from the server (GET /api/market/buy/currencies, the same data the checkout uses), never from fixed text.
// Every outcome is visible: loading, success, empty, "not enabled", and an error with a Retry button. The section is never silently empty.
(() => {
  const box = document.getElementById('asset-cards');
  const meta = document.getElementById('routes-meta');
  if (!box) return;
  const txt = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
  const card = (sym, status, ...lines) => {
    const d = document.createElement('div');
    d.className = 'asset';
    if (sym) d.dataset.symbol = sym;
    if (status) d.dataset.status = status;
    d.append(txt('b', '', sym || ''));
    for (const l of lines) if (l) d.append(l);
    return d;
  };
  const note = (state, title, text, retry) => {
    box.dataset.state = state;
    box.replaceChildren(card('USDT', 'settlement', txt('small', '', 'Settlement currency: Buy is paid in USDT on Celo')));
    const n = document.createElement('div');
    n.className = `asset routes-note ${state}`;
    n.id = 'routes-note';
    n.append(txt('b', '', title), txt('small', '', text));
    if (retry) { const b = txt('button', 'secondary', 'Retry'); b.type = 'button'; b.id = 'routes-retry'; b.addEventListener('click', () => load()); n.append(b); }
    box.append(n);
    if (meta) meta.textContent = '';
  };
  const BADGE = { live: 'Live', simulated: 'Simulated', temporarily_unavailable: 'Temporarily unavailable', unsupported: 'Unsupported' };
  const ORDER = ['live', 'simulated', 'temporarily_unavailable', 'unsupported'];
  const GROUP_TITLE = { live: 'Live', simulated: 'Simulated (development)', temporarily_unavailable: 'Temporarily unavailable', unsupported: 'Unsupported' };
  const short = (t) => (String(t || '').length > 170 ? `${String(t).slice(0, 167)}...` : String(t || ''));

  function render(d) {
    box.dataset.state = 'ready';
    box.replaceChildren(card('USDT', 'settlement', txt('small', '', 'Settlement currency: Buy is paid in USDT on Celo')));
    // ONLY the currencies on Textile's official Celo list, in its order (the server decides which; if an older server sends no such list, filter here)
    const official = d.officialList && Array.isArray(d.officialList.symbols) ? d.officialList.symbols : null;
    const list = Array.isArray(d.landing) ? d.landing : d.currencies.filter((c) => !official || official.includes(c.symbol));
    for (const c of list) {
      const live = c.status === 'live' || c.status === 'simulated';
      const lines = [txt('small', `badge-line ${c.status}`, live ? (c.status === 'live' ? 'LIVE' : 'SIMULATED') : String(c.statusLabel || c.status).toUpperCase())];
      if (live && c.thinLiquidity) lines.push(txt('small', 'thin-note', c.liquidityNote || 'Thin liquidity: a large amount may not fill.'));
      if (!live) lines.push(txt('small', 'reason', short(c.reason || c.statusDetail)));
      box.append(card(c.symbol, c.status, ...lines));
    }
    if (meta) {
      const when = d.checkedAt ? String(d.checkedAt).replace('T', ' ').slice(0, 19) : '';
      meta.textContent = `Textile's official Celo corridors, checked live${when ? ` at ${when} UTC` : ''}.`;
    }
  }

  let timer;
  async function load() {
    clearTimeout(timer);
    if (!box.querySelector('#routes-note') && !box.querySelector('[data-symbol]:not([data-status="settlement"])')) {
      box.dataset.state = 'loading';
    }
    try {
      const r = await fetch('/api/market/buy/currencies', { signal: AbortSignal.timeout(25000) });
      let d;
      try { d = await r.json(); } catch { d = undefined; }
      if (!r.ok || !d) { note('error', 'Route status could not be loaded', `The server answered ${r.status}. Nothing is shown as supported until it can be read.`, true); return; }
      if (!d.ok) { note('error', 'Route status could not be loaded', short(d.message || 'The server refused the request.'), true); return; }
      if (!d.enabled) { note('disabled', 'Other currencies are not switched on', d.note || 'Paying with another currency is not enabled on this server. Only USDT works.', false); return; }
      if (d.error) { note('error', 'Route status could not be read just now', short(d.error), true); return; }
      if (!Array.isArray(d.currencies) || d.currencies.length === 0 || (Array.isArray(d.landing) && d.landing.length === 0)) { note('empty', 'No currencies to show', 'The server returned no currency routes. Nothing is shown as supported.', true); return; }
      render(d);
      timer = setTimeout(load, 60000); // refresh by itself: a route can become Live or drop out at any time
    } catch (e) {
      note('error', 'Route status could not be loaded', `The request failed (${String((e && e.message) || e).slice(0, 80)}). Nothing is shown as supported until it can be read.`, true);
    }
  }
  load();
})();
