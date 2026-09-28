import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { UpdateTaskFieldCommand } from '@renderer/commands/index';
import { NoteGoneError } from '@renderer/commands/noteGoneError';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard } from '@renderer/schema/index';

/**
 * An undo whose note is missing may have met another program's rename in
 * progress: the "missing" answer comes first, the rename a moment later. The
 * undo waits out the rename grace and applies at the new path; only a note
 * still missing after it is reported gone.
 */

let vault: MemoryVault;

function taskList(): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function resetAll(): void {
  __resetVaultIdentityForTests();
  __resetDirtyTrackingForTests();
  noteStore.__resetForTests();
  boardCacheStore.clear();
  vaultIndexStore.clear();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

describe('undo on a note that is being renamed', () => {
  beforeEach(() => {
    resetAll();
    vault = installMemoryVault({ 'task.md': '---\npriority: normal\n---\nbody\n' });
    vaultStore.setPath('/vault');
    boardCacheStore.hydrate({ tl: taskList() }, { tl: 'tasks.board.json' });
  });
  afterEach(() => {
    resetAll();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('applies at the new path when the rename arrives after the "missing" answer', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: high');

    // Another program moves the file; its rename event is still on the way.
    const bytes = vault.read('task.md') ?? '';
    vault.remove('task.md');
    vault.writeExternally('Moved.md', bytes);
    const undone = cmd.undo();
    await new Promise((r) => setTimeout(r, 200));
    renameAllPathKeys('task.md', 'Moved.md');

    await expect(undone).resolves.toBeUndefined();
    await noteStore.flushAll();
    expect(vault.read('Moved.md')).toContain('priority: normal');
    expect(vault.read('task.md')).toBeUndefined();
  });

  it('a note still missing after the grace is gone, and nothing is queued for it', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.remove('task.md');

    await expect(cmd.undo()).rejects.toBeInstanceOf(NoteGoneError);
    expect(noteStore.hasPendingWrites('task.md')).toBe(false);
    expect(vault.read('task.md')).toBeUndefined();
  });
});
