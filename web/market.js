// Payrail marketplace UI (test credits). Plain JavaScript. All server text is written with textContent, never as HTML.
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

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* optional */ } },
};
const session = { buyer: store.get('payrail.buyer'), seller: store.get('payrail.seller') };

async function api(path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const opts = body === undefined ? { method: 'GET', headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-payrail-token': TOKEN }, body: JSON.stringify(body) };
  const r = await fetch(`/api/market${path}`, opts);
  let d;
  try { d = await r.json(); } catch { d = { ok: false, message: 'Unreadable answer from the server.' }; }
  return d;
}
const fail = (d) => `${d.message || 'Request failed'}${d.code ? ` (${d.code})` : ''}`;
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------------ buyer
async function renderBuyer() {
  const box = $('buyer');
  clear(box);
  if (!session.buyer) {
    box.append(el('p', { text: 'Create a test buyer account to try services with test credits.' }),
      el('button', { type: 'button', text: 'Create test buyer', onclick: async () => {
        const d = await api('/buyer', { body: {} });
        if (!d.ok) return box.append(el('p', { class: 'problem', text: fail(d) }));
        session.buyer = d.token; store.set('payrail.buyer', d.token);
        renderBuyer(); renderHistory();
      } }));
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
        if (!d.ok) alert(fail(d));
        renderBuyer();
      } }),
      el('span', { class: 'muted', text: `Test credits are capped at ${me.creditCap} per buyer.` })),
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
  $('cat-status').textContent = `${d.items.length} services` + (d.buy.available ? '' : ` · Buy gateway: ${d.buy.message || 'unavailable'}`);
  for (const it of d.items) {
    const price = !it.pricing ? 'price on request'
      : it.pricing.kind === 'fixed' ? `${it.pricing.usd} ${it.pricing.asset}`
        : (it.pricing.minUsd === it.pricing.maxUsd ? `${it.pricing.minUsd} (indicative)` : `${it.pricing.minUsd}–${it.pricing.maxUsd} (indicative)`);
    const card = el('div', { class: 'svc' },
      el('div', {}, el('strong', { text: it.title }), ' ', it.demo && el('span', { class: 'badge', text: 'DEMO' })),
      el('div', { class: 'muted', text: it.description.slice(0, 160) }),
      el('div', { class: 'price', text: price }),
      el('div', {}, el('span', { class: 'badge', text: it.execution === 'payrail-gateway' ? 'Pay only if it qualifies' : 'Direct x402 (Buy gateway)' }), ' ', !it.available && el('span', { class: 'badge', text: 'Unavailable' })),
    );
    if (it.execution === 'payrail-gateway') card.append(el('button', { type: 'button', text: 'Try it', onclick: () => select(it) }));
    else if (it.available) card.append(el('a', { href: '/', text: 'Pay with the Buy flow' }));
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
  $('run-input').value = selected.demo ? (selected.method === 'GET' ? '{"id":"eth"}' : '{"text":"hello"}') : '{}';
  $('run-result').replaceChildren();
  $('run-card').scrollIntoView({ behavior: 'smooth' });
}
$('run-btn').addEventListener('click', async () => {
  if (!session.buyer) return ($('run-msg').textContent = 'Create a test buyer first.');
  let input;
  try { input = JSON.parse($('run-input').value || '{}'); } catch { return ($('run-msg').textContent = 'Input must be valid JSON.'); }
  $('run-msg').textContent = 'Running…';
  const d = await api('/execute', { body: { listingId: selected.id, input, idempotencyKey: newKey() }, bearer: session.buyer });
  $('run-msg').textContent = '';
  const out = $('run-result');
  clear(out);
  if (!d.ok) { out.append(el('div', { class: 'problem', text: fail(d) })); return; }
  const r = d.result;
  const headline = r.charged ? `Charged ${r.priceAtomic / 1e6} ${r.asset}: the response qualified.`
    : r.held ? 'Outcome unknown: your credits are held, not charged. They are released automatically if this stays unresolved.'
      : 'Not charged: the response did not meet the contract.';
  out.append(el('p', { class: 'headline', text: headline }), r.reason && el('p', { class: 'muted', text: r.reason }));
  if (r.checks.length) out.append(el('ul', {}, ...r.checks.map((c) => el('li', { text: `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}` }))));
  if (r.body !== undefined) out.append(el('pre', { text: JSON.stringify(r.body, null, 2) }));
  renderBuyer(); renderHistory();
});

