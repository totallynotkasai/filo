import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import {
  isApprovedCopySource,
  registerApprovedSource,
  clearApprovedSources,
  __resetApprovedSourcesForTests,
} from '../../main/services/approvedSources';
import { vaultRegistry } from '../../main/services/vaultRegistry';
import { copyFileToVault } from '../../main/vault/fileOps';

/**
 * Audit-12 S1 — `vault:copy-file` must constrain WHICH file the renderer may
 * name as a source. Two layers are tested here:
 *
 *   1. POLICY — `isApprovedCopySource(vaultRoot, sourcePath)` allows only files
 *      inside the vault or ones explicitly registered (dialog pick / OS drop),
 *      and REJECTS any other path. This is the line that turns an arbitrary
 *      host-file READ primitive back into a user-consented import.
 *
 *   2. TOCTOU / device defence — `copyFileToVault` re-stats through the open fd
 *      (so a path swapped to a non-regular-file after the handler's pre-flight
 *      check is caught) and caps the BYTES STREAMED (so a `/dev/zero`-style
 *      device that under-reports `size` then never EOFs can't fill the disk).
 *
 * Bite-verify (policy): make `isApprovedCopySource` always return true → the
 * "rejects an unregistered external source" specs go red. Bite-verify (TOCTOU):
 * remove the `.isFile()` re-check or the `maxBytes` cap from `copyFileToVault`
 * → the corresponding specs go red.
 */
