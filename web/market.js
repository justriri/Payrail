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
const signOutSeller = () => { session.seller = null; store.set('payrail.seller', null); renderSeller(); };

const STEP = (done, text) => el('li', { class: done ? 'step done' : 'step', text: `${done ? '✓' : '○'} ${text}` });

async function renderSeller() {
  const box = $('seller');
  clear(box);
  if (!session.seller) {
    box.append(
      el('p', { text: 'Sellers list an API, prove they own it, set a price and a response contract, and are paid only for qualifying responses.' }),
      el('div', { class: 'row' },
        config.sandbox && el('button', { type: 'button', text: 'Use the sandbox seller (no wallet needed)', onclick: async () => {
          try { await sellerLoginSandbox(); renderSeller(); } catch (e) { flash(box, e.message, true); }
        } }),
        el('button', { type: 'button', class: 'secondary', text: 'Sign in with a browser wallet', onclick: async () => {
          try { await sellerLoginWallet(); renderSeller(); } catch (e) { flash(box, e.message, true); }
        } })),
      config.sandbox && el('p', { class: 'muted', text: 'Sandbox: Payrail derives a test wallet for you and serves your sandbox API and verification file itself. It is a complete walk-through, but proves nothing about real ownership.' }),
    );
    return;
  }
  const [me, ls, earn] = await Promise.all([api('/me', { bearer: session.seller }), api('/seller/listings', { bearer: session.seller }), api('/seller/earnings', { bearer: session.seller })]);
  if (!ls.ok || !me.ok) { signOutSeller(); return; }
  const sandboxAccount = Boolean(session.sandboxSeed);
  box.append(
    el('div', { class: 'row' },
      el('strong', { text: `Earnings: ${earn.earnings} ${earn.asset}` }), el('span', { class: 'badge', text: 'TEST CREDITS' }),
      sandboxAccount && el('span', { class: 'badge o-sandbox', text: 'SANDBOX SELLER' }),
      el('button', { type: 'button', class: 'secondary', text: 'Sign out', onclick: signOutSeller })),
    el('p', { class: 'muted', text: `Account ${me.accountId}` }),
  );
  // earnings by outcome
  if (earn.byState.length) {
    box.append(el('table', {}, el('tr', {}, el('th', { text: 'Outcome' }), el('th', { text: 'Requests' }), el('th', { text: 'You earned' })),
      ...earn.byState.map((s) => el('tr', {}, el('td', { text: s.state }), el('td', { text: String(s.count) }), el('td', { text: s.sellerAtomic })))));
  }
  if (earn.recent.length) {
    box.append(el('details', {}, el('summary', { text: `Recent requests (${earn.recent.length})` }),
      el('ul', {}, ...earn.recent.map((e) => el('li', { text: `${e.at.slice(0, 19).replace('T', ' ')}  ${e.listing}  ${e.state}  ${e.price} ${e.asset}${e.reason ? ` — ${e.reason}` : ''}` })))));
  }
  box.append(el('p', { class: 'muted', text: 'Payouts: ' + (config.realFunds ? 'request a payout below once you have real earnings.' : 'disabled. Earnings here are test credits and cannot be paid out.') }));
  box.append(submitForm(box));
  if (!ls.listings.length) box.append(el('p', { class: 'muted', text: 'No listings yet. Open "List a new API" above.' }));
  for (const l of ls.listings) box.append(listingPanel(l, box));
}

