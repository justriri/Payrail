// Payrail marketplace UI. Plain JavaScript. All server text is written with textContent, never as HTML.
'use strict';

const TOKEN = document.querySelector('meta[name="payrail-token"]').content;
const $ = (id) => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
// conditional children (cond && el(...)) may be false/null: never render them as text
const _append = Element.prototype.append;
Element.prototype.append = function (...kids) { return _append.apply(this, kids.filter((k) => k !== false && k !== null && k !== undefined)); };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* optional */ } },
};
const session = { buyer: store.get('payrail.buyer'), seller: store.get('payrail.seller') };
let config = { mode: 'off', realFunds: false, legend: {} };

async function api(path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const opts = body === undefined ? { method: 'GET', headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-payrail-token': TOKEN }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(`/api/market${path}`, opts); } catch { return { ok: false, message: 'Could not reach the Payrail server.' }; }
  try { return await r.json(); } catch { return { ok: false, message: 'Unreadable answer from the server.' }; }
}
const fail = (d) => `${d.message || 'Request failed'}${d.code ? ` (${d.code})` : ''}`;
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const flash = (box, text, bad) => { const p = el('p', { class: bad ? 'problem' : 'notice', text }); box.prepend(p); setTimeout(() => p.remove(), 9000); };

const ORIGIN_CLASS = { 'buy-gateway': 'o-buy', 'payrail-seller': 'o-seller' };
const ORIGIN_SHORT = { 'buy-gateway': 'BUY GATEWAY', 'payrail-seller': 'PAYRAIL SELLER' };

// ------------------------------------------------------------------ banner + legend
async function loadConfig() {
  const d = await api('/config');
  const pill = $('mode-pill');
  if (!d.ok || !d.realFunds) {
    // there is no demo fallback: a server without real-funds mode simply has no marketplace
    config = { mode: 'off', realFunds: false, legend: {} };
    $('mode-banner').textContent = 'The API marketplace is not enabled on this server.';
    $('mode-banner').className = 'banner sim';
    pill.textContent = 'OFF · marketplace not enabled';
    pill.className = 'pill sim';
    document.body.dataset.funds = 'off';
    return;
  }
  config = d;
  const n = d.network;
  $('mode-banner').textContent = `REAL FUNDS · ${n.name} (chain ${n.chainId}) · pay in ${n.token.symbol} · ${n.platformFeePercent}% platform fee`;
  $('mode-banner').className = 'banner live';
  pill.textContent = `LIVE · ${n.token.symbol} on ${n.name}`;
  pill.className = 'pill live';
  document.body.dataset.funds = 'live';
  const lg = $('legend');
  clear(lg);
  for (const [k, v] of Object.entries(d.legend || {})) lg.append(el('li', {}, el('span', { class: `badge ${ORIGIN_CLASS[k] || ''}`, text: ORIGIN_SHORT[k] || k }), ' ', v));
}
const notEnabled = (box) => { clear(box); box.append(el('p', { class: 'problem', id: 'not-enabled', text: 'The API marketplace is not enabled on this server (real-funds mode is off). Nothing can be bought, funded or sold here.' })); };

// ------------------------------------------------------------------ buyer
async function buyerLoginWallet() {
  if (!window.ethereum) throw new Error('No browser wallet found. Install a wallet extension (for example MetaMask or Rabby) to sign in.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const EXPECTED = config.network ? config.network.chainId : 42220;
  let chainId = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
  if (chainId !== EXPECTED) {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${EXPECTED.toString(16)}` }] });
    chainId = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    if (chainId !== EXPECTED) throw new Error(`Your wallet is not on Celo mainnet (chain ${EXPECTED}).`);
  }
  const s = await api('/buyer/login/start', { body: { wallet: account, chainId } });
  if (!s.ok) throw new Error(fail(s));
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [s.message, account] });
  const c = await api('/buyer/login/complete', { body: { wallet: account, nonce: s.nonce, signature } });
  if (!c.ok) throw new Error(fail(c));
  session.buyer = c.token; store.set('payrail.buyer', c.token);
  await renderBuyer(); renderHistory(); renderAgents(); renderAddFunds();
}
async function renderBuyer() {
  const box = $('buyer');
  if (!config.realFunds) return notEnabled(box);
  clear(box);
  if (!session.buyer) {
    box.append(
      el('p', {}, el('span', { class: 'badge ok', text: 'REAL FUNDS' }), ` Sign in with your wallet to fund your account in ${config.network.token.symbol} and pay for APIs. Signing sends no transaction and never shares a key.`),
      el('button', { type: 'button', id: 'wallet-signin', text: 'Sign in with wallet', onclick: async () => {
        try { await buyerLoginWallet(); } catch (e) { flash(box, e.message, true); }
      } }),
    );
    return;
  }
  const me = await api('/me', { bearer: session.buyer });
  if (!me.ok || !me.live) {
    session.buyer = null; store.set('payrail.buyer', null);
    return renderBuyer();
  }
  box.append(
    el('p', {}, el('strong', { id: 'real-balance', text: `${me.live.available} ${me.live.asset}` }), ' available · ', `${me.live.held} held `, el('span', { class: 'badge ok', text: 'REAL USDT' })),
    el('p', { class: 'muted', text: 'Your balance is credited only after a transfer from your verified wallet is confirmed on-chain. Fund it under Wallet and funding, or pay directly on an API page.' }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', id: 'sign-out-buyer', text: 'Sign out', onclick: () => { session.buyer = null; store.set('payrail.buyer', null); renderBuyer(); renderHistory(); renderAgents(); renderAddFunds(); } })),
    el('p', { class: 'muted', text: `Account: ${me.accountId}` }),
  );
}

// ------------------------------------------------------------------ catalog
async function loadCatalog() {
  const q = $('q').value.trim();
  const d = await api(`/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const list = $('cat-list');
  clear(list);
  if (!d.ok) { $('cat-status').textContent = config.realFunds ? fail(d) : 'The API marketplace is not enabled on this server.'; return; }
  const counts = {};
  for (const it of d.items) counts[it.origin] = (counts[it.origin] || 0) + 1;
  $('cat-status').textContent = `${d.items.length} services · ` + Object.entries(counts).map(([k, n]) => `${n} ${ORIGIN_SHORT[k] || k}`).join(', ')
    + (d.buy.available ? '' : ` · Buy gateway: ${d.buy.message || 'unavailable'}`);
  if (d.items.length === 0) {
    list.append(el('div', { class: 'notice' }, 'No APIs are published yet. ', el('a', { href: '#/seller/new', text: 'Publish one in Seller, Create API' }), '.'));
  }
  for (const it of d.items) {
    const price = !it.pricing ? 'price on request'
      : it.pricing.kind === 'fixed' ? `${it.pricing.usd} ${it.pricing.asset}`
        : (it.pricing.minUsd === it.pricing.maxUsd ? `${it.pricing.minUsd} (indicative)` : `${it.pricing.minUsd}–${it.pricing.maxUsd} (indicative)`);
    const isGateway = it.execution === 'payrail-gateway';
    const card = el('article', { class: 'svc', 'data-id': it.id },
      el('div', { class: 'svc-top' },
        el('span', { class: `badge ${ORIGIN_CLASS[it.origin] || ''}`, text: ORIGIN_SHORT[it.origin] || it.origin }),
        el('span', { class: `badge ${it.available ? 'ok' : 'warn'}`, text: it.available ? 'Published' : 'Unavailable' })),
      el('h4', { text: it.title }),
      el('p', { class: 'svc-desc', text: it.description.slice(0, 200) }),
      el('p', { class: 'svc-seller', text: `Seller: ${it.seller || it.originLabel}` }),
      el('div', { class: 'svc-foot' }, el('span', { class: 'price', text: price })),
    );
    if (isGateway) card.querySelector('.svc-foot').append(el('a', { class: 'btn', href: `/api.html?id=${encodeURIComponent(it.id)}`, text: 'View API' }));
    else if (it.available) card.querySelector('.svc-foot').append(el('a', { class: 'btn ghost', href: '/index.html', text: 'Open Buy flow' }));
    list.append(card);
  }
}
async function showReceipt(box, id) {
  const d = await api(`/receipt/${encodeURIComponent(id)}`, { bearer: session.buyer });
  if (!d.ok) { box.append(el('p', { class: 'problem', text: fail(d) })); return; }
  const r = d.receipt;
  const rows = [
    ['Receipt', r.receiptId], ['Outcome', r.outcome], ['Charged', `${r.charged.display} ${r.asset}`], ['Held (not charged)', `${r.held.display} ${r.asset}`],
    ['Returned to you', `${r.returned.display} ${r.asset}`], ['Platform fee', r.platformFee ? `${r.platformFee.display} ${r.asset}` : '—'], ['Seller earned', r.sellerEarned ? `${r.sellerEarned.display} ${r.asset}` : '—'],
    ['Settlement', 'Payrail ledger (USDT)'], ['Contract', r.contract ? `v${r.contract.version}` : '—'],
    ['Response hash', r.validation.responseSha256 || '—'], ['Idempotency key', r.idempotencyKey],
  ];
  box.append(el('table', { class: 'quote' }, ...rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { class: 'v', text: String(v) })))));
  if (r.ledger.length) box.append(el('p', { class: 'muted', text: 'Ledger entries: ' + r.ledger.map((t) => `#${t.id} ${t.kind}`).join(', ') }));
  box.append(el('p', { class: 'muted', text: r.validation.note }));
}

