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
// conditional children (cond ? el(...) : null) must never render as the text "null"
const _append = Element.prototype.append;
Element.prototype.append = function (...kids) { return _append.apply(this, kids.filter((k) => k !== false && k !== null && k !== undefined)); };
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
    ['Settlement', window.PayrailDev && window.PayrailDev.api ? 'Payrail ledger (development test credits)' : 'Payrail ledger (USDT)'], ['Contract', r.contract ? `v${r.contract.version}` : '—'],
    ['Response hash', r.validation.responseSha256 || '—'], ['Idempotency key', r.idempotencyKey],
  ]));
  if (r.ledger.length) box.append(el('p', { class: 'muted', text: 'Ledger entries: ' + r.ledger.map((t) => `#${t.id} ${t.kind}`).join(', ') }));
  box.append(el('p', { class: 'muted', text: r.validation.note }));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const t = document.createElement('script');
    t.src = src;
    t.onload = resolve;
    t.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(t);
  });
}

async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || '';
  if (params.get('src') === 'buy') {
    // an API from the Buy AI catalogue: details come from Buy's catalogue, payment is made by the buyer's own wallet (see buy.js)
    if (!/^[\w.-]{1,160}$/.test(id)) return notFound('No API was specified.');
    const [bd, bcfg] = await Promise.all([api(`/buy/service/${encodeURIComponent(id)}`), api('/config')]);
    if (!bd.ok) return notFound(bd.code === 'NOT_FOUND' ? 'This API is not in the current Buy catalogue.' : fail(bd));
    if (!bcfg.ok) return notFound('The API marketplace is not enabled on this server.');
    return window.renderBuy(bd, bcfg);
  }
  if (!/^[\w-]{1,80}$/.test(id)) return notFound('No API was specified.');
  const [d, cfg] = await Promise.all([api(`/listing/${encodeURIComponent(id)}`), api('/config')]);
  if (!d.ok) return notFound(d.code === 'NOT_FOUND' ? 'This API does not exist or is not published.' : fail(d));
  const dev = cfg.ok && cfg.environment === 'development';
  if (!cfg.ok || (!cfg.realFunds && !dev)) return notFound('The API marketplace is not enabled on this production server. (To develop and test it without real money, run the separate development server: npm run dev:market.)');
  if (dev) {
    // the development helper is served only by the development server; if it is missing the page refuses rather than guessing
    try { await loadScript('/dev-api.js'); } catch { return notFound('The development helper could not be loaded.'); }
  }
  render(d, cfg);
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
  // DEVELOPMENT only: the helper exists only on the development server and only when the server says it is the development environment
  const devApi = cfg.environment === 'development' && window.PayrailDev ? window.PayrailDev.api : undefined;
  if (q.asset !== 'USDT' && !devApi) return notFound('This API cannot be purchased: it is not priced in real USDT.');
  document.title = `${l.name} · Payrail`;
  clear(root);
  const kind = ['PAYRAIL SELLER', 'o-seller'];
  const net = cfg.network;

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
      ...(l.listed ? [["Seller's pricing currency", `${l.listed.amount} ${l.listed.currency} (converted to USDT with a Textile rate of 1 ${l.listed.currency} = ${l.listed.rate} USDT, quoted ${String(l.listed.quotedAt).replace('T', ' ').slice(0, 19)} UTC; you are billed in USDT)`]] : []),
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
  input.value = '{}';
  const problem = el('p', { class: 'problem', id: 'input-problem', hidden: '' });
  const balance = el('p', { id: 'api-balance', class: 'muted' });
  const confirmRow = el('div', { class: 'confirm', id: 'run-confirm-row', hidden: '' });
  const runBtn = el('button', { id: 'run-btn', type: 'button', text: 'Pay and Use API' });
  const confirmBtn = el('button', { id: 'run-confirm', type: 'button', text: `Confirm: pay up to ${q.buyerPays.display} ${q.asset}, only if the response qualifies` });
  const cancelBtn = el('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: () => { confirmRow.hidden = true; runBtn.disabled = false; } });
  confirmRow.append(el('p', { class: 'notice', text: `You will be charged ${q.buyerPays.display} ${q.asset} only if the response meets the contract. Otherwise nothing is charged.` }), el('div', { class: 'row' }, confirmBtn, cancelBtn));

  const buyBox = el('section', { class: 'card', id: 'api-buy' },
    el('h2', { text: 'Use this API' }),
    devApi ? el('div', { class: 'banner sim', role: 'note', id: 'dev-note', text: devApi.note }) : null,
    el('p', {}, el('span', { class: `badge ${devApi ? 'o-sim' : 'ok'}`, id: 'mode-badge', text: devApi ? devApi.badge : 'REAL USDT' }), ' ', el('span', { class: 'muted', id: 'network-line', text: devApi ? devApi.networkLine : net ? `${net.name} (chain ${net.chainId}) · token ${net.token.symbol} ${net.token.address}` : '' })),
    balance,
    el('label', { for: 'run-input', text: 'Request input (JSON object)' }), input, problem,
    el('div', { class: 'row' }, runBtn, msg), confirmRow, out);

  root.append(el('div', { class: 'apigrid' }, details, buyBox));

  async function refreshBalance() {
    if (devApi) {
      if (!buyerToken) {
        clear(balance);
        balance.append('No development session yet. ', el('a', { href: '/market.html#/buyer', text: 'Start one on the dashboard (Buyer card)' }), ' to get test credits.');
        return;
      }
      const me = await api('/me', { bearer: buyerToken });
      if (!me.ok) { buyerToken = null; store.set('payrail.buyer', null); return refreshBalance(); }
      balance.textContent = devApi.balanceText(me);
      return;
    }
    if (!buyerToken) {
      clear(balance);
      balance.append('This API is charged in real USDT. Press Pay and Use API: your wallet signs in, tops up exactly what is missing and pays. Or ',
        el('a', { href: '/market.html#/buyer', text: 'sign in and fund your account on the dashboard' }), '.');
      return;
    }
    const me = await api('/me', { bearer: buyerToken });
    if (!me.ok || !me.live) { buyerToken = null; store.set('payrail.buyer', null); return refreshBalance(); }
    balance.textContent = `Available balance: ${me.live.available} ${me.live.asset} (held ${me.live.held}) · real USDT`;
  }

  runBtn.addEventListener('click', () => {
    problem.hidden = true; msg.textContent = '';
    if (!q.available) { msg.textContent = `This API cannot be used right now: ${q.unavailableReason}.`; return; }
    const c = checkInput(input.value, rules);
    if (!c.ok) { problem.textContent = c.problem; problem.hidden = false; return; }
    confirmRow.hidden = false;
    runBtn.disabled = true;
  });

  // ---- one-click pay (real USDT only): the buyer's OWN wallet tops up exactly the shortfall, the server verifies the
  // transfer on-chain and credits it, and only then does the request run. Nothing is copied or pasted by the buyer.
  const stepsBox = el('ol', { id: 'pay-steps', class: 'paysteps', hidden: '' });
  buyBox.insertBefore(stepsBox, out);
  function addStep(key, text) {
    stepsBox.hidden = false;
    const li = el('li', { 'data-state': 'pending', 'data-step': key }, el('span', { class: 'st', text: '…' }), ' ', el('span', { text }));
    stepsBox.append(li);
    return {
      done(t) { li.dataset.state = 'done'; li.firstChild.textContent = '✓'; if (t) li.lastChild.textContent = t; },
      fail(t) { li.dataset.state = 'failed'; li.firstChild.textContent = '✗'; li.lastChild.textContent = t; },
      note(t) { li.lastChild.textContent = t; },
    };
  }
  const lower = (x) => String(x).toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const eth = () => window.ethereum;
  const T = () => window.PayrailTopUp;

  async function ensureWallet() {
    const st = addStep('wallet', 'Connect your wallet');
    if (!eth()) { st.fail('No browser wallet found. Install a wallet extension to pay with real USDT.'); return null; }
    let acct;
    try { [acct] = await eth().request({ method: 'eth_requestAccounts' }); } catch (e) { st.fail(`Wallet connection was declined: ${e.message || e}`); return null; }
    let chain = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (chain !== 42220) {
      try {
        await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4ec' }] });
        chain = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
      } catch { /* reported below */ }
      if (chain !== 42220) { st.fail('Switch your wallet to Celo mainnet (chain 42220) and try again.'); return null; }
    }
    st.done(`Wallet connected: ${acct.slice(0, 6)}…${acct.slice(-4)} on Celo`);
    return acct;
  }

  async function ensureSignedIn(acct) {
    if (buyerToken) {
      const me = await api('/me', { bearer: buyerToken });
      if (me.ok) return true;
      buyerToken = null; store.set('payrail.buyer', null);
    }
    const st = addStep('login', 'Sign in with your wallet (signature only, no transaction)');
    const s = await api('/buyer/login/start', { body: { wallet: acct, chainId: 42220 } });
    if (!s.ok) { st.fail(fail(s)); return false; }
    let signature;
    try { signature = await eth().request({ method: 'personal_sign', params: [s.message, acct] }); } catch (e) { st.fail(`Signature declined: ${e.message || e}`); return false; }
    const c = await api('/buyer/login/complete', { body: { wallet: acct, nonce: s.nonce, signature } });
    if (!c.ok) { st.fail(fail(c)); return false; }
    buyerToken = c.token; store.set('payrail.buyer', c.token);
    st.done('Signed in');
    return true;
  }

  async function ensureFundingWallet(acct, f) {
    if (f.wallets.map(lower).includes(lower(acct))) return true;
    const st = addStep('verify', 'Verify this wallet as your funding wallet (signature only)');
    const me = await api('/me', { bearer: buyerToken });
    const message = f.walletMessageTemplate.replace('<your wallet address in lowercase>', lower(acct)).replace(/Buyer: .*\n/, `Buyer: ${me.accountId}\n`);
    let signature;
    try { signature = await eth().request({ method: 'personal_sign', params: [message, acct] }); } catch (e) { st.fail(`Signature declined: ${e.message || e}`); return false; }
    const r = await api('/funding/wallet', { body: { wallet: acct, signature }, bearer: buyerToken });
    if (!r.ok) { st.fail(fail(r)); return false; }
    st.done('Funding wallet verified');
    return true;
  }

  async function awaitCredit(hash, st) {
    for (let i = 0; i < 40; i++) {
      const r = await api('/funding/confirm', { body: { txHash: hash }, bearer: buyerToken });
      if (r.ok) { store.set('payrail.topup', null); return true; }
      if (!T().isPendingCode(r.code)) { st.fail(`NOT CREDITED: ${r.message || 'verification failed'} (${r.code}). Nothing was credited.`); return false; }
      st.note(`Waiting for on-chain confirmations… (${r.message || 'pending'})`);
      await sleep(window.__payrailPollMs || 5000);
    }
    st.fail('Still waiting for confirmations. Your transfer was sent; reload this page later and use "Check pending top-up".');
    return false;
  }

  /** DEVELOPMENT: a test-credit session is enough; there is no wallet, no transfer and no chain */
  async function devSessionReady() {
    if (buyerToken) return true;
    msg.textContent = 'Start a development session on the dashboard first (Buyer card).';
    return false;
  }

  /** returns true when the balance covers the price and the request may run */
  async function payWithWallet() {
    clear(stepsBox);
    const acct = await ensureWallet();
    if (!acct) return false;
    if (!(await ensureSignedIn(acct))) return false;
    const f = await api('/funding', { bearer: buyerToken });
    if (!f.ok || !f.enabled) { addStep('config', '').fail('Real-funds deposits are not enabled on this server.'); return false; }
    if (!(await ensureFundingWallet(acct, f))) return false;
    const me = await api('/me', { bearer: buyerToken });
    const avail = T().parseUnits6(me.live ? me.live.available : '0');
    const price = T().parseUnits6(q.buyerPays.display);
    const cap = T().parseUnits6(f.maxDeposit);
    const planSt = addStep('plan', 'Check your balance');
    if (avail === null || price === null || cap === null) { planSt.fail('Could not read the balance or price.'); return false; }
    const plan = T().planTopUp({ priceAtomic: price, availableAtomic: avail, maxDepositAtomic: cap });
    if (plan.error) { planSt.fail(plan.error); return false; }
    if (!plan.needed) { planSt.done(`Balance ${T().formatUnits6(avail)} USDT covers the price. No top-up needed.`); return true; }
    planSt.done(`Balance ${T().formatUnits6(avail)} USDT; top-up of ${T().formatUnits6(plan.amountAtomic)} USDT needed`);
    const send = addStep('send', `Send ${T().formatUnits6(plan.amountAtomic)} USDT from your wallet (confirm in your wallet)`);
    let hash;
    try {
      hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: acct, to: f.token, data: T().transferCalldata(f.depositAddress, plan.amountAtomic), value: '0x0' }] });
    } catch (e) { send.fail(`Transaction was not sent: ${String(e.message || e).replace(/\.$/, '')}. Nothing was charged.`); return false; }
    store.set('payrail.topup', JSON.stringify({ hash, at: Date.now() }));
    send.done(`Transfer sent (${String(hash).slice(0, 10)}…)`);
    const conf = addStep('confirm', 'Waiting for on-chain confirmations');
    if (!(await awaitCredit(hash, conf))) return false;
    // credit exactly what was verified on-chain; if that is less than the price, stop instead of running the request
    const me2 = await api('/me', { bearer: buyerToken });
    const now = T().parseUnits6(me2.live ? me2.live.available : '0');
    if (now === null || now < price) {
      conf.fail(`Verified and credited ${T().formatUnits6(now === null ? 0n : now)} USDT, which is less than the price (${T().formatUnits6(price)} USDT). The API was not run and nothing was charged. Top up again to continue.`);
      return false;
    }
    conf.done('Verified on-chain and credited');
    return true;
  }

  async function runRequest(inputValue) {
    msg.textContent = 'Running…';
    const r0 = await api('/execute', { body: { listingId: l.id, input: inputValue, idempotencyKey: newKey() }, bearer: buyerToken });
    msg.textContent = '';
    clear(out);
    if (!r0.ok) { out.append(el('div', { class: 'problem', text: fail(r0) })); refreshBalance(); return; }
    const r = r0.result;
    const price = (Number(r.priceAtomic) / 1e6).toString();
    const headline = r.charged ? `Charged ${price} ${r.asset}: the response qualified.`
      : r.held ? 'Outcome unknown: the amount is held, not charged. It is released automatically if this stays unresolved.'
        : 'Not charged: the response did not meet the contract.';
    out.append(el('p', { class: `headline ${r.charged ? 'ok' : r.held ? 'warn' : 'bad'}`, id: 'run-headline', text: headline }), r.reason && el('p', { class: 'muted', text: r.reason }),
      el('p', {}, el('strong', { text: 'Transaction status: ' }), el('span', { id: 'run-status', text: r.charged ? 'completed and charged' : r.held ? 'held (outcome unknown)' : 'completed, not charged' })));
    if (r.checks.length) out.append(el('ul', {}, ...r.checks.map((x) => el('li', { text: `${x.ok ? '✓' : '✗'} ${x.name} — ${x.detail}` }))));
    if (r.body !== undefined) out.append(el('h3', { text: 'API response' }), el('pre', { text: JSON.stringify(r.body, null, 2) }));
    const rec = el('details', { open: '' }, el('summary', { text: 'Receipt' }));
    out.append(rec);
    out.append(el('p', { class: 'notice', text: 'Qualified means the response matched the agreed structure, types and freshness. It does not prove the data is true.' }));
    await showReceipt(rec, r.executionId);
    refreshBalance();
  }

  confirmBtn.addEventListener('click', async () => {
    const c = checkInput(input.value, rules);
    if (!c.ok) { confirmRow.hidden = true; runBtn.disabled = false; problem.textContent = c.problem; problem.hidden = false; return; }
    confirmBtn.disabled = true;
    clear(out);
    msg.textContent = devApi ? 'Checking your development session…' : 'Preparing payment from your wallet…';
    const ready = devApi ? await devSessionReady() : await payWithWallet();
    msg.textContent = '';
    if (!ready) { confirmBtn.disabled = false; confirmRow.hidden = true; runBtn.disabled = false; refreshBalance(); return; }
    await runRequest(c.value);
    confirmBtn.disabled = false; confirmRow.hidden = true; runBtn.disabled = false;
  });

  // a transfer that was sent but not yet verified (for example the tab was closed) can be re-checked, never re-sent
  const pending = (() => { try { return JSON.parse(store.get('payrail.topup') || 'null'); } catch { return null; } })();
  if (!devApi && pending && /^0x[0-9a-fA-F]{64}$/.test(pending.hash)) {
    buyBox.insertBefore(el('p', { class: 'notice' }, 'A top-up transfer was sent from this browser and has not been confirmed yet. ',
      el('button', { type: 'button', class: 'secondary', id: 'check-pending', text: 'Check pending top-up', onclick: async (e) => {
        e.target.disabled = true; clear(stepsBox);
        const st = addStep('confirm', 'Checking the pending top-up');
        if (!buyerToken) { st.fail('Sign in with the same wallet first.'); e.target.disabled = false; return; }
        if (await awaitCredit(pending.hash, st)) { st.done('Verified on-chain and credited'); refreshBalance(); }
        e.target.disabled = false;
      } })), stepsBox);
  }

  refreshBalance();
}

main();
