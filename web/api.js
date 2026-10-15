// Payrail API details and purchase page. Plain JavaScript. All server text is written with textContent, never as HTML.
// Opening this page NEVER charges anything: it only reads the listing and its quote. A charge happens only when the buyer
// confirms a request, and the server then applies the normal outcome-based billing (reserve, validate, charge or release).
'use strict';

const TOKEN = document.querySelector('meta[name="payrail-token"]').content;
const root = document.getElementById('api-root');
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* optional */ } },
};
let buyerToken = store.get('payrail.buyer');
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function api(path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const opts = body === undefined ? { method: 'GET', headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-payrail-token': TOKEN }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(`/api/market${path}`, opts); } catch { return { ok: false, message: 'Could not reach the Payrail server.' }; }
  try { return await r.json(); } catch { return { ok: false, message: 'Unreadable answer from the server.' }; }
}
const fail = (d) => `${d.message || 'Something went wrong.'}${d.code ? ` (${d.code})` : ''}${d.hint ? ` ${d.hint}` : ''}`;

// ---- client-side input check (the server enforces the same rules and refuses bad input before reserving anything)
function checkInput(text, rules) {
  let v;
  try { v = JSON.parse(text.trim() === '' ? '{}' : text); } catch { return { ok: false, problem: 'The input is not valid JSON.' }; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, problem: 'The input must be a JSON object such as {"id":"eth"}.' };
  const entries = Object.entries(v);
  if (entries.length > rules.maxFields) return { ok: false, problem: `At most ${rules.maxFields} fields are allowed.` };
  for (const [k, x] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/.test(k) || k === '__proto__') return { ok: false, problem: `"${k}" is not a valid field name.` };
    if (typeof x === 'string' ? x.length > 500 : typeof x === 'number' ? !Number.isFinite(x) : typeof x !== 'boolean') return { ok: false, problem: `The value of "${k}" must be text (up to 500 characters), a number or true/false.` };
  }
  if (JSON.stringify(v).length > rules.maxBytes) return { ok: false, problem: 'The input is too large.' };
  return { ok: true, value: v };
}

function table(rows) {
  return el('table', { class: 'quote' }, ...rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { class: 'v', text: String(v) }))));
}

async function showReceipt(box, id) {
  const d = await api(`/receipt/${encodeURIComponent(id)}`, { bearer: buyerToken });
  if (!d.ok) { box.append(el('p', { class: 'problem', text: fail(d) })); return; }
  const r = d.receipt;
  box.append(table([
    ['Receipt', r.receiptId], ['Outcome', r.outcome], ['Charged', `${r.charged.display} ${r.asset}`], ['Held (not charged)', `${r.held.display} ${r.asset}`],
    ['Returned to you', `${r.returned.display} ${r.asset}`], ['Platform fee', r.platformFee ? `${r.platformFee.display} ${r.asset}` : '—'],
    ['Seller earned', r.sellerEarned ? `${r.sellerEarned.display} ${r.asset}` : '—'],
    ['Settlement', r.settlement === 'escrow' ? 'on-chain escrow (testnet)' : 'Payrail ledger'], ['Contract', r.contract ? `v${r.contract.version}` : '—'],
    ['Response hash', r.validation.responseSha256 || '—'], ['Idempotency key', r.idempotencyKey],
  ]));
  if (r.ledger.length) box.append(el('p', { class: 'muted', text: 'Ledger entries: ' + r.ledger.map((t) => `#${t.id} ${t.kind}`).join(', ') }));
  if (r.escrow) box.append(el('p', { class: 'muted', text: `Escrow hold ${r.escrow.holdId || '—'} · ` + Object.entries(r.escrow.txs).map(([k, v]) => `${k}: ${v}`).join(' · ') }));
  box.append(el('p', { class: 'muted', text: r.validation.note }));
}

async function main() {
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!/^[\w-]{1,80}$/.test(id)) return notFound('No API was specified.');
  const [d, cfg] = await Promise.all([api(`/listing/${encodeURIComponent(id)}`), api('/config')]);
  if (!d.ok) return notFound(d.code === 'NOT_FOUND' ? 'This API does not exist or is not published.' : fail(d));
  render(d, cfg.ok ? cfg : {});
}

function notFound(text) {
  clear(root);
  document.title = 'API not found · Payrail';
  root.append(el('div', { class: 'card' }, el('h1', { text: 'API not available' }), el('p', { id: 'api-error', text: text }),
    el('a', { class: 'btn', href: '/market.html#/buyer/explore', text: 'Back to the marketplace' })));
}