describe('Audit-12 S1 — approved copy-source policy', () => {
  const VAULT = process.platform === 'win32' ? 'C:\\Users\\me\\Vault' : '/home/me/Vault';

  beforeEach(() => {
    __resetApprovedSourcesForTests();
    // Audit-14 4.2 — registration now BINDS to the active vault (read from the
    // registry), so a registerApprovedSource(...) only takes effect with a vault
    // set. Anchor on VAULT for the generic specs; cross-vault specs override.
    vaultRegistry.setCurrentVault(VAULT);
  });

  afterEach(() => {
    vaultRegistry.setCurrentVault(null);
  });

  it('rejects an unregistered source outside the vault (the core hole)', () => {
    const evil = process.platform === 'win32' ? 'C:\\Users\\me\\.ssh\\id_rsa' : '/etc/passwd';
    expect(isApprovedCopySource(VAULT, evil)).toBe(false);
  });

  it('allows a file that lives inside the vault (no registration needed)', () => {
    const inside = join(VAULT, 'attachments', 'a.png');
    expect(isApprovedCopySource(VAULT, inside)).toBe(true);
  });

  it('treats the vault root itself as inside (but not a sibling that shares its prefix)', () => {
    expect(isApprovedCopySource(VAULT, VAULT)).toBe(true);
    // `…/Vault-backup` must NOT count as inside `…/Vault`.
    expect(isApprovedCopySource(VAULT, `${VAULT}-backup${process.platform === 'win32' ? '\\' : '/'}x.png`)).toBe(false);
  });

  it('allows an external source once it is registered (dialog pick / OS drop)', () => {
    const picked = process.platform === 'win32' ? 'D:\\Photos\\holiday.jpg' : '/mnt/usb/holiday.jpg';
    expect(isApprovedCopySource(VAULT, picked)).toBe(false);
    registerApprovedSource(picked);
    expect(isApprovedCopySource(VAULT, picked)).toBe(true);
  });

  it('normalises `..`/`.` segments so a registered path matches its canonical form', () => {
    const picked = process.platform === 'win32' ? 'D:\\Photos\\holiday.jpg' : '/mnt/usb/holiday.jpg';
    registerApprovedSource(picked);
    const messy =
      process.platform === 'win32'
        ? 'D:\\Photos\\sub\\..\\holiday.jpg'
        : '/mnt/usb/sub/../holiday.jpg';
    expect(isApprovedCopySource(VAULT, messy)).toBe(true);
  });

  it('case-folds on Windows so a re-spelled drive/casing still matches', () => {
    if (process.platform !== 'win32') return; // POSIX is case-sensitive by design
    registerApprovedSource('C:\\Users\\Me\\a.png');
    expect(isApprovedCopySource(VAULT, 'c:\\users\\me\\A.PNG')).toBe(true);
  });

  it('Audit-14 4.2 — a source approved under vault A is NOT approved after a swap to vault B (binding)', () => {
    const VAULT_A = process.platform === 'win32' ? 'C:\\Users\\me\\VaultA' : '/home/me/VaultA';
    const VAULT_B = process.platform === 'win32' ? 'C:\\Users\\me\\VaultB' : '/home/me/VaultB';
    const picked = process.platform === 'win32' ? 'D:\\Photos\\holiday.jpg' : '/mnt/usb/holiday.jpg';

    // User picks an external file while vault A is active → bound to A.
    vaultRegistry.setCurrentVault(VAULT_A);
    registerApprovedSource(picked);
    expect(isApprovedCopySource(VAULT_A, picked)).toBe(true);

    // Swap to vault B WITHOUT clearing — the per-source binding alone rejects the
    // cross-vault reuse (clearApprovedSources is a separate defence layer below).
    vaultRegistry.setCurrentVault(VAULT_B);
    expect(isApprovedCopySource(VAULT_B, picked)).toBe(false);

    // A file that lives INSIDE the newly-open vault still needs no registration.
    const insideB = join(VAULT_B, 'attachments', 'a.png');
    expect(isApprovedCopySource(VAULT_B, insideB)).toBe(true);
  });

  it('Audit-13 M11 — clearApprovedSources() drops a leaked approval (defence in depth)', () => {
    const VAULT_A = process.platform === 'win32' ? 'C:\\Users\\me\\VaultA' : '/home/me/VaultA';
    const picked = process.platform === 'win32' ? 'D:\\Photos\\holiday.jpg' : '/mnt/usb/holiday.jpg';

    vaultRegistry.setCurrentVault(VAULT_A);
    registerApprovedSource(picked);
    expect(isApprovedCopySource(VAULT_A, picked)).toBe(true);

    // The `vault:close` / `vault:watch` swap path calls clearApprovedSources();
    // even back under vault A the approval is gone (a fresh pick is required).
    clearApprovedSources();
    expect(isApprovedCopySource(VAULT_A, picked)).toBe(false);
  });

  it('Audit-14 4.2 — registration with no active vault is a no-op (nothing to bind)', () => {
    const picked = process.platform === 'win32' ? 'D:\\Photos\\x.jpg' : '/mnt/usb/x.jpg';
    vaultRegistry.setCurrentVault(null);
    registerApprovedSource(picked); // no active vault → not recorded
    vaultRegistry.setCurrentVault(VAULT);
    expect(isApprovedCopySource(VAULT, picked)).toBe(false);
  });

  it('ignores empty / non-string inputs (defensive)', () => {
    expect(isApprovedCopySource(VAULT, '')).toBe(false);
    // @ts-expect-error — deliberately exercising the runtime guard
    expect(isApprovedCopySource(VAULT, undefined)).toBe(false);
    registerApprovedSource('');
    expect(isApprovedCopySource(VAULT, '')).toBe(false);
  });
});

