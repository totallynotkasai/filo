import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { copyFileToVault, TargetNameExhaustedError } from '../../main/vault/fileOps';

/**
 * `copyFileToVault` uses `fs.open(..., 'wx')` (O_WRONLY|O_CREAT|O_EXCL) inside
 * the unique-suffix counter loop to RESERVE the destination NAME (a 0-byte
 * placeholder) so two concurrent same-basename copies can never race onto the
 * same name. It then streams the bytes into a sibling `<dest>.<nonce>.tmp` and
 * atomically `rename`s it OVER the placeholder, so the final name never holds a
 * torn/partial file. Contract:
 *
 *   1. On success the destination exists and no `.tmp` siblings remain (the
 *      staging temp is renamed onto the placeholder).
 *   2. Two concurrent copies of the same source resolve to two distinct
 *      destination names; neither caller observes the other's bytes.
 *   3. On a copy failure (non-ENOSPC) BOTH the staging temp and the reserved
 *      placeholder are unlinked.
 *   4. On ENOSPC/EIO/ENOMEM the partially-written staging temp is preserved (the
 *      placeholder is dropped, so no torn partial lands at the final name) and the
 *      temp path is attached to the rejected error via `preservedTmpPath` so the
 *      IPC layer can surface it in a toast.
 *   5. If 1000 same-basename candidates are all taken, the call rejects
 *      with `TargetNameExhaustedError` rather than spinning forever.
 */
