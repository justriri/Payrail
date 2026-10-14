// SSRF defences. All network access is faked (resolver + transport): no packets leave this process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EgressError, RateLimiter, blockedAddressReason, safeFetch, validateDestination } from '../src/egress.ts';
import type { EgressRequest, Resolver, Transport } from '../src/egress.ts';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof EgressError ? e.code : `other:${(e as Error).message}`;
  }
};
const syncCode = (f: () => unknown) => {
  try {
    f();
    return 'no error';
  } catch (e) {
    return e instanceof EgressError ? e.code : `other:${(e as Error).message}`;
  }
};

const PUBLIC = '93.184.216.34';
const ok = (status = 200, body = '{"price":1}', headers: Record<string, string> = { 'content-type': 'application/json' }): Transport =>
  async () => ({ status, headers, body: Buffer.from(body) });
const resolves = (...addrs: string[]): Resolver => async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));

// ------------------------------------------------------------------ address classification
test('blocked ranges: private, loopback, link-local/metadata, CGNAT, multicast, reserved, IPv6 equivalents and embedded forms', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '100::1',
  ];
  for (const ip of blocked) assert.ok(blockedAddressReason(ip), `${ip} must be blocked`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) {
    assert.equal(blockedAddressReason(ip), undefined, `${ip} must be allowed`);
  }
  assert.ok(blockedAddressReason('not-an-ip'));
});

// ------------------------------------------------------------------ destination validation (no network)
test('validateDestination: scheme, credentials, port, IP literals in every spelling, and internal-looking names', () => {
  const cases: Array<[string, string]> = [
    ['http://example.com/', 'SCHEME_NOT_ALLOWED'],
    ['ftp://example.com/', 'SCHEME_NOT_ALLOWED'],
    ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
    ['https://user:pw@example.com/', 'USERINFO_NOT_ALLOWED'],
    ['https://example.com:8443/', 'PORT_NOT_ALLOWED'],
    ['https://example.com:22/', 'PORT_NOT_ALLOWED'],
    ['https://127.0.0.1/', 'ADDRESS_BLOCKED'],
    ['https://2130706433/', 'ADDRESS_BLOCKED'], // decimal form of 127.0.0.1
    ['https://0x7f000001/', 'ADDRESS_BLOCKED'], // hex form
    ['https://0177.0.0.1/', 'ADDRESS_BLOCKED'], // octal form
    ['https://127.1/', 'ADDRESS_BLOCKED'], // short form
    ['https://169.254.169.254/latest/meta-data/', 'ADDRESS_BLOCKED'],
    ['https://[::1]/', 'ADDRESS_BLOCKED'],
    ['https://[::ffff:7f00:1]/', 'ADDRESS_BLOCKED'],
    ['https://[fd00::1]/', 'ADDRESS_BLOCKED'],
    ['https://8.8.8.8/', 'HOST_BLOCKED'], // public IP literal: names are required
    ['https://localhost/', 'HOST_BLOCKED'],
    ['https://app.localhost/', 'HOST_BLOCKED'],
    ['https://printer.local/', 'HOST_BLOCKED'],
    ['https://db.internal/', 'HOST_BLOCKED'],
    ['https://intranet/', 'HOST_BLOCKED'],
    ['not a url', 'URL_INVALID'],
    ['', 'URL_INVALID'],
  ];
  for (const [u, want] of cases) assert.equal(syncCode(() => validateDestination(u)), want, u);
  const good = validateDestination('https://api.example.com/v1/price?id=eth');
  assert.equal(good.hostname, 'api.example.com');
  assert.equal(good.port, 443);
  assert.equal(validateDestination('https://api.example.com:8443/x', { allowedPorts: [443, 8443] }).port, 8443);
});

// ------------------------------------------------------------------ resolution, pinning, rebinding
test('a host that RESOLVES to a private or metadata address is refused before any connection', async () => {
  let calls = 0;
  const transport: Transport = async () => (calls++, { status: 200, headers: {}, body: Buffer.alloc(0) });
  for (const addr of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '::ffff:192.168.0.1']) {
    assert.equal(await code(safeFetch('https://innocent.example.com/', { resolver: resolves(addr), transport })), 'ADDRESS_BLOCKED', addr);
  }
  assert.equal(calls, 0, 'no transport call was ever made');
});

