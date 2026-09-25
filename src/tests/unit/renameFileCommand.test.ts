import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { RenameFileCommand } from '@renderer/commands/renameFileCommand';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultRenameResult } from '@renderer/stores/vaultFolderOps';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Undo of "Rename file to match title" is the reverse rename through the same
 * vault rename (queue held, boards follow); redo renames forward again.
 */

let rename: MockInstance<(oldPath: string, newPath: string) => Promise<VaultRenameResult>>;

beforeEach(() => {
  vaultStore.setPath('/vault');
  rename = vi.spyOn(vaultStore, 'rename').mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vaultStore.setPath('');
});

describe('RenameFileCommand', () => {
  it('undo renames back, redo renames forward again', async () => {
    const cmd = new RenameFileCommand('Notes/Untitled.md', 'Notes/Shopping.md');
    await cmd.undo();
    expect(rename).toHaveBeenLastCalledWith('/vault/Notes/Shopping.md', '/vault/Notes/Untitled.md');
    await cmd.execute();
    expect(rename).toHaveBeenLastCalledWith('/vault/Notes/Untitled.md', '/vault/Notes/Shopping.md');
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('a name taken since is reported, not overwritten', async () => {
    rename.mockResolvedValue({ success: false, code: 'TARGET_EXISTS' });
    const toast = vi.spyOn(uiStore, 'toast').mockReturnValue('');
    const cmd = new RenameFileCommand('A.md', 'B.md');
    await cmd.undo();
    expect(toast).toHaveBeenCalledWith('Cannot undo the rename: "A.md" exists now.', 'warning', 5000);
  });

  it('after a vault change nothing is renamed', async () => {
    const toast = vi.spyOn(uiStore, 'toast').mockReturnValue('');
    const cmd = new RenameFileCommand('A.md', 'B.md');
    vaultStore.setPath('/other');
    await cmd.undo();
    expect(rename).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Cannot undo the rename: the vault has changed since it ran.', 'warning', 5000);
  });
});
