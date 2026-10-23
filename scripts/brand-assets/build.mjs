// Builds the Payrail logo assets from code so they are reproducible: SVG masters (no fonts, no external files) and transparent PNGs.
//   node scripts/brand-assets/build.mjs            writes assets/brand/*.svg and copies the web SVGs into web/
//   node scripts/brand-assets/build.mjs --png      also renders assets/brand/*.png with headless Edge (Windows)
// Concept: two rails cross and swap sides (currency exchange / routing). One rail passes over the other, which breaks to let it through.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'assets', 'brand');
mkdirSync(OUT, { recursive: true });

const INK = '#0e1a17', DEEP = '#0a5c45', MINT = '#34c08f', MINT_DARK = '#5ee0b0', WHITE = '#ffffff';

// ---- symbol (64 x 64 grid). Cubic bezier split by de Casteljau so the lower rail can break where the upper one passes over it.
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function split(p, t) {
  const [p0, p1, p2, p3] = p, a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t), d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}
const f = (n) => +n.toFixed(2);
const d = (p) => `M${p[0].map(f).join(' ')}C${p.slice(1).map((q) => q.map(f).join(' ')).join(' ')}`;
const SW = 7.5; // stroke width
const over = [[7, 46], [25, 46], [39, 18], [57, 18]];
const under = [[7, 18], [25, 18], [39, 46], [57, 46]];
const T0 = 0.38, T1 = 0.62; // the break in the lower rail
const u1 = split(under, T0)[0];
const u2 = split(under, T1)[1];

// the break in the lower rail ends square (butt) so the upper rail passes cleanly; the outer ends are round
const cap = (p, c) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${SW / 2}" fill="${c}" stroke="none"/>`;
const symbolPaths = (a, b) =>
  `<path d="${d(u1)}" stroke="${b}" stroke-linecap="butt"/><path d="${d(u2)}" stroke="${b}" stroke-linecap="butt"/>${cap(under[0], b)}${cap(under[3], b)}<path d="${d(over)}" stroke="${a}"/>`;
const symbolGroup = (a, b) => `<g fill="none" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round">${symbolPaths(a, b)}</g>`;

// ---- wordmark: custom monoline letters drawn with the same round strokes (no font needed). Baseline y=40, x-height top y=20.
const WS = 4.6;
const letters = {
  p: { w: 24, svg: (c) => `<path d="M2 20V52"/><circle cx="12" cy="30" r="10"/>` },
  a: { w: 24, svg: () => `<circle cx="12" cy="30" r="10"/><path d="M22 20V40"/>` },
  y: { w: 24, svg: () => `<path d="M2 20L12.6 41"/><path d="M22 20L8 52"/>` },
  r: { w: 15, svg: () => `<path d="M2 20V40"/><path d="M2 31C2 24 6 20 14 20"/>` },
  i: { w: 4, svg: (c) => `<path d="M2 20V40"/>`, dot: true },
  l: { w: 4, svg: () => `<path d="M2 8V40"/>` },
};
const GAP = 8;
function wordmark(ink, dot) {
  let x = 0, out = '';
  for (const ch of 'payrail') {
    const L = letters[ch];
    out += `<g transform="translate(${f(x)} 0)">${L.svg()}${L.dot ? `<circle cx="2" cy="9" r="3.1" fill="${dot}" stroke="none"/>` : ''}</g>`;
    x += L.w + GAP;
  }
  const width = x - GAP + 2;
  return { width, svg: `<g fill="none" stroke="${ink}" stroke-width="${WS}" stroke-linecap="round" stroke-linejoin="round">${out}</g>` };
}

const doc = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t"><title id="t">${title}</title>${body}</svg>\n`;

const mark = (a, b) => doc(64, 64, symbolGroup(a, b), 'Payrail');
function horizontal(a, b, ink, dot) {
  const wm = wordmark(ink, dot);
  const s = 0.8, gap = 12, wmX = 64 + gap, W = Math.ceil(wmX + wm.width * s + 3); // wordmark scaled so its x-height sits inside the rails' height, centred on them
  return doc(W, 64, `${symbolGroup(a, b)}<g transform="translate(${wmX} ${f(32 - 30 * s)}) scale(${s})">${wm.svg}</g>`, 'Payrail');
}
function tile() {
  // square app icon / favicon: deep green tile, white and mint rails; the symbol sits at 74% so it survives 16 px
  const s = 0.74, o = (64 - 64 * s) / 2;
  return doc(64, 64, `<rect width="64" height="64" rx="14" fill="${DEEP}"/><g transform="translate(${f(o)} ${f(o)}) scale(${s})">${symbolGroup(WHITE, MINT_DARK)}</g>`, 'Payrail');
}

const files = {
  'payrail-mark.svg': mark(DEEP, MINT),
  'payrail-mark-dark.svg': mark(WHITE, MINT_DARK),
  'payrail-logo.svg': horizontal(DEEP, MINT, INK, MINT),
  'payrail-logo-dark.svg': horizontal(WHITE, MINT_DARK, WHITE, MINT_DARK),
  'payrail-icon.svg': tile(),
};
for (const [n, s] of Object.entries(files)) writeFileSync(join(OUT, n), s);
// the web server serves a small allow-list from web/: copies of the masters used by the pages
for (const [src, dst] of [['payrail-logo.svg', 'brand-logo.svg'], ['payrail-mark.svg', 'brand-mark.svg'], ['payrail-icon.svg', 'favicon.svg']]) copyFileSync(join(OUT, src), join(ROOT, 'web', dst));
console.log('svg written:', Object.keys(files).join(', '));

if (process.argv.includes('--png')) {
  const EDGE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe';
  const { launch } = await import('../browser/cdp.mjs');
  const jobs = [
    ['payrail-mark.svg', 'payrail-mark.png', 1024, 1024], ['payrail-mark-dark.svg', 'payrail-mark-dark.png', 1024, 1024],
    ['payrail-icon.svg', 'payrail-icon-512.png', 512, 512], ['payrail-icon.svg', 'payrail-icon-192.png', 192, 192], ['payrail-icon.svg', 'favicon-32.png', 32, 32],
    ['payrail-logo.svg', 'payrail-logo.png', 2400, null], ['payrail-logo-dark.svg', 'payrail-logo-dark.png', 2400, null],
  ];
  const { tmpdir } = await import('node:os');
  const b = await launch(9421, tmpdir(), 1200, 1200); // the browser profile lives in the temp folder, not in the project
  const { readFileSync } = await import('node:fs');
  for (const [svg, png, w, h0] of jobs) {
    const src = readFileSync(join(OUT, svg), 'utf8');
    const vb = src.match(/viewBox="0 0 (\d+) (\d+)"/); const h = h0 ?? Math.round((w * vb[2]) / vb[1]);
    const html = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent}img{display:block;width:${w}px;height:${h}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(src).toString('base64')}">`;
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await b.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'), 600);
    const r = await b.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    writeFileSync(join(OUT, png), Buffer.from(r.result.data, 'base64'));
  }
  b.close();
  console.log('png written');
  process.exit(0);
}
