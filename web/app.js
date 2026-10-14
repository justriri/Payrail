// Payrail browser UI. Plain JavaScript, no dependencies.
// Every piece of server/service text is written as plain text (textContent), never parsed as HTML, so a
// malicious service response or description cannot inject markup or script.
'use strict';

const TOKEN = document.querySelector('meta[name="payrail-token"]').content;
const MODE = document.querySelector('meta[name="payrail-mode"]').content;
const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

async function api(path, body) {
  const opts = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-payrail-token': TOKEN }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  let data;
  try { data = await r.json(); } catch { data = { ok: false, problems: [{ code: 'BAD_RESPONSE', message: 'The server sent an unreadable answer.' }] }; }
  return { status: r.status, data };
}

let current = null;      // the inspect view being reviewed
let source = 'auto';     // the currency the user picked
let pollTimer = null;

// ---- banner + wallet
function showBanner(mode, signing) {
  const b = $('banner');
  b.hidden = false;
  if (mode === 'simulated') {
    b.className = 'banner sim';
    b.textContent = 'SIMULATION MODE: no real money, no real blockchain. Results below are fake and for demonstration only.';
  } else {
    b.className = 'banner live';
    b.textContent = signing
      ? 'LIVE: payments use real funds on Celo mainnet, within your spending limits.'
      : 'LIVE (read-only): you can inspect services and quotes. Payments are disabled until the server is started with a wallet key.';
  }
}

async function loadWallet() {
  const { data } = await api('/api/status');
  const w = $('wallet');
  clear(w);
  if (!data.ok) { w.textContent = 'Could not read your wallet right now.'; return; }
  showBanner(data.mode, data.signing);
  w.append(el('p', {}, 'Address: ', el('code', { text: data.wallet })));
  const t = el('table');
  for (const b of data.balances) t.append(el('tr', {}, el('td', { text: b.symbol }), el('td', { class: 'v', text: b.amount })));
  w.append(t);
  w.append(el('p', { class: 'hint', text: `Limits: ${data.limits.perPaymentUsd} per payment, ${data.limits.perDayUsd} per day; conversions up to ${data.limits.perSwapUsd} each, ${data.limits.swapsPerDayUsd} per day.` }));
}

// ---- inspect
function showProblems(container, problems, warn) {
  clear(container);
  container.hidden = !problems || problems.length === 0;
  for (const p of problems || []) container.append(el('div', { class: 'problem' + (warn ? ' warn' : '') }, el('strong', { text: p.message })));
}

async function inspect() {
  stopPolling();
  $('order-card').hidden = true;
  $('inspect-msg').textContent = 'Inspecting…';
  $('inspect-btn').disabled = true;
  const { data } = await api('/api/inspect', { url: $('url').value, body: $('body').value, source });
  $('inspect-btn').disabled = false;
  $('inspect-msg').textContent = '';
  if (!data.ok) {
    $('plan-card').hidden = true;
    showProblems($('problems'), data.problems, false);
    return;
  }
  showProblems($('problems'), [], false);
  current = data;
  if ($('body').value.trim() === '') $('body').value = data.service.bodyExample;
  renderPlan(data);
}

function row(label, value) { return el('tr', {}, el('td', { text: label }), el('td', { class: 'v', text: value })); }

