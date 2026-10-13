// Concurrency tests. These launch SEPARATE operating-system processes that compete for one receipts
// folder, because two calls inside one process prove nothing about cross-process safety.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { executeDirectPayment } from '../src/executor.ts';
import { listPending } from '../src/history.ts';
import { LockError, acquireLock } from '../src/lock.ts';
import { BODY, gateway, makeAuth, tempDir, testAccount, verifyDeps } from './support.ts';

const WORKER = fileURLToPath(new URL('./workers/worker.ts', import.meta.url));

interface WorkerResult {
  kind?: string;
  code?: string;
  status?: string;
  paid?: number;
  windows?: Array<{ start: number; end: number }>;
}

function start(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [WORKER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Spawns n workers that all begin at the same wall-clock instant (a start barrier), so they really collide. */
function group(n: number, env: Record<string, string>): ChildProcess[] {
  // generous barrier: under a loaded machine (the whole suite runs files in parallel) process start-up is slow
  const at = String(Date.now() + 10_000);
  return Array.from({ length: n }, () => start({ ...env, W_START: at }));
}

function finish(child: ChildProcess): Promise<{ code: number | null; result: WorkerResult; stderr: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      resolve({ code, result: line ? (JSON.parse(line) as WorkerResult) : {}, stderr: err });
    });
  });
}

function waitFor(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`worker never printed ${marker}`)), 15_000);
    child.stdout!.on('data', (d) => {
      buf += d;
      if (buf.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('close', () => reject(new Error('worker exited early')));
  });
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on('close', () => resolve());
    child.kill('SIGKILL'); // forced: no cleanup handlers run, like a real crash
  });
}

const receiptFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json'));

// ------------------------------------------------------------------ the main claim
test('4 competing PROCESSES: exactly one payment is sent, the rest are refused', async () => {
  const dir = tempDir();
  const workers = group(4, { W_DIR: dir, W_MODE: 'pay', W_DELAY: '600' });
  const results = await Promise.all(workers.map(finish));
  for (const r of results) assert.equal(r.code, 0, r.stderr);

  const completed = results.filter((r) => r.result.kind === 'completed');
  const refused = results.filter((r) => r.result.kind === 'not_sent');
  assert.equal(completed.length, 1, JSON.stringify(results.map((r) => r.result)));
  assert.equal(refused.length, 3);
  for (const r of refused) assert.ok(['LOCK_HELD', 'PRIOR_RECEIPT', 'PENDING_PAYMENT'].includes(r.result.code!), String(r.result.code));
  assert.equal(results.reduce((n, r) => n + (r.result.paid ?? 0), 0), 1, 'total paid requests across all processes');
  assert.equal(receiptFiles(dir).length, 1);
  assert.equal(listPending(dir).length, 0);
  assert.ok(!existsSync(join(dir, 'locks', 'execution.lock')), 'lock released');
});

test('with --again and waiting, payments are SERIALIZED (never overlapping) and the daily limit holds across processes', async () => {
  const dir = tempDir();
  // limit = exactly one 5000-unit payment per day
  const workers = group(3, { W_DIR: dir, W_MODE: 'pay', W_DELAY: '250', W_AGAIN: '1', W_WAIT: '15000', W_MAX_DAY: '5000' });
  const results = await Promise.all(workers.map(finish));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const completed = results.filter((r) => r.result.kind === 'completed');
  assert.equal(completed.length, 1, JSON.stringify(results.map((r) => r.result)));
  for (const r of results.filter((r) => r.result.kind !== 'completed')) assert.equal(r.result.code, 'DAILY_LIMIT');
  assert.equal(results.reduce((n, r) => n + (r.result.paid ?? 0), 0), 1);
});

