// Child-process worker for the concurrency tests. Configured through W_* environment variables.
// It prints exactly one JSON line to stdout when finished (or a marker line for the "hold" modes).
// No real network, no real keys: accounts are ephemeral and the gateway is an in-process fake.
import { appendFileSync } from 'node:fs';
import { executeDirectPayment } from '../../src/executor.ts';
import { writePending } from '../../src/history.ts';
import { acquireLock } from '../../src/lock.ts';
import { BODY, gateway, makeAuth, testAccount, verifyDeps } from '../support.ts';

const dir = process.env.W_DIR!;
const mode = process.env.W_MODE ?? 'pay';
const delayMs = Number(process.env.W_DELAY ?? 0);
const again = process.env.W_AGAIN === '1';
const waitMs = Number(process.env.W_WAIT ?? 0);
const staleAfterMs = Number(process.env.W_STALE ?? 30_000);
const maxPerDay = process.env.W_MAX_DAY ? BigInt(process.env.W_MAX_DAY) : undefined;

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

// Start barrier: every worker in a group waits for the same wall-clock instant, so they truly collide.
const startAt = Number(process.env.W_START ?? 0);
while (startAt > Date.now()) await new Promise((r) => setTimeout(r, Math.min(20, startAt - Date.now())));
const forever = () => new Promise<void>(() => setInterval(() => undefined, 1000));

if (mode === 'hold-lock') {
  // Acquire the lock, announce it, then wait to be killed (simulates a crash inside the critical section).
  await acquireLock(dir, { staleAfterMs });
  process.stdout.write('LOCKED\n');
  await forever();
} else if (mode === 'hold-journal') {
  // Acquire the lock AND write the pending journal, then wait to be killed (a crash after "sending").
  await acquireLock(dir, { staleAfterMs });
  writePending(dir, {
    id: 'pending-crashed',
    createdAt: new Date().toISOString(),
    state: 'in_flight',
    planId: 'plan-crashed',
    serviceId: 'x.posts.search',
    url: 'https://gateway.usebuy.ai/v1/social/x/posts/search',
    payer: '0x0',
    asset: '0x0',
    payTo: '0x0',
    amountAtomic: '5000',
    note: 'simulated crash',
  });
  process.stdout.write('JOURNALED\n');
  await forever();
} else if (mode === 'critical-nolock') {
  // NEGATIVE CONTROL (test-only): the same probe as 'critical' but WITHOUT the lock. Must interleave.
  const marker = process.env.W_MARKER!;
  appendFileSync(marker, `ENTER ${process.pid}\n`);
  await new Promise((r) => setTimeout(r, 120));
  appendFileSync(marker, `EXIT ${process.pid}\n`);
  out({ ok: true });
} else if (mode === 'pay-naive') {
  // NEGATIVE CONTROL (test-only): the PRE-FIX sequence, check-then-act with no lock:
  //   guard check -> (balance read) -> write journal -> send -> write receipt.
  // It uses the real history primitives so it shows the real race the lock closes.
  const { assertNoPriorPayment } = await import('../../src/history.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  let paid = 0;
  try {
    assertNoPriorPayment(dir, { again });
    await new Promise((r) => setTimeout(r, 400)); // the balance read / signing gap (wide, so the race is reliable)
    writePending(dir, {
      id: `pending-${process.pid}`,
      createdAt: new Date().toISOString(),
      state: 'in_flight',
      planId: 'naive',
      serviceId: 'x.posts.search',
      url: 'u',
      payer: '0x0',
      asset: '0x0',
      payTo: '0x0',
      amountAtomic: '5000',
      note: 'naive',
    });
    await new Promise((r) => setTimeout(r, delayMs)); // "send"
    paid = 1;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `naive-${process.pid}.json`), JSON.stringify({ id: `naive-${process.pid}`, createdAt: new Date().toISOString() }));
  } catch {
    paid = 0;
  }
  out({ paid });
} else if (mode === 'critical') {
  // Classic mutual-exclusion probe: record ENTER/EXIT around a sleep, using an append-only shared file.
  const marker = process.env.W_MARKER!;
  const lock = await acquireLock(dir, { waitMs, pollMs: 10 });
  appendFileSync(marker, `ENTER ${process.pid}\n`);
  await new Promise((r) => setTimeout(r, 120));
  appendFileSync(marker, `EXIT ${process.pid}\n`);
  lock.release();
  out({ ok: true });
} else {
  const account = testAccount();
  const gw = gateway({ payer: account.address, delayMs });
  const auth = makeAuth(account.address);
  const r = await executeDirectPayment(auth, {
    account,
    body: BODY,
    receiptDir: dir,
    attributionTag: 'celo_b2fff2ac9413',
    verify: verifyDeps('settled', account.address),
    getBalance: async () => 600_000n,
    fetchImpl: gw.fetchImpl,
    again,
    lock: { waitMs, pollMs: 10, staleAfterMs },
    ...(maxPerDay !== undefined ? { maxPerDayAtomic: maxPerDay } : {}),
  });
  out({
    kind: r.kind,
    code: r.kind === 'not_sent' ? r.code : undefined,
    status: r.kind === 'completed' ? r.receipt.status : undefined,
    paid: gw.paidCount(),
    windows: gw.windows,
  });
}
