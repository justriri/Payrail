import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { createWebServer } from '../src/webapi.ts';
import { createSimulatedRuntime } from '../src/dev/websim.ts';

const SVGS = ['brand-logo.svg', 'brand-mark.svg', 'favicon.svg'];

test('brand assets: masters exist, are self-contained SVG (no fonts, scripts or external references) and the web copies match the masters', () => {
  const masters = ['payrail-logo.svg', 'payrail-logo-dark.svg', 'payrail-mark.svg', 'payrail-mark-dark.svg', 'payrail-icon.svg'];
  for (const n of masters) {
    const s = readFileSync(new URL(`../assets/brand/${n}`, import.meta.url), 'utf8');
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/, n);
    assert.ok(!/<text|<script|<image|<foreignObject|font-family|https?:\/\/(?!www\.w3\.org)|href=/i.test(s), `${n} must not depend on fonts, scripts or external files`);
    assert.equal((s.match(/<svg/g) ?? []).length, 1);
    assert.ok(s.trim().endsWith('</svg>'));
  }
  for (const [web, master] of [['brand-logo.svg', 'payrail-logo.svg'], ['brand-mark.svg', 'payrail-mark.svg'], ['favicon.svg', 'payrail-icon.svg']]) {
    assert.equal(readFileSync(new URL(`../web/${web}`, import.meta.url), 'utf8'), readFileSync(new URL(`../assets/brand/${master}`, import.meta.url), 'utf8'), `${web} is a copy of ${master}`);
  }
  for (const png of ['payrail-logo.png', 'payrail-logo-dark.png', 'payrail-mark.png', 'payrail-icon-512.png', 'favicon-32.png']) assert.ok(existsSync(new URL(`../assets/brand/${png}`, import.meta.url)), png);
});

test('the server serves the logo SVGs with an image type, and every page that shows the brand links assets that exist', async () => {
  const { server } = createWebServer(createSimulatedRuntime({ scenario: 'ok', delayMs: 5 }), { token: 'brand-test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const n of SVGS) {
      const r = await fetch(`${base}/${n}`);
      assert.equal(r.status, 200, n);
      assert.match(r.headers.get('content-type') ?? '', /^image\/svg\+xml/);
      assert.match(await r.text(), /<svg /);
    }
    for (const page of ['/', '/market.html', '/api.html', '/index.html']) {
      const html = await (await fetch(base + page)).text();
      assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/, page);
      for (const m of html.matchAll(/(?:src|href)="\/([\w.-]+\.svg)"/g)) assert.ok(SVGS.includes(m[1]!), `${page} links ${m[1]}`);
    }
    assert.match(await (await fetch(`${base}/`)).text(), /<img src="\/brand-logo\.svg" alt="Payrail"/);
    assert.equal((await fetch(`${base}/not-a-brand.svg`)).status, 404, 'only the listed assets are served');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
