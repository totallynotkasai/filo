import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renameVaultEntry } from '@renderer/lib/vault/renameVaultEntry';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileTreeNode } from '@shared/types';

/**
 * A sidebar rename never overwrites: main refuses a name another file has.
 * So a real clash is said plainly (OK only, nothing changed), and a change
 * of case only, which the file-exists probe also reports, is no clash at all.
 */

function note(name: string): FileTreeNode {
  return { name, path: `/vault/${name}`, isDirectory: false, extension: '.md' } as FileTreeNode;
}

let renameSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installFiloMock({ 'vault:file-exists': () => true });
  vaultStore.setPath('/vault');
  renameSpy = vi.spyOn(vaultStore, 'rename').mockResolvedValue({ success: true } as never);
});
afterEach(() => {
  renameSpy.mockRestore();
  uiStore.closeConfirm();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('renaming a sidebar entry onto a taken name', () => {
  it('a case-only rename goes ahead with no question', async () => {
    await renameVaultEntry(note('plan.md'), 'Plan');
    expect(uiStore.confirmDialog).toBeNull();
    expect(renameSpy).toHaveBeenCalledWith('/vault/plan.md', '/vault/Plan.md');
  });

  it('another file\'s name is refused with an OK-only notice, nothing renamed', async () => {
    const done = renameVaultEntry(note('plan.md'), 'Other');
    await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
    const dialog = uiStore.confirmDialog!;
    expect(dialog.notice).toBe(true);
    expect(dialog.body).toContain('"Other.md" already exists');
    expect(dialog.body).not.toMatch(/replaced|cannot be recovered/);
    dialog.onConfirm(false);
    uiStore.closeConfirm();
    await done;
    expect(renameSpy).not.toHaveBeenCalled();
  });
});