test('mixed answers (one public, one private) reject the whole host', async () => {
  let calls = 0;
  const transport: Transport = async () => (calls++, { status: 200, headers: {}, body: Buffer.alloc(0) });
  assert.equal(await code(safeFetch('https://mixed.example.com/', { resolver: resolves(PUBLIC, '10.0.0.9'), transport })), 'ADDRESS_BLOCKED');
  assert.equal(calls, 0);
});

test('pinning / DNS rebinding: the connection goes to the validated address; a later DNS change cannot redirect it', async () => {
  let lookups = 0;
  const resolver: Resolver = async () => {
    lookups += 1;
    // first answer is public, every later answer would be the metadata service
    return [{ address: lookups === 1 ? PUBLIC : '169.254.169.254', family: 4 }];
  };
  let seen: EgressRequest | undefined;
  const transport: Transport = async (r) => ((seen = r), { status: 200, headers: {}, body: Buffer.from('ok') });
  const res = await safeFetch('https://rebind.example.com/path?q=1', { resolver, transport });
  assert.equal(lookups, 1, 'DNS is consulted exactly once per hop');
  assert.equal(seen!.ip, PUBLIC);
  assert.equal(seen!.hostname, 'rebind.example.com', 'the host name is kept for TLS verification');
  assert.equal(seen!.path, '/path?q=1');
  assert.equal(res.connectedTo, PUBLIC);
});

test('DNS failures and empty answers are clear errors', async () => {
  assert.equal(await code(safeFetch('https://nx.example.com/', { resolver: async () => { throw new Error('ENOTFOUND'); }, transport: ok() })), 'DNS_FAILED');
  assert.equal(await code(safeFetch('https://empty.example.com/', { resolver: resolves(), transport: ok() })), 'DNS_FAILED');
});

// ------------------------------------------------------------------ redirects
test('redirects are refused by default; when allowed, EVERY hop is validated from scratch', async () => {
  const redirectTo = (loc: string): Transport => async () => ({ status: 302, headers: { location: loc }, body: Buffer.alloc(0) });
  assert.equal(await code(safeFetch('https://a.example.com/', { resolver: resolves(PUBLIC), transport: redirectTo('https://b.example.com/') })), 'REDIRECT_BLOCKED');

  // allowed, but the redirect target is a literal private IP / http / a name that resolves privately
  for (const [loc, want] of [
    ['http://b.example.com/', 'SCHEME_NOT_ALLOWED'],
    ['https://127.0.0.1/admin', 'ADDRESS_BLOCKED'],
    ['https://169.254.169.254/latest/meta-data/', 'ADDRESS_BLOCKED'],
    ['https://user:pw@b.example.com/', 'USERINFO_NOT_ALLOWED'],
  ] as const) {
    assert.equal(await code(safeFetch('https://a.example.com/', { maxRedirects: 2, resolver: resolves(PUBLIC), transport: redirectTo(loc) })), want, loc);
  }
  const resolver: Resolver = async (h) => [{ address: h === 'evil.example.com' ? '10.1.1.1' : PUBLIC, family: 4 }];
  assert.equal(await code(safeFetch('https://a.example.com/', { maxRedirects: 2, resolver, transport: redirectTo('https://evil.example.com/') })), 'ADDRESS_BLOCKED');

  // a valid redirect chain works, a loop is bounded
  let n = 0;
  const chain: Transport = async () => {
    const headers: Record<string, string> = n === 0 ? { location: '/final' } : {};
    return n++ === 0 ? { status: 301, headers, body: Buffer.alloc(0) } : { status: 200, headers, body: Buffer.from('done') };
  };
  const r = await safeFetch('https://a.example.com/start', { maxRedirects: 2, resolver: resolves(PUBLIC), transport: chain });
  assert.equal(r.body.toString(), 'done');
  const loop: Transport = async () => ({ status: 302, headers: { location: '/again' }, body: Buffer.alloc(0) });
  assert.equal(await code(safeFetch('https://a.example.com/', { maxRedirects: 2, resolver: resolves(PUBLIC), transport: loop })), 'TOO_MANY_REDIRECTS');
});