function renderPlan(v) {
  $('plan-card').hidden = false;
  const info = $('service-info');
  clear(info);
  info.append(el('p', {}, el('strong', { text: v.service.title }), el('br'), el('span', { class: 'muted', text: v.service.description })));
  info.append(el('p', { class: 'hint' }, 'Pays to ', el('code', { text: v.payTo || '—' })));

  const f = $('funding');
  clear(f);
  for (const o of v.fundingOptions) {
    const input = el('input', { type: 'radio', name: 'src', value: o.symbol });
    if (o.selected) input.checked = true;
    input.addEventListener('change', () => { source = o.symbol; inspect(); });
    f.append(el('label', { class: o.selected ? 'selected' : '' }, input, el('span', { text: `${o.symbol} — you hold ${o.held}` }), el('span', { class: 'tag', text: o.kind === 'direct' ? 'pay directly' : 'convert first' })));
  }
  if (v.fundingOptions.length === 0) f.append(el('p', { class: 'muted', text: 'You do not hold a currency Payrail can use for this service.' }));

  const s = $('steps');
  clear(s);
  for (const st of v.steps) s.append(el('li', { text: st }));

  const n = $('numbers');
  clear(n);
  if (v.price) n.append(row('Service price', `${v.price.amount} ${v.price.symbol}${v.price.usd ? `  (${v.price.usd})` : ''}`));
  if (v.conversion) {
    const c = v.conversion;
    n.append(row('You sell', `${c.sell} ${c.sellSymbol}`));
    n.append(row('Rate (indicative)', c.rate));
    n.append(row('Conversion fee', c.fee));
    n.append(row('You receive (approx.)', `${c.receive} ${c.receiveSymbol}`));
    n.append(row('Left in your wallet after paying', c.keptAfterPaying));
    n.append(row('Venue', c.provider));
  }
  if (v.costs.gasCelo) n.append(row('Network fees (worst-case estimate; usually lower)', `up to ${v.costs.gasCelo} CELO`));
  if (v.costs.totalUsd) n.append(row('Total cost (service + fee)', v.costs.totalUsd));
  if (v.maxSpend.sell) n.append(row('Most you could sell', v.maxSpend.sell));
  if (v.maxSpend.payment) n.append(row('Payment to the service', v.maxSpend.payment));

  showProblems($('plan-problems'), v.problems, v.canApprove);
  if (v.uncertainties && v.uncertainties.length) {
    for (const u of v.uncertainties) $('plan-problems').append(el('div', { class: 'problem warn' }, el('span', { text: u })));
    $('plan-problems').hidden = false;
  }

  const agree = $('agree');
  agree.checked = false;
  const text = v.conversion
    ? `I approve selling up to ${v.maxSpend.sell} to get ${v.conversion.receiveSymbol}, then paying ${v.maxSpend.payment} to the service.`
    : `I approve paying ${v.maxSpend.payment || 'the service price'} to the service.`;
  $('agree-text').textContent = text;
  $('approval').hidden = false;
  syncApprove();
}

function syncApprove() { $('approve-btn').disabled = !(current && current.canApprove && $('agree').checked); }

// ---- approve + progress
async function approve() {
  if (!current) return;
  $('approve-btn').disabled = true;
  const { status, data } = await api('/api/approve', {
    planId: current.planId,
    termsDigest: current.terms.digest,
    maxSellAtomic: current.terms.maxSellAtomic,
    minReceiveAtomic: current.terms.minReceiveAtomic,
  });
  if (!data.ok) {
    showProblems($('plan-problems'), data.problems, false);
    $('plan-problems').hidden = false;
    if (data.replan) { current = data.replan; renderPlan(data.replan); showProblems($('plan-problems'), data.problems, true); }
    else $('approve-btn').disabled = false;
    return;
  }
  void status;
  $('order-card').hidden = false;
  $('order-card').scrollIntoView({ behavior: 'smooth' });
  startPolling(data.orderId);
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling(orderId) {
  stopPolling();
  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    const { data } = await api(`/api/order/${orderId}`);
    if (data.ok) renderOrder(data);
    if (data.ok && ['completed', 'stopped', 'uncertain', 'refused'].includes(data.stage)) stopPolling();
    if (ticks > 600) stopPolling();
  };
  tick();
  pollTimer = setInterval(tick, 2000);
  $('check-btn').onclick = async () => { const { data } = await api(`/api/order/${orderId}/check`, {}); if (data.ok) renderOrder(data); };
  $('resume-btn').onclick = async () => {
    const { data } = await api(`/api/order/${orderId}/resume`, {});
    if (data.ok) startPolling(orderId); else { $('order-next').textContent = data.problems.map((p) => p.message).join(' '); }
  };
}

