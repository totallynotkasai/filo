import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  UpdateTaskFieldCommand,
  UpdateCardFieldCommand,
} from '@renderer/commands/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, KanbanBoard } from '@renderer/schema/index';

/**
 * A frontmatter-field command (UpdateTaskField / UpdateCardField) must not
 * blindly write its before/after snapshot over the note on undo/redo: after an
 * external edit to the SAME field that would silently clobber the external
 * value. The patch is rebased onto the note as it stands (a fresh read): a
 * same-field conflict KEEPS the external value and prompts ("Apply anyway").
 * An edit to a DIFFERENT field, or no external edit at all, still applies.
 */
function makeTaskListFixture(): BoardFileData {
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

function makeKanbanFixture(): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Board',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
      cards: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

const TASK = '---\ntitle: Task\npriority: normal\n---\nTask body\n';
const CARD = '---\ntitle: Card\npriority: low\n---\nCard body\n';

describe('undo/redo rebases frontmatter onto external edits', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'task.md': TASK, 'card.md': CARD });
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture(), kb: makeKanbanFixture() },
      { tl: 'tasks.board.json', kb: 'board.board.json' },
    );
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  function conflictToast() {
    return uiStore.toasts.find((t) => t.text.includes('External edit changed'));
  }

  it('keeps an external SAME-field edit instead of clobbering it on undo (task)', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: high');

    // External edit changes the SAME field out from under the command.
    vault.writeExternally('task.md', TASK.replace('priority: normal', 'priority: urgent'));

    await cmd.undo();
    await noteStore.flushAll();

    // The external value survives; a prompt offers to apply anyway.
    expect(vault.read('task.md')).toContain('priority: urgent');
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    expect(toast?.actions?.[0]?.label).toBe('Apply anyway');
  });

  it('"Apply anyway" forces the undo, overwriting the external value (task)', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.writeExternally('task.md', TASK.replace('priority: normal', 'priority: urgent'));
    await cmd.undo();
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    uiStore.invokeToastAction(toast!.id, 0);
    expect(noteStore.frontmatter('task.md').priority).toBe('normal');
    await noteStore.flushAll();
    expect(vault.read('task.md')).toBe(TASK);
  });

  it('still applies undo normally when there is no external conflict (task)', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: high');
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toBe(TASK);
    expect(conflictToast()).toBeFalsy();
  });

  it('preserves an external edit to a DIFFERENT field while undoing its own (task)', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.writeExternally('task.md', '---\ntitle: Task\npriority: high\ntags: [urgent]\n---\nTask body\n');
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toBe('---\ntitle: Task\npriority: normal\ntags: [urgent]\n---\nTask body\n');
  });

  it('keeps an external SAME-field edit on undo (kanban card)', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.writeExternally('card.md', CARD.replace('priority: low', 'priority: urgent'));
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('card.md')).toContain('priority: urgent');
    expect(conflictToast()).toBeTruthy();
  });
});
