import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { UpdateTaskFieldCommand } from '@renderer/commands/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard } from '@renderer/schema/index';

/**
 * Undo's check for "another program changed this key since" reads the file,
 * not the open note's model: the model catches up only after the watcher's
 * debounce, and a change inside that window must still count. And the
 * conflict toast's "Apply anyway" follows a rename made while it waits.
 */
function taskList(): BoardFileData {
  return {
    board: {
      id: 'tl', type: 'tasklist', name: 'Tasks', emoji: '', createdAt: 0, updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' }, tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

const TASK = '---\ntitle: Task\npriority: normal\n---\nTask body\n';

describe('undo conflict check reads the disk', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'task.md': TASK }, '/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ tl: taskList() }, { tl: 'tasks.board.json' });
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  const conflictToast = () => uiStore.toasts.find((t) => t.text.includes('External edit changed'));

  it('an outside change to the same key, not yet seen by the open note, raises the conflict', async () => {
    const model = noteStore.acquire('task.md', 'view-1');
    await model.loaded;
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: high');

    // Another program saves; the watcher hasn't told the model yet.
    vault.writeExternally('task.md', TASK.replace('priority: normal', 'priority: urgent'));
    expect(noteStore.frontmatter('task.md').priority).toBe('high');

    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: urgent');
    expect(conflictToast()).toBeTruthy();
    noteStore.release('task.md', 'view-1');
  });

  it('"Apply anyway" after a rename writes the note at its new path', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.writeExternally('task.md', TASK.replace('priority: normal', 'priority: urgent'));
    await cmd.undo();
    const toast = conflictToast();
    expect(toast).toBeTruthy();

    // The note is renamed while the toast waits.
    vault.writeExternally('moved/task.md', vault.read('task.md')!);
    vault.remove('task.md');
    renameAllPathKeys('task.md', 'moved/task.md');

    uiStore.invokeToastAction(toast!.id, 0);
    await noteStore.flushAll();
    expect(vault.read('moved/task.md')).toContain('priority: normal');
    expect(vault.read('task.md')).toBeUndefined();
  });
});
