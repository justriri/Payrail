// Landing page: say which mode this server is really in (read from the server, never assumed).
(async () => {
  try {
    const r = await fetch('/api/market/config');
    const d = await r.json();
    const note = document.getElementById('mode-note');
    if (!d.ok || !note) return;
    note.textContent = d.realFunds
      ? 'LIVE: this server is in real-funds mode. APIs priced in real USDT on Celo mainnet are paid from your own wallet and every deposit is verified on-chain. Demo APIs, if shown, use test credits and are labelled DEMO.'
      : 'DEMO: this server runs on test credits and simulated conversion. Nothing here moves real money.';
  } catch { /* the static text above stays */ }
})();
