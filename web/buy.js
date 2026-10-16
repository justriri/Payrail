// A Buy AI API: details, exact price, and payment from the buyer's OWN wallet. Plain JavaScript; all server text is written with
// textContent. Loaded after api.js and shares its helpers (el, api, fail, clear, store, root, buyerToken).
//
// The flow: the page asks the server for the exact price (the gateway's own HTTP 402 answer), the wallet signs a one-time EIP-3009
// authorization for exactly that amount to Buy's payee (eth_signTypedData_v4; no transaction is sent by the buyer), the server
// submits it to Buy once, and the order only turns CONFIRMED after the settlement is verified on-chain.
'use strict';

function schemaRows(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return [];
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties).slice(0, 40).map(([name, p]) => {
    const t = p && typeof p === 'object' ? p : {};
    const type = Array.isArray(t.type) ? t.type.join(' | ') : t.type || (t.enum ? 'enum' : 'any');
    const extra = [t.enum ? `one of: ${t.enum.slice(0, 8).join(', ')}` : '', t.minimum !== undefined ? `min ${t.minimum}` : '', t.maximum !== undefined ? `max ${t.maximum}` : '', t.default !== undefined ? `default ${JSON.stringify(t.default)}` : ''].filter(Boolean).join('; ');
    return { name, type, required: req.has(name), description: [typeof t.description === 'string' ? t.description : '', extra].filter(Boolean).join(' · ') };
  });
}

/** an example body made from the schema (required fields only), so the buyer starts from something valid-looking */
function exampleFromSchema(schema) {
  const gen = (s) => {
    if (!s || typeof s !== 'object') return 'text';
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (s.default !== undefined) return s.default;
    switch (s.type) {
      case 'integer': case 'number': return Math.max(1, Number(s.minimum) || 1);
      case 'boolean': return false;
      case 'array': return [gen(s.items)];
      case 'object': { const o = {}; for (const k of s.required || []) o[k] = gen((s.properties || {})[k]); return o; }
      default: return s.format === 'uri' ? 'https://example.com' : 'text';
    }
  };
  const v = gen(schema && schema.type === 'object' ? schema : { type: 'object', required: [] });
  return JSON.stringify(v, null, 2);
}

const STATE_COPY = {
  CONFIRMED: { cls: 'ok', title: 'Paid and verified on-chain', text: 'The payment settled on Celo and was verified independently. The API response is below.' },
  REVIEW: { cls: 'warn', title: 'Needs review: NOT confirmed', text: 'Something about this order could not be confirmed. Do not treat it as paid or as a successful purchase.' },
  UNRESOLVED: { cls: 'warn', title: 'Outcome unknown: NOT confirmed', text: 'The gateway gave no usable answer and the payment has not been seen on-chain yet. Nothing is resent. Re-check below.' },
  FAILED: { cls: 'bad', title: 'Failed: nothing was charged', text: 'The payment did not settle.' },
  EXPIRED: { cls: 'bad', title: 'Expired: nothing was charged', text: 'The authorization window passed before it was submitted.' },
  SUBMITTED: { cls: 'warn', title: 'Submitted: waiting for the result', text: 'The payment was sent to Buy. Not confirmed yet.' },
  QUOTED: { cls: '', title: 'Quoted: nothing signed or sent', text: '' },
};

