/**
 * A file picked in the system's dialog (card cover, File tile, background)
 * that is already in the vault is linked by its path; only one from outside
 * the vault, or from a hidden folder in it, is copied in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bringPickedFileIn } from '@renderer/lib/vault/pickedFile';
import * as vaultOperations from '@renderer/lib/vault/vaultOperations';

const ROOT = 'C:/Vaults/Book';

beforeEach(() => {
  vi.spyOn(vaultOperations, 'copyFileIntoVault').mockResolvedValue({
    success: true,
    path: `${ROOT}/Board/photo.jpg`,
    relativePath: 'Board/photo.jpg',
  } as Awaited<ReturnType<typeof vaultOperations.copyFileIntoVault>>);
});

afterEach(() => vi.restoreAllMocks());

describe('bringPickedFileIn', () => {
  it('links a file already in the vault, without copying it (any case, either slash)', async () => {
    expect(await bringPickedFileIn('C:\\Vaults\\Book\\Art\\map.png', ROOT, 'Board')).toEqual({ success: true, relPath: 'Art/map.png', linked: true });
    expect(await bringPickedFileIn('c:/vaults/book/cover.jpg', ROOT, 'Board')).toEqual({ success: true, relPath: 'cover.jpg', linked: true });
    expect(vaultOperations.copyFileIntoVault).not.toHaveBeenCalled();
  });

  it('copies a file from outside the vault into the folder', async () => {
    expect(await bringPickedFileIn('D:/Pictures/photo.jpg', ROOT, 'Board')).toEqual({ success: true, relPath: 'Board/photo.jpg', linked: false });
    expect(vaultOperations.copyFileIntoVault).toHaveBeenCalledWith('D:/Pictures/photo.jpg', ROOT, 'Board');
  });

  it('copies a file from a hidden folder in the vault', async () => {
    await bringPickedFileIn(`${ROOT}/.filo/trash/abc/files/old.png`, ROOT, 'Board');
    await bringPickedFileIn(`${ROOT}/.stversions/old~20260101.png`, ROOT, 'Board');
    expect(vaultOperations.copyFileIntoVault).toHaveBeenCalledTimes(2);
  });

  it('says why a copy failed', async () => {
    vi.mocked(vaultOperations.copyFileIntoVault).mockResolvedValueOnce({ success: false, error: 'disk full' } as Awaited<ReturnType<typeof vaultOperations.copyFileIntoVault>>);
    expect(await bringPickedFileIn('D:/x.png', ROOT, '')).toEqual({ success: false, error: 'disk full' });
  });
});
