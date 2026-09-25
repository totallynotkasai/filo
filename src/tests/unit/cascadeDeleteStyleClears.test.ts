/**
 * Sprint 35.2 regression — CascadeDeleteCommand must snapshot the style-clears
 * the cascade applies (kanban placement `coverImage`, frame
 * `style.backgroundImage`, mindmap `defaults.frame.backgroundImage`) so undo
 * restores them. Without the snapshot, the placements return on Ctrl+Z but
 * the dependent style fields stay wiped — and the next debounce persists the
 * loss to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { CascadeStyleClears } from '@renderer/stores/boardCacheFrontmatter';
import type { KanbanBoard, MindMapBoard } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function makeKanban(id: string, cardTileId: string, coverImage: string): V7BoardFileData {
  return {
    board: {
      id,
      type: 'kanban',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'col1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [
            {
              tileId: cardTileId,
              position: 0,
              coverImage,
            },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      [cardTileId]: {
        id: cardTileId,
        type: 'text',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 0,
        updatedAt: 0,
        filePath: 'Card.md',
      },
    },
    connections: {},
    frames: [],
  };
}

function makeMindMapWithFrame(
  id: string,
  frameId: string,
  frameBackgroundImage: string,
  defaultsBackgroundImage: string,
): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        defaults: {
          frame: { backgroundImage: defaultsBackgroundImage },
        },
      },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [
      {
        id: frameId,
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        title: 'F',
        style: { backgroundImage: frameBackgroundImage },
      },
    ] as unknown as V7BoardFileData['frames'],
  };
}

describe('CascadeDeleteCommand — styleClears undo (Sprint 35.2)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('undo restores a kanban placement coverImage that the cascade wiped', async () => {
    const deletedPath = 'attachments/cover.png';
    const cardId = 'card-1';
    const kb = makeKanban('kb', cardId, deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {
        kb: [{ columnId: 'col1', tileId: cardId, matchedPath: deletedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    };

    // Cascade applies clears then dispatches the command. We mirror the
    // production sequence here by calling applyCascadeStyleClears directly.
    boardCacheStore.applyCascadeStyleClears(styleClears);
    const placementsBefore = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    expect(placementsBefore[0].coverImage).toBeUndefined();

    // No tile was removed in this scenario — the card itself stays, only the
    // cover image goes. byBoardTiles is empty.
    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const placementsAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    expect(placementsAfter[0].coverImage).toBe(deletedPath);
  });

  it('undo restores a frame.style.backgroundImage that the cascade wiped', async () => {
    const deletedPath = 'attachments/bg.jpg';
    const frameId = 'frame-1';
    const mm = makeMindMapWithFrame('mm', frameId, deletedPath, 'attachments/other.jpg');
    boardCacheStore.hydrate({ mm }, { mm: 'mm.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {},
      columnCoverImage: {},
      frameBackground: {
        mm: [{ frameId, matchedPath: deletedPath }],
      },
      boardSettings: {},
    };

    boardCacheStore.applyCascadeStyleClears(styleClears);
    const beforeFrame = boardCacheStore.cache.mm.frames[0] as { style?: { backgroundImage?: string } };
    expect(beforeFrame.style?.backgroundImage).toBe('');

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const afterFrame = boardCacheStore.cache.mm.frames[0] as { style?: { backgroundImage?: string } };
    expect(afterFrame.style?.backgroundImage).toBe(deletedPath);
  });

  it('undo restores mindmap defaults.frame.backgroundImage that the cascade wiped', async () => {
    const deletedPath = 'attachments/defaultBg.png';
    const mm = makeMindMapWithFrame('mm', 'f1', 'unrelated.jpg', deletedPath);
    boardCacheStore.hydrate({ mm }, { mm: 'mm.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {},
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {
        mm: [{ path: 'defaults.frame.backgroundImage', matchedPath: deletedPath }],
      },
    };

    boardCacheStore.applyCascadeStyleClears(styleClears);
    const settingsBefore = (boardCacheStore.cache.mm.board as MindMapBoard).settings as {
      defaults?: { frame?: { backgroundImage?: string } };
    };
    expect(settingsBefore.defaults?.frame?.backgroundImage).toBeUndefined();

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const settingsAfter = (boardCacheStore.cache.mm.board as MindMapBoard).settings as {
      defaults?: { frame?: { backgroundImage?: string } };
    };
    expect(settingsAfter.defaults?.frame?.backgroundImage).toBe(deletedPath);
  });

  it('redo re-applies the style clears', async () => {
    const deletedPath = 'attachments/cover.png';
    const cardId = 'card-1';
    const kb = makeKanban('kb', cardId, deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {
        kb: [{ columnId: 'col1', tileId: cardId, matchedPath: deletedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    };
    boardCacheStore.applyCascadeStyleClears(styleClears);

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });

    // Undo to restore.
    await cmd.undo();
    await flushAsync();
    const placementsAfterUndo = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    expect(placementsAfterUndo[0].coverImage).toBe(deletedPath);

    // Redo to re-clear.
    await cmd.execute();
    await flushAsync();
    const placementsAfterRedo = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    expect(placementsAfterRedo[0].coverImage).toBeUndefined();
  });

  it('constructor deep-clones styleClears (caller mutation does not leak in)', async () => {
    const deletedPath = 'attachments/cover.png';
    const cardId = 'card-1';
    const kb = makeKanban('kb', cardId, deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {
        kb: [{ columnId: 'col1', tileId: cardId, matchedPath: deletedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    };
    boardCacheStore.applyCascadeStyleClears(styleClears);
    const cmd = new CascadeDeleteCommand({}, [], { styleClears });

    // Mutate the original after construction.
    styleClears.coverImage.kb[0].matchedPath = 'totally/different.png';

    await cmd.undo();
    await flushAsync();
    const placementsAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    // Snapshot inside the command preserved the original matchedPath.
    expect(placementsAfter[0].coverImage).toBe(deletedPath);
  });
});

describe('boardCacheStore.findCascadeDeleteTargets / applyCascadeStyleClears (Sprint 35.2)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('findCascadeDeleteTargets returns styleClears without mutating the cache', () => {
    const deletedPath = 'attachments/cover.png';
    const kb = makeKanban('kb', 'card-1', deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const targets = boardCacheStore.findCascadeDeleteTargets(deletedPath);

    expect(targets.styleClears.coverImage.kb).toBeDefined();
    expect(targets.styleClears.coverImage.kb).toHaveLength(1);
    expect(targets.styleClears.coverImage.kb[0]).toEqual({
      columnId: 'col1',
      tileId: 'card-1',
      matchedPath: deletedPath,
    });

    // Cache is unchanged — coverImage still set, pending an applyCascadeStyleClears call.
    const placements = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].tilePlacements;
    expect(placements[0].coverImage).toBe(deletedPath);
  });

  /**
   * D.7 — `applyCascadeStyleClears` only calls `markDirty(boardId)` when at
   * least one placement was actually mutated. A no-op clear (placement's
   * `coverImage` doesn't match the recorded `matchedPath`, or the placement
   * was already cleared by a parallel writer) used to mark every targeted
   * board dirty, queuing redundant `.board.json` writes for boards whose
   * state hadn't changed.
   *
   * Symptom we're guarding against: the cache map identity stayed stable
   * (no `setCache({ ...cache })` call) but the per-board markDirty fires
   * a fresh scheduleBoardWrite. Tracking cache identity is the cleanest
   * proxy: setCache only fires when `mutatedAny === true`, which is the
   * same gate that suppresses per-board markDirty.
   */
  it('no-op clear (path mismatch) leaves cache identity stable and does not markDirty', () => {
    const cachedPath = 'attachments/keep.png';
    const targetPath = 'attachments/different.png';
    const kb = makeKanban('kb', 'card-1', cachedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const cacheBefore = boardCacheStore.cache;
    const placementsBefore = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements;
    expect(placementsBefore[0].coverImage).toBe(cachedPath);

    // Apply a clear that targets a DIFFERENT path — should be a no-op
    // because the placement's actual value doesn't match the recorded
    // matchedPath the clear plan is asking us to remove.
    boardCacheStore.applyCascadeStyleClears({
      coverImage: {
        kb: [{ columnId: 'col1', tileId: 'card-1', matchedPath: targetPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    });

    // Cache identity preserved — setCache wasn't called, so markDirty
    // wasn't either.
    expect(boardCacheStore.cache).toBe(cacheBefore);
    // Placement state still pointing at the original image.
    const placementsAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements;
    expect(placementsAfter[0].coverImage).toBe(cachedPath);
  });

  it('matching clear mutates the cache (positive regression check)', () => {
    const cachedPath = 'attachments/match.png';
    const kb = makeKanban('kb', 'card-1', cachedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const cacheBefore = boardCacheStore.cache;

    boardCacheStore.applyCascadeStyleClears({
      coverImage: {
        kb: [{ columnId: 'col1', tileId: 'card-1', matchedPath: cachedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    });

    // Cache identity changed — setCache fired, markDirty fired with it.
    expect(boardCacheStore.cache).not.toBe(cacheBefore);
    const placements = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements;
    expect(placements[0].coverImage).toBeUndefined();
  });
});

/**
 * Polish phase 3.2 (2026-05-25) — `restoreCascadeStyleClears` must not
 * trample a manual edit the user made between cascade-delete and undo.
 * Previously the guard `value === matchedPath` only skipped when the field
 * already held the right value; if the user re-pointed coverImage /
 * backgroundImage to a different file, undo would overwrite the new pick
 * with the original deleted path.
 */
describe('restoreCascadeStyleClears — manual-edit guard (polish phase 3.2)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('preserves a manually-re-pointed coverImage when undo runs', async () => {
    const deletedPath = 'attachments/cover.png';
    const cardId = 'card-1';
    const kb = makeKanban('kb', cardId, deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {
        kb: [{ columnId: 'col1', tileId: cardId, matchedPath: deletedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    };

    // Cascade clears the coverImage.
    boardCacheStore.applyCascadeStyleClears(styleClears);

    // User manually points the placement at a different image *before* undo.
    const manualPath = 'attachments/manual-pick.png';
    const placement = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements[0] as Record<string, unknown>;
    placement.coverImage = manualPath;

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    // Manual pick survives the undo — undo did NOT overwrite it.
    const placementAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements[0];
    expect(placementAfter.coverImage).toBe(manualPath);
  });

  it('still restores coverImage when the user did not touch it', async () => {
    const deletedPath = 'attachments/cover.png';
    const cardId = 'card-1';
    const kb = makeKanban('kb', cardId, deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {
        kb: [{ columnId: 'col1', tileId: cardId, matchedPath: deletedPath }],
      },
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {},
    };

    boardCacheStore.applyCascadeStyleClears(styleClears);
    // No manual edit between cascade and undo.

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const placementAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]
      .tilePlacements[0];
    expect(placementAfter.coverImage).toBe(deletedPath);
  });

  it('preserves a manually-re-pointed frame.style.backgroundImage when undo runs', async () => {
    const deletedPath = 'attachments/bg.jpg';
    const frameId = 'frame-1';
    const mm = makeMindMapWithFrame('mm', frameId, deletedPath, 'attachments/other.jpg');
    boardCacheStore.hydrate({ mm }, { mm: 'mm.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {},
      columnCoverImage: {},
      frameBackground: {
        mm: [{ frameId, matchedPath: deletedPath }],
      },
      boardSettings: {},
    };

    boardCacheStore.applyCascadeStyleClears(styleClears);

    // Manual override before undo.
    const manualPath = 'attachments/new-bg.jpg';
    const frame = boardCacheStore.cache.mm.frames[0] as { style: Record<string, unknown> };
    frame.style.backgroundImage = manualPath;

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const after = boardCacheStore.cache.mm.frames[0] as { style?: { backgroundImage?: string } };
    expect(after.style?.backgroundImage).toBe(manualPath);
  });

  it('preserves a manually-re-pointed defaults.frame.backgroundImage when undo runs', async () => {
    const deletedPath = 'attachments/defaultBg.png';
    const mm = makeMindMapWithFrame('mm', 'f1', 'unrelated.jpg', deletedPath);
    boardCacheStore.hydrate({ mm }, { mm: 'mm.board.json' });

    const styleClears: CascadeStyleClears = {
      coverImage: {},
      columnCoverImage: {},
      frameBackground: {},
      boardSettings: {
        mm: [{ path: 'defaults.frame.backgroundImage', matchedPath: deletedPath }],
      },
    };

    boardCacheStore.applyCascadeStyleClears(styleClears);

    // Manual override before undo — user picks a new default background.
    const manualPath = 'attachments/manual-default.png';
    const board = boardCacheStore.cache.mm.board as MindMapBoard;
    const settings = board.settings as { defaults?: { frame?: Record<string, unknown> } };
    settings.defaults = { ...(settings.defaults ?? {}), frame: { backgroundImage: manualPath } };

    const cmd = new CascadeDeleteCommand({}, [], { styleClears });
    await cmd.undo();
    await flushAsync();

    const settingsAfter = (boardCacheStore.cache.mm.board as MindMapBoard).settings as {
      defaults?: { frame?: { backgroundImage?: string } };
    };
    expect(settingsAfter.defaults?.frame?.backgroundImage).toBe(manualPath);
  });
});
