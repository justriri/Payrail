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
const session = { buyer: store.get('payrail.buyer'), seller: store.get('payrail.seller'), sandboxSeed: store.get('payrail.sandboxSeed') };
let config = { mode: 'test-credits', sandbox: false, escrow: null, legend: {} };

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

const ORIGIN_CLASS = { 'buy-gateway': 'o-buy', 'buy-gateway-simulated': 'o-sim', 'payrail-seller': 'o-seller', 'payrail-sandbox': 'o-sandbox', 'payrail-demo': 'o-demo' };
const ORIGIN_SHORT = { 'buy-gateway': 'BUY GATEWAY', 'buy-gateway-simulated': 'BUY (SIMULATED)', 'payrail-seller': 'PAYRAIL SELLER', 'payrail-sandbox': 'SANDBOX', 'payrail-demo': 'DEMO' };

// ------------------------------------------------------------------ banner + legend
async function loadConfig() {
  const d = await api('/config');
  if (d.ok) config = d;
  const parts = [d.realFunds ? 'REAL FUNDS MODE' : 'TEST CREDITS ONLY: no real money moves in the marketplace'];
  if (d.sandbox) parts.push('sandbox sellers on');
  if (d.escrow) parts.push('testnet escrow on (Celo Sepolia, mock token)');
  $('mode-banner').textContent = `${parts.join(' · ')}. The Buy payment flow is separate and unchanged.`;
  const lg = $('legend');
  clear(lg);
  for (const [k, v] of Object.entries(d.legend || {})) lg.append(el('li', {}, el('span', { class: `badge ${ORIGIN_CLASS[k] || ''}`, text: ORIGIN_SHORT[k] || k }), ' ', v));
}

// ------------------------------------------------------------------ buyer
async function quickStart() {
  const d = await api('/buyer', { body: {} });
  if (!d.ok) return flash($('buyer'), fail(d), true);
  session.buyer = d.token; store.set('payrail.buyer', d.token);
  const c = await api('/credits', { body: { amount: '5' }, bearer: session.buyer });
  if (!c.ok) flash($('buyer'), fail(c), true);
  await renderBuyer(); renderHistory(); renderAgents(); renderEscrow();
}
async function renderBuyer() {
  const box = $('buyer');
  clear(box);
  if (!session.buyer) {
    box.append(
      el('p', { text: 'You do not need a wallet to try the marketplace. One click creates a test buyer with 5 test credits (not real money).' }),
      el('button', { type: 'button', text: 'Start testing: get 5 test credits', onclick: quickStart }),
    );
    return;
  }
  const me = await api('/me', { bearer: session.buyer });
  if (!me.ok) {
    session.buyer = null; store.set('payrail.buyer', null);
    return renderBuyer();
  }
  box.append(
    el('p', {}, el('strong', { text: `${me.available} ${me.asset}` }), ' available · ', `${me.held} held `, el('span', { class: 'badge', text: 'TEST CREDITS' })),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', text: 'Add 1 test credit', onclick: async () => {
        const d = await api('/credits', { body: { amount: '1' }, bearer: session.buyer });
        if (!d.ok) flash(box, fail(d), true);
        renderBuyer();
      } }),
      el('span', { class: 'muted', text: `Total test credits are capped at ${me.creditCap} per buyer.` }),
      el('button', { type: 'button', class: 'secondary', text: 'Forget this buyer', onclick: () => { session.buyer = null; store.set('payrail.buyer', null); renderBuyer(); renderHistory(); renderAgents(); renderEscrow(); } })),
    el('p', { class: 'muted', text: `Account: ${me.accountId}` }),
  );
}