const STATE_TEXT = (e) => (e.state === 'QUALIFIED' ? `charged ${e.price} ${e.asset}` : e.state === 'UNRESOLVED' || e.state === 'HELD' ? `held ${e.price} ${e.asset} (outcome unknown, not charged)` : e.state === 'RELEASED_UNRESOLVED' ? 'released: outcome never established, not charged' : 'not charged');
async function renderHistory() {
  const box = $('history');
  const st = $('statement');
  clear(box); clear(st);
  if (!config.realFunds) { box.textContent = 'The marketplace is not enabled on this server.'; return; }
  if (!session.buyer) { box.textContent = 'Sign in with your wallet first.'; return; }
  const [d, sm] = await Promise.all([api('/executions', { bearer: session.buyer }), api('/me/statement', { bearer: session.buyer })]);
  if (sm.ok) {
    for (const b of sm.statement.balances) {
      st.append(el('table', { class: 'quote' },
        el('tr', {}, el('th', { text: `Account summary (${b.asset})` }), el('td', {})),
        el('tr', {}, el('th', { text: 'Deposited / granted' }), el('td', { class: 'v', text: b.deposited.display })),
        el('tr', {}, el('th', { text: 'Charged for qualifying responses' }), el('td', { class: 'v', text: b.charged.display })),
        el('tr', {}, el('th', { text: 'Returned (non-qualifying or expired)' }), el('td', { class: 'v', text: b.returned.display })),
        el('tr', {}, el('th', { text: 'Held (outcome unknown)' }), el('td', { class: 'v', text: b.held.display })),
        el('tr', {}, el('th', { text: 'Available' }), el('td', { class: 'v', text: b.available.display }))));
    }
  }
  if (!d.ok) { box.textContent = fail(d); return; }
  if (!d.executions.length) { box.textContent = 'No requests yet.'; return; }
  box.append(el('div', {}, ...d.executions.map((e) => {
    const det = el('details', {}, el('summary', { text: `${e.at.slice(0, 19).replace('T', ' ')}  ${e.listing}: ${STATE_TEXT(e)}${e.reason && e.state !== 'QUALIFIED' ? ` — ${e.reason}` : ''}` }));
    let loaded = false;
    det.addEventListener('toggle', () => { if (det.open && !loaded) { loaded = true; showReceipt(det, e.id); } });
    return det;
  })));
}