test('without a daily limit, --again payments from several processes still never overlap in time', async () => {
  const dir = tempDir();
  const workers = group(3, { W_DIR: dir, W_MODE: 'pay', W_DELAY: '300', W_AGAIN: '1', W_WAIT: '15000' });
  const results = await Promise.all(workers.map(finish));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const windows = results.flatMap((r) => r.result.windows ?? []).sort((a, b) => a.start - b.start);
  assert.equal(windows.length, 3, 'each process was allowed to pay once, one after another');
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i]!.start >= windows[i - 1]!.end, `payment ${i} overlapped payment ${i - 1}`);
  }
});

test('mutual exclusion: 6 processes entering a critical section never interleave', async () => {
  const dir = tempDir();
  const marker = join(dir, 'marker.txt');
  writeFileSync(marker, '');
  const workers = group(6, { W_DIR: dir, W_MODE: 'critical', W_MARKER: marker, W_WAIT: '15000' });
  const results = await Promise.all(workers.map(finish));
  // every worker's exit code, result and stderr is in the failure message, so a flake is diagnosable
  const detail = JSON.stringify(results.map((r) => ({ code: r.code, result: r.result, stderr: r.stderr.slice(0, 300) })));
  for (const r of results) assert.equal(r.code, 0, detail);
  const lines = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(lines.length, 12, `${detail}\n${lines.join('|')}`);
  for (let i = 0; i < lines.length; i += 2) {
    const [a, b] = [lines[i]!.split(' '), lines[i + 1]!.split(' ')];
    assert.deepEqual([a[0], b[0]], ['ENTER', 'EXIT'], `${detail}\n${lines.join('|')}`);
    assert.equal(a[1], b[1], `the process that entered is the one that exits next: ${lines.join('|')}`);
  }
});

// ------------------------------------------------------------------ negative controls (probes must be able to FAIL)
test('NEGATIVE CONTROL: without the lock the critical-section probe DOES see interleaving', async () => {
  const dir = tempDir();
  const marker = join(dir, 'marker.txt');
  writeFileSync(marker, '');
  const workers = group(6, { W_DIR: dir, W_MODE: 'critical-nolock', W_MARKER: marker });
  await Promise.all(workers.map(finish));
  const lines = readFileSync(marker, 'utf8').trim().split('\n');
  let alternating = true;
  for (let i = 0; i < lines.length; i += 2) {
    if (lines[i]!.split(' ')[0] !== 'ENTER' || lines[i + 1]!.split(' ')[0] !== 'EXIT' || lines[i]!.split(' ')[1] !== lines[i + 1]!.split(' ')[1]) {
      alternating = false;
    }
  }
  assert.equal(alternating, false, 'the probe is sensitive: it detects processes overlapping when no lock is used');
});

test('NEGATIVE CONTROL: the pre-fix check-then-act sequence double-pays when processes race', async () => {
  const dir = tempDir();
  const workers = group(4, { W_DIR: dir, W_MODE: 'pay-naive', W_DELAY: '300' });
  const results = await Promise.all(workers.map(finish));
  const paid = results.reduce((n, r) => n + (r.result.paid ?? 0), 0);
  assert.ok(paid > 1, `expected the unlocked sequence to pay more than once, got ${paid}`);
});

// ------------------------------------------------------------------ crash handling (real killed processes)
test('a process killed inside the critical section does not leave the app permanently unusable', async () => {
  const dir = tempDir();
  const holder = start({ W_DIR: dir, W_MODE: 'hold-lock' });
  await waitFor(holder, 'LOCKED');
  assert.ok(existsSync(join(dir, 'locks', 'execution.lock')));

  // Owner alive: a competitor must be refused.
  await assert.rejects(acquireLock(dir, { staleAfterMs: 1 }), (e) => e instanceof LockError && e.code === 'LOCK_HELD');

  await kill(holder);
  await new Promise((r) => setTimeout(r, 80)); // let the heartbeat age pass staleAfterMs
  const lock = await acquireLock(dir, { staleAfterMs: 50 });
  lock.assertHeld();
  lock.release();
});

