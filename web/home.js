// Landing page: state the real network and token this server uses (read from the server, never assumed).
(async () => {
  try {
    const r = await fetch('/api/market/config');
    const d = await r.json();
    const note = document.getElementById('mode-note');
    if (!note) return;
    if (d.ok && d.realFunds && d.network) {
      note.textContent = `Real funds: ${d.network.token.symbol} on ${d.network.name} (chain ${d.network.chainId}), paid from your own wallet. Every deposit is verified on-chain before it is credited; the platform fee is ${d.network.platformFeePercent}%.`;
    } else {
      note.textContent = 'The API marketplace is not enabled on this server right now.';
    }
  } catch { /* the static text stays */ }
})();