// ------------------------------------------------------------------ buyer: funding (real USDT deposits)
// REAL funds: the buyer sends USDT from their own proven wallet to the deposit address, then submits the transaction hash.
// Nothing is credited until the server has verified the transfer (token, sender, recipient, amount, confirmations).
async function renderLiveDeposit(box) {
  const f = await api('/funding', { bearer: session.buyer });
  if (!f.ok || !f.enabled) { box.append(el('p', { class: 'muted', text: 'Real-funds deposits are not enabled on this server.' })); return; }
  box.append(el('div', { class: 'banner live', text: `REAL FUNDS: ${f.asset} on chain ${f.chainId}. Transfers are final.` }));
  const msg = el('p', { class: 'muted', role: 'status' });
  const w = f.wallets[0];
  box.append(el('p', {}, el('strong', { text: w ? `Sending wallet verified: ${w}` : 'No sending wallet verified yet' })));
  if (!w) {
    box.append(el('button', { type: 'button', text: 'Verify my wallet (signature only, no transaction)', onclick: async () => {
      try {
        if (!window.ethereum) throw new Error('No browser wallet found.');
        const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const me = await api('/me', { bearer: session.buyer });
        const message = f.walletMessageTemplate.replace('<your wallet address in lowercase>', account.toLowerCase()).replace(/Buyer: .*\n/, 'Buyer: ' + me.accountId + '\n');
        const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] });
        const r = await api('/funding/wallet', { body: { wallet: account, signature }, bearer: session.buyer });
        if (!r.ok) throw new Error(fail(r));
        renderAddFunds();
      } catch (e) { msg.textContent = e.message; msg.className = 'problem'; }
    } }), msg);
    return;
  }
  box.append(el('table', { class: 'quote' },
    el('tr', {}, el('th', { text: 'Send' }), el('td', { class: 'v', text: `${f.asset} (token ${f.token})` })),
    el('tr', {}, el('th', { text: 'To' }), el('td', { class: 'v', text: f.depositAddress })),
    el('tr', {}, el('th', { text: 'From' }), el('td', { class: 'v', text: `${w} (only this wallet is credited)` })),
    el('tr', {}, el('th', { text: 'Limit per deposit' }), el('td', { class: 'v', text: `${f.maxDeposit} ${f.asset}` })),
    el('tr', {}, el('th', { text: 'Confirmations needed' }), el('td', { class: 'v', text: String(f.minConfirmations) }))));
  const tx = el('input', { placeholder: '0x… transaction hash of your transfer', 'aria-label': 'Transaction hash' });
  box.append(el('label', { text: 'After sending, paste the transaction hash' }), tx,
    el('div', { class: 'row' }, el('button', { type: 'button', text: 'Verify and credit', onclick: async () => {
      msg.className = 'muted'; msg.textContent = 'Checking the chain…';
      const r = await api('/funding/confirm', { body: { txHash: tx.value.trim() }, bearer: session.buyer });
      if (r.ok) { msg.className = 'notice'; msg.textContent = r.credited.map((c) => `SUCCESS: ${c.amount} ${f.asset} ${c.alreadyCredited ? 'was already credited' : 'credited'}`).join('; '); renderBuyer(); }
      else if (r.code === 'NOT_ENOUGH_CONFIRMATIONS' || r.code === 'TX_NOT_FOUND') { msg.className = 'muted'; msg.textContent = `PENDING: ${r.message} Not credited yet; check again shortly.`; }
      else { msg.className = 'problem'; msg.textContent = `NOT CREDITED: ${r.message} (${r.code}). Nothing was credited.`; }
    } })), msg);
}

async function renderAddFunds() {
  const box = $('fund');
  if (!config.realFunds) return notEnabled(box);
  clear(box);
  if (!session.buyer) { box.append(el('p', { class: 'muted', text: 'Sign in with your wallet (Buyer card) to fund your account.' })); return; }
  await renderLiveDeposit(box);
  box.append(el('details', { id: 'other-currencies' }, el('summary', { text: 'Other currencies (cNGN, wARS, wBRL, USDC and others)' }),
    el('p', { class: 'muted', text: 'Not available. Converting other assets to USDT needs a Textile route that has been executed and verified end to end with a real wallet on mainnet, and none has been enabled yet. Quotes alone are not proof of liquidity. Fund in USDT.' })));
}

// ------------------------------------------------------------------ buyer: agent keys
async function renderAgents() {
  const box = $('agents');
  clear(box);
  if (!config.realFunds) return notEnabled(box);
  if (!session.buyer) { box.append(el('p', { class: 'muted', text: 'Sign in with your wallet first.' })); return; }
  const d = await api('/agents', { bearer: session.buyer });
  if (!d.ok) { box.append(el('p', { class: 'problem', text: fail(d) })); return; }
  const name = el('input', { placeholder: 'Agent name, e.g. research-bot', value: 'my-agent' });
  const per = el('input', { value: '0.03', 'aria-label': 'Per-request cap' });
  const day = el('input', { value: '0.1', 'aria-label': 'Daily cap' });
  box.append(
    el('p', { class: 'muted', text: 'An agent key lets a script spend your real USDT balance inside hard limits you set. It cannot create keys or change limits.' }),
    el('div', { class: 'row' }, name, el('label', {}, 'per request ', per), el('label', {}, 'per day ', day),
      el('button', { type: 'button', class: 'secondary', text: 'Create agent key', onclick: async () => {
        const r = await api('/agents', { body: { name: name.value, perRequestCap: per.value, dailyCap: day.value }, bearer: session.buyer });
        if (!r.ok) return flash(box, fail(r), true);
        box.prepend(el('div', { class: 'notice' }, el('strong', { text: 'Copy this key now; it is shown once: ' }), el('code', { text: r.key }),
          el('p', { class: 'muted', text: `Use it with:  POST /api/market/agent/execute  Authorization: Bearer <key>  body {"listingId","input","idempotencyKey"}` })));
        loadAgentList();
      } })),
  );
  const listBox = el('div', { id: 'agent-list' });
  box.append(listBox);
  async function loadAgentList() {
    const l = await api('/agents', { bearer: session.buyer });
    clear(listBox);
    for (const a of l.agents || []) {
      listBox.append(el('div', { class: 'svc' }, el('strong', { text: a.name }), ` — ${a.status} · per request ${a.perRequestCap} · per day ${a.dailyCap} · spent (24h) ${a.spentLast24h}`,
        a.status === 'active' && el('button', { type: 'button', class: 'secondary', text: 'Revoke', onclick: async () => { await api(`/agents/${a.id}/revoke`, { body: {}, bearer: session.buyer }); loadAgentList(); } })));
    }
  }
  loadAgentList();
}

// ------------------------------------------------------------------ seller
// Seller UI state lives in `ui` (mirrored to localStorage; NEVER holds secrets) so that re-rendering the dashboard after
// any action cannot lose what the seller typed. Secrets (credential values) are kept in memory only.
const SELLER_UI_KEY = 'payrail.seller.ui';
const blankForm = () => ({ name: '', desc: '', url: '', method: 'GET', price: '' });
const ui = (() => {
  try {
    const v = JSON.parse(store.get(SELLER_UI_KEY) || 'null');
    if (v && typeof v === 'object') return { form: { ...blankForm(), ...(v.form || {}) }, per: v.per && typeof v.per === 'object' ? v.per : {} };
  } catch { /* fall through */ }
  return { form: blankForm(), per: {} };
})();
const saveUi = () => store.set(SELLER_UI_KEY, JSON.stringify(ui));
const per = (id) => (ui.per[id] = ui.per[id] || {});
const memSecrets = {};
let renderToken = 0;