describe('Audit-12 S1 — copyFileToVault TOCTOU + streamed-byte cap', () => {
  let vaultDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-s1-vault-'));
    sourceDir = await fs.mkdtemp(join(tmpdir(), 'filo-s1-source-'));
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  it('aborts mid-stream once the bytes copied exceed maxBytes (and cleans up the partial)', async () => {
    // 256 KB source, 128 KB cap. With 64 KB chunks the copy reads 3 chunks
    // (192 KB) and throws BEFORE reading the 4th — proving the cap counts
    // bytes STREAMED, not the pre-read size.
    const src = join(sourceDir, 'big.bin');
    const payload = Buffer.alloc(256 * 1024, 0x42);
    await fs.writeFile(src, payload);

    await expect(copyFileToVault(src, vaultDir, undefined, 128 * 1024)).rejects.toThrow(/copy cap/);

    // The partial destination is unlinked on the (non-ENOSPC) failure.
    expect(await fs.readdir(vaultDir)).toEqual([]);
  });

  it('copies normally when under the cap', async () => {
    const src = join(sourceDir, 'ok.bin');
    const payload = Buffer.alloc(10 * 1024, 0x7);
    await fs.writeFile(src, payload);
    const dest = await copyFileToVault(src, vaultDir, undefined, 128 * 1024);
    expect((await fs.readFile(dest)).equals(payload)).toBe(true);
  });

  it('rejects when the open fd re-stats as a non-regular-file (post-lstat swap)', async () => {
    const src = join(sourceDir, 'swapme.png');
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Simulate a TOCTOU swap: the SOURCE fd ('r') fstats as a non-file (e.g. a
    // character device substituted after the handler's pre-flight lstat).
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
      const handle = await (realOpen as typeof fs.open)(p, flags, mode);
      if (flags === 'r') {
        const realStat = handle.stat.bind(handle);
        handle.stat = (async (...args: Parameters<FileHandle['stat']>) => {
          const s = await realStat(...args);
          return Object.assign(s, { isFile: () => false });
        }) as typeof handle.stat;
      }
      return handle;
    });

    try {
      await expect(copyFileToVault(src, vaultDir)).rejects.toThrow(/not a regular file/);
    } finally {
      openSpy.mockRestore();
    }
    // No partial left behind.
    expect(await fs.readdir(vaultDir)).toEqual([]);
  });

  it('default cap is unbounded — a normal copy of a real file still succeeds', async () => {
    // A regular in-vault-style copy with no explicit cap (the non-IPC callers'
    // signature) must be unaffected by the new param.
    const src = join(sourceDir, 'plain.txt');
    const payload = Buffer.from('hello world', 'utf-8');
    await fs.writeFile(src, payload);
    const dest = await copyFileToVault(src, vaultDir);
    expect(dirname(dest)).toBe(vaultDir);
    expect((await fs.readFile(dest)).equals(payload)).toBe(true);
  });

  // ── Audit-14 4.3 — symlink-target-swap defence (noFollowSource) ────────────

  it('refuses a symlink source when noFollowSource is true (O_NOFOLLOW / lstat-reject)', async () => {
    // Models the post-lstat swap: the source the IPC handler validated as a
    // regular file is now a symlink pointing at another file. With
    // noFollowSource=true the open must refuse it (POSIX: ELOOP; Windows:
    // pre-open lstat rejects the symlink).
    const realTarget = join(sourceDir, 'real-secret.txt');
    await fs.writeFile(realTarget, Buffer.from('secret bytes'));
    const linkPath = join(sourceDir, 'link-to-secret.txt');
    try {
      await fs.symlink(realTarget, linkPath);
    } catch {
      return; // symlink creation needs privilege (common on Windows) — skip
    }

    await expect(
      copyFileToVault(linkPath, vaultDir, undefined, undefined, true),
    ).rejects.toThrow();
    // No partial / placeholder left behind in the vault.
    expect(await fs.readdir(vaultDir)).toEqual([]);
  });

  it('still follows a symlink source when noFollowSource is false (non-IPC callers unchanged)', async () => {
    const realTarget = join(sourceDir, 'real-ok.txt');
    const payload = Buffer.from('followed bytes', 'utf-8');
    await fs.writeFile(realTarget, payload);
    const linkPath = join(sourceDir, 'link-ok.txt');
    try {
      await fs.symlink(realTarget, linkPath);
    } catch {
      return; // skip without symlink privilege
    }

    // Default (5th arg omitted) keeps the legacy follow-the-symlink behaviour.
    const dest = await copyFileToVault(linkPath, vaultDir);
    expect((await fs.readFile(dest)).equals(payload)).toBe(true);
  });
});
