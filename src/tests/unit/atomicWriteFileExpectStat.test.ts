import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile, StaleWriteError } from '../../main/vault/filenameUtils';
import { ipcErrorCode } from '../../main/ipc/ipcErrorCode';

/**
 * A note write names the stat of the version it was built on. A sync client or
 * editor that replaces the file before the rename (including during a Windows
 * lock backoff, which lasts seconds) makes the write fail with STALE: nothing
 * is written over that version, and the staged tmp is removed.
 */

function lockError(code = 'EBUSY'): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: resource busy`);
  err.code = code;
  return err;
}

const tmps = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));

describe('atomicWriteFile with an expected stat', () => {
  let dir: string;
  const savedBudget = process.env.FILO_LOCK_RETRY_BUDGET_MS;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-expectstat-'));
    process.env.FILO_LOCK_RETRY_BUDGET_MS = '1500';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.FILO_LOCK_RETRY_BUDGET_MS = savedBudget;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes when the file still has the stat the caller read', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'theirs');
    const { mtimeMs, size } = await fs.stat(target);
    await atomicWriteFile(target, 'mine', { expectExisting: true, expectStat: { mtimeMs, size } });
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('mine');
  });

  it('refuses with STALE, and cleans up its tmp, when the file changed after the read', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'read by Filo');
    const { mtimeMs, size } = await fs.stat(target);
    await fs.writeFile(target, 'saved by a sync client');
    const err = await atomicWriteFile(target, 'mine', { expectStat: { mtimeMs, size } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StaleWriteError);
    expect(ipcErrorCode(err)).toBe('STALE');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('saved by a sync client');
    expect(await tmps(dir)).toEqual([]);
  });

  it('re-checks before every rename attempt: a file replaced during a lock backoff is not overwritten', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'read by Filo');
    const { mtimeMs, size } = await fs.stat(target);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      calls++;
      // A sync client replaces the file while the rename is locked out.
      if (calls === 1) await fs.writeFile(target, 'saved by a sync client, longer');
      throw lockError();
    });
    const err = await atomicWriteFile(target, 'mine', { expectExisting: true, expectStat: { mtimeMs, size } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as NodeJS.ErrnoException).code).toBe('STALE');
    expect(calls).toBe(1);
    vi.restoreAllMocks();
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('saved by a sync client, longer');
    expect(await tmps(dir)).toEqual([]);
  });
});
