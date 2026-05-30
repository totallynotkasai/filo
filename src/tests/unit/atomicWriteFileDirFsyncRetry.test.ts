/**
 * D.6 — `atomicWriteFile` retries the directory fsync on EBUSY / EACCES
 * with the same exponential backoff as the rename step. SMB-mounted
 * vaults on Windows occasionally return EBUSY on a dir-handle open while
 * antivirus or the parent watcher briefly holds a transient lock — the
 * retry keeps metadata durability intact on network shares without
 * forcing every save site to serialise around them.
 *
 * Other dir-fsync failures (EISDIR/EBADF/ENOTSUP/EPERM) still fail-open
 * silently — they indicate the platform doesn't support dir-fsync at
 * all, and the file-handle sync already covered the data-durability
 * half of the crash-safety contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile } from '../../main/vault/filenameUtils';

describe('atomicWriteFile — D.6 dir-fsync EBUSY retry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-dirsync-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('retries dir-handle open on EBUSY and ultimately succeeds', async () => {
    const target = join(dir, 'note.md');

    const originalOpen = fs.open.bind(fs);
    let dirOpenAttempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (path: unknown, flags?: unknown) => {
      const p = String(path);
      // Only intercept dir-handle opens. The tmp + final-file opens still
      // use the real fs.
      if (p === dir) {
        dirOpenAttempts += 1;
        if (dirOpenAttempts < 3) {
          const err: NodeJS.ErrnoException = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
      }
      return originalOpen(p, flags as Parameters<typeof originalOpen>[1]);
    });

    await atomicWriteFile(target, 'hello');

    // File landed despite the dir-fsync retries.
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('hello');
    // Retry path was exercised at least twice.
    expect(dirOpenAttempts).toBeGreaterThanOrEqual(3);
  });

  it('does not retry on EISDIR / ENOTSUP / EBADF (fail-open semantics preserved)', async () => {
    const target = join(dir, 'note.md');

    const originalOpen = fs.open.bind(fs);
    let dirOpenAttempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (path: unknown, flags?: unknown) => {
      const p = String(path);
      if (p === dir) {
        dirOpenAttempts += 1;
        const err: NodeJS.ErrnoException = new Error('ENOTSUP');
        err.code = 'ENOTSUP';
        throw err;
      }
      return originalOpen(p, flags as Parameters<typeof originalOpen>[1]);
    });

    await atomicWriteFile(target, 'world');

    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('world');
    // Single attempt — no retry on ENOTSUP.
    expect(dirOpenAttempts).toBe(1);
  });

  it('gives up after retry budget exhausted but still resolves (data already on disk)', async () => {
    const target = join(dir, 'note.md');

    const originalOpen = fs.open.bind(fs);
    let dirOpenAttempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (path: unknown, flags?: unknown) => {
      const p = String(path);
      if (p === dir) {
        dirOpenAttempts += 1;
        const err: NodeJS.ErrnoException = new Error('EBUSY');
        err.code = 'EBUSY';
        throw err;
      }
      return originalOpen(p, flags as Parameters<typeof originalOpen>[1]);
    });

    await atomicWriteFile(target, 'persistent');

    // Data lands on disk regardless of dir-fsync outcome (file-handle
    // sync + rename already happened).
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('persistent');
    // Six attempts: 1 initial + 5 retries.
    expect(dirOpenAttempts).toBe(6);
  });
});
