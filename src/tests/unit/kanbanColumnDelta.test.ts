/**
 * Audit5 Phase 4 (#9) — Kanban `DeleteColumnCommand` must be delta-aware.
 *
 * `DeleteColumnCommand` previously snapshotted the WHOLE `columns` slice at
 * construction and replayed it on undo, silently reverting any edit made to a
 * SURVIVING column between execute and undo — the Kanban analogue of the
 * TaskList `DeleteSectionCommand` slice-replace bug Audit5 2.5 fixed (2.5 was
 * scoped to `sectionCommands.ts` only, so the structurally identical Kanban
 * command was missed). It now captures only the removed column + its index and
 * re-inserts it against the LIVE cache via `insertKanbanColumnAt`.
 *
 * These tests pin: the deleted column (with its cards) round-trips exactly, AND
 * an out-of-band edit to a sibling column between execute and undo survives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { DeleteColumnCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    // headerColor + bodyColor are required by TileStyleSchema (persistAddKanban-
    // Placement validates the def), so an empty-object style would be rejected.
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

/** Board: columns A (card c1), B (card c2), C (card c3) at positions 0,1,2. */
function makeBoard(): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Board',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'col-A', title: 'A', position: 0, collapsed: false, tilePlacements: [{ tileId: 'c1', position: 0 }] },
        { id: 'col-B', title: 'B', position: 1, collapsed: false, tilePlacements: [{ tileId: 'c2', position: 0 }] },
        { id: 'col-C', title: 'C', position: 2, collapsed: false, tilePlacements: [{ tileId: 'c3', position: 0 }] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { c1: textDef('c1', 'Card 1'), c2: textDef('c2', 'Card 2'), c3: textDef('c3', 'Card 3') },
    connections: {},
    frames: [],
  };
}

function board(): KanbanBoard {
  return boardCacheStore.cache.kb!.board as KanbanBoard;
}
function columns() {
  return board().columns ?? [];
}
function columnIds(): string[] {
  return columns().map((c) => c.id);
}
function column(id: string) {
  return columns().find((c) => c.id === id);
}
function cardIds(colId: string): string[] {
  return (column(colId)?.tilePlacements ?? []).map((p) => p.tileId);
}

describe('Audit5 Phase 4 — DeleteColumnCommand (delta-aware)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeBoard() }, { kb: 'kb.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('round-trips a deleted column (with its cards + position) exactly via undo', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-C', 'C');

    cmd.execute();
    expect(columnIds()).toEqual(['col-A', 'col-B']);

    cmd.undo();
    expect(columnIds()).toEqual(['col-A', 'col-B', 'col-C']);
    expect(column('col-C')?.position).toBe(2);
    expect(cardIds('col-C')).toEqual(['c3']);
  });

  it('an edit to a SURVIVING column between execute and undo SURVIVES the undo', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-C', 'C');

    cmd.execute();
    expect(columnIds()).toEqual(['col-A', 'col-B']);

    // Out-of-band edits to surviving columns (not on the undo stack): a column-
    // field rename + collapse, plus a card added into a sibling column.
    boardCacheStore.renameKanbanColumn('kb', 'col-A', 'A-renamed');
    boardCacheStore.setKanbanColumnCollapsed('kb', 'col-B', true);
    boardCacheStore.persistAddKanbanPlacement('kb', 'col-B', textDef('c4', 'Card 4'), 1);
    // Guard against a silent validation no-op masking the test.
    expect(cardIds('col-B')).toContain('c4');

    cmd.undo();

    // Pre-fix the wholesale `columns` replay reverted ALL of these; the delta
    // restore keeps them while still bringing column C back.
    expect(columnIds()).toEqual(['col-A', 'col-B', 'col-C']);
    expect(column('col-A')?.title).toBe('A-renamed');
    expect(column('col-B')?.collapsed).toBe(true);
    expect(cardIds('col-B')).toContain('c4');
    expect(cardIds('col-C')).toEqual(['c3']);
  });

  it('redo→undo keeps the retained snapshot pristine (no reference sharing)', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-C', 'C');

    cmd.execute();
    cmd.undo(); // C back
    cmd.execute(); // redo — C gone again
    expect(columnIds()).toEqual(['col-A', 'col-B']);

    cmd.undo(); // C back again
    expect(columnIds()).toEqual(['col-A', 'col-B', 'col-C']);
    expect(cardIds('col-C')).toEqual(['c3']);
  });
});

describe('DeleteColumnCommand drops the defs of the cards it removes', () => {
  /** col-A holds c1 + c5; col-B holds c2 + c5 (c5 is placed in two columns). */
  function boardWithSharedCard(): BoardFileData {
    const data = makeBoard();
    const kb = data.board as unknown as { columns: { id: string; tilePlacements: { tileId: string; position: number }[] }[] };
    kb.columns[0]!.tilePlacements.push({ tileId: 'c5', position: 1 });
    kb.columns[1]!.tilePlacements.push({ tileId: 'c5', position: 1 });
    data.tileDefs.c5 = textDef('c5', 'Shared card');
    return data;
  }

  function defIds(): string[] {
    return Object.keys(boardCacheStore.cache.kb?.tileDefs ?? {}).sort();
  }

  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: boardWithSharedCard() }, { kb: 'kb.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('delete removes the column cards defs; a card also placed in another column keeps its def', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-A', 'A');
    cmd.execute();
    expect(defIds()).toEqual(['c2', 'c3', 'c5']);
  });

  it('undo restores the defs deep-equal alongside the column', () => {
    const before = JSON.parse(JSON.stringify(boardCacheStore.cache.kb?.tileDefs.c1));
    const cmd = new DeleteColumnCommand('kb', 'col-A', 'A');
    cmd.execute();
    cmd.undo();
    expect(defIds()).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(JSON.parse(JSON.stringify(boardCacheStore.cache.kb?.tileDefs.c1))).toEqual(before);
    expect(cardIds('col-A')).toEqual(['c1', 'c5']);
  });

  it('a sibling edit between delete and undo survives, and the defs come back', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-A', 'A');
    cmd.execute();
    boardCacheStore.renameKanbanColumn('kb', 'col-B', 'B-renamed');
    cmd.undo();
    expect(column('col-B')?.title).toBe('B-renamed');
    expect(defIds()).toEqual(['c1', 'c2', 'c3', 'c5']);
  });

  it('redo after undo drops the defs again', () => {
    const cmd = new DeleteColumnCommand('kb', 'col-A', 'A');
    cmd.execute();
    cmd.undo();
    cmd.execute();
    expect(defIds()).toEqual(['c2', 'c3', 'c5']);
    cmd.undo();
    expect(defIds()).toEqual(['c1', 'c2', 'c3', 'c5']);
  });
});
