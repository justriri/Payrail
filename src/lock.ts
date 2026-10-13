// Cross-process execution lock.
//
// WHY: the duplicate guard and the journal write used to be separate steps, so two processes could both
// pass the guard and both pay, or each be under the daily limit and together exceed it. Everything that
// decides and performs a payment now runs inside this lock.
//
// HOW: the lock is a file created with the exclusive flag ('wx'), which the operating system guarantees
// succeeds for exactly one process. The holder refreshes the file's modified time as a heartbeat.
//
// STALE LOCKS (a holder that crashed): a lock is broken ONLY when ALL of these hold:
//   * it was written by this machine (we can check the process),
//   * the owning process is not running, and
//   * the heartbeat is older than staleAfterMs.
// Otherwise it is treated as held. Breaking is done with an atomic rename so only one process wins.
//
// This lock only guarantees MUTUAL EXCLUSION, not that a crashed payment is resolved. A payment that may
// have been sent leaves the pending journal (history.ts), which still needs a human, as before.
//
// LIMIT: file locks are local to one machine. Do not share the receipts folder between machines
// (including via a cloud-sync folder) and expect them to coordinate.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

export class LockError extends Error {
  code: 'LOCK_HELD' | 'LOCK_UNAVAILABLE' | 'LOCK_LOST';
  constructor(code: LockError['code'], message: string) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

export interface LockOptions {
  /** Heartbeat age after which a lock whose owner is provably dead may be broken. Default 30s. */
  staleAfterMs?: number;
  /** How often the holder refreshes the heartbeat. Default 5s. */
  heartbeatMs?: number;
  /** How long to wait for a held lock before giving up. Default 0 (fail immediately). */
  waitMs?: number;
  pollMs?: number;
  /** Lock name (file locks/<name>.lock). Default 'execution': the one shared by payments and swaps. */
  name?: string;
  // Injectable for tests:
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  host?: string;
  pid?: number;
}

export interface HeldLock {
  readonly token: string;
  readonly path: string;
  /** Throws LockError('LOCK_LOST') unless this process still owns the lock file. Call right before a send. */
  assertHeld(): void;
  release(): void;
}

interface LockFile {
  token: string;
  pid: number;
  host: string;
  startedAt: string;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else: alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readLock(path: string): LockFile | undefined {
  try {
    const j: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof j === 'object' && j !== null) {
      const o = j as Record<string, unknown>;
      if (typeof o.token === 'string' && typeof o.pid === 'number' && typeof o.host === 'string') {
        return { token: o.token, pid: o.pid, host: o.host, startedAt: String(o.startedAt ?? '') };
      }
    }
  } catch {
    /* unreadable or half-written */
  }
  return undefined;
}

export async function acquireLock(dir: string, opts: LockOptions = {}): Promise<HeldLock> {
  const staleAfterMs = opts.staleAfterMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 5_000;
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? Date.now;
  const alive = opts.isProcessAlive ?? isProcessAlive;
  const host = opts.host ?? hostname();
  const pid = opts.pid ?? process.pid;

  const lockDir = join(dir, 'locks');
  const path = join(lockDir, `${opts.name ?? 'execution'}.lock`);
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (e) {
    throw new LockError('LOCK_UNAVAILABLE', `cannot create the lock directory: ${(e as Error).message}`);
  }

  const token = randomUUID();
  const started = now();

  // On Windows, creating the lock while another process's unlink is still being processed can fail with
  // EPERM/EACCES/EBUSY instead of EEXIST. That is contention, not a broken lock directory: retry briefly
  // (bounded), and fail closed if it persists.
  let transient = 0;
  for (;;) {
    try {
      const fd = openSync(path, 'wx'); // atomic: succeeds for exactly one process
      try {
        const body: LockFile = { token, pid, host, startedAt: new Date(now()).toISOString() };
        writeSync(fd, JSON.stringify(body));
      } finally {
        closeSync(fd);
      }
      return makeHeld(path, token, heartbeatMs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && transient < 50) {
          transient += 1;
          await sleep(20);
          continue;
        }
        throw new LockError('LOCK_UNAVAILABLE', `cannot create the lock file (${code ?? 'unknown error'}); failing closed`);
      }
    }

    // Held. Decide whether it is provably stale.
    const info = readLock(path);
    let ageMs = 0;
    try {
      ageMs = now() - statSync(path).mtimeMs;
    } catch {
      continue; // it vanished between our attempts; try again
    }
    const provablyDead = info !== undefined && info.host === host && !alive(info.pid);
    if (provablyDead && ageMs > staleAfterMs) {
      try {
        renameSync(path, `${path}.stale-${token}`); // atomic: only one breaker wins
      } catch {
        /* someone else broke it first */
      }
      continue;
    }
    if (now() - started < waitMs) {
      await sleep(pollMs);
      continue;
    }
    const who = info ? `pid ${info.pid} on ${info.host} since ${info.startedAt}` : 'an unreadable lock file';
    throw new LockError(
      'LOCK_HELD',
      `another Payrail process holds the execution lock (${who}). If you are sure it is gone, delete ${path} yourself.`,
    );
  }
}

function makeHeld(path: string, token: string, heartbeatMs: number): HeldLock {
  const timer = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(path, t, t);
    } catch {
      /* assertHeld() will report the loss */
    }
  }, heartbeatMs);
  timer.unref();
  let released = false;
  const stillOurs = () => readLock(path)?.token === token;
  return {
    token,
    path,
    assertHeld() {
      if (released || !stillOurs()) {
        throw new LockError('LOCK_LOST', 'this process no longer owns the execution lock; refusing to continue');
      }
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        if (stillOurs()) unlinkSync(path);
      } catch {
        /* nothing more to do */
      }
    },
  };
}
