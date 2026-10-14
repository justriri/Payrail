// File helpers for journals.
//
// WHY: Payrail's journals are written "temp file, then rename over the real file" so a crash never leaves a
// half-written journal. On a OneDrive-synced folder (and with antivirus/indexers) the rename can fail for a
// moment with EPERM/EBUSY/EACCES while the sync client holds the destination. That is a TRANSIENT condition,
// so the rename is retried with a short bounded backoff. If it still cannot be done the function THROWS: a
// journal that cannot be saved must stop the operation (journal-before-send), never be skipped.
import { copyFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);

/** Blocking sleep (journal writes are synchronous by design). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ReplaceOptions {
  /** Rename attempts before falling back to copy. Default 10. */
  attempts?: number;
  /** First backoff (ms), doubled each attempt up to maxBackoffMs. Default 20 / 400. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable for tests. */
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}

/** Replace `dest` with `contents`. Atomic when the rename succeeds; retried when it is transiently blocked. */
export function replaceFileAtomic(dest: string, contents: string, o: ReplaceOptions = {}): void {
  const rename = o.rename ?? renameSync;
  const sleep = o.sleep ?? sleepSync;
  const attempts = Math.max(1, o.attempts ?? 10);
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);

  let lastError: unknown;
  let wait = o.backoffMs ?? 20;
  const cap = o.maxBackoffMs ?? 400;
  for (let i = 1; i <= attempts; i++) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code)) break; // a real error: do not mask it
      if (i < attempts) {
        sleep(wait);
        wait = Math.min(cap, wait * 2);
      }
    }
  }
  // Last resort for a persistently locked destination: copy over it (the temp file is complete, so this still
  // produces a whole file). If even that fails the error propagates and the caller must not proceed.
  const code = (lastError as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (TRANSIENT.has(code)) {
    try {
      copyFileSync(tmp, dest);
      try {
        unlinkSync(tmp);
      } catch {
        /* a stray temp file is harmless: journal listings only read *.json */
      }
      return;
    } catch (e) {
      lastError = e;
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastError;
}