describe('copyFileToVault — O_EXCL contract', () => {
  let vaultDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-vault-'));
    sourceDir = await fs.mkdtemp(join(tmpdir(), 'filo-source-'));
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  it('leaves no `.tmp` sibling after a successful copy', async () => {
    const src = join(sourceDir, 'image.png');
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await copyFileToVault(src, vaultDir);
    const entries = await fs.readdir(vaultDir);
    expect(entries).toEqual(['image.png']);
  });

  it('round-trips binary content byte-identical through the O_EXCL fd', async () => {
    const src = join(sourceDir, 'image.png');
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    await fs.writeFile(src, payload);
    const dest = await copyFileToVault(src, vaultDir);
    const onDisk = await fs.readFile(dest);
    expect(onDisk.equals(payload)).toBe(true);
  });

  it('round-trips a multi-chunk binary payload identically (covers the streaming loop)', async () => {
    // 200 KB is larger than the 64 KB chunk window, so this exercises the
    // multi-chunk read/write loop. Pseudo-random bytes drawn deterministically
    // from a counter so the test stays repeatable without spinning up `crypto`.
    const src = join(sourceDir, 'big.bin');
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    await fs.writeFile(src, payload);
    const dest = await copyFileToVault(src, vaultDir);
    const onDisk = await fs.readFile(dest);
    expect(onDisk.equals(payload)).toBe(true);
  });

  it('two concurrent copies of the same source resolve to two distinct destinations', async () => {
    // The previous fileExists() probe could both see "destPath doesn't exist"
    // and race onto the same name. The O_EXCL reservation makes the loser
    // observe EEXIST and bump to the "(1)" candidate.
    const src = join(sourceDir, 'image.png');
    const payload = Buffer.from('hello-world', 'utf-8');
    await fs.writeFile(src, payload);

    const [a, b] = await Promise.all([
      copyFileToVault(src, vaultDir),
      copyFileToVault(src, vaultDir),
    ]);
    expect(a).not.toBe(b);
    const entries = (await fs.readdir(vaultDir)).sort();
    expect(entries).toEqual(['image (1).png', 'image.png']);

    // Both destinations carry the original bytes verbatim — neither
    // truncated the other's copy mid-flight.
    expect((await fs.readFile(a)).equals(payload)).toBe(true);
    expect((await fs.readFile(b)).equals(payload)).toBe(true);
  });

  it('cleans up the partial destination on a non-ENOSPC write failure', async () => {
    const src = join(sourceDir, 'image.png');
    await fs.writeFile(src, Buffer.from([0x01]));

    // Mock the write step by intercepting fs.open for the destination handle.
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await (realOpen as typeof fs.open)(path, flags, mode);
      if (flags === 'wx') {
        // First write through the dest fd throws EACCES.
        handle.write = (async () => {
          const err: NodeJS.ErrnoException = Object.assign(new Error('Simulated EACCES'), {
            code: 'EACCES',
          });
          throw err;
        }) as FileHandle['write'];
      }
      return handle;
    });

    try {
      await expect(copyFileToVault(src, vaultDir)).rejects.toThrow('Simulated EACCES');
    } finally {
      openSpy.mockRestore();
    }

    const entries = await fs.readdir(vaultDir);
    expect(entries).toEqual([]);
  });

  it('preserves the partial destination + attaches preservedTmpPath on ENOSPC', async () => {
    const src = join(sourceDir, 'image.png');
    await fs.writeFile(src, Buffer.from([0x01, 0x02, 0x03, 0x04]));

    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await (realOpen as typeof fs.open)(path, flags, mode);
      if (flags === 'wx') {
        const origWrite = handle.write.bind(handle) as FileHandle['write'];
        let firstWrite = true;
        handle.write = (async (...args: Parameters<FileHandle['write']>) => {
          if (firstWrite) {
            firstWrite = false;
            // Partially write a few bytes so a real partial file lands on
            // disk, then throw ENOSPC the way a true out-of-space disk
            // surfaces it mid-stream.
            await origWrite(Buffer.from([0x99]), 0, 1, 0);
            const err: NodeJS.ErrnoException = Object.assign(
              new Error('ENOSPC: no space left on device'),
              { code: 'ENOSPC' },
            );
            throw err;
          }
          return origWrite(...args);
        }) as typeof origWrite;
      }
      return handle;
    });

    let caught: unknown;
    try {
      await copyFileToVault(src, vaultDir);
    } catch (e) {
      caught = e;
    } finally {
      openSpy.mockRestore();
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('ENOSPC');
    const preserved = (caught as { preservedTmpPath?: string }).preservedTmpPath;
    expect(preserved).toBeDefined();
    expect(preserved).toContain('image.png');
    // The partial file remains at the preserved path so the user can
    // recover it / clear it manually.
    await expect(fs.access(preserved!)).resolves.toBeUndefined();
    // Atomicity: the partial bytes live ONLY in the staging temp. The
    // FINAL destination name never holds a torn file (the placeholder is dropped),
    // and the preserved path is the `.tmp`, not the destination itself.
    expect(preserved!.endsWith('.tmp')).toBe(true);
    await expect(fs.access(join(vaultDir, 'image.png'))).rejects.toBeDefined();
  });

  it('throws TargetNameExhaustedError after 1000 same-basename collisions', async () => {
    // Stub fs.open so every wx-open against this directory returns EEXIST.
    // We can't realistically create 1000 placeholders without slowing the
    // suite, and a deterministic stub is cheaper than a fixture sweep.
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (flags === 'wx' && typeof path === 'string' && path.startsWith(vaultDir)) {
        const err: NodeJS.ErrnoException = Object.assign(new Error('EEXIST'), {
          code: 'EEXIST',
        });
        throw err;
      }
      return (realOpen as typeof fs.open)(path, flags, mode);
    });

    const src = join(sourceDir, 'image.png');
    await fs.writeFile(src, Buffer.from([0x01]));

    let caught: unknown;
    try {
      await copyFileToVault(src, vaultDir);
    } catch (e) {
      caught = e;
    } finally {
      openSpy.mockRestore();
    }
    expect(caught).toBeInstanceOf(TargetNameExhaustedError);
    expect((caught as TargetNameExhaustedError).code).toBe('TARGET_NAME_EXHAUSTED');
    expect((caught as TargetNameExhaustedError).baseName).toBe('image.png');
  });
});