// ------------------------------------------------------------------ limits
test('response size cap and deadline are enforced', async () => {
  const big: Transport = async () => ({ status: 200, headers: {}, body: Buffer.alloc(5_000) });
  assert.equal(await code(safeFetch('https://a.example.com/', { resolver: resolves(PUBLIC), transport: big, maxBytes: 1_000 })), 'RESPONSE_TOO_LARGE');

  const never: Transport = () => new Promise(() => undefined);
  const t0 = Date.now();
  assert.equal(await code(safeFetch('https://a.example.com/', { resolver: resolves(PUBLIC), transport: never, timeoutMs: 150 })), 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2_000, 'it gave up promptly');

  const slowDns: Resolver = () => new Promise(() => undefined);
  assert.equal(await code(safeFetch('https://a.example.com/', { resolver: slowDns, transport: ok(), timeoutMs: 150 })), 'TIMEOUT');
});

// ------------------------------------------------------------------ request and response hygiene
test('request: injected headers, hop-by-hop headers and unknown methods are refused; safe defaults are added', async () => {
  const send = (h: Record<string, string>, method?: any) => safeFetch('https://a.example.com/', { resolver: resolves(PUBLIC), transport: ok(), headers: h, ...(method ? { method } : {}) });
  assert.equal(await code(send({ 'X-Test': 'a\r\nHost: evil' })), 'HEADER_INVALID');
  assert.equal(await code(send({ 'Bad Header': 'x' })), 'HEADER_INVALID');
  assert.equal(await code(send({ Host: 'internal.example.com' })), 'HEADER_INVALID');
  assert.equal(await code(send({ 'Transfer-Encoding': 'chunked' })), 'HEADER_INVALID');
  assert.equal(await code(send({}, 'CONNECT')), 'METHOD_NOT_ALLOWED');
  assert.equal(await code(send({}, 'TRACE')), 'METHOD_NOT_ALLOWED');

  let seen: EgressRequest | undefined;
  const transport: Transport = async (r) => ((seen = r), { status: 200, headers: {}, body: Buffer.alloc(0) });
  await safeFetch('https://a.example.com/x', { resolver: resolves(PUBLIC), transport, method: 'POST', body: '{"a":1}', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' } });
  assert.equal(seen!.headers['host'], 'a.example.com');
  assert.equal(seen!.headers['accept-encoding'], 'identity');
  assert.equal(seen!.headers['content-length'], '7');
  assert.equal(seen!.headers['authorization'], 'Bearer abc');
  assert.equal(seen!.method, 'POST');
  assert.equal(seen!.body!.toString(), '{"a":1}');
});

test('response: only allow-listed headers are returned (no cookies, no server internals)', async () => {
  const t: Transport = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'session=secret', server: 'internal-nginx/1.2', 'x-internal-ip': '10.0.0.4', 'retry-after': '5' },
    body: Buffer.from('{}'),
  });
  const r = await safeFetch('https://a.example.com/', { resolver: resolves(PUBLIC), transport: t });
  assert.deepEqual(Object.keys(r.headers).sort(), ['content-type', 'retry-after']);
});

test('rate limiter: a burst up to capacity, then refills over time, per key', () => {
  let t = 0;
  const rl = new RateLimiter(3, 1, () => t);
  assert.deepEqual([rl.take('k'), rl.take('k'), rl.take('k'), rl.take('k')], [true, true, true, false]);
  assert.equal(rl.take('other'), true, 'keys are independent');
  t = 1_000;
  assert.equal(rl.take('k'), true);
  assert.equal(rl.take('k'), false);
  t = 10_000;
  assert.deepEqual([rl.take('k'), rl.take('k'), rl.take('k'), rl.take('k')], [true, true, true, false], 'capped at capacity');
});