async function renderHistory() {
  const box = $('history');
  clear(box);
  if (!session.buyer) { box.textContent = 'Create a buyer first.'; return; }
  const d = await api('/executions', { bearer: session.buyer });
  if (!d.ok) { box.textContent = fail(d); return; }
  if (!d.executions.length) { box.textContent = 'No requests yet.'; return; }
  box.append(el('ul', {}, ...d.executions.map((e) => el('li', { text: `${e.at.slice(0, 19).replace('T', ' ')}  ${e.listing}  ${e.state === 'QUALIFIED' ? `charged ${e.price} ${e.asset}` : e.state === 'UNRESOLVED' ? `held ${e.price} ${e.asset} (outcome unknown)` : `not charged (${e.state})`}${e.reason && e.state !== 'QUALIFIED' ? ` — ${e.reason}` : ''}` }))));
}

// ------------------------------------------------------------------ seller
async function walletSign(message) {
  if (!window.ethereum) throw new Error('No browser wallet found. Install a wallet extension to sign.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] });
  return { account, signature };
}
async function sellerLogin() {
  const probe = await walletSign('Payrail: choose account');
  const s = await api('/seller/login/start', { body: { wallet: probe.account } });
  if (!s.ok) throw new Error(fail(s));
  const { signature } = await walletSign(s.message);
  const c = await api('/seller/login/complete', { body: { wallet: probe.account, nonce: s.nonce, signature } });
  if (!c.ok) throw new Error(fail(c));
  session.seller = c.token; store.set('payrail.seller', c.token);
}
const msg = (box, text, bad) => { const p = el('p', { class: bad ? 'problem' : 'muted', text }); box.prepend(p); setTimeout(() => p.remove(), 8000); };

async function renderSeller() {
  const box = $('seller');
  clear(box);
  if (!session.seller) {
    box.append(el('button', { type: 'button', text: 'Sign in with wallet', onclick: async () => {
      try { await sellerLogin(); renderSeller(); } catch (e) { msg(box, e.message, true); }
    } }));
    return;
  }
  const [ls, earn] = await Promise.all([api('/seller/listings', { bearer: session.seller }), api('/seller/earnings', { bearer: session.seller })]);
  if (!ls.ok) { session.seller = null; store.set('payrail.seller', null); return renderSeller(); }
  box.append(
    el('p', {}, el('strong', { text: `Earnings: ${earn.earnings} ${earn.asset}` }), el('span', { class: 'badge', text: 'TEST CREDITS' }), ' ',
      el('button', { type: 'button', class: 'secondary', text: 'Sign out', onclick: () => { session.seller = null; store.set('payrail.seller', null); renderSeller(); } })),
    submitForm(box),
  );
  for (const l of ls.listings) box.append(listingPanel(l, box));
}
function submitForm(box) {
  const f = { name: el('input', { placeholder: 'Name' }), url: el('input', { placeholder: 'https://api.example.com/v1/price', type: 'url' }),
    price: el('input', { placeholder: 'Price per qualifying response, e.g. 0.02' }), method: el('select', {}, el('option', { value: 'GET', text: 'GET' }), el('option', { value: 'POST', text: 'POST' })),
    desc: el('input', { placeholder: 'Short description' }) };
  return el('details', {}, el('summary', { text: 'List a new API' }), f.name, f.desc, f.url, f.method, f.price,
    el('button', { type: 'button', text: 'Submit listing', onclick: async () => {
      const d = await api('/seller/listings', { body: { name: f.name.value, description: f.desc.value, endpointUrl: f.url.value, method: f.method.value, price: f.price.value }, bearer: session.seller });
      if (!d.ok) return msg(box, fail(d), true);
      renderSeller();
    } }));
}
function listingPanel(l, box) {
  const act = async (path, body, okText) => {
    const d = await api(`/seller/listing/${l.id}${path}`, { body: body || {}, bearer: session.seller });
    if (!d.ok) return msg(box, fail(d), true);
    if (okText) msg(box, okText);
    renderSeller();
    return d;
  };
  const p = el('div', { class: 'svc' },
    el('div', {}, el('strong', { text: l.name }), ' ', el('span', { class: 'badge', text: l.status }), ' ', l.demo && el('span', { class: 'badge', text: 'DEMO' })),
    el('div', { class: 'muted', text: `${l.method} ${l.endpointUrl} · ${l.price.usd} ${l.price.asset} · fee ${l.feePercent}%` }),
  );
  if (l.challenge) {
    const c = l.challenge;
    p.append(el('div', {},
      el('p', { text: `1. Wallet proof: ${c.walletVerified ? 'done' : 'sign the listing challenge'}` }),
      !c.walletVerified && el('button', { type: 'button', class: 'secondary', text: 'Sign with wallet', onclick: async () => {
        try { const { signature } = await walletSign(c.walletMessage); await act('/wallet-proof', { signature }, 'Wallet proof recorded.'); } catch (e) { msg(box, e.message, true); }
      } }),
      el('p', { text: `2. Domain proof: ${c.domainVerified ? `done (${c.domainMethod})` : 'publish ONE of these, then check'}` }),
      !c.domainVerified && el('pre', { text: `DNS TXT  ${c.dnsRecord.name}\n  = ${c.dnsRecord.value}\nor file  ${c.wellKnown.url}\n  containing ${c.wellKnown.content}` }),
      !c.domainVerified && el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', text: 'Check DNS', onclick: () => act('/domain-proof', { method: 'dns_txt' }, 'Domain verified.') }),
        el('button', { type: 'button', class: 'secondary', text: 'Check file', onclick: () => act('/domain-proof', { method: 'well_known' }, 'Domain verified.') })),
    ));
  }
  if (l.status !== 'draft' && l.status !== 'suspended') {
    const cred = el('input', { type: 'password', placeholder: 'API credential value (write-only)', autocomplete: 'off' });
    const hdr = el('input', { placeholder: 'Header name, e.g. Authorization', value: 'Authorization' });
    const testIn = el('input', { value: '{}', 'aria-label': 'Test input JSON' });
    p.append(el('div', {},
      !l.demo && el('div', {}, el('p', { class: 'muted', text: `Credentials: ${l.credentials.filter((c) => c.status === 'active').map((c) => `${c.label} v${c.version}`).join(', ') || 'none'} (values are never shown)` }), hdr, cred,
        el('button', { type: 'button', class: 'secondary', text: 'Save credential', onclick: async () => {
          const v = cred.value; cred.value = '';
          await act('/credential', { label: 'api-key', headerName: hdr.value, value: v }, 'Credential stored encrypted.');
        } })),
      el('p', { text: 'Test your API (no buyer is charged):' }), testIn,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', text: 'Run test', onclick: async () => {
          let input; try { input = JSON.parse(testIn.value || '{}'); } catch { return msg(box, 'Test input must be JSON.', true); }
          const d = await api(`/seller/listing/${l.id}/test`, { body: { input, ...(l.contract ? { contractId: l.contract.id } : {}) }, bearer: session.seller });
          msg(box, d.ok ? `Test: ${d.report.outcome} ${d.report.httpStatus || ''} ${d.report.elapsedMs || ''}ms${d.report.contract ? (d.report.contract.qualified ? ' · QUALIFIES' : ' · does NOT qualify') : ''}${d.report.failure ? ` · ${d.report.failure.message}` : ''}` : fail(d), !d.ok);
        } }),
        !l.demo && el('button', { type: 'button', class: 'secondary', text: 'Suggest contract', onclick: async () => {
          let input; try { input = JSON.parse(testIn.value || '{}'); } catch { return msg(box, 'Test input must be JSON.', true); }
          const s = await api(`/seller/listing/${l.id}/suggest-contract`, { body: { input }, bearer: session.seller });
          if (!s.ok) return msg(box, fail(s), true);
          if (confirm(`Propose this contract?\n${JSON.stringify(s.suggestion.success, null, 2)}`)) await act('/contract', { contract: s.suggestion }, 'Contract proposed. Approve it below.');
        } }),
        l.status !== 'published' ? el('button', { type: 'button', text: 'Publish', onclick: () => act('/publish', {}, 'Published.') }) : el('button', { type: 'button', class: 'secondary', text: 'Unpublish', onclick: () => act('/unpublish', {}, 'Unpublished.') })),
      el('ul', {}, ...l.contracts.map((c) => el('li', {}, `v${c.version} ${c.status} `, c.status === 'proposed' && el('button', { type: 'button', class: 'secondary', text: 'Approve', onclick: async () => {
        const d = await api(`/seller/contract/${c.id}/approve`, { body: {}, bearer: session.seller });
        msg(box, d.ok ? 'Contract approved.' : fail(d), !d.ok); renderSeller();
      } })))),
    ));
  }
  return p;
}

$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadCatalog, 250); });
loadCatalog(); renderBuyer(); renderHistory(); renderSeller();
