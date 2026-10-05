/**
 * A note Filo made under a placeholder name ("New Card (7).md", "New Tile
 * 4.md", "New Task 2.md", "Untitled.md") is renamed after the first title it
 * is given, in the same undo step as the title; any other note keeps its
 * name whatever its title becomes.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { isPlaceholderStem, placeholderRenameTarget, withPlaceholderRename } from '@renderer/lib/notes/placeholderNames';
import { RenamePlaceholderCommand } from '@renderer/commands/renamePlaceholderCommand';
import { BatchCommand } from '@renderer/commands/index';
import { Command } from '@renderer/commands/Command';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { holdCloseDrainUntilSwap } from '@renderer/lib/editor/closeDrainGate.svelte';
import type { VaultRenameResult } from '@renderer/stores/vaultFolderOps';
import type { FileTreeNode } from '@shared/types';

class TitleStep extends Command {
  description = 'Rename to "The Siege"';
  readonly targetBoardId: string;
  constructor() {
    super();
    this.targetBoardId = 'b1';
  }
  execute(): void {}
  undo(): void {}
}

function treeFile(rel: string): FileTreeNode {
  return { name: rel.split('/').pop()!, path: `/vault/${rel}`, isDirectory: false, extension: '.md' };
}

let rename: MockInstance<(oldPath: string, newPath: string) => Promise<VaultRenameResult>>;

beforeEach(() => {
  vaultStore.setPath('/vault');
  vaultStore.setTree([]);
  rename = vi.spyOn(vaultStore, 'rename').mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vaultStore.setTree([]);
  vaultStore.setPath('');
});

describe('placeholder names', () => {
  it('knows the names Filo gives new notes, bumped or not', () => {
    for (const stem of ['New Card', 'New Card (7)', 'New Tile', 'New Tile 4', 'New Tile 4 (2)', 'New Task', 'New Task 12', 'Untitled', 'Untitled (3)', 'Plot - Subtask 2']) {
      expect(isPlaceholderStem(stem), stem).toBe(true);
    }
    for (const stem of ['The Siege', 'New Cards', 'A New Card', 'New Tile four', 'Untitled draft', 'Subtask 2']) {
      expect(isPlaceholderStem(stem), stem).toBe(false);
    }
  });

  it('a placeholder-named note moves to its title; a named one, or a placeholder title, stays', () => {
    expect(placeholderRenameTarget('Board/New Card (7).md', 'The Siege')).toBe('Board/The Siege.md');
    expect(placeholderRenameTarget('New Tile 4.md', 'Magic: the cost')).toBe('Magic- the cost.md');
    expect(placeholderRenameTarget('Chapter 1.md', 'The Siege')).toBeNull();
    expect(placeholderRenameTarget('New Card.md', 'New Card')).toBeNull();
    expect(placeholderRenameTarget('New Card.md', '...')).toBeNull();
  });

  it('a name another file has takes the next free one', () => {
    vaultStore.setTree([treeFile('The Siege.md')]);
    expect(placeholderRenameTarget('New Card.md', 'The Siege')).toBe('The Siege (2).md');
  });

  it('joins the title step only when the note has a placeholder name, and not while leaving the vault', () => {
    const title = new TitleStep();
    expect(withPlaceholderRename(title, 'Chapter 1.md', 'The Siege', 'b1')).toBe(title);
    expect(withPlaceholderRename(title, null, 'The Siege', 'b1')).toBe(title);
    const both = withPlaceholderRename(title, 'New Card.md', 'The Siege', 'b1');
    expect(both).toBeInstanceOf(BatchCommand);
    expect(both.targetBoardId).toBe('b1');
    const release = holdCloseDrainUntilSwap();
    try {
      expect(withPlaceholderRename(title, 'New Card.md', 'The Siege', 'b1')).toBe(title);
    } finally {
      release();
    }
  });
});

describe('RenamePlaceholderCommand', () => {
  it('renames to the title, undo renames back, redo renames forward again', async () => {
    const cmd = new RenamePlaceholderCommand('Board/New Card.md', 'Board/The Siege.md');
    await cmd.execute();
    expect(rename).toHaveBeenLastCalledWith('/vault/Board/New Card.md', '/vault/Board/The Siege.md');
    await cmd.undo();
    expect(rename).toHaveBeenLastCalledWith('/vault/Board/The Siege.md', '/vault/Board/New Card.md');
    await cmd.execute();
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('a rename that fails leaves the file, says so, and makes undo a no-op', async () => {
    rename.mockResolvedValueOnce({ success: false, code: 'TARGET_EXISTS' });
    const toast = vi.spyOn(uiStore, 'toast').mockReturnValue('');
    const cmd = new RenamePlaceholderCommand('New Card.md', 'The Siege.md');
    await cmd.execute();
    expect(toast).toHaveBeenCalledWith('"New Card.md" keeps its name: "The Siege.md" exists now. Its title changed.', 'warning', 5000);
    await cmd.undo();
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('follows a later rename of its folder, but not its own rename', async () => {
    const cmd = new RenamePlaceholderCommand('Board/New Card.md', 'Board/The Siege.md');
    await cmd.execute();
    cmd.renamePath('Board/New Card.md', 'Board/The Siege.md');
    cmd.renamePath('Board', 'Book');
    await cmd.undo();
    expect(rename).toHaveBeenLastCalledWith('/vault/Book/The Siege.md', '/vault/Book/New Card.md');
  });
});
