import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, type PathLike } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { renameItem, CaseRenameStrandedError } from '../../main/vault/fileOps';

/**
 * IMPL_PLAN_2026-05-26 / Item 2 — Windows case-only rename robustness.
 *
 * The two-step trampoline (`Notes.md` → `Notes.md.case-rename-<ts>` →
 * `notes.md`) used to fail catastrophically if step 2 hit a transient
 * Windows file-lock (antivirus hold, indexer scan, EBUSY from a sibling
 * handle). The fix retries step 2 with exponential backoff on
 * EBUSY/EPERM/EACCES, and when every retry plus the rescue restore fail
 * it throws a typed `CaseRenameStrandedError` carrying the temp path so
 * the IPC layer can surface it in the rename-failure toast.
 *
 * These tests run only on Windows because the case-only trampoline path
 * is Windows-specific — POSIX treats `Notes.md` and `notes.md` as
 * different files and uses a direct `fs.rename`.
 */

const itOnWindows = platform() === 'win32' ? it : it.skip;

describe('renameItem case-only rename (Windows)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-case-rename-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  itOnWindows('happy path: case-only rename succeeds on the first attempt', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'happy', 'utf-8');

    await renameItem(oldPath, newPath);

    const entries = await fs.readdir(dir);
    expect(entries).toContain('notes.md');
    expect(entries).not.toContain('Notes.md');
    expect(entries.some((n) => n.includes('case-rename'))).toBe(false);
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('happy');
  });

  itOnWindows('retry path: first attempt fails EBUSY, second attempt succeeds', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'retry', 'utf-8');

    const realRename = fs.rename.bind(fs);
    let secondLegAttempts = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from: PathLike, to: PathLike) => {
      if (String(to) === newPath) {
        secondLegAttempts += 1;
        if (secondLegAttempts === 1) {
          // First retry: simulate an antivirus hold.
          throw Object.assign(new Error('antivirus hold'), { code: 'EBUSY' });
        }
        // Second attempt succeeds.
        return realRename(from, to);
      }
      return realRename(from, to);
    });

    try {
      await renameItem(oldPath, newPath);
    } finally {
      spy.mockRestore();
    }

    expect(secondLegAttempts).toBeGreaterThanOrEqual(2);
    const entries = await fs.readdir(dir);
    expect(entries).toContain('notes.md');
    expect(entries).not.toContain('Notes.md');
    expect(entries.some((n) => n.includes('case-rename'))).toBe(false);
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('retry');
  });

  itOnWindows('stranded path: every retry AND the rescue fail → CaseRenameStrandedError', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'stranded', 'utf-8');

    let strandedTmpPath: string | null = null;
    const realRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from: PathLike, to: PathLike) => {
      const toStr = String(to);
      const fromStr = String(from);
      // First leg: oldPath → tmp. Let it through and record the tmp path.
      if (fromStr === oldPath) {
        strandedTmpPath = toStr;
        return realRename(from, to);
      }
      // Every second-leg attempt (tmp → newPath) fails with EBUSY.
      if (toStr === newPath) {
        throw Object.assign(new Error('persistent lock'), { code: 'EBUSY' });
      }
      // Rescue: tmp → oldPath. Force that to fail too with a non-retry code.
      if (toStr === oldPath) {
        throw Object.assign(new Error('rescue blocked'), { code: 'EPERM' });
      }
      return realRename(from, to);
    });

    let caught: unknown = null;
    try {
      await renameItem(oldPath, newPath);
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }

    expect(caught).toBeInstanceOf(CaseRenameStrandedError);
    const stranded = caught as CaseRenameStrandedError;
    expect(stranded.strandedAt).toBe(strandedTmpPath);
    expect(stranded.originalPath).toBe(oldPath);
    expect(stranded.code).toBe('IO_ERROR');
  });

  itOnWindows('non-retry error code (e.g. ENOENT) bails immediately without retrying', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'no-retry', 'utf-8');

    let secondLegAttempts = 0;
    const realRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from: PathLike, to: PathLike) => {
      if (String(to) === newPath) {
        secondLegAttempts += 1;
        // ENOENT is not in the retry allowlist (EBUSY/EPERM/EACCES) — the
        // function should bail without further attempts.
        throw Object.assign(new Error('source vanished'), { code: 'ENOENT' });
      }
      return realRename(from, to);
    });

    try {
      await expect(renameItem(oldPath, newPath)).rejects.toThrow('source vanished');
    } finally {
      spy.mockRestore();
    }

    expect(secondLegAttempts).toBe(1);
    // Rescue still runs — file should be restored to oldPath.
    const entries = await fs.readdir(dir);
    expect(entries).toContain('Notes.md');
    expect(entries.some((n) => n.includes('case-rename'))).toBe(false);
  });
});