function render(d, cfg) {
  const l = d.listing;
  const q = d.quote;
  const rules = d.inputRules;
  document.title = `${l.name} · Payrail`;
  clear(root);
  const kind = l.demo ? ['DEMO', 'o-demo'] : l.sandbox ? ['SANDBOX', 'o-sandbox'] : ['PAYRAIL SELLER', 'o-seller'];

  // ---------------------------------------------------------------- details (left)
  const details = el('section', { class: 'card', id: 'api-details' },
    el('p', { class: 'eyebrow', text: 'API details' }),
    el('h1', { id: 'api-name', text: l.name }),
    el('p', {}, el('span', { class: `badge ${kind[1]}`, text: kind[0] }), ' ',
      el('span', { class: `badge ${q.available ? 'ok' : 'warn'}`, id: 'api-status', text: q.available ? 'Published' : 'Unavailable' }), ' ',
      el('span', { class: 'muted', id: 'api-seller', text: `Seller: ${l.seller}` })),
    el('p', { id: 'api-description', text: l.description || 'The seller has not added a description.' }),
    el('h3', { text: 'Pricing and billing' }),
    table([
      ['Price per request', `${q.buyerPays.display} ${q.asset}`],
      ['Billing method', 'Outcome-based: charged only if the response meets the contract'],
      [`Platform fee (${q.platformFee.percent}%, taken from the seller's share)`, `${q.platformFee.display} ${q.asset}`],
      ['Seller receives', `${q.sellerReceives.display} ${q.asset}`],
    ]),
    el('h3', { text: 'What you receive' }),
    el('p', { text: `A JSON response from the seller's endpoint (${l.method}, host ${l.host}). You are charged only if it satisfies all of these conditions (contract v${q.contract ? q.contract.version : '?'}):` }),
    el('ul', { id: 'api-conditions' }, ...q.chargedOnlyIf.map((c) => el('li', { text: c }))),
    el('h3', { text: 'Required inputs' }),
    el('p', { text: rules.format }),
    el('p', { class: 'muted', text: rules.nameRule }),
    el('p', { class: 'muted', text: rules.note }),
    el('h3', { text: 'Limits and requirements' }),
    el('ul', {},
      el('li', { text: `The response must arrive within ${q.maxLatencyMs === null ? 'the contract limit' : `${q.maxLatencyMs} ms`}.` }),
      q.freshness && el('li', { text: `Data must be fresher than ${q.freshness.maxAgeSeconds} seconds (field "${q.freshness.path}").` }),
      el('li', { text: `Up to ${rules.maxFields} input fields, ${rules.maxBytes} bytes in total.` }),
      el('li', { text: 'You need an available balance of at least the price. The amount is reserved first and released if the response does not qualify.' }),
      el('li', { text: 'Repeating a request with the same idempotency key never charges twice.' })),
    el('details', {}, el('summary', { text: 'What happens if it does not qualify, or the outcome is unknown?' }), el('ul', {}, ...q.notCharged.map((c) => el('li', { text: c })))),
    el('p', { class: 'notice', text: q.validationNote }));

  // ---------------------------------------------------------------- purchase (right)
  const msg = el('p', { class: 'muted', id: 'run-msg', role: 'status' });
  const out = el('div', { id: 'run-result' });
  const input = el('textarea', { id: 'run-input', rows: '4', spellcheck: 'false', 'aria-label': 'Request input (JSON object)' });
  input.value = l.demo || l.sandbox ? (l.method === 'POST' ? '{"text":"hello"}' : '{"id":"eth"}') : '{}';
  const problem = el('p', { class: 'problem', id: 'input-problem', hidden: '' });
  const balance = el('p', { id: 'api-balance', class: 'muted' });
  const confirmRow = el('div', { class: 'confirm', id: 'run-confirm-row', hidden: '' });
  const runBtn = el('button', { id: 'run-btn', type: 'button', text: 'Pay and Use API' });
  const confirmBtn = el('button', { id: 'run-confirm', type: 'button', text: `Confirm: pay up to ${q.buyerPays.display} ${q.asset}, only if the response qualifies` });
  const cancelBtn = el('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: () => { confirmRow.hidden = true; runBtn.disabled = false; } });
  confirmRow.append(el('p', { class: 'notice', text: `You will be charged ${q.buyerPays.display} ${q.asset} only if the response meets the contract. Otherwise nothing is charged.` }), el('div', { class: 'row' }, confirmBtn, cancelBtn));
  const escrow = el('input', { type: 'checkbox', id: 'run-escrow' });
  const escrowRow = cfg.escrow ? el('label', { class: 'check' }, escrow, el('span', { text: 'Settle through the testnet escrow contract (Celo Sepolia, mock token) instead of the Payrail ledger' })) : null;

  const buyBox = el('section', { class: 'card', id: 'api-buy' },
    el('h2', { text: 'Use this API' }),
    el('p', {}, el('span', { class: `badge ${q.asset === 'USDT' ? 'ok' : 'warn'}`, id: 'mode-badge', text: q.asset === 'USDT' ? 'REAL USDT' : 'TEST CREDITS: no real money' })),
    balance,
    el('label', { for: 'run-input', text: 'Request input (JSON object)' }), input, problem,
    escrowRow,
    el('div', { class: 'row' }, runBtn, msg), confirmRow, out);

  root.append(el('div', { class: 'apigrid' }, details, buyBox));

  async function refreshBalance() {
    if (!buyerToken) {
      clear(balance);
      if (q.asset === 'USDT') balance.append('This API is charged in real USDT. ', el('a', { href: '/market.html#/buyer', text: 'Sign in with your wallet and fund your account on the dashboard' }), '.');
      else balance.append('No buyer account yet. ', el('button', { type: 'button', class: 'secondary', id: 'start-testing', text: 'Start testing: get 5 test credits', onclick: startTesting }),
        ' or ', el('a', { href: '/market.html#/buyer', text: 'sign in on the dashboard' }), '.');
      return;
    }
    const me = await api('/me', { bearer: buyerToken });
    if (!me.ok) { buyerToken = null; store.set('payrail.buyer', null); return refreshBalance(); }
    const real = q.asset === 'USDT' && me.live;
    const b = real ? me.live : me;
    balance.textContent = `Available balance: ${b.available} ${b.asset} (held ${b.held})${real ? ' · real USDT' : ''}`;
  }
  async function startTesting() {
    const b = await api('/buyer', { body: {} });
    if (!b.ok) { msg.textContent = fail(b); return; }
    buyerToken = b.token; store.set('payrail.buyer', b.token);
    const c = await api('/credits', { body: { amount: '5' }, bearer: buyerToken });
    if (!c.ok) msg.textContent = fail(c);
    refreshBalance();
  }

  runBtn.addEventListener('click', () => {
    problem.hidden = true; msg.textContent = '';
    if (!q.available) { msg.textContent = `This API cannot be used right now: ${q.unavailableReason}.`; return; }
    if (!buyerToken) { msg.textContent = 'Start testing or sign in first.'; return; }
    const c = checkInput(input.value, rules);
    if (!c.ok) { problem.textContent = c.problem; problem.hidden = false; return; }
    confirmRow.hidden = false;
    runBtn.disabled = true;
  });

  confirmBtn.addEventListener('click', async () => {
    const c = checkInput(input.value, rules);
    if (!c.ok) { confirmRow.hidden = true; runBtn.disabled = false; problem.textContent = c.problem; problem.hidden = false; return; }
    const useEscrow = Boolean(cfg.escrow && escrow.checked);
    confirmBtn.disabled = true;
    msg.textContent = useEscrow ? 'Running through the TESTNET escrow (on-chain transactions, may take ~20s)…' : 'Running…';
    const r0 = await api('/execute', { body: { listingId: l.id, input: c.value, idempotencyKey: newKey(), ...(useEscrow ? { settlement: 'escrow' } : {}) }, bearer: buyerToken });
    confirmBtn.disabled = false; confirmRow.hidden = true; runBtn.disabled = false; msg.textContent = '';
    clear(out);
    if (!r0.ok) { out.append(el('div', { class: 'problem', text: fail(r0) })); refreshBalance(); return; }
    const r = r0.result;
    const price = (Number(r.priceAtomic) / 1e6).toString();
    const headline = r.charged ? `Charged ${price} ${r.asset}: the response qualified.`
      : r.held ? 'Outcome unknown: your credits are held, not charged. They are released automatically if this stays unresolved.'
        : 'Not charged: the response did not meet the contract.';
    out.append(el('p', { class: `headline ${r.charged ? 'ok' : r.held ? 'warn' : 'bad'}`, id: 'run-headline', text: headline }), r.reason && el('p', { class: 'muted', text: r.reason }),
      el('p', {}, el('strong', { text: 'Transaction status: ' }), el('span', { id: 'run-status', text: r.charged ? 'completed and charged' : r.held ? 'held (outcome unknown)' : 'completed, not charged' })));
    if (r0.settlement === 'escrow') out.append(el('p', { class: 'notice', text: 'Settled through the Celo Sepolia TESTNET escrow contract (mock token).' }));
    if (r.checks.length) out.append(el('ul', {}, ...r.checks.map((x) => el('li', { text: `${x.ok ? '✓' : '✗'} ${x.name} — ${x.detail}` }))));
    if (r.body !== undefined) out.append(el('h3', { text: 'API response' }), el('pre', { text: JSON.stringify(r.body, null, 2) }));
    const rec = el('details', { open: '' }, el('summary', { text: 'Receipt' }));
    out.append(rec);
    out.append(el('p', { class: 'notice', text: 'Qualified means the response matched the agreed structure, types and freshness. It does not prove the data is true.' }));
    await showReceipt(rec, r.executionId);
    refreshBalance();
  });

  refreshBalance();
}

main();