function renderOrder(o) {
  const order = $('order-card');
  order.hidden = false;
  const stages = { converting: 0, paying: 1, completed: 2 };
  const lis = [...document.querySelectorAll('#stages li')];
  lis.forEach((li) => (li.className = ''));
  const idx = o.stage === 'running' ? 0 : stages[o.stage];
  const failed = ['stopped', 'uncertain', 'refused'].includes(o.stage);
  if (o.stage === 'completed') lis.forEach((li) => li.classList.add('done'));
  else if (idx !== undefined) {
    lis.forEach((li, i) => { if (i < idx) li.classList.add('done'); });
    lis[idx].classList.add(failed ? 'bad' : 'active');
  }
  if (failed) { const last = o.conversion && o.conversion.state === 'CONFIRMED' ? 1 : 0; lis[last].classList.add('bad'); }

  const h = $('order-headline');
  h.textContent = o.headline;
  h.className = 'headline ' + (o.stage === 'completed' ? 'ok' : o.stage === 'uncertain' ? 'warn' : failed ? 'bad' : '');
  $('order-detail').textContent = o.detail;
  $('order-next').textContent = o.nextAction;
  $('logs').textContent = o.logs.join('\n');
  $('check-btn').hidden = !(o.stage === 'uncertain' || o.stage === 'stopped');
  $('resume-btn').hidden = !o.canResume;

  const links = $('order-links');
  clear(links);
  if (o.mode === 'simulated') links.append(el('p', { class: 'hint', text: 'Simulation: the transactions below are fake and not on any blockchain.' }));
  if (o.conversion) for (const t of o.conversion.txs) links.append(el('p', {}, 'Conversion: ', el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.hash })));
  if (o.payment && o.payment.url) links.append(el('p', {}, `Payment (${o.payment.status}): `, el('a', { href: o.payment.url, target: '_blank', rel: 'noopener noreferrer', text: o.payment.txHash })));
  if (o.payment && o.payment.receiptId) links.append(el('p', { class: 'hint', text: `Receipt: ${o.payment.receiptId}` }));

  if (o.hasResponse) loadResponse(o.orderId, o.payment);
}

let shown = null;
async function loadResponse(orderId, payment) {
  if (shown === orderId) return;
  shown = orderId;
  const { data } = await api(`/api/order/${orderId}/response`);
  $('response-wrap').hidden = false;
  if (!data.ok) { $('response').textContent = data.problems.map((p) => p.message).join(' '); return; }
  let text = data.text;
  try { text = JSON.stringify(JSON.parse(data.text), null, 2); } catch { /* show as received */ }
  $('response').textContent = text;
  $('response-meta').textContent =
    `Delivered${payment && payment.httpStatus ? ` (HTTP ${payment.httpStatus})` : ''}. SHA-256 of the saved response: ${data.sha256 || 'n/a'}.` +
    (data.truncated ? ' Display truncated; the full response is saved on disk.' : '');
}

// ---- browse the catalog
const BR = { offset: 0, limit: 30, loading: false, timer: null, seq: 0 };

function badge(text, kind) { return el('span', { class: 'badge' + (kind ? ' ' + kind : ''), text }); }

function serviceCard(s) {
  const verdicts = [];
  if (!s.available) verdicts.push(badge('Not available', 'bad'));
  else if (!s.verdict.contactable) verdicts.push(badge('Not supported', 'bad'));
  else if (!s.verdict.withinLimit) verdicts.push(badge('Above your per-payment limit', 'warn'));
  else if (s.verdict.autoPay) verdicts.push(badge('Auto-pay allowed', 'ok'));
  else verdicts.push(badge('Needs your approval each time', ''));
  const price = s.price
    ? (s.price.variable ? `${s.price.minUsd} – ${s.price.maxUsd}` : s.price.usd) + (s.price.variable ? ' (varies)' : ' per call')
    : 'price not listed';
  const use = el('button', { type: 'button', text: 'Use this service' });
  if (!s.available || !s.verdict.contactable) use.disabled = true;
  use.addEventListener('click', () => {
    $('url').value = s.url;
    $('body').value = '';
    source = 'auto';
    $('inspect-card').scrollIntoView({ behavior: 'smooth' });
    inspect();
  });
  return el('div', { class: 'svc' + (s.available ? '' : ' off') },
    el('div', { class: 'meta' }, badge(s.platform), el('span', { class: 'price', text: price })),
    el('h4', { text: s.title }),
    el('p', { text: s.description }),
    el('div', {}, ...verdicts),
    use);
}

