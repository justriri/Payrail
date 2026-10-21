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

// Landing page: the currency cards come from the server (the same data the Buy page uses), never from fixed text.
(async () => {
  const box = document.getElementById('asset-cards');
  const loading = document.getElementById('asset-loading');
  if (!box) return;
  const card = (sym, ...lines) => {
    const d = document.createElement('div');
    d.className = 'asset';
    const b = document.createElement('b');
    b.textContent = sym;
    d.append(b);
    for (const t of lines) { const s = document.createElement('small'); s.textContent = t; s.style.display = 'block'; d.append(s); }
    return d;
  };
  try {
    const d = await (await fetch('/api/market/buy/currencies')).json();
    if (loading) loading.remove();
    if (!d.ok || !d.enabled) {
      box.append(card('Other currencies', d.note || 'Paying with another currency is not switched on on this server. Only USDT works.'));
      return;
    }
    const order = { live: 0, simulated: 1, temporarily_unavailable: 2, unsupported: 3 };
    for (const c of [...d.currencies].sort((x, y) => order[x.status] - order[y.status] || x.symbol.localeCompare(y.symbol))) {
      const el = c.status === 'temporarily_unavailable' ? card(c.symbol, c.statusLabel, c.reason || c.statusDetail) : card(c.symbol, c.statusLabel);
      el.dataset.symbol = c.symbol;
      el.dataset.status = c.status;
      box.append(el);
    }
  } catch {
    if (loading) loading.remove();
    box.append(card('Other currencies', 'Status could not be read from this server right now.'));
  }
})();
