/**
 * Audit-12 H1 — Task List creation must persist `filePath` onto the def BEFORE
 * `AddTaskCommand` deep-clones it.
 *
 * The bug: `AddTaskCommand`'s ctor deep-clones the def and `execute()` persists
 * that clone; task creation stamped `def.filePath = relPath` in `seedMdFile` —
 * AFTER the clone had already entered the cache — so the persisted `.board.json`
 * row carried NO `filePath`. On a cold load (boards don't preload docs →
 * documentStore empty) a subfolder task's field/tag edit then fell through the
 * per-board folder cascade / vault root and hit the WRONG file.
 *
 * The fix stamps `filePath` inside `buildTaskDef` (pre-clone). These tests assert
 * the persisted cache def carries `Tasks/<title>.md`, and that a cold-load resolve
 * (documentStore cleared, folder cascade since diverged) returns that persisted
 * path — not the diverged cascade path.
 *
 * Bite-verify: revert the `buildTaskDef` stamp → the persisted `filePath` is
 * `undefined` and the first assertion goes red.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { makeTaskCreator } from '@renderer/lib/tasklist/taskCreation';
import { resolveTextTileVaultPath } from '@renderer/lib/boards/textTilePath';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { TaskListBoard as TaskListBoardType, Tile, TileDefinition } from '@renderer/schema/index';

function makeBoard(defaultFolder: string): TaskListBoardType {
  return {
    id: 'tl',
    type: 'tasklist',
    name: 'T',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: { groupBy: 'status', sortBy: 'manual', defaultFolder },
    sections: [],
    tasks: [],
  } as unknown as TaskListBoardType;
}

function hydrate(board: TaskListBoardType, tileDefs: Record<string, TileDefinition> = {}): void {
  boardCacheStore.hydrate(
    { tl: { board, tileDefs, connections: {}, frames: [] } },
    { tl: 'tl.board.json' },
  );
}

function makeCreator(board: TaskListBoardType) {
  return makeTaskCreator({
    getBoard: () => board,
    getSections: () => [],
    getPlacements: () => [],
    getRows: () => [],
    getCollapsedSubtasks: () => new Set<string>(),
    getLastTargetedSectionId: () => null,
    setLastTargetedSectionId: () => {},
    ensureDefaultSectionMaterialized: () => null,
    persistCollapsedSubtasks: () => {},
    tickAndPersist: () => {},
    announce: () => {},
    defaultSectionId: 'default',
  });
}

function findTextDef(): (TileDefinition & { filePath?: string }) | undefined {
  const defs = Object.values(boardCacheStore.cache.tl?.tileDefs ?? {});
  return defs.find((d) => (d as { type?: string }).type === 'text') as
    | (TileDefinition & { filePath?: string })
    | undefined;
}

describe('Audit-12 H1 — Task List creation persists filePath', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\n---\n', mtimeMs: 1, size: 24 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 24 };
      return { success: true };
    });
    // Run the real command body so its folded-in seed thunk fires + the
    // placement (with the cloned def) lands in the cache.
    vi.spyOn(historyStore, 'execute').mockImplementation((async (cmd: {
      execute: () => Promise<void>;
    }): Promise<void> => {
      await cmd.execute();
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('persists def.filePath as <folder>/<title>.md for a subfolder task', async () => {
    const board = makeBoard('Tasks');
    hydrate(board);

    const creator = makeCreator(board);
    await creator.addTask();

    const textDef = findTextDef();
    expect(textDef).toBeDefined();
    expect(textDef?.filePath).toBe('Tasks/New Task.md');
  });

  it('cold load: a field/tag edit resolves to the PERSISTED filePath, not the diverged folder cascade', async () => {
    const board = makeBoard('Tasks');
    hydrate(board);

    const creator = makeCreator(board);
    await creator.addTask();

    const created = findTextDef();
    expect(created?.filePath).toBe('Tasks/New Task.md');
    // Snapshot the persisted def as a plain object (decouple from the reactive cache).
    const persisted = {
      id: created!.id,
      type: 'text',
      filePath: created!.filePath,
    } as unknown as Tile & { filePath?: string };

    // Cold load: documentStore is empty (boards don't preload docs on restart) AND
    // the board's default folder has since diverged (user re-pointed it).
    documentStore.clear();
    hydrate(makeBoard('Archive'), { [persisted.id]: persisted as unknown as TileDefinition });

    // The persisted explicit filePath wins → resolves to the REAL subfolder path.
    expect(resolveTextTileVaultPath(persisted, 'tl')).toBe('Tasks/New Task.md');

    // Negative control: the path comes only from filePath. A tile without one
    // names no note, so nothing is guessed from the board's (diverged) folder.
    const withoutFilePath = { ...persisted, filePath: undefined } as unknown as Tile;
    expect(resolveTextTileVaultPath(withoutFilePath, 'tl')).toBeNull();
  });
});
