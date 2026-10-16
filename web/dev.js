// DEVELOPMENT ENVIRONMENT ONLY. This script is served only by the development server (scripts/dev-serve.ts); a production server has no
// route for it. It adds the development affordances to the dashboard: a test-credit buyer session, simulated funding that is
// explained as such, a sandbox seller and sandbox presets. Nothing here is real money.
'use strict';

session.sandboxSeed = store.get('payrail.sandboxSeed');

// labels for the development-only listing origins (the production script knows none of them)
Object.assign(ORIGIN_SHORT, { 'payrail-demo': 'DEMO', 'payrail-sandbox': 'SANDBOX', 'buy-gateway-simulated': 'BUY (SIMULATED)' });
Object.assign(ORIGIN_CLASS, { 'payrail-demo': 'o-demo', 'payrail-sandbox': 'o-sandbox', 'buy-gateway-simulated': 'o-sim' });

const devNote = (text) => el('div', { class: 'banner sim', role: 'note', text });

async function devStartSession() {
  const d = await api('/buyer', { body: {} });
  if (!d.ok) return flash($('buyer'), fail(d), true);
  session.buyer = d.token; store.set('payrail.buyer', d.token);
  const c = await api('/credits', { body: { amount: '5' }, bearer: session.buyer });
  if (!c.ok) flash($('buyer'), fail(c), true);
  await renderBuyer(); renderHistory(); renderAgents(); renderAddFunds();
}

// ---- buyer card: a development session with TEST CREDITS
renderBuyer = async function renderBuyerDev() {
  const box = $('buyer');
  clear(box);
  box.append(devNote('DEVELOPMENT: test credits are a ledger entry on this development server. They are not money.'));
  if (!session.buyer) {
    box.append(
      el('p', { text: 'Start a development session to browse and test the marketplace. One click creates a test buyer with 5 test credits.' }),
      el('button', { type: 'button', id: 'dev-start', text: 'Start development session: get 5 test credits', onclick: devStartSession }),
    );
    return;
  }
  const me = await api('/me', { bearer: session.buyer });
  if (!me.ok) { session.buyer = null; store.set('payrail.buyer', null); return renderBuyer(); }
  box.append(
    el('p', {}, el('strong', { id: 'dev-balance', text: `${me.available} ${me.asset}` }), ` available · ${me.held} held `, el('span', { class: 'badge o-sim', text: 'TEST CREDITS' })),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', id: 'dev-add-credit', text: 'Add 1 test credit', onclick: async () => {
        const d = await api('/credits', { body: { amount: '1' }, bearer: session.buyer });
        if (!d.ok) flash(box, fail(d), true);
        renderBuyer(); renderAddFunds();
      } }),
      el('span', { class: 'muted', text: `Test credits are capped at ${me.creditCap} per buyer.` }),
      el('button', { type: 'button', class: 'secondary', text: 'Forget this buyer', onclick: () => { session.buyer = null; store.set('payrail.buyer', null); renderBuyer(); renderHistory(); renderAgents(); renderAddFunds(); } })),
    el('p', { class: 'muted', text: `Account: ${me.accountId}` }),
  );
};

// ---- wallet and funding: say exactly what exists in development
renderAddFunds = async function renderAddFundsDev() {
  const box = $('fund');
  clear(box);
  box.append(
    devNote('DEVELOPMENT: funding is simulated with test credits.'),
    el('ul', { id: 'dev-funding-explainer' },
      el('li', { text: 'No wallet is connected and no blockchain is used on this server.' }),
      el('li', { text: 'No transaction is sent and none is verified on-chain: a balance here is a test-credit ledger entry.' }),
      el('li', { text: 'Nothing on this page means a wallet is funded or that anything happened on-chain.' }),
      el('li', { text: 'In production, funding is a USDT transfer from your own wallet that is credited only after it is verified on Celo mainnet.' })),
    session.buyer
      ? el('button', { type: 'button', class: 'secondary', text: 'Add 1 test credit', onclick: async () => {
        const d = await api('/credits', { body: { amount: '1' }, bearer: session.buyer });
        if (!d.ok) flash(box, fail(d), true);
        renderBuyer(); renderAddFunds();
      } })
      : el('p', { class: 'muted', text: 'Start a development session (Buyer card) first.' }),
  );
};

// ---- seller: a sandbox seller (a test wallet derived by this development server) and sandbox presets
const _renderSeller = renderSeller;
renderSeller = async function renderSellerDev() {
  await _renderSeller();
  if (session.seller) return;
  const box = $('seller');
  box.prepend(devNote('DEVELOPMENT: the sandbox seller is a test wallet derived by this server. It proves nothing about real ownership.'));
  box.append(el('div', { class: 'row' },
    el('button', { type: 'button', id: 'dev-sandbox-seller', text: 'Use the sandbox seller (development only)', onclick: async () => {
      const d = await api('/seller/sandbox/login', { body: session.sandboxSeed ? { seed: session.sandboxSeed } : {} });
      if (!d.ok) return say(fail(d), 'bad');
      session.seller = d.token; store.set('payrail.seller', d.token);
      session.sandboxSeed = d.seed; store.set('payrail.sandboxSeed', d.seed);
      renderSeller();
    } })));
};

const _newListingPage = newListingPage;
newListingPage = function newListingPageDev() {
  const node = _newListingPage();
  const f = ui.form;
  const rid = () => Math.random().toString(36).slice(2, 8);
  const preset = (label, path, method, name, price) => el('button', { type: 'button', class: 'secondary', text: label, onclick: () => {
    Object.assign(f, { url: `https://my-${rid()}.sandbox.payrail.example${path}`, method, name, price, desc: 'Sandbox API served by the development server' });
    saveUi(); renderSeller();
  } });
  node.insertBefore(el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Development sandbox presets:' }),
    preset('Price API', '/v1/price', 'GET', 'My sandbox price API', '0.01'), preset('Echo API', '/v1/echo', 'POST', 'My sandbox echo API', '0.005')), node.children[1] || null);
  return node;
};

const _editorPage = editorPage;
editorPage = function editorPageDev(l) {
  const page = _editorPage(l);
  if (!session.sandboxSeed) return page;
  const btn = [...page.querySelectorAll('button')].find((x) => x.textContent === 'Sign with wallet');
  if (btn) {
    const copy = btn.cloneNode(true);
    copy.textContent = 'Sign (sandbox wallet, development)';
    copy.addEventListener('click', async () => {
      say('Working…', 'info');
      const d = await api(`/seller/listing/${l.id}/wallet-proof`, { body: { sandbox: true, seed: session.sandboxSeed }, bearer: session.seller });
      say(d.ok ? 'Wallet proof recorded (sandbox).' : fail(d), d.ok ? 'ok' : 'bad');
      await renderSeller();
    });
    btn.replaceWith(copy);
  }
  return page;
};
