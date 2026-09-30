/**
 * Audit-11 FILO-UR-3 — disk-bytes undo round-trip for the note-backed field
 * commands (`UpdateCardFieldCommand` / `UpdateTaskFieldCommand`).
 *
 * The existing `frontmatterRebaseConflict.test.ts` asserts only the DISPLAY
 * cache and mocks reads as empty — so it never
 * proved that the BYTES on disk survive an execute → undo cycle. These tests use
 * a MUTABLE-disk mock (reads return the current file, writes mutate it) and
 * assert the on-disk bytes directly, covering the two cases the cache-only tests
 * couldn't see:
 *   - a present-but-empty key (`aliases:`) survives a `priority` edit + undo;
 *   - a previously-absent key added by the edit is removed again on undo, while
 *     the untouched present-but-empty key is preserved throughout.
 *
 * Both ride the delta-onto-fresh-disk write source: the field command
 * queues `patchToFrontmatterDelta(patch)` and the note writer applies ONLY the
 * delta keys to a fresh disk read, so the source-preserving CST engine
 * emits every untouched key from disk verbatim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  UpdateCardFieldCommand,
  UpdateTaskFieldCommand,
} from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, KanbanBoard } from '@renderer/schema/index';

/** Mutable-disk mock — reads return the current file; writes mutate it. */
function installDisk(initial: string): { get: () => string } {
  let disk = initial;
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    if (channel === 'vault:read-file-text') {
      return { success: true, content: disk, mtimeMs: 1, size: disk.length };
    }
    if (channel === 'vault:stat') {
      return { success: true, mtimeMs: 1, size: disk.length };
    }
    if (channel === 'vault:write-existing-file-text') {
      disk = args[2] as string;
      return { success: true };
    }
    return undefined;
  });
  return { get: () => disk };
}

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

describe('Audit-11 FILO-UR-3 — field-command disk-bytes undo round-trip', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture(), kb: makeKanbanFixture() },
      { tl: 'tasks.board.json', kb: 'board.board.json' },
    );
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
  });

  it('UpdateCardFieldCommand — present-but-empty `aliases:` survives a priority edit + undo (bytes)', async () => {
    const disk = installDisk('---\naliases:\npriority: low\n---\nbody content\n');

    const cmd = new UpdateCardFieldCommand(
      'kb',
      'card.md',
      { priority: 'high' },
      { priority: 'low' },
    );

    await cmd.execute();
    await noteStore.flushAll();
    // The empty key the user never touched is still on disk; the edit applied.
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: high/);

    await cmd.undo();
    await noteStore.flushAll();
    // Undo restored priority WITHOUT destroying the untouched empty key.
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: low/);
    // Body untouched throughout.
    expect(disk.get()).toContain('body content');
  });

  it('UpdateTaskFieldCommand — present-but-empty `aliases:` survives a priority edit + undo (bytes)', async () => {
    const disk = installDisk('---\naliases:\npriority: low\n---\ntask body\n');

    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      { priority: 'high' },
      { priority: 'low' },
    );

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: high/);

    await cmd.undo();
    await noteStore.flushAll();
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: low/);
  });

  it('UpdateCardFieldCommand — a previously-ABSENT key is added on execute, removed on undo; empty key preserved (bytes)', async () => {
    const disk = installDisk('---\naliases:\npriority: low\n---\nbody content\n');

    // `dueDate` is absent from disk; the command adds it.
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'card.md',
      { dueDate: '2026-06-06' },
      { dueDate: undefined },
    );

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toMatch(/dueDate: ['"]?2026-06-06/);
    // The untouched present-but-empty key is preserved alongside the addition.
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: low/);

    await cmd.undo();
    await noteStore.flushAll();
    // The added key is gone again; the empty key + untouched priority survive.
    expect(disk.get()).not.toMatch(/dueDate:/);
    expect(disk.get()).toContain('aliases:');
    expect(disk.get()).toMatch(/priority: low/);
  });

  it('undo puts back a key that was present but empty (`status:`) instead of deleting it', async () => {
    const disk = installDisk('---\ntitle: Card\nstatus:\npriority: low\n---\nbody content\n');

    const cmd = new UpdateCardFieldCommand('kb', 'card.md', { status: 'doing' }, { status: '' });

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toMatch(/status: doing/);

    await cmd.undo();
    await noteStore.flushAll();
    expect(disk.get()).toBe('---\ntitle: Card\nstatus:\npriority: low\n---\nbody content\n');

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toMatch(/status: doing/);
  });

  it('undo puts back an empty quoted value (`due: ""`) as it was', async () => {
    const disk = installDisk('---\ndue: ""\n---\nbody\n');

    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { due: '2026-10-01' }, { due: '' });

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toMatch(/due: ['"]?2026-10-01/);

    await cmd.undo();
    await noteStore.flushAll();
    expect(disk.get()).toBe('---\ndue: ""\n---\nbody\n');
  });
});