test('a crash AFTER the journal is written leaves the lock recoverable but payments still blocked until a human resolves', async () => {
  const dir = tempDir();
  const holder = start({ W_DIR: dir, W_MODE: 'hold-journal' });
  await waitFor(holder, 'JOURNALED');
  await kill(holder);
  await new Promise((r) => setTimeout(r, 80));

  const account = testAccount();
  const gw = gateway({ payer: account.address });
  const r = await executeDirectPayment(makeAuth(account.address), {
    account,
    body: BODY,
    receiptDir: dir,
    attributionTag: 'celo_b2fff2ac9413',
    verify: verifyDeps('settled', account.address),
    getBalance: async () => 600_000n,
    fetchImpl: gw.fetchImpl,
    again: true,
    lock: { staleAfterMs: 50 },
  });
  assert.equal(r.kind === 'not_sent' && r.code, 'PENDING_PAYMENT', 'uncertain payments still need a human, even with --again');
  assert.equal(gw.calls.length, 0);
  assert.ok(!existsSync(join(dir, 'locks', 'execution.lock')), 'the lock itself was recovered and released');
});

// ------------------------------------------------------------------ stale-lock rules (injected liveness)
/** Writes a lock file as if another process had created it `ageMs` ago. */
function seedLock(dir: string, info: { pid: number; host: string }, ageMs: number, raw?: string): string {
  mkdirSync(join(dir, 'locks'), { recursive: true });
  const file = join(dir, 'locks', 'execution.lock');
  const contents = raw ?? JSON.stringify({ token: 'old', pid: info.pid, host: info.host, startedAt: new Date().toISOString() });
  writeFileSync(file, contents);
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
  return file;
}

test('stale-lock rules: broken only if owner is on this host, not running, and the heartbeat is old', async () => {
  const HOST = 'this-host';
  const base = { host: HOST, staleAfterMs: 1000, isProcessAlive: (pid: number) => pid === 111 };

  // dead owner + old heartbeat -> broken
  let dir = tempDir();
  seedLock(dir, { pid: 222, host: HOST }, 60_000);
  const l = await acquireLock(dir, base);
  l.release();

  // live owner + old heartbeat -> NOT broken
  dir = tempDir();
  seedLock(dir, { pid: 111, host: HOST }, 60_000);
  await assert.rejects(acquireLock(dir, base), (e) => e instanceof LockError && e.code === 'LOCK_HELD');

  // dead owner + FRESH heartbeat -> NOT broken
  dir = tempDir();
  seedLock(dir, { pid: 222, host: HOST }, 10);
  await assert.rejects(acquireLock(dir, base), (e) => e instanceof LockError && e.code === 'LOCK_HELD');

  // owner on a different host (cannot check the process) -> NOT broken
  dir = tempDir();
  seedLock(dir, { pid: 222, host: 'another-machine' }, 60_000);
  await assert.rejects(acquireLock(dir, base), (e) => e instanceof LockError && e.code === 'LOCK_HELD');

  // unreadable/corrupt lock file -> NOT broken (cannot prove the owner is gone)
  dir = tempDir();
  seedLock(dir, { pid: 0, host: HOST }, 60_000, '{ half written');
  await assert.rejects(acquireLock(dir, base), (e) => e instanceof LockError && e.code === 'LOCK_HELD');
});

test('lock acquisition fails closed when the lock directory cannot be created', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'locks'), 'a file where the directory should be');
  await assert.rejects(acquireLock(dir), (e) => e instanceof LockError && e.code === 'LOCK_UNAVAILABLE');
});

test('a holder whose lock was broken refuses to continue (assertHeld)', async () => {
  const dir = tempDir();
  const lock = await acquireLock(dir);
  writeFileSync(lock.path, JSON.stringify({ token: 'someone-else', pid: 1, host: 'h', startedAt: '' }));
  assert.throws(() => lock.assertHeld(), (e) => e instanceof LockError && e.code === 'LOCK_LOST');
  lock.release(); // must NOT delete a lock it does not own
  assert.ok(existsSync(lock.path));
});