function submitForm(box) {
  const f = {
    name: el('input', { placeholder: 'Name' }), desc: el('input', { placeholder: 'Short description' }),
    url: el('input', { placeholder: 'https://api.example.com/v1/price', type: 'url' }),
    method: el('select', {}, el('option', { value: 'GET', text: 'GET' }), el('option', { value: 'POST', text: 'POST' })),
    price: el('input', { placeholder: 'Price per qualifying response, e.g. 0.02' }),
  };
  const rid = () => Math.random().toString(36).slice(2, 8);
  const preset = (label, path, method, name, price) => el('button', { type: 'button', class: 'secondary', text: label, onclick: () => {
    f.url.value = `https://my-${rid()}.sandbox.payrail.example${path}`;
    f.method.value = method; f.name.value = name; f.price.value = price; f.desc.value = 'Sandbox API served by Payrail';
  } });
  return el('details', { open: '' }, el('summary', { text: 'List a new API' }),
    config.sandbox && el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Sandbox presets:' }),
      preset('Price API', '/v1/price', 'GET', 'My sandbox price API', '0.01'), preset('Echo API', '/v1/echo', 'POST', 'My sandbox echo API', '0.005')),
    f.name, f.desc, f.url, f.method, f.price,
    el('button', { type: 'button', text: 'Submit listing', onclick: async () => {
      const d = await api('/seller/listings', { body: { name: f.name.value, description: f.desc.value, endpointUrl: f.url.value, method: f.method.value, price: f.price.value }, bearer: session.seller });
      if (!d.ok) return flash(box, fail(d), true);
      renderSeller();
    } }));
}

