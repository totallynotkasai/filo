import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { trashTheme } from '../../main/vault/configOps';
import { listTrash, restoreFromTrash, isThemeFilePath } from '../../main/vault/trashOps';

/**
 * Deleting a custom theme moves its file into Filo's trash (it used to be
 * unlinked for good), and Settings → Trash puts it back. A theme file is the
 * only thing under `.filo/` a trash manifest may name.
 */
let vault: string;

beforeEach(async () => {
  vault = await fs.mkdtemp(join(tmpdir(), 'filo-theme-trash-'));
  await fs.mkdir(join(vault, '.filo', 'themes'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

describe('theme delete goes to the trash', () => {
  it('moves the file in, lists it, and restores the same bytes', async () => {
    const bytes = JSON.stringify({ id: 'sea', name: 'Sea', base: 'dark', variables: { '--ui-bg': '#001122' } });
    const file = join(vault, '.filo', 'themes', 'sea.json');
    await fs.writeFile(file, bytes);

    const trashId = await trashTheme(vault, 'sea', 'aaaaaaaaaaaa');
    await expect(fs.access(file)).rejects.toThrow();
    expect((await listTrash(vault)).map((e) => e.originalPath)).toEqual(['.filo/themes/sea.json']);

    const restored = await restoreFromTrash(vault, trashId);
    expect(restored.restoredPath).toBe('.filo/themes/sea.json');
    expect(await fs.readFile(file, 'utf-8')).toBe(bytes);
  });

  it('refuses a name with a path in it', async () => {
    await expect(trashTheme(vault, '../app', 'aaaaaaaaaaaa')).rejects.toThrow();
  });
});

describe('isThemeFilePath', () => {
  it('admits a single file directly in .filo/themes and nothing else under .filo', () => {
    expect(isThemeFilePath('.filo/themes/sea.json')).toBe(true);
    expect(isThemeFilePath('.filo/themes/sea (restored).json')).toBe(true);
    expect(isThemeFilePath('.filo/app.json')).toBe(false);
    expect(isThemeFilePath('.filo/themes/sub/sea.json')).toBe(false);
    expect(isThemeFilePath('.filo/themes/sea.txt')).toBe(false);
    expect(isThemeFilePath('.FILO/themes/sea.json')).toBe(false);
  });

  it('a manifest naming any other .filo path is not listed, so it can\'t be restored', async () => {
    const container = join(vault, '.filo', 'trash', '20260927T120000Z-abcdef');
    await fs.mkdir(join(container, 'files', '.filo'), { recursive: true });
    await fs.writeFile(join(container, 'files', '.filo', 'app.json'), '{}');
    await fs.writeFile(join(container, 'manifest.json'), JSON.stringify({
      originalPath: '.filo/app.json', deletedAt: new Date().toISOString(), machineId: 'aaaaaaaaaaaa', kind: 'file',
    }));
    expect(await listTrash(vault)).toEqual([]);
  });
});
