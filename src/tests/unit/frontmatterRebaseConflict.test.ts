import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { resetFrontmatterScheduler } from '@renderer/lib/boards/frontmatterWriteScheduler';
import {
  UpdateTaskFieldCommand,
  UpdateCardFieldCommand,
} from '@renderer/commands/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, KanbanBoard } from '@renderer/schema/index';

/**
 * Audit2 4.2 — a frontmatter-field command (UpdateTaskField / UpdateCardField)
 * snapshots its before/after patch at construction and, on undo/redo, blindly
 * merged that snapshot over the live frontmatter cache. After an external edit
 * to the SAME field, the blind merge silently clobbered the external value
 * (`notePossiblyStale` only warns — it never disarms the stack). The fix
 * rebases the patch onto the live (disk-synced) frontmatter: a same-field
 * conflict KEEPS the external value and prompts ("Apply anyway") instead of
 * overwriting it. An edit to a DIFFERENT field, or no external edit at all,
 * still applies exactly as before.
 */

function makeTaskListFixture(): V7BoardFileData {
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

function makeKanbanFixture(): V7BoardFileData {
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

describe('Audit2 4.2 — undo/redo rebases frontmatter onto external edits', () => {
  beforeEach(() => {
    resetFrontmatterScheduler();
    restoreFiloDefault();
    installFiloMock(async (channel: string) => {
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:read-file-text') return { success: true, content: '' };
      return null;
    });
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture(), kb: makeKanbanFixture() },
      { tl: 'tasks.board.json', kb: 'board.board.json' },
    );
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    vi.useRealTimers();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('keeps an external SAME-field edit instead of clobbering it on undo (task)', async () => {
    documentStore.setFrontmatter('doc-1', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    expect(documentStore.getFrontmatter('doc-1')?.priority).toBe('high');

    // External edit changes the SAME field out from under the command.
    documentStore.setFrontmatter('doc-1', { priority: 'urgent' });

    await cmd.undo();

    // The external value survives (pre-fix: blind merge restored 'normal').
    expect(documentStore.getFrontmatter('doc-1')?.priority).toBe('urgent');
    // A prompt was surfaced offering to apply anyway.
    const toast = uiStore.toasts.find((t) => t.text.includes('External edit changed'));
    expect(toast).toBeTruthy();
    expect(toast?.actions?.[0]?.label).toBe('Apply anyway');
  });

  it('"Apply anyway" forces the undo, overwriting the external value (task)', async () => {
    documentStore.setFrontmatter('doc-1', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    documentStore.setFrontmatter('doc-1', { priority: 'urgent' });
    await cmd.undo();
    const toast = uiStore.toasts.find((t) => t.text.includes('External edit changed'));
    expect(toast).toBeTruthy();
    uiStore.invokeToastAction(toast!.id, 0);
    expect(documentStore.getFrontmatter('doc-1')?.priority).toBe('normal');
  });

  it('still applies undo normally when there is no external conflict (task)', async () => {
    documentStore.setFrontmatter('doc-1', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    expect(documentStore.getFrontmatter('doc-1')?.priority).toBe('high');
    await cmd.undo();
    expect(documentStore.getFrontmatter('doc-1')?.priority).toBe('normal');
    expect(
      uiStore.toasts.find((t) => t.text.includes('External edit changed')),
    ).toBeFalsy();
  });

  it('preserves an external edit to a DIFFERENT field while undoing its own (task)', async () => {
    documentStore.setFrontmatter('doc-1', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    documentStore.mergeFrontmatter('doc-1', { tags: ['urgent'] });
    await cmd.undo();
    const fm = documentStore.getFrontmatter('doc-1');
    expect(fm?.priority).toBe('normal');
    expect(fm?.tags).toEqual(['urgent']);
  });

  it('keeps an external SAME-field edit on undo (kanban card)', async () => {
    documentStore.setFrontmatter('doc-2', { priority: 'low' });
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'card.md',
      'doc-2',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();
    documentStore.setFrontmatter('doc-2', { priority: 'urgent' });
    await cmd.undo();
    expect(documentStore.getFrontmatter('doc-2')?.priority).toBe('urgent');
  });
});