async function loadCatalog(reset) {
  if (reset) { BR.offset = 0; clear($('browse-list')); }
  const mine = ++BR.seq;
  BR.loading = true;
  $('browse-error').hidden = true;
  $('browse-retry').hidden = true;
  $('browse-more').hidden = true;
  $('browse-status').textContent = BR.offset === 0 ? 'Loading services… (the first load can take about 10 seconds)' : 'Loading more…';
  const p = new URLSearchParams();
  if ($('q').value.trim()) p.set('q', $('q').value.trim());
  if ($('platform').value) p.set('platform', $('platform').value);
  if ($('f-available').checked) p.set('available', '1');
  if ($('f-within').checked) p.set('within', '1');
  p.set('offset', String(BR.offset));
  p.set('limit', String(BR.limit));
  let data;
  try {
    data = (await api('/api/catalog?' + p.toString())).data;
  } catch {
    data = { ok: false, problems: [{ code: 'NETWORK', message: 'Could not reach the Payrail server.' }] };
  }
  if (mine !== BR.seq) return; // a newer search replaced this one
  BR.loading = false;
  if (!data.ok) {
    $('browse-status').textContent = '';
    showProblems($('browse-error'), data.problems, false);
    $('browse-retry').hidden = false;
    return;
  }
  // platform filter options (kept stable once filled)
  const sel = $('platform');
  if (sel.options.length <= 1) {
    for (const pl of data.platforms) sel.append(el('option', { value: pl.platform, text: `${pl.platform} (${pl.count})` }));
  }
  const list = $('browse-list');
  for (const s of data.items) list.append(serviceCard(s));
  BR.offset += data.items.length;
  const shown = Math.min(BR.offset, data.matched);
  if (data.matched === 0) {
    $('browse-status').textContent = `No services match your filters (${data.total} listed in total).`;
  } else {
    $('browse-status').textContent =
      `Showing ${shown} of ${data.matched} matching services (${data.total} listed by ${data.source === 'buy-gateway' ? 'the Buy gateway' : data.source})` +
      (data.stale ? '. This list may be out of date: the catalog could not be refreshed.' : '.') +
      (data.mode === 'simulated' ? ' SIMULATED catalog.' : '');
  }
  $('browse-more').hidden = BR.offset >= data.matched;
}

function reloadSoon() {
  if (BR.timer) clearTimeout(BR.timer);
  BR.timer = setTimeout(() => loadCatalog(true), 300);
}

// ---- wire up
$('q').addEventListener('input', reloadSoon);
$('platform').addEventListener('change', () => loadCatalog(true));
$('f-available').addEventListener('change', () => loadCatalog(true));
$('f-within').addEventListener('change', () => loadCatalog(true));
$('browse-more').addEventListener('click', () => loadCatalog(false));
$('browse-retry').addEventListener('click', () => loadCatalog(true));
$('inspect-btn').addEventListener('click', () => { source = 'auto'; inspect(); });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { source = 'auto'; inspect(); } });
$('agree').addEventListener('change', syncApprove);
$('approve-btn').addEventListener('click', approve);
if (MODE === 'simulated') $('url').placeholder = 'https://gateway.usebuy.ai/v1/social/x/posts/search  (simulation)';
loadWallet();
loadCatalog(true);