// ------------------------------------------------------------------ catalog
let selected = null;
async function loadCatalog() {
  const q = $('q').value.trim();
  const d = await api(`/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const list = $('cat-list');
  clear(list);
  if (!d.ok) { $('cat-status').textContent = fail(d); return; }
  const counts = {};
  for (const it of d.items) counts[it.origin] = (counts[it.origin] || 0) + 1;
  $('cat-status').textContent = `${d.items.length} services · ` + Object.entries(counts).map(([k, n]) => `${n} ${ORIGIN_SHORT[k] || k}`).join(', ')
    + (d.buy.available ? '' : ` · Buy gateway: ${d.buy.message || 'unavailable'}`);
  for (const it of d.items) {
    const price = !it.pricing ? 'price on request'
      : it.pricing.kind === 'fixed' ? `${it.pricing.usd} ${it.pricing.asset}`
        : (it.pricing.minUsd === it.pricing.maxUsd ? `${it.pricing.minUsd} (indicative)` : `${it.pricing.minUsd}–${it.pricing.maxUsd} (indicative)`);
    const card = el('div', { class: 'svc' },
      el('div', {}, el('span', { class: `badge ${ORIGIN_CLASS[it.origin] || ''}`, text: ORIGIN_SHORT[it.origin] || it.origin }), ' ', !it.available && el('span', { class: 'badge', text: 'Unavailable' })),
      el('div', {}, el('strong', { text: it.title })),
      el('div', { class: 'muted', text: it.description.slice(0, 160) }),
      el('div', { class: 'price', text: price }),
      el('div', { class: 'muted', text: it.originLabel }),
    );
    if (it.execution === 'payrail-gateway') card.append(el('button', { type: 'button', text: 'Try it', onclick: () => select(it) }));
    else if (it.available) card.append(el('a', { href: '/', text: 'Pay with the Buy flow (real payment page)' }));
    list.append(card);
  }
}
async function select(it) {
  const d = await api(`/listing/${encodeURIComponent(it.id)}`);
  if (!d.ok) return alert(fail(d));
  selected = d.listing;
  $('run-card').hidden = false;
  $('run-title').textContent = `Run: ${selected.name}`;
  const r = selected.contract ? selected.contract.rules : null;
  $('run-terms').textContent = `You pay ${selected.price.usd} ${selected.price.asset} only if the response meets contract v${selected.contract ? selected.contract.version : '?'}`
    + (r ? ` (status ${r.statuses.join('/')}, JSON, within ${r.maxLatencyMs} ms, fields: ${r.fields.map((f) => `${f.path}:${f.type}`).join(', ')}${r.freshness ? `, ${r.freshness.path} no older than ${r.freshness.maxAgeSeconds}s` : ''}).` : '.')
    + ` Platform fee ${selected.feePercent}% comes out of the seller's share, not on top of your price.`;
  const hint = selected.method === 'POST' ? '{"text":"hello"}' : '{"id":"eth"}';
  $('run-input').value = selected.demo || selected.sandbox ? hint : '{}';
  $('run-hint').textContent = selected.demo || selected.sandbox
    ? 'Failure injection: add "scenario" with one of stale, http500, html, empty, wrongtype, missing, hang to see a non-qualifying or unresolved result.'
    : '';
  $('run-settle').hidden = !config.escrow;
  $('run-result').replaceChildren();
  $('run-card').scrollIntoView({ behavior: 'smooth' });
}
$('run-btn').addEventListener('click', async () => {
  if (!session.buyer) return ($('run-msg').textContent = 'Click "Start testing" in the Buyer card first.');
  let input;
  try { input = JSON.parse($('run-input').value || '{}'); } catch { return ($('run-msg').textContent = 'Input must be valid JSON.'); }
  const useEscrow = config.escrow && $('run-escrow').checked;
  $('run-msg').textContent = useEscrow ? 'Running through the TESTNET escrow (on-chain transactions, may take ~20s)…' : 'Running…';
  $('run-btn').disabled = true;
  const d = await api('/execute', { body: { listingId: selected.id, input, idempotencyKey: newKey(), ...(useEscrow ? { settlement: 'escrow' } : {}) }, bearer: session.buyer });
  $('run-btn').disabled = false;
  $('run-msg').textContent = '';
  const out = $('run-result');
  clear(out);
  if (!d.ok) { out.append(el('div', { class: 'problem', text: fail(d) })); return; }
  const r = d.result;
  const price = (Number(r.priceAtomic) / 1e6).toString();
  const headline = r.charged ? `Charged ${price} ${r.asset}: the response qualified.`
    : r.held ? 'Outcome unknown: your credits are held, not charged. They are released automatically if this stays unresolved.'
      : 'Not charged: the response did not meet the contract.';
  out.append(el('p', { class: 'headline', text: headline }), r.reason && el('p', { class: 'muted', text: r.reason }),
    d.settlement === 'escrow' && el('p', { class: 'notice', text: 'Settled through the Celo Sepolia TESTNET escrow contract (mock token).' }));
  if (r.checks.length) out.append(el('ul', {}, ...r.checks.map((c) => el('li', { text: `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}` }))));
  if (r.body !== undefined) out.append(el('pre', { text: JSON.stringify(r.body, null, 2) }));
  renderBuyer(); renderHistory(); renderEscrow();
  if (session.seller) renderSeller();
});

async function renderHistory() {
  const box = $('history');
  clear(box);
  if (!session.buyer) { box.textContent = 'Start testing first.'; return; }
  const d = await api('/executions', { bearer: session.buyer });
  if (!d.ok) { box.textContent = fail(d); return; }
  if (!d.executions.length) { box.textContent = 'No requests yet.'; return; }
  box.append(el('ul', {}, ...d.executions.map((e) => el('li', { text: `${e.at.slice(0, 19).replace('T', ' ')}  ${e.listing}  ${e.state === 'QUALIFIED' ? `charged ${e.price} ${e.asset}` : e.state === 'UNRESOLVED' ? `held ${e.price} ${e.asset} (outcome unknown)` : `not charged (${e.state})`}${e.reason && e.state !== 'QUALIFIED' ? ` — ${e.reason}` : ''}` }))));
}

// ------------------------------------------------------------------ buyer: agents, escrow, real funds
async function renderAgents() {
  const box = $('agents');
  clear(box);
  if (!session.buyer) { box.append(el('p', { class: 'muted', text: 'Start testing first.' })); return; }
  const d = await api('/agents', { bearer: session.buyer });
  if (!d.ok) { box.append(el('p', { class: 'problem', text: fail(d) })); return; }
  const name = el('input', { placeholder: 'Agent name, e.g. research-bot', value: 'my-agent' });
  const per = el('input', { value: '0.03', 'aria-label': 'Per-request cap' });
  const day = el('input', { value: '0.1', 'aria-label': 'Daily cap' });
  box.append(
    el('p', { class: 'muted', text: 'An agent key lets a script spend your test credits inside hard limits. It cannot create keys or change limits.' }),
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

async function renderEscrow() {
  const box = $('escrow');
  clear(box);
  if (!config.escrow) {
    box.append(el('p', { class: 'muted', text: 'Testnet escrow is not enabled on this server (start with --escrow-testnet and the testnet deployer key file).' }));
    return;
  }
  if (!session.buyer) { box.append(el('p', { class: 'muted', text: 'Start testing first.' })); return; }
  const d = await api('/escrow', { bearer: session.buyer });
  box.append(
    el('p', {}, el('span', { class: 'badge o-sim', text: 'TESTNET' }), ` Celo Sepolia · contract ${config.escrow.contract} · mock token, no real value`),
    el('p', { text: d.ok && d.wallet ? `Escrow balance for your test wallet: ${d.available} test tokens.` : 'No escrow deposit yet.' }),
    el('button', { type: 'button', class: 'secondary', text: 'Deposit 0.1 test tokens (sends a testnet transaction)', onclick: async () => {
      box.prepend(el('p', { class: 'notice', text: 'Sending a testnet transaction…' }));
      const r = await api('/escrow/testnet-deposit', { body: { amount: '0.1' }, bearer: session.buyer });
      flash(box, r.ok ? `Deposited. Tx ${r.txHash}` : fail(r), !r.ok);
      renderEscrow();
    } }),
    el('p', { class: 'muted', text: 'Then tick "Settle through the testnet escrow" when you run a service.' }),
  );
}

async function renderFunding() {
  const box = $('funding');
  clear(box);
  box.append(el('p', { class: 'muted', text: config.realFunds
    ? 'Real-funds mode is on. Register a wallet and deposit by following the instructions the server returns.'
    : 'Real-funds mode is OFF on this server. Deposits and payouts are disabled; everything in this page uses test credits.' }));
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
  const m = /^#\/seller(?:\/(new|api\/([\w-]{1,80})))?$/.exec(location.hash);
  if (!m || !m[1]) return { page: 'apis' };
  if (m[1] === 'new') return { page: 'new' };
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
  if (!window.ethereum) throw new Error('No browser wallet found. Use the sandbox seller instead, or install a wallet extension.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] });
  return { account, signature };
}
async function sellerLoginWallet() {
  const probe = await walletSign('Payrail: choose account');
  const s = await api('/seller/login/start', { body: { wallet: probe.account } });
  if (!s.ok) throw new Error(fail(s));
  const { signature } = await walletSign(s.message);
  const c = await api('/seller/login/complete', { body: { wallet: probe.account, nonce: s.nonce, signature } });
  if (!c.ok) throw new Error(fail(c));
  session.seller = c.token; store.set('payrail.seller', c.token);
  session.sandboxSeed = null; store.set('payrail.sandboxSeed', null);
}
async function sellerLoginSandbox() {
  const d = await api('/seller/sandbox/login', { body: session.sandboxSeed ? { seed: session.sandboxSeed } : {} });
  if (!d.ok) throw new Error(fail(d));
  session.seller = d.token; store.set('payrail.seller', d.token);
  session.sandboxSeed = d.seed; store.set('payrail.sandboxSeed', d.seed);
}
const signOutSeller = () => { session.seller = null; store.set('payrail.seller', null); say(''); renderSeller(); };

const STATUS_CLASS = { Published: 'ok', Suspended: 'bad', Draft: '', 'Pending verification': 'warn' };
const chip = (text, cls) => el('span', { class: `badge ${cls || ''}`, text });
const tick = (done, text) => el('li', { class: done ? 'step done' : 'step', text: `${done ? '✓' : '○'} ${text}` });

async function renderSeller() {
  const mine = ++renderToken;
  const box = $('seller');
  if (!session.seller) {
    clear(box);
    say('');
    box.append(
      el('p', { text: 'Sellers list an API, prove they own it, set a price and a response contract, and are paid only for qualifying responses.' }),
      el('div', { class: 'row' },
        config.sandbox && el('button', { type: 'button', text: 'Use the sandbox seller (no wallet needed)', onclick: async () => {
          try { await sellerLoginSandbox(); renderSeller(); } catch (e) { say(e.message, 'bad'); }
        } }),
        el('button', { type: 'button', class: 'secondary', text: 'Sign in with a browser wallet', onclick: async () => {
          try { await sellerLoginWallet(); renderSeller(); } catch (e) { say(e.message, 'bad'); }
        } })),
      config.sandbox && el('p', { class: 'muted', text: 'Sandbox: Payrail derives a test wallet for you and serves your sandbox API and verification file itself. It is a complete walk-through, but proves nothing about real ownership.' }),
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
      el('strong', { text: `Earnings: ${earn.earnings} ${earn.asset}` }), chip('TEST CREDITS'),
      config.sandbox && session.sandboxSeed && chip('SANDBOX SELLER', 'o-sandbox'),
      el('button', { type: 'button', class: 'secondary', text: 'Sign out', onclick: signOutSeller })),
    el('p', { class: 'muted', text: `${listings.length} API${listings.length === 1 ? '' : 's'} · ${published} published · payouts: ${config.realFunds ? 'available once you have real earnings' : 'disabled (test credits cannot be paid out)'}` }),
    el('nav', { class: 'subtabs', 'aria-label': 'Seller sections' },
      el('a', { class: `subtab${route.page === 'apis' ? ' active' : ''}`, href: '#/seller', text: `My APIs (${listings.length})` }),
      el('a', { class: `subtab${route.page === 'new' ? ' active' : ''}`, href: '#/seller/new', text: 'New listing' }),
      route.page === 'edit' && el('span', { class: 'subtab active', text: 'Manage API' })),
  );
  if (route.page === 'new') box.append(newListingPage());
  else if (route.page === 'edit') {
    const l = listings.find((x) => x.id === route.id);
    if (!l) { box.append(el('p', { class: 'problem', text: 'That listing was not found in your account.' }), el('a', { href: '#/seller', text: 'Back to My APIs' })); }
    else box.append(editorPage(l));
  } else box.append(myApisPage(listings, earn));
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
      el('div', {}, el('strong', { text: l.name }), ' ', chip(l.displayStatus, STATUS_CLASS[l.displayStatus] || ''), ' ',
        l.demo && chip('DEMO', 'o-demo'), l.sandbox && chip('SANDBOX', 'o-sandbox')),
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
  const rid = () => Math.random().toString(36).slice(2, 8);
  const preset = (label, path, method, name, price) => el('button', { type: 'button', class: 'secondary', text: label, onclick: () => {
    Object.assign(f, { url: `https://my-${rid()}.sandbox.payrail.example${path}`, method, name, price, desc: 'Sandbox API served by Payrail' });
    saveUi(); renderSeller();
  } });
  const method = el('select', {}, el('option', { value: 'GET', text: 'GET' }), el('option', { value: 'POST', text: 'POST' }));
  method.value = f.method; method.addEventListener('change', () => { f.method = method.value; saveUi(); });
  const msg = el('div', {});
  return el('div', {},
    el('h3', { text: 'New listing' }),
    config.sandbox && el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Sandbox presets:' }), preset('Price API', '/v1/price', 'GET', 'My sandbox price API', '0.01'), preset('Echo API', '/v1/echo', 'POST', 'My sandbox echo API', '0.005')),
    el('label', { text: 'Name' }), bind(el('input', { placeholder: 'e.g. Token price API' }), 'name'),
    el('label', { text: 'Description' }), bind(el('input', { placeholder: 'What does it return?' }), 'desc'),
    el('label', { text: 'Endpoint URL (https, fixed; buyers can only change input values)' }), bind(el('input', { placeholder: 'https://api.example.com/v1/price', type: 'url' }), 'url'),
    el('label', { text: 'HTTP method' }), method,
    el('label', { text: 'Price per qualifying response (test credits)' }), bind(el('input', { placeholder: 'e.g. 0.02' }), 'price'),
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
    el('div', {}, chip(l.displayStatus, STATUS_CLASS[l.displayStatus] || ''), ' ', l.demo && chip('DEMO', 'o-demo'), l.sandbox && chip('SANDBOX', 'o-sandbox')),
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
  if (ch && !l.demo) {
    page.append(el('div', {},
      el('h3', { text: '1. Verify ownership' }),
      el('p', { text: `Wallet proof: ${o.wallet ? 'done' : 'not done'}` }),
      !o.wallet && el('button', { type: 'button', class: 'secondary', text: session.sandboxSeed ? 'Sign (sandbox wallet)' : 'Sign with wallet', onclick: async () => {
        try {
          if (session.sandboxSeed) await act('/wallet-proof', { sandbox: true, seed: session.sandboxSeed }, 'Wallet proof recorded.');
          else { const { signature } = await walletSign(ch.walletMessage); await act('/wallet-proof', { signature }, 'Wallet proof recorded.'); }
        } catch (e) { say(e.message, 'bad'); }
      } }),
      el('p', { text: `Domain proof: ${o.domain ? `done (${o.domainMethod === 'dns_txt' ? 'DNS record' : 'well-known file'})` : l.sandbox ? 'not done: sandbox hosts are verified by Payrail itself, just press a check button' : 'not done: publish ONE of these, then check'}` }),
      !o.domain && !l.sandbox && el('pre', { text: `DNS TXT  ${ch.dnsRecord.name}\n  = ${ch.dnsRecord.value}\nor file  ${ch.wellKnown.url}\n  containing ${ch.wellKnown.content}` }),
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
    if (!l.demo) {
      const hdr = bindState(el('input', { placeholder: 'Header name, e.g. Authorization' }), 'credHeader', 'Authorization');
      const cred = el('input', { type: 'password', placeholder: 'API credential value (write-only)', autocomplete: 'off' });
      cred.value = memSecrets[l.id] || '';
      cred.addEventListener('input', () => { memSecrets[l.id] = cred.value; });
      page.append(el('div', {},
        el('h3', { text: '2. Credentials (optional)' }),
        el('p', { class: 'muted', text: `Stored encrypted, never shown again, sent only to your verified host. Active: ${l.credentials.filter((x) => x.status === 'active').map((x) => `${x.headerName} v${x.version}`).join(', ') || 'none'}` }),
        hdr, cred,
        el('button', { type: 'button', class: 'secondary', text: 'Save credential', onclick: async () => {
          const d = await act('/credential', { label: 'api-key', headerName: hdr.value, value: memSecrets[l.id] || '' }, 'Credential stored encrypted.');
          if (d.ok) delete memSecrets[l.id];
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
    if (!l.demo) {
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
function applyView() {
  const v = currentView();
  for (const sec of document.querySelectorAll('main [data-view]')) {
    // the run card is also hidden until a service is chosen; keep that rule
    const forceHidden = sec.id === 'run-card' && !selected;
    sec.hidden = sec.dataset.view !== v || forceHidden;
  }
  for (const name of ['buyer', 'seller']) {
    const t = $(`tab-${name}`);
    t.classList.toggle('active', name === v);
    t.setAttribute('aria-selected', name === v ? 'true' : 'false');
  }
  $('mode-line').textContent = v === 'buyer' ? 'You are in Buyer mode: browse services, run requests and manage test credits.' : 'You are in Seller mode: list APIs, verify ownership, set contracts and track earnings.';
  document.body.dataset.mode = v;
  window.scrollTo(0, 0);
  document.title = `Payrail ${v === 'buyer' ? 'Buyer' : 'Seller'}`;
  if (v === 'seller') renderSeller();
  else { loadCatalog(); renderBuyer(); renderHistory(); }
}
window.addEventListener('hashchange', applyView);

$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadCatalog, 250); });
(async () => {
  await loadConfig();
  loadCatalog(); renderBuyer(); renderHistory(); renderAgents(); renderEscrow(); renderFunding(); renderSeller();
  applyView();
})();
