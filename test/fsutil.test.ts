// Journal writes must survive a sync client briefly locking the destination, but must never hide a real failure.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replaceFileAtomic } from '../src/fsutil.ts';
import { tempDir } from './support.ts';

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

test('a transiently blocked rename (OneDrive) is retried with backoff and then succeeds', () => {
  const dest = join(tempDir(), 'j.json');
  writeFileSync(dest, 'old');
  let calls = 0;
  const sleeps: number[] = [];
  replaceFileAtomic(dest, 'new', {
    rename: (from, to) => {
      calls += 1;
      if (calls <= 3) throw eperm();
      writeFileSync(to, readFileSync(from));
    },
    sleep: (ms) => void sleeps.push(ms),
  });
  assert.equal(readFileSync(dest, 'utf8'), 'new');
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [20, 40, 80]);
});

test('a persistently locked destination falls back to a whole-file copy; the content is complete', () => {
  const dest = join(tempDir(), 'j.json');
  writeFileSync(dest, 'old');
  replaceFileAtomic(dest, '{"state":"READY"}', { rename: () => { throw eperm(); }, sleep: () => undefined, attempts: 3 });
  assert.equal(readFileSync(dest, 'utf8'), '{"state":"READY"}');
  assert.equal(existsSync(`${dest}.tmp-${process.pid}`), false, 'no stray temp file when the copy worked');
});

test('a non-transient error is NOT masked, and a save that cannot be done THROWS (the caller must stop)', () => {
  const dir = tempDir();
  const dest = join(dir, 'j.json');
  assert.throws(
    () => replaceFileAtomic(dest, 'x', { rename: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }, sleep: () => undefined }),
    /ENOSPC/,
  );
  // destination folder missing: even the copy fallback fails, so it must throw
  assert.throws(() => replaceFileAtomic(join(dir, 'missing-dir', 'j.json'), 'x', { sleep: () => undefined }));
});
