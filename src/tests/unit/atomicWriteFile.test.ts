import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile } from '../../main/vault/filenameUtils';

/**
 * Phase 1 (P0-1) regression guard: `vault:write-file-text` now routes
 * through `atomicWriteFile`, so a crash mid-write can never leave a
 * partial file on disk. The contract:
 *
 *   1. The destination file is either fully old or fully new after the call.
 *   2. On success no `.tmp` sibling is left behind.
 *   3. The function is overwrite-safe: a second call replaces the previous
 *      content atomically.
 */
describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-atomic-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes to a non-existent path and produces the final file', async () => {
    const target = join(dir, 'note.md');
    await atomicWriteFile(target, '# hello');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('# hello');
  });

  it('leaves no `.tmp` sibling after a successful write', async () => {
    const target = join(dir, 'note.md');
    await atomicWriteFile(target, 'content');
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['note.md']);
  });

  it('overwrites an existing file atomically without truncating mid-call', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'old content', 'utf-8');
    await atomicWriteFile(target, 'new content that is longer');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe(
      'new content that is longer',
    );
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['note.md']);
  });

  it('cleans up its `.tmp` sibling if the rename ultimately fails', async () => {
    // Force a rename failure by passing an invalid destination (the parent
    // directory does not exist). `atomicWriteFile` should propagate the
    // error but not leak a `.tmp` file inside the existing `dir`.
    const target = join(dir, 'missing-subdir', 'note.md');
    await expect(atomicWriteFile(target, 'content')).rejects.toBeDefined();
    const entries = await fs.readdir(dir);
    // No `.tmp` orphan inside `dir`; the failure surface should be limited
    // to the missing subdirectory.
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  // Phase 31 B1.1 — Buffer overload regression. `media:save-audio` and the
  // recovery-snapshot copy path now write binary data through this helper.
  // Confirm the bytes round-trip without UTF-8 mangling.
  it('writes Buffer payloads byte-identical', async () => {
    const target = join(dir, 'audio.bin');
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    await atomicWriteFile(target, payload);
    const onDisk = await fs.readFile(target);
    expect(onDisk.equals(payload)).toBe(true);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['audio.bin']);
  });

  // Polish phase 1.1 — EACCES joins ENOSPC/EIO/ENOMEM on the preserve-tmp
  // branch. The retry loop exhausted EACCES attempts (antivirus / Dropbox
  // briefly held the destination), but the tmp is intact on disk with the
  // user's content; preserving it lets them recover after regaining
  // permissions on the target. Without the preserve branch, the tmp gets
  // unlink'd and the staged write is lost.
  it('preserves the .tmp sibling on EACCES rename failure (polish 1.1)', async () => {
    const target = join(dir, 'note.md');
    // Pre-create the destination so a real read is possible; the spy
    // forces fs.rename to always throw EACCES so retry budget exhausts.
    await fs.writeFile(target, 'existing', 'utf-8');

    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      const err: NodeJS.ErrnoException = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });

    let captured: unknown;
    try {
      await atomicWriteFile(target, 'staged content');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    const preserved = (captured as { preservedTmpPath?: string } | undefined)?.preservedTmpPath;
    expect(typeof preserved).toBe('string');

    // The preserved tmp must exist on disk with the staged content.
    const entries = await fs.readdir(dir);
    const tmpEntries = entries.filter((n) => n.endsWith('.tmp'));
    expect(tmpEntries.length).toBe(1);
    const preservedContents = await fs.readFile(join(dir, tmpEntries[0]), 'utf-8');
    expect(preservedContents).toBe('staged content');

    // The original destination is unchanged.
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('existing');
  });

  // Polish phase 1.1 — when write/sync throws AND the close handle also
  // throws, the original write/sync error must reach the caller. Without
  // the inner try around fh.close(), the close-after-throw would replace
  // the actionable diagnostic with a generic close failure.
  it('surfaces the write error when both write and close throw (polish 1.1)', async () => {
    const target = join(dir, 'note.md');

    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (path: unknown, flags?: unknown) => {
      const p = String(path);
      // Only intercept the tmp open (the .tmp file path includes our
      // target prefix + a nonce + ".tmp"); the dir-handle open below
      // uses the directory path itself.
      if (p.startsWith(target) && p.endsWith('.tmp')) {
        const fh = await originalOpen(p, flags as Parameters<typeof originalOpen>[1]);
        // Wrap writeFile to throw, and wrap close to also throw — the
        // failing close must NOT mask the failing write.
        const fhAny = fh as unknown as {
          writeFile: (...args: unknown[]) => Promise<void>;
          close: () => Promise<void>;
          sync: () => Promise<void>;
        };
        fhAny.writeFile = async () => {
          const err: NodeJS.ErrnoException = new Error('forced write failure');
          err.code = 'EIO';
          throw err;
        };
        fhAny.close = async () => {
          throw new Error('forced close failure');
        };
        return fh;
      }
      return originalOpen(p, flags as Parameters<typeof originalOpen>[1]);
    });

    let captured: unknown;
    try {
      await atomicWriteFile(target, 'payload');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    // The write error is the load-bearing diagnostic; the close error
    // is logged via console.warn but never thrown.
    expect((captured as Error).message).toContain('forced write failure');
    expect((captured as Error).message).not.toContain('forced close failure');
  });

  // Audit-7 L7 — `vault:write-existing-file-text` passes `expectExisting: true`
  // so a dirty editor's debounce can't resurrect a file the user just deleted.
  // `fs.rename(tmp, dest)` creates `dest` unconditionally, so the guard
  // re-verifies existence immediately before the rename and aborts (ENOENT) if
  // it's gone — shrinking the stat-precheck→rename resurrection window.
  it('expectExisting: refuses to recreate a missing destination (ENOENT, no resurrection)', async () => {
    const target = join(dir, 'deleted.md');
    let captured: NodeJS.ErrnoException | undefined;
    try {
      await atomicWriteFile(target, 'stale editor bytes', { expectExisting: true });
    } catch (err) {
      captured = err as NodeJS.ErrnoException;
    }
    expect(captured?.code).toBe('ENOENT');
    // The file was NOT resurrected, and the staged .tmp was cleaned up.
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  it('expectExisting: writes normally when the destination still exists', async () => {
    const target = join(dir, 'note.md');
    await fs.writeFile(target, 'old', 'utf-8');
    await atomicWriteFile(target, 'new content', { expectExisting: true });
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('new content');
    expect(await fs.readdir(dir)).toEqual(['note.md']);
  });

  it('without expectExisting, a missing destination is still created (default unchanged)', async () => {
    const target = join(dir, 'fresh.md');
    await atomicWriteFile(target, 'created');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('created');
  });
});
