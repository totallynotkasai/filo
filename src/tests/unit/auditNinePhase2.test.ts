import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-9 Phase 2 — silent-error honesty. Each test reds when its fix is
 * temp-reverted (the A8 discipline):
 *   - A9-L2: the orphan commit rethrows a failed write (no swallowed catch),
 *            so UpdateOrphanFrontmatterCommand.execute() rejects.
 *   - A9-L3: a docId-less Task field edit routes through UpdateOrphanFrontmatter-
 *            Command (a direct, undoable disk write) instead of the silent
 *            scheduleFrontmatterWrite(path, null) no-op.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

// ── A9-L2 — orphan commit surfaces a failed write (no silent SUCCESS) ──────────
describe('A9-L2 — UpdateOrphanFrontmatterCommand rejects when the markdown write fails', () => {
  let calls: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    calls = [];
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    documentStore.clear();
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\npriority: low\n---\nbody content', mtimeMs: 1, size: 40 };
      }
      // The write fails (e.g. ENOSPC / EACCES). invokeOk rejects on a
      // `{ success: false }` envelope, so the gateway's trackComponentWrite
      // rethrows up through writeMarkdownFile into the orphan commit.
      if (channel === 'vault:write-existing-file-text') {
        return { success: false, error: 'disk full', code: 'ENOSPC' };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 40 };
      return { success: true };
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    documentStore.clear();
  });

  it('execute() rejects (failure attributed) instead of resolving SUCCESS while disk stayed stale', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    // Pre-fix the commit swallowed the write rejection (reportError only), so
    // execute() RESOLVED — the command "took" on the undo stack and markDirty'd
    // the board while disk diverged. Post-fix the rejection propagates.
    await expect(cmd.execute()).rejects.toThrowError();
    // It reached the actual write (didn't bail early) — proving the rejection
    // is the write failure, not an upstream guard.
    expect(calls.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(true);
  });

  it('undo() also rejects when the inverse write fails', async () => {
    // Disk currently matches the forward patch (priority: high), so undo's
    // inverse (priority: low) does NOT conflict with expectedCurrent → it
    // reaches the write, which fails → undo() rejects (no silent SUCCESS).
    calls = [];
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\npriority: high\n---\nbody content', mtimeMs: 1, size: 41 };
      }
      if (channel === 'vault:write-existing-file-text') {
        return { success: false, error: 'disk full', code: 'ENOSPC' };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 41 };
      return { success: true };
    });
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await expect(cmd.undo()).rejects.toThrowError();
    expect(calls.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(true);
  });
});

// ── A9-L3 — docId-less Task field edit persists (no silent !fm no-op) ──────────
describe('A9-L3 — docId-less Task field edit routes through an undoable orphan command', () => {
  let calls: Captured[];

  function makeWriter() {
    return makeFrontmatterWriter({
      getBoard: () =>
        ({
          id: 'tl',
          type: 'tasklist',
          name: 'T',
          emoji: '',
          createdAt: 0,
          updatedAt: 0,
          settings: {},
          tasks: [],
          sections: [],
        }) as unknown as TaskListBoardType,
      vaultPathForTile: () => 'Orphan.md',
      // Construction-time inverse placeholder; the command recomputes from disk.
      readFrontmatter: () => ({}),
      bumpCacheVersion: () => {},
    });
  }

  // A row whose backing tile has NO contentId — the legacy, pre-live-cache
  // shape that buildTaskFieldCommand returns null for (forcing the fallback).
  function makeRow(): TaskRow {
    return {
      placement: { tileId: 't1', position: 0 },
      tile: { id: 't1', type: 'text', title: 'Orphan', tags: [] } as unknown as Tile,
      completed: false,
      priority: 'none',
      dueDate: '',
      dueTime: '',
      startDate: '',
      status: '',
      tags: [],
      parent: '',
      recurrence: '',
      recurrenceMode: 'schedule',
      category: '',
    };
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    calls = [];
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    documentStore.clear();
    // A9-L3 scenario: the `.md` EXISTS on disk but is ABSENT from the vault
    // index (getMetadata(path) === undefined). The old fallback armed
    // scheduleFrontmatterWrite(path, null); writeFrontmatter then resolved
    // fm = getMetadata(path)?.frontmatter === undefined → `if (!fm) return` →
    // a SILENT no-op that dropped the edit. So leave the index empty.
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\n---\ntask body', mtimeMs: 1, size: 36 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 36 };
      return { success: true };
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    documentStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('persists the field edit via a direct disk write (never a silent !fm no-op)', async () => {
    const writer = makeWriter();
    await writer.updateRowField(makeRow(), { completed: true });
    await flushAllPendingFrontmatterWrites();

    // Pre-fix: NO write fired — the null-docId schedule no-op'd on the empty
    // index. Post-fix: the orphan command wrote the patched FM to disk.
    const write = calls.find(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Orphan.md',
    );
    expect(write, 'docId-less field edit must reach disk, not silently drop').toBeDefined();
    expect(write?.args[2] as string).toContain('completed: true');
    expect(write?.args[2] as string).toContain('task body');
  });

  it('is undoable (the edit ran as a command on the board history stack)', async () => {
    const writer = makeWriter();
    await writer.updateRowField(makeRow(), { completed: true });
    // The old fallback was not a Command at all — nothing landed on the stack.
    expect(historyStore.canUndo).toBe(true);
  });
});