function sellerRoute() {
  const m = /^#\/seller(?:\/(new|earnings|overview|payouts|payout-settings|api\/([\w-]{1,80})))?$/.exec(location.hash);
  if (!m || !m[1]) return { page: 'apis' };
  if (m[1] === 'overview') return { page: 'overview' };
  if (m[1] === 'payouts') return { page: 'payouts' };
  if (m[1] === 'new') return { page: 'new' };
  if (m[1] === 'earnings') return { page: 'earnings' };
  if (m[1] === 'payout-settings') return { page: 'payout-settings' };
  return { page: 'edit', id: m[2] };
}
const go = (hash) => { if (location.hash === hash) renderSeller(); else location.hash = hash; };

// a status line that is always on screen while the seller works (sticky), so results are never lost off-screen
function say(text, kind) {
  const bar = $('seller-status');
  clear(bar);
  if (!text) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.className = `status-bar ${kind || 'info'}`;
  bar.append(el('span', { text }), el('button', { type: 'button', class: 'secondary', text: 'Dismiss', onclick: () => say('') }));
}

async function walletSign(message) {
  if (!window.ethereum) throw new Error('No browser wallet found. Install a wallet extension (for example MetaMask or Rabby) to sign in.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] });
  return { account, signature };
}
async function sellerLoginWallet() {
  const probe = await walletSign('Payrail: choose account');
  const chainId = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
  const s = await api('/seller/login/start', { body: { wallet: probe.account, chainId } });
  if (!s.ok) throw new Error(fail(s));
  const { signature } = await walletSign(s.message);
  const c = await api('/seller/login/complete', { body: { wallet: probe.account, nonce: s.nonce, signature } });
  if (!c.ok) throw new Error(fail(c));
  session.seller = c.token; store.set('payrail.seller', c.token);
}
const signOutSeller = () => { session.seller = null; store.set('payrail.seller', null); say(''); renderSeller(); };

const STATUS_CLASS = { Published: 'ok', Suspended: 'bad', Draft: '', 'Pending verification': 'warn' };
const chip = (text, cls) => el('span', { class: `badge ${cls || ''}`, text });
const tick = (done, text) => el('li', { class: done ? 'step done' : 'step', text: `${done ? '✓' : '○'} ${text}` });

async function renderSeller() {
  const mine = ++renderToken;
  const box = $('seller');
  if (!config.realFunds) { say(''); return notEnabled(box); }
  if (!session.seller) {
    clear(box);
    say('');
    box.append(
      el('p', { text: 'Sellers list an API, prove they own it, set a price and a response contract, and are paid in USDT only for qualifying responses.' }),
      el('div', { class: 'row' },
        el('button', { type: 'button', id: 'seller-signin', text: 'Sign in with your wallet', onclick: async () => {
          try { await sellerLoginWallet(); renderSeller(); } catch (e) { say(e.message, 'bad'); }
        } })),
      el('p', { class: 'muted', text: 'Signing proves you control the wallet. It sends no transaction and never shares a key.' }),
    );
    return;
  }
  const [me, ls, earn] = await Promise.all([api('/me', { bearer: session.seller }), api('/seller/listings', { bearer: session.seller }), api('/seller/earnings', { bearer: session.seller })]);
  if (mine !== renderToken) return; // a newer render started; never paint stale data over it
  if (!ls.ok || !me.ok) { signOutSeller(); return; }
  clear(box);
  const route = sellerRoute();
  const listings = ls.listings;
  const published = listings.filter((l) => l.public).length;
  box.append(
    el('div', { class: 'row' },
      el('strong', { text: `Earnings: ${earn.earnings} ${earn.asset}` }), chip('REAL USDT', 'ok'),
      el('button', { type: 'button', class: 'secondary', text: 'Sign out', onclick: signOutSeller })),
    el('p', { class: 'muted', text: `${listings.length} API${listings.length === 1 ? '' : 's'} · ${published} published · payouts: disabled until the secure payout flow is reviewed (earnings stay in your USDT balance)` }),
    el('nav', { class: 'subtabs', 'aria-label': 'Seller sections' },
      el('a', { class: `subtab${route.page === 'overview' ? ' active' : ''}`, href: '#/seller/overview', text: 'Overview' }),
      el('a', { class: `subtab${route.page === 'apis' ? ' active' : ''}`, href: '#/seller', text: `My APIs (${listings.length})` }),
      el('a', { class: `subtab${route.page === 'new' ? ' active' : ''}`, href: '#/seller/new', text: 'New listing' }),
      el('a', { class: `subtab${route.page === 'earnings' ? ' active' : ''}`, href: '#/seller/earnings', text: 'Earnings & payouts' }),
      el('a', { class: `subtab${route.page === 'payout-settings' ? ' active' : ''}`, href: '#/seller/payout-settings', text: 'Payout settings' }),
      el('a', { class: `subtab${route.page === 'payouts' ? ' active' : ''}`, href: '#/seller/payouts', text: 'Payout history' }),
      route.page === 'edit' && el('span', { class: 'subtab active', text: 'Manage API' })),
  );
  if (route.page === 'overview') {
    const sm = await api('/seller/statement', { bearer: session.seller });
    if (mine !== renderToken) return;
    box.append(sm.ok ? sellerOverviewPage(sm.statement, listings) : el('p', { class: 'problem', text: fail(sm) }));
  } else if (route.page === 'payouts') {
    const sm = await api('/seller/statement', { bearer: session.seller });
    if (mine !== renderToken) return;
    box.append(sm.ok ? payoutHistoryPage(sm.statement) : el('p', { class: 'problem', text: fail(sm) }));
  } else if (route.page === 'payout-settings') {
    box.append(payoutSettingsPage());
  } else if (route.page === 'earnings') {
    const sm = await api('/seller/statement', { bearer: session.seller });
    if (mine !== renderToken) return;
    box.append(sm.ok ? earningsPage(sm.statement) : el('p', { class: 'problem', text: fail(sm) }));
  } else if (route.page === 'new') box.append(newListingPage());
  else if (route.page === 'edit') {
    const l = listings.find((x) => x.id === route.id);
    if (!l) { box.append(el('p', { class: 'problem', text: 'That listing was not found in your account.' }), el('a', { href: '#/seller', text: 'Back to My APIs' })); }
    else box.append(editorPage(l));
  } else box.append(myApisPage(listings, earn));
}

// ---- Earnings & payouts (derived from persisted executions, ledger and payouts)
function payoutSettingsPage() {
  const wrap = el('div', { id: 'payout-settings' });
  wrap.append(el('h3', { text: 'Payout settings' }),
    el('p', { class: 'notice', id: 'payouts-disabled', text: 'Payouts are not enabled yet. Your earnings accrue in your Payrail USDT balance and are recorded in the ledger. Paying them out needs a secure payout design (a bounded signer, verified destination addresses and human approval) that has not been built or reviewed.' }),
    el('ul', {},
      el('li', { text: 'Choosing a payout currency (USDT or another asset) is unavailable until payouts are enabled.' }),
      el('li', { text: 'Converting earnings into other currencies is unavailable: no conversion route has been verified end to end on mainnet.' }),
      el('li', { text: 'Nothing is ever marked paid until the delivery transaction has been verified on-chain.' })));
  return wrap;
}

// ---- seller overview: compact summary cards computed from the same statement the Earnings page uses
const sumDisplay = (items, pick) => {
  let total = 0;
  for (const x of items) total += Number(pick(x) || 0);
  return (Math.round(total * 1e6) / 1e6).toString();
};
function sellerOverviewPage(sm, listings) {
  const wrap = el('div', {});
  const asset = 'USDT';
  const earned = sumDisplay(sm.buckets, (b) => b.sellerEarnings.display);
  const fees = sumDisplay(sm.buckets, (b) => b.platformFees.display);
  const available = sm.ledgerBalances.length ? sm.ledgerBalances.map((l) => l.available.display).join(' + ') : '0';
  const pending = sumDisplay(sm.payoutTotals, (t) => t.pending.display);
  const completed = sumDisplay(sm.payoutTotals, (t) => t.completed.display);
  const stat = (label, value, note) => el('div', { class: 'stat' }, el('small', { text: label }), el('b', { text: value }), el('span', { text: note || asset }));
  wrap.append(
    el('div', { class: 'stat-grid' },
      stat('Total earned', earned), stat('Platform fees (3%)', fees), stat('Available to pay out', available),
      stat('Payouts pending', pending), stat('Payouts completed', completed)),
    el('p', { class: 'muted', text: 'Earnings are real USDT credited to your Payrail balance only for responses that met the contract. The 3% platform fee is already deducted.' }));
  wrap.append(el('p', {}, el('strong', { text: 'Payouts: ' }), 'disabled until the secure payout flow is reviewed · ',
    el('a', { href: '#/seller/payout-settings', text: 'Payout settings' }), ' · ', el('a', { href: '#/seller/payouts', text: 'Payout history' })));
  wrap.append(el('h3', { text: `Your APIs (${listings.length})` }));
  if (!listings.length) wrap.append(el('p', { class: 'muted', text: 'No APIs yet.' }), el('a', { class: 'btn', href: '#/seller/new', text: 'Create your first API' }));
  else {
    wrap.append(el('table', {}, el('tr', {}, ...['API', 'Status', 'Price', ''].map((h) => el('th', { text: h }))),
      ...listings.slice(0, 8).map((l) => el('tr', {},
        el('td', { text: l.name }), el('td', {}, chip(l.displayStatus, STATUS_CLASS[l.displayStatus] || '')),
        el('td', { text: l.price ? `${l.price.usd} ${l.price.asset}` : '' }),
        el('td', {}, el('a', { href: `#/seller/api/${l.id}`, text: 'Manage' }))))));
  }
  return wrap;
}

// ---- payout history: every payout with its real lifecycle state; nothing is "complete" until delivery was verified
function payoutHistoryPage(sm) {
  const wrap = el('div', {});
  if (!sm.payouts.length) {
    wrap.append(el('p', { class: 'muted', id: 'no-payouts', text: 'No payouts. Seller payouts are disabled until the secure payout flow is reviewed; your earnings stay in your USDT balance.' }));
  } else {
    wrap.append(el('table', {}, el('tr', {}, ...['Requested', 'Amount', 'State', 'Transaction'].map((h) => el('th', { text: h }))),
      ...sm.payouts.map((p) => el('tr', {},
        el('td', { text: p.requestedAt.slice(0, 19).replace('T', ' ') }),
        el('td', { text: `${p.amount.display} ${p.asset}` }),
        el('td', {}, chip(p.state === 'confirmed' ? 'completed' : p.state === 'failed' || p.state === 'cancelled' ? 'failed' : 'pending', p.state === 'confirmed' ? 'ok' : p.state === 'failed' || p.state === 'cancelled' ? 'bad' : 'warn')),
        el('td', { text: p.txHash || (p.state === 'confirmed' ? 'delivered' : 'not sent yet') })))));
  }
  return wrap;
}

function earningsPage(sm) {
  const wrap = el('div', {});
  wrap.append(el('p', { class: 'notice', text: 'Every figure below is computed from saved requests, ledger entries and payouts. All amounts are real USDT in the Payrail ledger.' }));
  if (!sm.buckets.length) wrap.append(el('p', { class: 'muted', text: 'No requests yet.' }));
  for (const b of sm.buckets) {
    wrap.append(el('h3', { text: `Payrail ledger · ${b.asset}` }),
      el('table', { class: 'quote' },
        el('tr', {}, el('th', { text: 'Requests' }), el('td', { class: 'v', text: `${b.requests} (${b.qualified} qualified, ${b.notCharged} not charged, ${b.unresolvedOpen} unresolved, ${b.releasedUnresolved} released)` })),
        el('tr', {}, el('th', { text: 'Gross sales (buyers charged)' }), el('td', { class: 'v', text: b.gross.display })),
        el('tr', {}, el('th', { text: 'Platform fees (3%)' }), el('td', { class: 'v', text: b.platformFees.display })),
        el('tr', {}, el('th', { text: 'Your earnings' }), el('td', { class: 'v', text: b.sellerEarnings.display })),
        el('tr', {}, el('th', { text: 'Returned to buyers (refunds)' }), el('td', { class: 'v', text: b.refunded.display })),
        el('tr', {}, el('th', { text: 'Held while outcome is unknown' }), el('td', { class: 'v', text: b.heldOpen.display }))));
  }
  for (const l of sm.ledgerBalances) {
    wrap.append(el('p', { text: `${l.asset}: available to pay out ${l.available.display} · payout pending ${l.pendingPayout.display}` }));
  }
  for (const t of sm.payoutTotals) wrap.append(el('p', { text: `${t.asset} payouts: pending ${t.pending.display} · completed ${t.completed.display}` }));
  wrap.append(el('p', { class: 'muted', text: 'Payouts are disabled until the secure payout flow is reviewed. Nothing here can be withdrawn yet.' }));
  wrap.append(el('h3', { text: 'Payouts' }));
  if (!sm.payouts.length) wrap.append(el('p', { class: 'muted', text: 'No payouts. Payouts are disabled until the secure payout flow is reviewed.' }));
  else wrap.append(el('ul', {}, ...sm.payouts.map((p) => el('li', { text: `${p.requestedAt.slice(0, 19).replace('T', ' ')}  ${p.amount.display} ${p.asset}  ${p.state}${p.txHash ? '  tx ' + p.txHash : ''}` }))));
  wrap.append(el('h3', { text: 'Recent sales' }));
  if (!sm.recentSales.length) wrap.append(el('p', { class: 'muted', text: 'No qualifying sales yet.' }));
  else wrap.append(el('table', {}, el('tr', {}, ...['When', 'API', 'Gross', 'Fee', 'You earned', 'Path'].map((h) => el('th', { text: h }))),
    ...sm.recentSales.map((r) => el('tr', {}, el('td', { text: r.at.slice(0, 19).replace('T', ' ') }), el('td', { text: r.listing }), el('td', { text: r.gross }), el('td', { text: r.fee }), el('td', { text: r.earned }), el('td', { text: r.settlement })))));
  wrap.append(el('ul', { class: 'muted' }, ...sm.notes.map((n) => el('li', { text: n }))));
  return wrap;
}

// ---- My APIs (private management view)
function myApisPage(listings, earn) {
  const wrap = el('div', {});
  wrap.append(el('p', { class: 'notice', text: 'My APIs is your private management view: only you see these listings. Buyers only discover APIs with status "Published", in the Buyer tab.' }));
  if (!listings.length) {
    wrap.append(el('p', { class: 'muted', text: 'You have not submitted any APIs yet.' }), el('a', { class: 'btn', href: '#/seller/new', text: 'Create your first listing' }));
  }
  for (const l of listings) {
    const o = l.ownership || {};
    wrap.append(el('div', { class: 'svc wide', 'data-listing': l.id },
      el('div', {}, el('strong', { text: l.name }), ' ', chip(l.displayStatus, STATUS_CLASS[l.displayStatus] || '')),
      l.description && el('div', { class: 'muted', text: l.description }),
      el('div', { class: 'muted', text: `${l.method} ${l.endpointUrl}` }),
      el('ul', { class: 'steps' },
        el('li', { text: `Price: ${l.price.usd} ${l.price.asset} per qualifying response (platform fee ${l.feePercent}%)` }),
        tick(o.wallet, 'Wallet ownership proof'),
        tick(o.domain, `Domain ownership proof${o.domainMethod ? ` (${o.domainMethod === 'dns_txt' ? 'DNS record' : 'well-known file'})` : ''}`),
        tick(l.contractStatus.state === 'approved', `Response contract: ${l.contractStatus.state === 'none' ? 'none yet' : `v${l.contractStatus.version} ${l.contractStatus.state}`}`),
        el('li', { class: l.public ? 'step done' : 'step', text: `${l.public ? '●' : '○'} ${l.visibility}` }),
      ),
      el('div', { class: 'muted', text: `Requests: ${l.stats.requests} · qualified: ${l.stats.qualified} · earned: ${l.stats.earned} ${l.price.asset}` }),
      el('div', { class: 'row' },
        el('a', { class: 'btn', href: `#/seller/api/${l.id}`, text: l.public ? 'Manage' : 'Open and continue' }),
        l.public && el('a', { class: 'btn secondary', href: '#/buyer', text: 'View in the marketplace', onclick: () => { $('q').value = l.name; } }))));
  }
  return wrap;
}

// ---- New listing
function newListingPage() {
  const f = ui.form;
  const bind = (input, key) => { input.value = f[key] || ''; input.addEventListener('input', () => { f[key] = input.value; saveUi(); }); return input; };
  const method = el('select', {}, el('option', { value: 'GET', text: 'GET' }), el('option', { value: 'POST', text: 'POST' }));
  method.value = f.method; method.addEventListener('change', () => { f.method = method.value; saveUi(); });
  const msg = el('div', {});
  return el('div', {},
    el('h3', { text: 'New listing' }),
    el('label', { text: 'Name' }), bind(el('input', { placeholder: 'e.g. Token price API' }), 'name'),
    el('label', { text: 'Description' }), bind(el('input', { placeholder: 'What does it return?' }), 'desc'),
    el('label', { text: 'Endpoint URL (https, fixed; buyers can only change input values)' }), bind(el('input', { placeholder: 'https://api.example.com/v1/price', type: 'url' }), 'url'),
    el('label', { text: 'HTTP method' }), method,
    el('label', { text: 'Price per qualifying response (USDT)' }), bind(el('input', { placeholder: 'e.g. 0.02' }), 'price'),
    el('p', { class: 'muted', text: 'Listings are always priced in real USDT on Celo mainnet. Your endpoint must be a real, public https API you control.' }),
    el('p', { class: 'muted', text: 'Your entries are kept if something fails, and after a page reload, until you submit successfully.' }),
    el('div', { class: 'row' },
      el('button', { type: 'button', text: 'Submit listing', onclick: async () => {
        say('Submitting…', 'info');
        const d = await api('/seller/listings', { body: { name: f.name, description: f.desc, endpointUrl: f.url, method: f.method, price: f.price }, bearer: session.seller });
        if (!d.ok) { say(`Could not submit: ${fail(d)}. Your entries are still here.`, 'bad'); return; }
        Object.assign(f, blankForm()); saveUi();
        say(`Saved "${d.listing.name}" as ${d.listing.displayStatus}. Continue with ownership verification below.`, 'ok');
        go(`#/seller/api/${d.listing.id}`);
      } }),
      el('button', { type: 'button', class: 'secondary', text: 'Clear form', onclick: () => { Object.assign(f, blankForm()); saveUi(); renderSeller(); } })),
    msg,
  );
}

// ---- Manage one API
function editorPage(l) {
  const st = per(l.id);
  const act = async (path, body, okText) => {
    say('Working…', 'info');
    const d = await api(`/seller/listing/${l.id}${path}`, { body: body || {}, bearer: session.seller });
    if (!d.ok) {
      st.note = { kind: 'bad', text: fail(d) }; saveUi();
      say(fail(d), 'bad');
      await renderSeller();
      return d;
    }
    st.note = { kind: 'ok', text: okText || 'Done.' }; saveUi();
    say(okText || 'Done.', 'ok');
    await renderSeller();
    loadCatalog();
    return d;
  };
  const bindState = (input, key, dflt) => { input.value = st[key] !== undefined ? st[key] : dflt; input.addEventListener('input', () => { st[key] = input.value; saveUi(); }); return input; };
  const o = l.ownership;
  const ch = l.challenge;
  const page = el('div', { class: 'editor' });

  page.append(
    el('p', {}, el('a', { href: '#/seller', text: '← My APIs' })),
    el('h3', { text: l.name }),
    el('div', {}, chip(l.displayStatus, STATUS_CLASS[l.displayStatus] || '')),
    el('p', { class: l.public ? 'notice' : 'muted', text: l.visibility }),
    st.note && el('p', { class: st.note.kind === 'bad' ? 'problem' : 'notice', text: `Last action: ${st.note.text}` }),
  );

  // saved details
  const nameIn = bindState(el('input', {}), 'name', l.name);
  const descIn = bindState(el('input', {}), 'desc', l.description);
  const priceIn = bindState(el('input', {}), 'price', l.price.usd);
  page.append(el('details', { open: '' }, el('summary', { text: 'Listing details (saved in your account)' }),
    el('div', { class: 'muted', text: `${l.method} ${l.endpointUrl} (the endpoint and method are fixed once submitted; submit a new listing to change them)` }),
    el('label', { text: 'Name' }), nameIn, el('label', { text: 'Description' }), descIn, el('label', { text: 'Price per qualifying response' }), priceIn,
    l.public && el('p', { class: 'muted', text: 'Unpublish before changing the price.' }),
    l.editable && el('button', { type: 'button', class: 'secondary', text: 'Save details', onclick: async () => {
      const d = await act('/details', { name: nameIn.value, description: descIn.value, price: priceIn.value }, 'Details saved.');
      if (d.ok) { delete st.name; delete st.desc; delete st.price; saveUi(); }
    } })));

  // 1. ownership
  if (ch) {
    page.append(el('div', {},
      el('h3', { text: '1. Verify ownership' }),
      el('p', { text: `Wallet proof: ${o.wallet ? 'done' : 'not done'}` }),
      !o.wallet && el('button', { type: 'button', class: 'secondary', text: 'Sign with wallet', onclick: async () => {
        try { const { signature } = await walletSign(ch.walletMessage); await act('/wallet-proof', { signature }, 'Wallet proof recorded.'); } catch (e) { say(e.message, 'bad'); }
      } }),
      el('p', { text: `Domain proof: ${o.domain ? `done (${o.domainMethod === 'dns_txt' ? 'DNS record' : 'well-known file'})` : 'not done: publish ONE of these, then check'}` }),
      !o.domain && el('pre', { text: `DNS TXT  ${ch.dnsRecord.name}\n  = ${ch.dnsRecord.value}\nor file  ${ch.wellKnown.url}\n  containing ${ch.wellKnown.content}` }),
      !o.domain && el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', text: 'Check DNS', onclick: () => act('/domain-proof', { method: 'dns_txt' }, 'Domain verified.') }),
        el('button', { type: 'button', class: 'secondary', text: 'Check file', onclick: () => act('/domain-proof', { method: 'well_known' }, 'Domain verified.') })),
    ));
  }

  const verified = l.status !== 'draft' && l.status !== 'suspended';
  if (!verified) {
    page.append(el('p', { class: 'muted', text: 'Credentials, testing, contracts and publishing unlock after both ownership proofs are done.' }));
  } else {
    // 2. credentials (secret value is kept in memory only)
    {
      const hdr = bindState(el('input', { placeholder: 'Header name, e.g. Authorization' }), 'credHeader', 'Authorization');
      const cred = el('input', { type: 'password', placeholder: 'API credential value (write-only)', autocomplete: 'off' });
      cred.value = memSecrets[l.id] || '';
      cred.addEventListener('input', () => { memSecrets[l.id] = cred.value; });
      page.append(el('div', {},
        el('h3', { text: '2. Credentials (optional)' }),
        el('p', { class: 'muted', text: `Stored encrypted, never shown again, sent only to your verified host. Active: ${l.credentials.filter((x) => x.status === 'active').map((x) => `${x.headerName} v${x.version}`).join(', ') || 'none'}` }),
        l.credentials.some((x) => x.status === 'active' && x.usable === false) && el('p', { class: 'problem', text: 'A saved credential can no longer be decrypted (it was stored under a vault key this server no longer has). Requests that need it will not be sent. Save the credential again below.' }),
        hdr, cred,
        el('button', { type: 'button', class: 'secondary', text: 'Save credential', onclick: async () => {
          // the write-only value leaves the page's memory and the field as soon as it is sent, before the page re-renders
          const value = memSecrets[l.id] || '';
          delete memSecrets[l.id];
          cred.value = '';
          const d = await act('/credential', { label: 'api-key', headerName: hdr.value, value }, 'Credential stored encrypted.');
          if (!d.ok) memSecrets[l.id] = value;
        } })));
    }

    // 3. test
    const testIn = bindState(el('input', { 'aria-label': 'Test input JSON' }), 'testInput', l.method === 'POST' ? '{"text":"hello"}' : '{"id":"eth"}');
    page.append(el('div', {},
      el('h3', { text: '3. Test your API (no buyer is charged)' }), testIn,
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'secondary', text: 'Run test', onclick: async () => {
        let input; try { input = JSON.parse(testIn.value || '{}'); } catch { st.note = { kind: 'bad', text: 'Test input must be valid JSON.' }; say('Test input must be valid JSON.', 'bad'); return; }
        say('Testing…', 'info');
        const d = await api(`/seller/listing/${l.id}/test`, { body: { input, ...(l.contractStatus.state === 'approved' ? { contractId: l.contract.id } : {}) }, bearer: session.seller });
        if (!d.ok) { say(fail(d), 'bad'); return; }
        const r = d.report;
        st.testResult = `${r.outcome} ${r.httpStatus || ''} ${r.elapsedMs ? r.elapsedMs + 'ms' : ''}${r.contract ? (r.contract.qualified ? ' · QUALIFIES for the approved contract' : ' · does NOT qualify') : ''}${r.failure ? ` · ${r.failure.code}: ${r.failure.message}` : ''}\n${r.bodyPreview || ''}`;
        saveUi(); say('Test finished.', r.outcome === 'RESPONDED' ? 'ok' : 'bad'); await renderSeller();
      } })),
      st.testResult && el('pre', { text: st.testResult }),
      l.tests.length > 0 && el('p', { class: 'muted', text: `${l.tests.length} recent test run(s) saved.` }),
    ));

    // 4. contract
    const contractBox = el('div', {}, el('h3', { text: '4. Response contract' }),
      el('p', { class: 'muted', text: 'The contract is the written definition of a qualifying response. Buyers are charged only when a response satisfies the approved version.' }));
    {
      contractBox.append(el('button', { type: 'button', class: 'secondary', text: 'Suggest a contract from a sample call', onclick: async () => {
        let input; try { input = JSON.parse(testIn.value || '{}'); } catch { say('Test input must be valid JSON.', 'bad'); return; }
        say('Calling your API for a sample…', 'info');
        const s = await api(`/seller/listing/${l.id}/suggest-contract`, { body: { input }, bearer: session.seller });
        if (!s.ok) { say(fail(s), 'bad'); return; }
        st.suggestion = s.suggestion; saveUi(); say('Suggestion ready: review it below.', 'ok'); await renderSeller();
      } }));
    }
    if (st.suggestion) {
      contractBox.append(el('div', { class: 'notice' }, el('strong', { text: 'Suggested contract (review before proposing):' }), el('pre', { text: JSON.stringify(st.suggestion.success, null, 2) }),
        el('div', { class: 'row' },
          el('button', { type: 'button', text: 'Propose this contract', onclick: async () => {
            const d = await act('/contract', { contract: st.suggestion }, 'Contract proposed. Approve it below.');
            if (d.ok) { delete st.suggestion; saveUi(); }
          } }),
          el('button', { type: 'button', class: 'secondary', text: 'Discard', onclick: () => { delete st.suggestion; saveUi(); renderSeller(); } }))));
    }
    contractBox.append(el('ul', {}, ...l.contracts.map((x) => el('li', {}, `v${x.version} ${x.status}: status ${x.rules.statuses.join('/')}, within ${x.rules.maxLatencyMs}ms, ${x.rules.fields.length} field rule(s)${x.rules.freshness ? `, ${x.rules.freshness.path} ≤ ${x.rules.freshness.maxAgeSeconds}s old` : ''} `,
      x.status === 'proposed' && el('button', { type: 'button', class: 'secondary', text: 'Approve', onclick: async () => {
        say('Approving…', 'info');
        const d = await api(`/seller/contract/${x.id}/approve`, { body: {}, bearer: session.seller });
        st.note = d.ok ? { kind: 'ok', text: `Contract v${x.version} approved.` } : { kind: 'bad', text: fail(d) }; saveUi();
        say(d.ok ? `Contract v${x.version} approved.` : fail(d), d.ok ? 'ok' : 'bad');
        await renderSeller(); loadCatalog();
      } })))));
    page.append(contractBox);

    // 5. publish
    const rd = l.publishReadiness;
    const pub = el('div', {}, el('h3', { text: '5. Publish' }));
    if (l.public) {
      pub.append(el('p', { class: 'notice', text: 'Published: buyers can find and run this API in the Buyer tab.' }),
        el('div', { class: 'row' },
          el('a', { class: 'btn', href: '#/buyer', text: 'View in the marketplace', onclick: () => { $('q').value = l.name; } }),
          el('button', { type: 'button', class: 'secondary', text: 'Unpublish', onclick: () => act('/unpublish', {}, 'Unpublished: it is private again.') })));
    } else {
      if (!rd.ready) pub.append(el('div', { class: 'problem' }, el('strong', { text: 'Not ready to publish yet:' }), el('ul', {}, ...rd.missing.map((m) => el('li', { text: m.message })))));
      else pub.append(el('p', { class: 'muted', text: 'All requirements are met. Publishing makes this listing visible to buyers.' }));
      pub.append(el('button', { type: 'button', ...(rd.ready ? {} : { disabled: '' }), text: 'Publish', onclick: () => act('/publish', {}, `Published at ${new Date().toLocaleTimeString()}. Buyers can now find "${l.name}" in the Buyer tab.`) }));
    }
    page.append(pub);
  }
  return page;
}

