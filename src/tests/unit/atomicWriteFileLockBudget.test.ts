import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile, retryOnWindowsLock } from '../../main/vault/filenameUtils';
import { renameItem } from '../../main/vault/fileOps';

/**
 * Audit-19 EXT-5 (plan D6) — OneDrive / Dropbox / antivirus hold rename-
 * blocking handles for a second or two. The old count-based retry gave up
 * after ~310 ms, so every such hold became "Save failed" plus a stray
 * `<file>.<nonce>.tmp` in the synced folder. win32 now retries for ~5 s of
 * ELAPSED time (a scaled budget + real timers stand in for it here).
 */

function lockError(code = 'EPERM'): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: operation not permitted`);
  err.code = code;
  return err;
}

describe('atomicWriteFile — time-bounded Windows lock backoff (Audit-19 EXT-5)', () => {
  let dir: string;
  const savedBudget = process.env.FILO_LOCK_RETRY_BUDGET_MS;

  // Real timers with a SCALED budget (1.5 s stands in for win32's 5 s): a lock
  // held 0.9 s outlasts the old ~310 ms count-based table but not the budget.
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-lockbudget-'));
    process.env.FILO_LOCK_RETRY_BUDGET_MS = '1500';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.FILO_LOCK_RETRY_BUDGET_MS = savedBudget;
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Stubs fs.rename to fail with a lock code until `lockedForMs` after the first attempt. */
  function lockRenameFor(lockedForMs: number): void {
    const realRename = fs.rename.bind(fs);
    let start: number | null = null;
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      start ??= Date.now();
      if (Date.now() - start < lockedForMs) throw lockError();
      return realRename(a, b);
    });
  }

  it('a lock longer than the old ~310 ms table → the write lands, no preserved tmp (bite)', async () => {
    const target = join(dir, 'note.md');
    lockRenameFor(900);
    await atomicWriteFile(target, 'mine');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('mine');
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a lock outlasting the budget → throws with preservedTmpPath after ~the budget', async () => {
    const target = join(dir, 'note.md');
    lockRenameFor(60_000);
    const started = Date.now();
    const err = await atomicWriteFile(target, 'mine').then(() => null, (e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeTruthy();
    expect((err as { preservedTmpPath?: string }).preservedTmpPath).toMatch(/\.[0-9a-f]{12}\.tmp$/);
    expect(elapsed).toBeGreaterThanOrEqual(1400); // time-bounded, not a 5-step table
  });

  it('expectExisting still aborts mid-backoff when the destination is deleted', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'old');
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      calls++;
      if (calls === 2) await fs.unlink(target); // deleted during the backoff
      throw lockError('EBUSY');
    });
    const err = await atomicWriteFile(target, 'mine', { expectExisting: true }).then(() => null, (e) => e);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(calls).toBe(2); // no further rename after the destination vanished
  });

  it('retryOnWindowsLock does not retry a non-lock error', async () => {
    let calls = 0;
    const op = async (): Promise<void> => {
      calls++;
      const e: NodeJS.ErrnoException = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    };
    await expect(retryOnWindowsLock(op, { budgetMs: 5000 })).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});

describe('renameItem — lock retry (Audit-19 EXT-5)', () => {
  let dir: string;
  const savedBudget = process.env.FILO_LOCK_RETRY_BUDGET_MS;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-renamelock-'));
    process.env.FILO_LOCK_RETRY_BUDGET_MS = '5000';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.FILO_LOCK_RETRY_BUDGET_MS = savedBudget;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('EBUSY ×3 then OK → the rename resolves (bite: failed on the first EPERM/EBUSY before)', async () => {
    const from = join(dir, 'Projects');
    const to = join(dir, 'Work');
    await fs.mkdir(from);
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      calls++;
      if (calls <= 3) throw lockError('EBUSY');
      return realRename(a, b);
    });
    await renameItem(from, to);
    expect(calls).toBe(4);
    await expect(fs.stat(to)).resolves.toBeDefined();
  });
});
