import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, type PathLike } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { renameItem, RenameTargetExistsError } from '../../main/vault/fileOps';

/**
 * Phase 8 (P1-10) regression guard: `renameItem` must handle two
 * platform-specific quirks the OS-default `fs.rename` mishandles:
 *
 *   1. Windows case-only rename (`Notes.md` → `notes.md`) — NTFS treats
 *      both paths as the same file, so a direct rename leaves the casing
 *      unchanged. We trampoline through a temp name to force the change.
 *   2. Cross-filesystem move (`EXDEV`) — `fs.rename` rejects when source
 *      and destination span different filesystems. We fall back to
 *      copy + unlink for files.
 */
describe('renameItem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-rename-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('renames a file to a new basename', async () => {
    const oldPath = join(dir, 'a.md');
    const newPath = join(dir, 'b.md');
    await fs.writeFile(oldPath, 'hello', 'utf-8');
    await renameItem(oldPath, newPath);
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('hello');
    await expect(fs.access(oldPath)).rejects.toBeDefined();
  });

  it('handles a no-op rename (same path) without error', async () => {
    const path = join(dir, 'a.md');
    await fs.writeFile(path, 'hello', 'utf-8');
    await renameItem(path, path);
    await expect(fs.readFile(path, 'utf-8')).resolves.toBe('hello');
  });

  // Phase 1 / 1.1 — POSIX `fs.rename` silently overwrites an existing
  // destination. The pre-flight `fs.access(newPath)` check in `renameItem`
  // must reject the operation with a typed `RenameTargetExistsError` so the
  // IPC layer can prompt the user before clobbering. The original file
  // must stay intact at `oldPath`.
  it('refuses to overwrite an existing destination (RenameTargetExistsError)', async () => {
    const oldPath = join(dir, 'a.md');
    const newPath = join(dir, 'b.md');
    await fs.writeFile(oldPath, 'source content', 'utf-8');
    await fs.writeFile(newPath, 'destination content', 'utf-8');

    await expect(renameItem(oldPath, newPath)).rejects.toBeInstanceOf(RenameTargetExistsError);

    // Both files are untouched — the source remains and the destination
    // is preserved (not silently clobbered, which is the POSIX default).
    await expect(fs.readFile(oldPath, 'utf-8')).resolves.toBe('source content');
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('destination content');
  });

  // The Windows-only case-rename trampoline path is exercised here; on
  // POSIX, `Notes.md` and `notes.md` are different files so the direct
  // `fs.rename` is already correct.
  const itOnWindows = platform() === 'win32' ? it : it.skip;

  itOnWindows('renames a file to a case-only variant of itself (Windows)', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'casing', 'utf-8');
    await renameItem(oldPath, newPath);
    const entries = await fs.readdir(dir);
    // The directory listing reflects the new casing exactly.
    expect(entries).toContain('notes.md');
    expect(entries).not.toContain('Notes.md');
    // No `.case-rename-*` orphan left behind.
    expect(entries.some((name) => name.includes('case-rename'))).toBe(false);
  });

  // When the (tmp → newPath) leg fails on every retry, the function falls
  // back to a best-effort restoration (tmp → oldPath). This test forces
  // every second-leg attempt to fail and asserts the original file is
  // restored without an orphan temp file remaining.
  //
  // IMPL_PLAN_2026-05-26 / Item 2 — `renameItem` now retries the second leg
  // on EBUSY / EPERM / EACCES before bailing, so the mock must throw on
  // every (tmp → newPath) call (not just one) for the rescue path to run.
  itOnWindows('restores the original file when every second-rename retry fails (Windows)', async () => {
    const oldPath = join(dir, 'Notes.md');
    const newPath = join(dir, 'notes.md');
    await fs.writeFile(oldPath, 'restoration', 'utf-8');

    const realRename = fs.rename.bind(fs);
    const spy = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (from: PathLike, to: PathLike) => {
        if (String(to) === newPath) {
          throw Object.assign(new Error('Simulated interruption'), { code: 'EPERM' });
        }
        return realRename(from, to);
      });

    try {
      await expect(renameItem(oldPath, newPath)).rejects.toThrow('Simulated interruption');
    } finally {
      spy.mockRestore();
    }

    const entries = await fs.readdir(dir);
    expect(entries).toContain('Notes.md');
    expect(entries.some((name) => name.includes('case-rename'))).toBe(false);
    await expect(fs.readFile(oldPath, 'utf-8')).resolves.toBe('restoration');
  });
});
