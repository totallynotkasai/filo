/**
 * Characterisation: Vault menu → New Vault works while a vault is open. The
 * open vault is saved and closed first, then the new folder is set up and
 * opened under its folder's name, and listed under Recent vaults.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { startApp, stopApp, newVaultFromMenu, recentVaultPaths } from './harness/app';
import { $$, editors, errorToasts, openNoteFromSidebar, typeAtEnd } from './harness/actions';
import { vaultName } from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

describe('New Vault from the vault menu', () => {
  it('while a vault is open: the new vault opens, and the edit just typed in the old one is saved', async () => {
    const app = await startApp({ 'Note.md': 'First line\n' });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' typed just now');

    const result = await newVaultFromMenu(app);
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
    expect(existsSync(join(result.other, '.filo', 'app.json'))).toBe(true);
    expect(vaultName(app)).toBe(basename(result.other));
    expect(app.read('Note.md')).toContain('typed just now');
    const sameFolder = (p: string): boolean => p.replace(/[\\/]+$/, '').toLowerCase() === result.other.toLowerCase();
    expect((await recentVaultPaths()).some(sameFolder)).toBe(true);
    expect(errorToasts()).toEqual([]);
  });
});