// ------------------------------------------------------------------ Buyer / Seller tabs
function currentView() { return /^#\/?seller(\/.*)?$/.test(location.hash) ? 'seller' : 'buyer'; }
const BUYER_PANELS = ['overview', 'explore', 'usage', 'funding', 'transactions'];
function currentPanel() {
  if (currentView() === 'seller') {
    const r = sellerRoute();
    return r.page === 'apis' ? 'apis' : r.page;
  }
  const m = /^#\/buyer\/(\w+)/.exec(location.hash);
  return m && BUYER_PANELS.includes(m[1]) ? m[1] : 'overview';
}
const PANEL_TITLES = { overview: 'Overview', explore: 'Explore APIs', usage: 'My API usage', funding: 'Wallet and funding', transactions: 'Transactions and receipts', apis: 'My APIs', new: 'Create API', earnings: 'Earnings', 'payout-settings': 'Payout settings', payouts: 'Payout history', edit: 'Manage API' };
function applyView() {
  const v = currentView();
  const panel = currentPanel();
  for (const sec of document.querySelectorAll('main [data-view]')) {
    // the run card is also hidden until a service is chosen; keep that rule
    const forceHidden = false;
    const inPanel = !sec.dataset.panel || sec.dataset.panel.split(' ').includes(panel);
    sec.hidden = sec.dataset.view !== v || forceHidden || !inPanel;
  }
  $('nav-buyer').hidden = v !== 'buyer';
  $('nav-seller').hidden = v !== 'seller';
  for (const a of document.querySelectorAll('.side-nav a')) a.classList.toggle('active', a.dataset.nav === panel && !a.closest('[hidden]'));
  $('page-title').textContent = `${v === 'buyer' ? 'Buyer' : 'Seller'} · ${PANEL_TITLES[panel] || ''}`;
  for (const name of ['buyer', 'seller']) {
    const t = $(`tab-${name}`);
    t.classList.toggle('active', name === v);
    t.setAttribute('aria-selected', name === v ? 'true' : 'false');
  }
  $('mode-line').textContent = v === 'buyer' ? 'You are in Buyer mode: browse APIs, fund your account in USDT and pay only for qualifying responses.' : 'You are in Seller mode: list APIs, verify ownership, set contracts and track earnings.';
  document.body.dataset.mode = v;
  window.scrollTo(0, 0);
  document.title = `Payrail ${v === 'buyer' ? 'Buyer' : 'Seller'}: ${PANEL_TITLES[panel] || ''}`;
  if (v === 'seller') renderSeller();
  else { loadCatalog(); renderBuyer(); renderHistory(); renderAddFunds(); }
}
window.addEventListener('hashchange', () => {
  // navigating closes the mobile menu (but the initial render must not, or a quick tap on Menu would be undone)
  document.body.classList.remove('nav-open');
  $('menu-btn').setAttribute('aria-expanded', 'false');
  applyView();
});
$('menu-btn').addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  $('menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
});

$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadCatalog, 250); });
(async () => {
  await loadConfig();
  loadCatalog(); renderBuyer(); renderHistory(); renderAgents(); renderSeller(); renderAddFunds();
  applyView();
})();