function listingPanel(l, box) {
  const act = async (path, body, okText) => {
    const d = await api(`/seller/listing/${l.id}${path}`, { body: body || {}, bearer: session.seller });
    if (!d.ok) { flash(box, fail(d), true); return d; }
    if (okText) flash(box, okText);
    renderSeller();
    loadCatalog();
    return d;
  };
  const c = l.challenge;
  const hasContract = l.contract !== null;
  const p = el('div', { class: 'svc wide' },
    el('div', {}, el('strong', { text: l.name }), ' ', el('span', { class: 'badge', text: l.status }), ' ', l.demo && el('span', { class: 'badge o-demo', text: 'DEMO' }), l.sandbox && el('span', { class: 'badge o-sandbox', text: 'SANDBOX' })),
    el('div', { class: 'muted', text: `${l.method} ${l.endpointUrl} · ${l.price.usd} ${l.price.asset} · fee ${l.feePercent}%` }),
    el('ul', { class: 'steps' },
      STEP(l.status !== 'draft', 'Ownership verified (wallet proof + domain proof)'),
      STEP(l.credentials.some((x) => x.status === 'active') || l.demo || l.sandbox, 'Credentials (optional): stored encrypted, write-only'),
      STEP(l.tests.length > 0, 'Tested'),
      STEP(hasContract, 'Contract approved'),
      STEP(l.status === 'published', 'Published'),
    ),
  );
  if (c && l.status === 'draft') {
    p.append(el('div', {},
      el('p', { text: `1. Wallet proof: ${c.walletVerified ? 'done' : 'sign the listing challenge'}` }),
      !c.walletVerified && el('button', { type: 'button', class: 'secondary', text: session.sandboxSeed ? 'Sign (sandbox wallet)' : 'Sign with wallet', onclick: async () => {
        try {
          if (session.sandboxSeed) await act('/wallet-proof', { sandbox: true, seed: session.sandboxSeed }, 'Wallet proof recorded.');
          else { const { signature } = await walletSign(c.walletMessage); await act('/wallet-proof', { signature }, 'Wallet proof recorded.'); }
        } catch (e) { flash(box, e.message, true); }
      } }),
      el('p', { text: `2. Domain proof: ${c.domainVerified ? `done (${c.domainMethod})` : l.sandbox ? 'sandbox hosts are verified by Payrail itself: just press a check button' : 'publish ONE of these, then check'}` }),
      !c.domainVerified && !l.sandbox && el('pre', { text: `DNS TXT  ${c.dnsRecord.name}\n  = ${c.dnsRecord.value}\nor file  ${c.wellKnown.url}\n  containing ${c.wellKnown.content}` }),
      !c.domainVerified && el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', text: 'Check DNS', onclick: () => act('/domain-proof', { method: 'dns_txt' }, 'Domain verified.') }),
        el('button', { type: 'button', class: 'secondary', text: 'Check file', onclick: () => act('/domain-proof', { method: 'well_known' }, 'Domain verified.') })),
    ));
  }
  if (l.status !== 'draft' && l.status !== 'suspended') {
    const cred = el('input', { type: 'password', placeholder: 'API credential value (write-only)', autocomplete: 'off' });
    const hdr = el('input', { placeholder: 'Header name, e.g. Authorization', value: 'Authorization' });
    const testIn = el('input', { value: l.method === 'POST' ? '{"text":"hello"}' : '{"id":"eth"}', 'aria-label': 'Test input JSON' });
    const result = el('div', {});
    p.append(el('div', {},
      !l.demo && el('div', {}, el('p', { class: 'muted', text: `Credentials: ${l.credentials.filter((x) => x.status === 'active').map((x) => `${x.label} v${x.version}`).join(', ') || 'none'} (values are never shown)` }), hdr, cred,
        el('button', { type: 'button', class: 'secondary', text: 'Save credential', onclick: async () => {
          const v = cred.value; cred.value = '';
          await act('/credential', { label: 'api-key', headerName: hdr.value, value: v }, 'Credential stored encrypted.');
        } })),
      el('p', { text: 'Test your API (no buyer is charged):' }), testIn,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', text: 'Run test', onclick: async () => {
          let input; try { input = JSON.parse(testIn.value || '{}'); } catch { return flash(box, 'Test input must be JSON.', true); }
          const d = await api(`/seller/listing/${l.id}/test`, { body: { input, ...(l.contract ? { contractId: l.contract.id } : {}) }, bearer: session.seller });
          clear(result);
          if (!d.ok) return result.append(el('p', { class: 'problem', text: fail(d) }));
          const r = d.report;
          result.append(el('p', { text: `${r.outcome} ${r.httpStatus || ''} ${r.elapsedMs ? r.elapsedMs + 'ms' : ''}${r.contract ? (r.contract.qualified ? ' · QUALIFIES' : ' · does NOT qualify') : ''}${r.failure ? ` · ${r.failure.code}: ${r.failure.message}` : ''}` }));
          if (r.bodyPreview) result.append(el('pre', { text: r.bodyPreview }));
        } }),
        !l.demo && el('button', { type: 'button', class: 'secondary', text: 'Suggest contract from a sample', onclick: async () => {
          let input; try { input = JSON.parse(testIn.value || '{}'); } catch { return flash(box, 'Test input must be JSON.', true); }
          const s = await api(`/seller/listing/${l.id}/suggest-contract`, { body: { input }, bearer: session.seller });
          if (!s.ok) return flash(box, fail(s), true);
          if (confirm(`Propose this contract?\n${JSON.stringify(s.suggestion.success, null, 2)}`)) await act('/contract', { contract: s.suggestion }, 'Contract proposed. Approve it below.');
        } }),
        l.status !== 'published'
          ? el('button', { type: 'button', text: 'Publish', onclick: () => act('/publish', {}, 'Published: buyers can now find it.') })
          : el('button', { type: 'button', class: 'secondary', text: 'Unpublish', onclick: () => act('/unpublish', {}, 'Unpublished.') })),
      result,
      el('ul', {}, ...l.contracts.map((x) => el('li', {}, `contract v${x.version} ${x.status} `, x.status === 'proposed' && el('button', { type: 'button', class: 'secondary', text: 'Approve', onclick: async () => {
        const d = await api(`/seller/contract/${x.id}/approve`, { body: {}, bearer: session.seller });
        flash(box, d.ok ? 'Contract approved.' : fail(d), !d.ok); renderSeller(); loadCatalog();
      } })))),
    ));
  }
  return p;
}


// ------------------------------------------------------------------ Buyer / Seller tabs
function currentView() { return /^#\/?seller$/.test(location.hash) ? 'seller' : 'buyer'; }
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
}
window.addEventListener('hashchange', applyView);

$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadCatalog, 250); });
(async () => {
  await loadConfig();
  loadCatalog(); renderBuyer(); renderHistory(); renderAgents(); renderEscrow(); renderFunding(); renderSeller();
  applyView();
})();