function renderBuy(d, cfg) {
  const s = d.service;
  const pay = d.payment;
  const dev = cfg.environment === 'development';
  document.title = `${dev ? '[DEV] ' : ''}${s.title} · Payrail`;
  clear(root);
  const msg = el('p', { class: 'muted', id: 'run-msg', role: 'status' });
  const out = el('div', { id: 'run-result' });
  const input = el('textarea', { id: 'run-input', rows: '7', spellcheck: 'false', 'aria-label': 'Request body (JSON)' });
  input.value = exampleFromSchema(s.inputSchema);
  const problem = el('p', { class: 'problem', id: 'input-problem', hidden: '' });
  const rows = schemaRows(s.inputSchema);
  const price = s.price
    ? (s.price.minUsd === s.price.maxUsd ? `about ${s.price.minUsd} USDT` : `about ${s.price.minUsd} to ${s.price.maxUsd} USDT`)
    : 'price on request';

  const details = el('section', { class: 'card', id: 'api-details' },
    el('p', { class: 'eyebrow', text: 'Buy AI API' }),
    el('h1', { id: 'api-name', text: s.title }),
    el('p', {}, el('span', { class: 'badge o-buy', text: 'BUY AI' }), ' ', el('span', { class: 'badge', id: 'api-platform', text: s.platform }), ' ',
      el('span', { class: `badge ${s.available ? 'ok' : 'warn'}`, id: 'api-status', text: s.available ? 'Available' : 'Unavailable' }), ' ',
      el('span', { class: 'muted', id: 'api-seller', text: `Provider: ${s.provider ? `${s.provider} via Buy AI` : 'Buy AI'}` })),
    el('p', { id: 'api-description', text: s.description || 'Buy has not provided a description.' }),
    el('h3', { text: 'Price' }),
    el('table', { class: 'quote' },
      el('tr', {}, el('th', { text: 'Listed price (indicative)' }), el('td', { class: 'v', id: 'indicative-price', text: price })),
      el('tr', {}, el('th', { text: 'Exact price' }), el('td', { class: 'v', text: 'Confirmed by Buy before you sign, in USDT' }))),
    s.price && s.price.options.length > 1 ? el('details', {}, el('summary', { text: `${s.price.options.length} price options` }), el('ul', {}, ...s.price.options.slice(0, 20).map((o) => el('li', { text: `${o.label}: ${o.usd}` })))) : null,
    el('h3', { text: 'How you pay' }),
    el('ul', { id: 'pay-facts' },
      el('li', { text: `Network: ${pay.network.name} (chain ${pay.network.chainId}). Token: USDT ${pay.token.address || ''}.` }),
      el('li', { text: `Your wallet signs a one-time authorization for the exact price, paid to Buy at ${pay.payTo || 'Buy'}. You send no transaction and pay no gas.` }),
      el('li', { text: 'Buy settles the payment on-chain and runs the API. Payrail never holds your funds and never has your key.' }),
      el('li', { text: 'Nothing is shown as paid until the settlement is verified on-chain.' }),
      pay.maxPerPayment ? el('li', { text: `This server refuses any single payment above ${pay.maxPerPayment} USDT.` }) : null),
    el('h3', { text: 'Platform fee' }),
    el('p', { id: 'fee-note', text: `${d.fee.percent}% platform fee: ${d.fee.note}` }),
    el('h3', { text: 'Request body' }),
    el('p', { class: 'muted', text: `${s.method} to ${s.host}. A JSON object matching this schema:` }),
    rows.length
      ? el('table', { id: 'schema-table' }, el('tr', {}, ...['Field', 'Type', 'Required', 'Description'].map((h) => el('th', { text: h }))),
        ...rows.map((r) => el('tr', {}, el('td', { text: r.name }), el('td', { text: r.type }), el('td', { text: r.required ? 'yes' : 'no' }), el('td', { text: r.description }))))
      : el('p', { class: 'muted', text: 'Buy publishes no field list for this API.' }),
    el('p', { class: 'muted', id: 'catalogue-source', text: `Catalogue fetched from Buy AI (${d.source.url}) at ${d.source.fetchedAt.replace('T', ' ').slice(0, 19)} UTC${d.source.stale ? ' (STALE copy: the refresh failed)' : ''}.` }));

  const buyBox = el('section', { class: 'card', id: 'api-buy' }, el('h2', { text: 'Pay and use this API' }),
    dev ? el('div', { class: 'banner sim', role: 'note', id: 'dev-note', text: 'DEVELOPMENT environment: Buy payments do not exist here. This page only shows what a real purchase would look like.' }) : null,
    el('p', {}, el('span', { class: `badge ${pay.enabled ? 'ok' : 'warn'}`, id: 'mode-badge', text: pay.enabled ? 'REAL USDT · Celo' : dev ? 'DEVELOPMENT · payments unavailable' : 'Payments not enabled' })),
    pay.enabled ? null : el('p', { class: 'notice', id: 'payments-disabled', text: dev ? 'No payment can be made in the development environment.' : 'The operator has not enabled Buy payments on this server, so nothing can be paid or bought here.' }),
    el('label', { for: 'run-input', text: 'Request body (JSON)' }), input, problem);

  const quoteBox = el('div', { id: 'quote-box', hidden: '' });
  const stepsBox = el('ol', { id: 'pay-steps', class: 'paysteps', hidden: '' });
  const quoteBtn = el('button', { id: 'quote-btn', type: 'button', text: 'Get the exact price', ...(pay.enabled && s.available ? {} : { disabled: '' }) });
  buyBox.append(el('div', { class: 'row' }, quoteBtn, msg), quoteBox, stepsBox, out);
  root.append(el('div', { class: 'apigrid' }, details, buyBox));

  const eth = () => window.ethereum;
  const lower = (x) => String(x).toLowerCase();
  function addStep(key, text) {
    stepsBox.hidden = false;
    const li = el('li', { 'data-state': 'pending', 'data-step': key }, el('span', { class: 'st', text: '…' }), ' ', el('span', { text }));
    stepsBox.append(li);
    return { done(t) { li.dataset.state = 'done'; li.firstChild.textContent = '✓'; if (t) li.lastChild.textContent = t; }, fail(t) { li.dataset.state = 'failed'; li.firstChild.textContent = '✗'; li.lastChild.textContent = t; } };
  }
  async function connect() {
    const st = addStep('wallet', 'Connect your wallet');
    if (!eth()) { st.fail('No browser wallet found. Install a wallet extension to pay with USDT.'); return null; }
    let acct;
    try { [acct] = await eth().request({ method: 'eth_requestAccounts' }); } catch (e) { st.fail(`Wallet connection was declined: ${e.message || e}`); return null; }
    let chain = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (chain !== pay.network.chainId) {
      try { await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${pay.network.chainId.toString(16)}` }] }); chain = parseInt(await eth().request({ method: 'eth_chainId' }), 16); } catch { /* reported below */ }
      if (chain !== pay.network.chainId) { st.fail(`Switch your wallet to Celo mainnet (chain ${pay.network.chainId}) and try again.`); return null; }
    }
    st.done(`Wallet connected: ${acct.slice(0, 6)}…${acct.slice(-4)} on Celo`);
    return acct;
  }
  async function signedIn(acct) {
    if (buyerToken) {
      const me = await api('/me', { bearer: buyerToken });
      if (me.ok && me.live) return true;
      buyerToken = null; store.set('payrail.buyer', null);
    }
    const st = addStep('login', 'Sign in with your wallet (signature only, no transaction)');
    const a = await api('/buyer/login/start', { body: { wallet: acct, chainId: pay.network.chainId } });
    if (!a.ok) { st.fail(fail(a)); return false; }
    let signature;
    try { signature = await eth().request({ method: 'personal_sign', params: [a.message, acct] }); } catch (e) { st.fail(`Signature declined: ${e.message || e}`); return false; }
    const c = await api('/buyer/login/complete', { body: { wallet: acct, nonce: a.nonce, signature } });
    if (!c.ok) { st.fail(fail(c)); return false; }
    buyerToken = c.token; store.set('payrail.buyer', c.token);
    st.done('Signed in');
    return true;
  }

  function showReceipt(o, container) {
    const c = STATE_COPY[o.state] || { cls: '', title: o.state, text: '' };
    const evidence = o.settlement;
    const rowsR = [
      ['Order', o.id], ['Status', `${o.state}${o.confirmed ? ' (verified on-chain)' : ' (NOT confirmed)'}`], ['Network', `${o.network.name} (chain ${o.network.chainId}), scheme ${o.network.scheme}`],
      ['Token', `${o.token.symbol} ${o.token.address}`], ['Payer (your wallet)', o.payer], ['Paid to (Buy)', o.payTo], ['Amount', `${o.amount} USDT`],
      ['Transaction', o.txHash || 'none seen'], ['Authorization nonce', o.nonce],
      ['On-chain evidence', evidence ? `authorization ${evidence.authorization}; transfer ${evidence.transferVerified ? 'verified' : 'not verified'}` : 'none'],
      ['Platform fee', `${o.fee.amount} USDT (${o.fee.percent}%): ${o.fee.state === 'collected' ? 'collected' : 'DUE, not collected'}`],
      ['Created', o.createdAt.replace('T', ' ').slice(0, 19)],
    ];
    clear(container);
    container.append(el('p', { class: `headline ${c.cls === 'ok' ? 'ok' : c.cls === 'bad' ? 'bad' : 'warn'}`, id: 'run-headline', text: c.title }), c.text ? el('p', { class: 'muted', text: c.text }) : null,
      o.failure ? el('p', { class: 'problem', text: o.failure }) : null,
      el('p', {}, el('strong', { text: 'Transaction status: ' }), el('span', { id: 'run-status', text: o.confirmed ? 'settled and verified on-chain' : o.state === 'FAILED' || o.state === 'EXPIRED' ? 'nothing charged' : 'not confirmed' })),
      o.txUrl ? el('p', {}, el('a', { href: o.txUrl, target: '_blank', rel: 'noopener noreferrer', id: 'tx-link', text: `View transaction ${o.txHash.slice(0, 10)}… on Celoscan` })) : null,
      o.response && o.response.body ? el('div', {}, el('h3', { text: 'API response' }), el('pre', { id: 'api-response', text: prettyBody(o.response.body) }), el('p', { class: 'muted', text: `Response SHA-256: ${o.response.sha256}` })) : null,
      el('details', { open: '' }, el('summary', { text: 'Receipt' }), el('table', { class: 'quote', id: 'receipt' }, ...rowsR.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { class: 'v', text: String(v) }))))),
      ['UNRESOLVED', 'REVIEW', 'SUBMITTED'].includes(o.state) ? el('button', { type: 'button', class: 'secondary', id: 'recheck-btn', text: 'Re-check on-chain (reads the chain only; nothing is resent)', onclick: async (e) => {
        e.target.disabled = true;
        const r = await api(`/buy/order/${o.id}/recheck`, { body: {}, bearer: buyerToken });
        if (r.ok) showReceipt(r.order, container); else { msg.textContent = fail(r); e.target.disabled = false; }
      } }) : null);
  }
  const prettyBody = (t) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };

  let current;
  let timer;
  function showQuote(o) {
    clear(quoteBox);
    quoteBox.hidden = false;
    quoteBox.append(
      el('table', { class: 'quote', id: 'quote-table' },
        el('tr', {}, el('th', { text: 'Exact price (confirmed by Buy)' }), el('td', { class: 'v', id: 'exact-price', text: `${o.amount} USDT` })),
        el('tr', {}, el('th', { text: 'Network and token' }), el('td', { class: 'v', text: `Celo (chain ${o.network.chainId}), USDT ${o.token.address}` })),
        el('tr', {}, el('th', { text: 'Paid to' }), el('td', { class: 'v', text: o.payTo })),
        el('tr', {}, el('th', { text: 'Paid from' }), el('td', { class: 'v', text: o.payer })),
        el('tr', {}, el('th', { text: 'Platform fee (3%)' }), el('td', { class: 'v', text: `${o.fee.amount} USDT, recorded as DUE, not collected` }))),
      el('p', { class: 'muted', id: 'quote-expiry' }),
      el('p', { class: 'notice', text: 'Signing authorizes exactly this payment, once. If you do not sign, nothing happens.' }),
      el('div', { class: 'row' }, el('button', { type: 'button', id: 'sign-btn', text: `Sign and pay ${o.amount} USDT with my wallet` })));
    const exp = quoteBox.querySelector('#quote-expiry');
    clearInterval(timer);
    const tick = () => { const left = Math.max(0, o.validBefore - Math.floor(Date.now() / 1000)); exp.textContent = left > 0 ? `This quote is valid for ${left}s.` : 'This quote has expired. Get a new price.'; const b = quoteBox.querySelector('#sign-btn'); if (b && left === 0) b.disabled = true; };
    tick();
    timer = setInterval(tick, 1000);
    quoteBox.querySelector('#sign-btn').addEventListener('click', () => payNow());
  }

  async function payNow() {
    const btn = quoteBox.querySelector('#sign-btn');
    btn.disabled = true;
    clear(stepsBox); clear(out); msg.textContent = '';
    const acct = await connect();
    if (!acct) { btn.disabled = false; return; }
    if (!(await signedIn(acct))) { btn.disabled = false; return; }
    if (lower(acct) !== lower(current.payer)) {
      addStep('wallet-match', '').fail(`This quote was prepared for ${current.payer}. Switch to that wallet, or get a new price with this one.`);
      btn.disabled = false;
      return;
    }
    const sg = addStep('sign', 'Sign the payment authorization in your wallet (no transaction is sent by you)');
    let signature;
    try {
      signature = await eth().request({ method: 'eth_signTypedData_v4', params: [acct, JSON.stringify(current.typedData)] });
    } catch (e) { sg.fail(`Signature declined: ${e.message || e}. Nothing was sent or charged.`); btn.disabled = false; return; }
    sg.done('Authorization signed');
    const sub = addStep('submit', 'Sending the payment to Buy and waiting for the on-chain result…');
    const r = await api('/buy/pay', { body: { orderId: current.id, signature }, bearer: buyerToken });
    if (!r.ok) { sub.fail(`${fail(r)}. Nothing was charged.`); btn.disabled = false; return; }
    sub.done(r.order.confirmed ? 'Settlement verified on-chain' : `Result: ${r.order.state} (not confirmed)`);
    showReceipt(r.order, out);
    clearInterval(timer);
  }

  function checkBody(text) {
    let v;
    try { v = JSON.parse(text.trim() === '' ? '{}' : text); } catch { return { ok: false, problem: 'The request body is not valid JSON.' }; }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, problem: 'The request body must be a JSON object.' };
    if (JSON.stringify(v).length > 8192) return { ok: false, problem: 'The request body is too large (8 KB limit).' };
    return { ok: true, value: v };
  }

  quoteBtn.addEventListener('click', async () => {
    problem.hidden = true; msg.textContent = ''; clear(out); clear(stepsBox); stepsBox.hidden = true;
    const c = checkBody(input.value);
    if (!c.ok) { problem.textContent = c.problem; problem.hidden = false; return; }
    if (!buyerToken) { msg.textContent = 'You will be asked to connect and sign in with your wallet first.'; }
    // a quote needs a signed-in buyer (it is bound to the buyer's wallet): do that first
    quoteBtn.disabled = true;
    const acct = await connect();
    if (!acct) { quoteBtn.disabled = false; return; }
    if (!(await signedIn(acct))) { quoteBtn.disabled = false; return; }
    msg.textContent = 'Asking Buy for the exact price (nothing is signed or sent)…';
    const r = await api('/buy/quote', { body: { serviceId: s.id, input: c.value }, bearer: buyerToken });
    msg.textContent = '';
    quoteBtn.disabled = false;
    if (!r.ok) { clear(quoteBox); quoteBox.hidden = true; problem.textContent = `${fail(r)}`; problem.hidden = false; return; }
    current = r.order;
    showQuote(current);
  });
}
window.renderBuy = renderBuy;
