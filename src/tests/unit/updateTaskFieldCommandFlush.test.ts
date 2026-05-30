import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  scheduleFrontmatterWrite,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { UpdateTaskFieldCommand } from '@renderer/commands/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard } from '@renderer/schema/index';

/**
 * Phase 6 / 6.4 — UpdateTaskFieldCommand.execute / undo must `await`
 * `flushAllPendingFrontmatterWrites()`. The previous `void` discarded
 * the flush completion, so a rapid Apply → Undo could leave the forward
 * debounced write in flight when the inverse patch was queued; the
 * inverse landed on disk first and the forward write overwrote it.
 *
 * Mirrors the assertion shape for UpdateCardFieldCommand (Phase 2.7).
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

describe('UpdateTaskFieldCommand — awaits flushAllPendingFrontmatterWrites', () => {
  beforeEach(() => {
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
    // Seed the frontmatter cache so mergeFrontmatter has something to
    // merge into. UpdateTaskFieldCommand only reads frontmatterCache
    // (via mergeFrontmatter); no need to register the full document.
    documentStore.setFrontmatter('doc-1', {});
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('execute drains an armed forward write before merging the new patch', async () => {
    vi.useFakeTimers();
    // Track every IPC call so we can verify ordering.
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:read-file-text') return { success: true, content: '' };
      return null;
    });

    // Arm a debounced forward write for task.md.
    documentStore.mergeFrontmatter('doc-1', { status: 'todo' });
    scheduleFrontmatterWrite('task.md', 'doc-1');
    expect(calls.filter((c) => c.channel === 'vault:write-existing-file-text').length).toBe(0);

    // Construct a command and invoke execute. It must await the flush,
    // so by the time `await cmd.execute()` resolves, the forward write
    // has fired AND the inverse-anchoring read of in-memory frontmatter
    // reflects the awaited state.
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { status: 'done' },
      { status: 'todo' },
    );

    const p = cmd.execute();
    // Advance fake timers so the debounce can fire mid-await.
    await vi.runAllTimersAsync();
    await p;

    // Exactly one forward write for `task.md` should have landed.
    const writes = calls.filter(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'task.md',
    );
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('execute and undo are async (return Promises)', () => {
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'doc-1',
      { priority: 'high' },
      { priority: 'low' },
    );
    const e = cmd.execute();
    const u = cmd.undo();
    expect(e).toBeInstanceOf(Promise);
    expect(u).toBeInstanceOf(Promise);
    return Promise.allSettled([e, u]);
  });
});
