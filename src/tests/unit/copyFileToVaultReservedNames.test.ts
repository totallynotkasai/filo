import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { copyFileToVault } from '../../main/vault/fileOps';

/**
 * Sprint 37 / 37.4 — `copyFileToVault` rejects Windows-reserved
 * basenames before they reach `fs.copyFile`. Dropping a file named
 * `CON.png` from outside the vault would otherwise open a device handle
 * on Windows (silent no-op or hang). The guard fires regardless of host
 * OS so tests are cross-platform.
 */
describe('copyFileToVault — Sprint 37 / 37.4 reserved-name guard', () => {
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

  it('copies a normally-named file successfully', async () => {
    const src = join(sourceDir, 'Notes.md');
    await fs.writeFile(src, '# hi', 'utf-8');
    const dest = await copyFileToVault(src, vaultDir);
    await expect(fs.readFile(dest, 'utf-8')).resolves.toBe('# hi');
  });

  it('rejects a source filename matching a Windows reserved DOS name', async () => {
    const src = join(sourceDir, 'CON.png');
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(copyFileToVault(src, vaultDir)).rejects.toThrow(/Windows reserved name/);
  });

  it('rejects reserved names regardless of case', async () => {
    const src = join(sourceDir, 'aux.txt');
    await fs.writeFile(src, 'content', 'utf-8');
    await expect(copyFileToVault(src, vaultDir)).rejects.toThrow(/Windows reserved name/);
  });

  it('rejects reserved names with multi-extension stems', async () => {
    const src = join(sourceDir, 'lpt1.tar.gz');
    await fs.writeFile(src, 'archive', 'utf-8');
    await expect(copyFileToVault(src, vaultDir)).rejects.toThrow(/Windows reserved name/);
  });

  it('does not leave a destination file when the guard rejects', async () => {
    const src = join(sourceDir, 'PRN.txt');
    await fs.writeFile(src, 'banned', 'utf-8');
    await expect(copyFileToVault(src, vaultDir)).rejects.toThrow();
    const entries = await fs.readdir(vaultDir);
    expect(entries).toEqual([]);
  });

  it('copies into a subfolder for valid names', async () => {
    const src = join(sourceDir, 'image.png');
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const dest = await copyFileToVault(src, vaultDir, 'attachments');
    expect(dest).toContain(join('attachments', 'image.png'));
    await expect(fs.access(dest)).resolves.toBeUndefined();
  });

  // Windows takes a 90-character Chinese name (270 UTF-8 bytes); a phone the
  // vault syncs to doesn't, and Filo wouldn't make such a name itself. Linux
  // can't hold the source name at all, so this runs on Windows.
  it.skipIf(process.platform !== 'win32')('shortens a name too long for a phone, keeping its extension, instead of refusing it', async () => {
    const src = join(sourceDir, `${'中'.repeat(90)}.png`);
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const dest = await copyFileToVault(src, vaultDir);
    expect(basename(dest)).toBe(`${'中'.repeat(66)}.png`);
    await expect(fs.readFile(dest)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
