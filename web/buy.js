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
    if (convDone && o.conversionId === convDone.id) {
      rowsR.splice(3, 0, ['Currency conversion (Textile)', `sold ${convDone.sell.amount} ${convDone.sell.symbol}, received ${convDone.receive.received} USDT; tx ${convDone.swapTx}`], ['Conversion fee (Textile)', `${convDone.conversionFee.amount} ${convDone.conversionFee.symbol} (included in the rate)`]);
    }
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
  let convDone = null; // a conversion proven on-chain for this page's purchase
  function showQuote(o, funding) {
    const short = Boolean(funding) && funding.shortfallAtomic !== '0';
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
      funding ? el('p', { class: 'muted', id: 'wallet-usdt', text: `Your wallet holds ${funding.usdtBalance} USDT.` }) : null,
      short ? null : el('p', { class: 'notice', text: 'Signing authorizes exactly this payment, once. If you do not sign, nothing happens.' }),
      short ? el('div', { id: 'convert-panel' }) : el('div', { class: 'row' }, el('button', { type: 'button', id: 'sign-btn', text: `Sign and pay ${o.amount} USDT with my wallet` })));
    if (short) renderConvertPanel(o, funding);
    const exp = quoteBox.querySelector('#quote-expiry');
    clearInterval(timer);
    const tick = () => { const left = Math.max(0, o.validBefore - Math.floor(Date.now() / 1000)); exp.textContent = left > 0 ? `This quote is valid for ${left}s.` : 'This quote has expired. Get a new price.'; const b = quoteBox.querySelector('#sign-btn'); if (b && left === 0) b.disabled = true; };
    tick();
    timer = setInterval(tick, 1000);
    const sb = quoteBox.querySelector('#sign-btn');
    if (sb) sb.addEventListener('click', () => payNow());
  }

  // ---- not enough USDT: convert another currency into USDT with Textile, in the buyer's own wallet, THEN pay Buy
  async function renderConvertPanel(o, funding) {
    const panel = quoteBox.querySelector('#convert-panel');
    if (!panel) return;
    clear(panel);
    panel.append(el('p', { class: 'notice', id: 'shortfall', text: `This API costs ${o.amount} USDT and your wallet holds ${funding.usdtBalance} USDT. Buy only accepts USDT, so you are ${funding.shortfall} USDT short. Nothing has been charged.` }));
    const cur = await api('/buy/currencies');
    if (!cur.ok || !cur.enabled) {
      panel.append(el('p', { class: 'muted', id: 'no-convert', text: 'Paying with another currency is not enabled on this server. Add USDT on Celo to your wallet, then get the price again.' }));
      return;
    }
    const usable = cur.currencies.filter((c) => c.available);
    const order = { live: 0, simulated: 1, temporarily_unavailable: 2, unsupported: 3 };
    const sorted = [...cur.currencies].sort((x, y) => order[x.status] - order[y.status] || x.symbol.localeCompare(y.symbol));
    const BADGE = { live: 'ok', simulated: 'warn', temporarily_unavailable: 'warn', unsupported: 'bad' };
    // every currency Payrail knows about, with its true status: nothing is hidden and nothing is labelled better than the evidence
    const list = el('ul', { class: 'curlist', id: 'currency-status' }, ...sorted.map((c) => el('li', { class: 'cur', 'data-symbol': c.symbol, 'data-status': c.status },
      el('div', { class: 'cur-top' }, el('strong', { text: c.symbol }), ' ', el('span', { class: `badge ${BADGE[c.status] || ''}`, text: c.statusLabel })),
      el('p', { class: 'muted', text: c.statusDetail }),
      // the general Textile label, kept apart from the verification status shown in the badge above
      c.available ? el('p', { class: 'muted', text: `Smallest swap ${c.minSell} ${c.symbol}${c.minUsdt ? ` (about ${c.minUsdt} USDT)` : ''}.` }) : null,
      c.directNote ? el('p', { class: 'muted', text: c.directNote }) : null)));
    panel.append(el('h3', { text: 'Pay with another currency' }), el('p', { class: 'muted', text: 'Textile converts it to USDT in your own wallet, then Buy is paid in USDT.' }), list);
    if (!usable.length) { panel.append(el('p', { class: 'muted', id: 'no-usable', text: 'No currency can be converted into USDT right now. Add USDT to your wallet instead.' })); return; }
    const sel = el('select', { id: 'pay-currency', 'aria-label': 'Pay with' }, el('option', { value: '', text: 'Choose a currency' }), ...usable.map((c) => el('option', { value: c.symbol, text: `${c.symbol} (${c.statusLabel})` })));
    const note = el('p', { class: 'muted', id: 'currency-evidence' });
    sel.addEventListener('change', () => {
      const c = usable.find((x) => x.symbol === sel.value);
      note.textContent = c ? `${c.route}. ${c.statusDetail} Allowed size: ${c.minSell} to ${c.maxSell} ${c.symbol}.` : '';
    });
    const estBtn = el('button', { type: 'button', id: 'estimate-btn', text: 'Show what it will cost' });
    const box = el('div', { id: 'estimate-box' });
    panel.append(el('label', { for: 'pay-currency', text: 'Pay with' }), sel, note, el('div', { class: 'row' }, estBtn), box);
    estBtn.addEventListener('click', async () => {
      clear(box);
      if (!sel.value) { box.append(el('p', { class: 'problem', text: 'Choose a currency first.' })); return; }
      estBtn.disabled = true;
      const r = await api('/buy/convert/estimate', { body: { orderId: o.id, symbol: sel.value }, bearer: buyerToken });
      estBtn.disabled = false;
      if (!r.ok) { box.append(el('p', { class: 'problem', id: 'estimate-error', text: fail(r) })); return; }
      showEstimate(o, r.conversion, r.evidence, box, r.limits, r.gas);
    });
  }

  function showEstimate(o, cv, evidence, box, limits, gas) {
    clear(box);
    box.append(
      el('table', { class: 'quote', id: 'estimate-table' },
        el('tr', {}, el('th', { text: 'Selected API' }), el('td', { class: 'v', id: 'est-service', text: s.title })),
        el('tr', {}, el('th', { text: 'Listed price and its currency' }), el('td', { class: 'v', id: 'est-listed', text: `${cv.apiPrice.amount} USDT (Buy prices this API in USDT)` })),
        el('tr', {}, el('th', { text: 'Buy is paid in' }), el('td', { class: 'v', id: 'est-pay-currency', text: 'USDT on Celo (Buy accepts nothing else here)' })),
        el('tr', {}, el('th', { text: 'Textile conversion route' }), el('td', { class: 'v', id: 'est-route', text: `${cv.sell.symbol} -> USDT (Celo, Textile reactor)` })),
        el('tr', {}, el('th', { text: 'Quote status' }), el('td', { class: 'v', id: 'est-quote-status', text: 'INDICATIVE only. A firm Textile quote is requested when you approve, and the swap is refused if it would give you less than the minimum shown.' })),
        el('tr', {}, el('th', { text: 'API price (Buy, in USDT)' }), el('td', { class: 'v', id: 'est-api', text: `${cv.apiPrice.amount} USDT` })),
        el('tr', {}, el('th', { text: `You will spend (Textile sells ${cv.sell.symbol} for USDT; this is more than the API price)` }), el('td', { class: 'v', id: 'est-sell', text: `${cv.sell.amount} ${cv.sell.symbol}` })),
        el('tr', {}, el('th', { text: 'Smallest swap Textile allows' }), el('td', { class: 'v', id: 'est-min-swap', text: limits ? `${limits.minSell} ${cv.sell.symbol}` : 'n/a' })),
        el('tr', {}, el('th', { text: 'Rate' }), el('td', { class: 'v', text: cv.rate })),
        el('tr', {}, el('th', { text: 'Conversion cost (Textile fee, included)' }), el('td', { class: 'v', id: 'est-fee', text: `${cv.conversionFee.amount} ${cv.conversionFee.symbol}` })),
        el('tr', {}, el('th', { text: 'You receive in USDT' }), el('td', { class: 'v', id: 'est-receive', text: `about ${cv.receive.expected}, never less than ${cv.receive.minimum}` })),
        el('tr', {}, el('th', { text: 'Then paid to Buy' }), el('td', { class: 'v', text: `${cv.apiPrice.amount} USDT` })),
        el('tr', {}, el('th', { text: 'Stays in your wallet as USDT' }), el('td', { class: 'v', id: 'est-left', text: `at least ${cv.leftoverAtLeast} USDT` })),
        el('tr', {}, el('th', { text: 'Payrail fee' }), el('td', { class: 'v', text: `3% platform fee on the API price (${o.fee.amount} USDT), recorded as DUE, not collected. Payrail adds nothing to the conversion.` }))),
      el('p', { class: 'muted', id: 'est-why', text: 'Textile converts at least about 1 USD at a time, so the conversion is larger than this API costs. The USDT you do not spend stays in your wallet. This is an estimate: the final price is fixed by Textile when you approve, and the conversion is rejected if it would give you less than the minimum shown.' }),
      el('p', { class: 'muted', text: evidence && evidence.basis ? `Route evidence: ${evidence.basis}` : '' }),
      gas && gas.low ? el('p', { class: 'notice', id: 'gas-warning', text: `Your wallet holds ${gas.celoBalance} CELO. The approval and the swap need gas (about ${gas.recommendedCelo} CELO is comfortable). Add a little CELO first, or the wallet may refuse the transaction.` }) : null,
      el('div', { class: 'row' }, el('button', { type: 'button', id: 'convert-btn', text: `Approve: convert ${cv.sell.amount} ${cv.sell.symbol} to USDT with my wallet` })));
    box.querySelector('#convert-btn').addEventListener('click', () => runConversion(o, cv, box));
  }

  async function runConversion(o, cv, box) {
    const btn = box.querySelector('#convert-btn');
    btn.disabled = true;
    clear(stepsBox); msg.textContent = '';
    const acct = await connect();
    if (!acct) { btn.disabled = false; return; }
    if (!(await signedIn(acct))) { btn.disabled = false; return; }
    if (lower(acct) !== lower(o.payer)) { addStep('wallet-match', '').fail(`This conversion was prepared for ${o.payer}. Switch to that wallet.`); btn.disabled = false; return; }
    const sp = addStep('proof', 'Sign Textile authorization in your wallet (a signature only: it moves nothing)');
    const pr = await api('/buy/convert/proof', { body: {}, bearer: buyerToken });
    if (!pr.ok) { sp.fail(fail(pr)); btn.disabled = false; return; }
    let signature;
    try { signature = await eth().request({ method: 'eth_signTypedData_v4', params: [acct, JSON.stringify(pr.typedData)] }); } catch (e) { sp.fail(`Signature declined: ${e.message || e}. Nothing was sent or converted.`); btn.disabled = false; return; }
    sp.done('Authorization signed');
    const sq = addStep('firm', 'Getting Textile\'s firm price and checking it against what you were shown…');
    const prep = await api('/buy/convert/prepare', { body: { conversionId: cv.id, nonce: pr.nonce, issuedAt: pr.issuedAt, signature }, bearer: buyerToken });
    if (!prep.ok) { sq.fail(`${fail(prep)}. Nothing was converted.`); btn.disabled = false; return; }
    const pd = prep.prepared;
    if (pd.kind === 'no_quote') { sq.fail(`Textile has no firm price for this right now: ${pd.reason}. Nothing was converted.`); btn.disabled = false; return; }
    if (pd.kind === 'rejected') { sq.fail(`The firm price was rejected by Payrail\'s checks (${pd.problems.slice(0, 2).join('; ')}). Nothing was converted.`); btn.disabled = false; return; }
    sq.done(`Firm price accepted: you pay ${pd.takerPays} (smallest units) and receive at least ${cv.receive.minimum} USDT`);
    let swapHash = null;
    for (const st of pd.steps) {
      const label = st.kind === 'swap' ? `Confirm the conversion transaction in your wallet (${cv.sell.symbol} -> USDT)` : `Confirm the ${cv.sell.symbol} spending approval in your wallet`;
      const sx = addStep(st.kind, label);
      let hash;
      try { hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: acct, to: st.to, data: st.data, value: '0x0' }] }); } catch (e) { sx.fail(`Transaction declined: ${e.message || e}. ${st.kind === 'swap' ? 'Nothing was converted.' : ''}`); btn.disabled = false; return; }
      sx.done(`${st.kind === 'swap' ? 'Conversion' : 'Approval'} sent: ${String(hash).slice(0, 12)}…`);
      const rep = await api('/buy/convert/tx', { body: { conversionId: cv.id, kind: st.kind === 'swap' ? 'swap' : 'approve', txHash: hash }, bearer: buyerToken });
      if (!rep.ok) { addStep('report', '').fail(fail(rep)); }
      if (st.kind === 'swap') swapHash = hash;
    }
    if (!swapHash) { addStep('swap', '').fail('No conversion transaction was produced.'); btn.disabled = false; return; }
    const vs = addStep('verify', 'Verifying the conversion on-chain (nothing counts until the receipt proves it)…');
    let last = null;
    for (let i = 0; i < 60; i++) {
      const r = await api(`/buy/convert/${cv.id}/recheck`, { body: {}, bearer: buyerToken });
      if (r.ok) { last = r.conversion; if (['CONFIRMED', 'FAILED', 'REVIEW'].includes(last.state)) break; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (!last || last.state !== 'CONFIRMED') {
      vs.fail(last ? (last.state === 'FAILED' ? 'The conversion transaction failed on-chain. No currency was converted.' : last.state === 'REVIEW' ? `The conversion could not be confirmed (${last.failure || 'unexpected result'}). It is NOT treated as done.` : 'Still waiting for confirmation. It is NOT confirmed yet; use Re-check conversion.') : 'Could not read the result yet. It is NOT confirmed.');
      box.append(el('button', { type: 'button', class: 'secondary', id: 'recheck-conversion', text: 'Re-check conversion', onclick: async (e) => {
        e.target.disabled = true;
        const r = await api(`/buy/convert/${cv.id}/recheck`, { body: {}, bearer: buyerToken });
        e.target.disabled = false;
        if (r.ok && r.conversion.state === 'CONFIRMED') { convDone = r.conversion; afterConversion(r.conversion); } else msg.textContent = r.ok ? `Conversion state: ${r.conversion.state}` : fail(r);
      } }));
      btn.disabled = false;
      return;
    }
    vs.done(`Conversion verified: ${last.receive.received} USDT arrived in your wallet`);
    convDone = last;
    afterConversion(last);
  }

  // the purchase is quoted again (the first quote has a short validity) with the proven conversion attached
  async function afterConversion(cv) {
    const c = checkBody(input.value);
    msg.textContent = 'Asking Buy for a fresh exact price…';
    const r = await api('/buy/quote', { body: { serviceId: s.id, input: c.value, conversionId: cv.id }, bearer: buyerToken });
    msg.textContent = '';
    if (!r.ok) { problem.textContent = fail(r); problem.hidden = false; return; }
    current = r.order;
    showQuote(current, r.funding);
    quoteBox.prepend(el('p', { class: 'headline ok', id: 'conversion-done', text: `Converted: ${cv.sell.amount} ${cv.sell.symbol} became ${cv.receive.received} USDT (verified on-chain). Now pay ${current.amount} USDT to Buy.` }));
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
    convDone = null;
    showQuote(current, r.funding);
  });
}
window.renderBuy = renderBuy;
