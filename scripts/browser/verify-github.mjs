// Browser regression: a seller proves ownership with GitHub (instead of DNS or a token pasted into the host). FAKE GitHub and a fake deployed host,
// REAL seller pages, routes and checks.   node scripts/browser/verify-github.mjs <output dir>
import { makeChecker, startHarness } from './harness.mjs';
import { launch } from './cdp.mjs';

const OUT = process.argv[2];
const h = await startHarness({ seedLegacyDemoRows: false });
const { check, finish } = makeChecker();
const b = await launch(9397, OUT, 1366, 1400);
h.ghState.base = h.BASE;
const wallet = await h.wire(b, h.sellerPk);
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await b.sleep(200); } return false; };
const overflow = () => b.ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
const go = async (hash, wait = 1500) => { await b.ev(`location.hash = ${JSON.stringify(hash)}; 0`); await b.sleep(wait); };

// a draft listing owned by the signed-in seller wallet (created through the same API the form uses)
const c = await h.call('POST', '/seller/listings', { bearer: h.sellerToken, body: { name: 'GitHub verified API', endpointUrl: 'https://api.mygithubapi.example/v1/quote', price: '0.02' } });
const L = c.listing;
const proofValue = L.challenge.wellKnown.content;

await b.goto(`${h.BASE}/market.html#/seller`, 2200);
await b.click('#seller button', 'Sign in with your wallet');
await until(async () => /My APIs/.test((await b.text('#seller')) || ''));
await go(`#/seller/api/${L.id}`, 1800);
await until(async () => (await b.ev(`!!document.querySelector('#github-panel')`)));
check('the ownership section offers GitHub next to DNS and the well-known file, with the reason it needs a file', (await b.ev(`!!document.querySelector('#github-panel')`)) && /GitHub proves you control a repository, not who runs a web address/.test(await b.text('#github-why')) && /Check DNS/.test(await b.text('#seller')) && /Check file/.test(await b.text('#seller')), (await b.text('#github-panel') || '').slice(0, 200));
await until(async () => (await b.ev(`!!document.querySelector('#github-connect')`)));
check('not connected: the page shows Connect GitHub and says no permissions beyond public data are requested', /no permissions beyond/i.test(await b.text('#github-panel')));
await b.shot('github-panel-disconnected');

// connect (the fake GitHub approves at once and returns to the page)
await b.click('#github-panel button', 'Connect GitHub');
await until(async () => (await b.ev(`!!document.querySelector('#github-login')`)), 20000);
check('after the OAuth round trip the page shows the connected GitHub account and no token anywhere', (await b.text('#github-login')) === 'alice' && !(await b.ev('document.documentElement.outerHTML')).includes('tok_alice') && !/github=/.test(await b.ev('location.search')), await b.text('#github-panel'));
check('the OAuth state is consumed and the seller token is sealed in the database', Number(h.db.prepare("SELECT COUNT(*) AS n FROM github_oauth_states WHERE used_at IS NOT NULL").get().n) === 1 && !String(h.db.prepare('SELECT token_sealed FROM github_connections').get().token_sealed).includes('tok_alice'));

// someone else's public repository
h.ghState.repos.set('mallory/their-api', { id: 7001, writers: ['mallory'], files: new Map([['.well-known/payrail-verification.txt', proofValue]]) });
await b.set('#github-repo', 'https://github.com/mallory/their-api');
await b.click('#github-use', 'Use this repository');
await until(async () => (await b.ev(`!!document.querySelector('#github-error')`)));
check("someone else's public repository is refused, even though it contains the proof value", /Repository refused/.test(await b.text('#github-error')) && /does not have write access/.test(await b.text('#github-error')) && !(await b.ev(`!!document.querySelector('#github-check')`)), await b.text('#github-error'));

// an invalid address
await b.set('#github-repo', 'alice/payrail-test-api');
await b.click('#github-use', 'Use this repository');
await until(async () => /Invalid repository address/.test((await b.text('#github-out')) || ''));
check('a bare name is refused as an invalid address', /Invalid repository address/.test(await b.text('#github-out')));

// the seller's own repository
h.ghState.repos.set('alice/my-api', { id: 7002, writers: ['alice'], files: new Map() });
await b.set('#github-repo', 'https://github.com/alice/my-api');
await b.click('#github-use', 'Use this repository');
await until(async () => (await b.ev(`!!document.querySelector('#github-create')`)));
const href = await b.ev(`document.querySelector('#github-create').href`);
check('own repository accepted: the page gives a prefilled "create file" link and the exact content to commit', /^https:\/\/github\.com\/alice\/my-api\/new\/main\?filename=/.test(href) && href.includes(encodeURIComponent(proofValue)) && (await b.text('#github-proof')).includes(proofValue), href);
await b.shot('github-proof-instructions');

// check before committing: a checklist with failures, nothing verified
await b.click('#github-check', 'Check now');
await until(async () => (await b.ev(`!!document.querySelector('#github-checks')`)));
const first = await b.ev(`JSON.stringify([...document.querySelectorAll('#github-checks li')].map((li) => [li.dataset.check, li.dataset.ok]))`).then(JSON.parse);
check('before the file exists the checklist shows which checks passed and which failed, and nothing is verified', first.length === 5 && first.find((x) => x[0] === 'repo_access')[1] === 'true' && first.find((x) => x[0] === 'repo_file')[1] === 'false' && first.find((x) => x[0] === 'deployed_file')[1] === 'false' && /Not verified yet/.test(await b.text('#github-failed')), JSON.stringify(first));
check('the listing is still not domain-verified', /Domain proof: not done/.test(await b.text('#seller')));

// commit the file and let the host serve it
h.ghState.repos.get('alice/my-api').files.set('.well-known/payrail-verification.txt', `${proofValue}\n`);
h.hostProof.value = proofValue;
await b.click('#github-check', 'Check now');
await until(async () => /Domain proof: done \(GitHub\)/.test((await b.text('#seller')) || ''), 20000);
check('after the commit and the deployment every check passes and the domain proof is recorded as GitHub', /Domain proof: done \(GitHub\)/.test(await b.text('#seller')), (await b.text('#seller') || '').slice(0, 300));
const row = h.db.prepare('SELECT domain_method FROM ownership_challenges WHERE listing_id = ?').get(L.id);
const gp = h.db.prepare('SELECT repo_id, github_login, verified_at FROM listing_github_proofs WHERE listing_id = ?').get(L.id);
check('the server recorded method github with the repository id and GitHub user', row.domain_method === 'github' && Number(gp.repo_id) === 7002 && gp.github_login === 'alice' && !!gp.verified_at);

// mobile
await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await b.sleep(400);
check('mobile: the GitHub section fits the screen', (await overflow()) <= 0, await overflow());
await b.shot('github-verified-mobile');

const failedAny = finish();
b.close();
await h.close();
process.exit(failedAny ? 1 : 0);
