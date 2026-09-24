/**
 * Audit-6 Phase 5.5 — execute/undo ROUND-TRIP coverage for the Kanban
 * structure commands the `ci:command-roundtrip-coverage` gate requires.
 *
 * H1 (`ReorderSectionCommand`) silently no-op'd a multi-slot drag because no
 * test ever drove a degenerate-delta reorder through execute → undo. These
 * tests lock the Kanban analogues — most importantly a multi-COLUMN
 * move-first-to-last (the direct `ReorderColumnCommand` twin of H1) — plus the
 * add-column / rename-column / add-card round-trips. Each asserts execute
 * changes state, undo reverses it, and redo re-applies it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  AddColumnCommand,
  RenameColumnCommand,
  ReorderColumnCommand,
  AddCardCommand,
  MoveCardsCommand,
  DeleteCardCommand,
} from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function column(id: string, title: string, position: number) {
  return { id, title, position, collapsed: false, tilePlacements: [] as unknown[] };
}

function makeKanban(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [column('c1', 'Todo', 0), column('c2', 'Doing', 1), column('c3', 'Done', 2)],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

// headerColor + bodyColor + borderColor are required by TileStyleSchema, which
// `persistAddKanbanPlacement` validates — an empty-object style is rejected.
function cardDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function kb(): KanbanBoard {
  return boardCacheStore.cache.kb!.board as KanbanBoard;
}
function columnIds(): string[] {
  return [...(kb().columns ?? [])].sort((a, b) => a.position - b.position).map((c) => c.id);
}
function columnTitle(id: string): string | undefined {
  return kb().columns?.find((c) => c.id === id)?.title;
}
function cardIds(columnId: string): string[] {
  const col = kb().columns?.find((c) => c.id === columnId);
  return ((col?.tilePlacements ?? []) as Array<{ tileId: string }>).map((p) => p.tileId);
}

describe('Audit-6 Phase 5.5 — Kanban structure command round-trips', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanban() }, { kb: 'k.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('AddColumnCommand: execute adds, undo removes, redo re-adds', () => {
    const cmd = new AddColumnCommand('kb', { id: 'c4', title: 'Archive', position: 3 });
    cmd.execute();
    expect(columnIds()).toContain('c4');
    cmd.undo();
    expect(columnIds()).not.toContain('c4');
    cmd.execute(); // redo
    expect(columnIds()).toContain('c4');
  });

  it('RenameColumnCommand: execute renames, undo restores, redo re-applies', () => {
    const cmd = new RenameColumnCommand('kb', 'c1', 'Todo', 'Backlog');
    cmd.execute();
    expect(columnTitle('c1')).toBe('Backlog');
    cmd.undo();
    expect(columnTitle('c1')).toBe('Todo');
    cmd.execute(); // redo
    expect(columnTitle('c1')).toBe('Backlog');
  });

  it('ReorderColumnCommand: a multi-slot move-first-to-last round-trips (H1 twin)', () => {
    // 3 positions change at once — the exact shape H1's section command silently
    // dropped. ReorderColumnCommand captures the WHOLE order, so it survives.
    const cmd = new ReorderColumnCommand('kb', ['c1', 'c2', 'c3'], ['c2', 'c3', 'c1']);
    cmd.execute();
    expect(columnIds()).toEqual(['c2', 'c3', 'c1']);
    cmd.undo();
    expect(columnIds()).toEqual(['c1', 'c2', 'c3']);
    cmd.execute(); // redo
    expect(columnIds()).toEqual(['c2', 'c3', 'c1']);
  });

  it('AddCardCommand: execute adds the card + def, undo removes them, redo re-adds', () => {
    const cmd = new AddCardCommand('kb', 'c1', cardDef('card1', 'First card'), 0);
    cmd.execute();
    expect(cardIds('c1')).toContain('card1');
    expect(boardCacheStore.cache.kb!.tileDefs.card1).toBeTruthy();
    cmd.undo();
    expect(cardIds('c1')).not.toContain('card1');
    cmd.execute(); // redo
    expect(cardIds('c1')).toContain('card1');
  });
});

// ── Audit-7 M3 — MoveCardsCommand neighbour-anchored multi-card undo ──────────
//
// MoveCardsCommand.undo restored each card to its absolute fromPosition, which
// goes stale if a source column is mutated between the move and the undo. The
// command now also captures the surviving sibling each card should sit before
// (from the PRE-move cache, mirroring single-card MoveCardCommand 6.4.M16) so an
// ascending-order replay reconstructs the original interleaving. These tests
// drive an intervening mutation — the exact case the roundtrip-coverage gate's
// plain construct→execute→undo never exercises.

function makeKanbanWithCards(): V7BoardFileData {
  const cards = ['A', 'B', 'C', 'D', 'E'];
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'src',
          title: 'Src',
          position: 0,
          collapsed: false,
          tilePlacements: cards.map((tileId, position) => ({ tileId, position })),
        },
        { id: 'dst', title: 'Dst', position: 1, collapsed: false, tilePlacements: [] as unknown[] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: Object.fromEntries(
      cards.map((id) => [id, cardDef(id, id)]),
    ) as unknown as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

describe('Audit-7 M3 — MoveCardsCommand neighbour-anchored undo', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanWithCards() }, { kb: 'k.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('undo lands multi-moved cards next to their original siblings after an intervening insert', () => {
    // src = [A,B,C,D,E]; move B,D out to dst. Construction (pre-move) captures
    // anchors B→C, D→E.
    const cmd = new MoveCardsCommand('kb', ['B', 'D'], 'dst', 0, [
      { tileId: 'B', fromColumnId: 'src', fromPosition: 1 },
      { tileId: 'D', fromColumnId: 'src', fromPosition: 3 },
    ]);
    cmd.execute();
    expect(cardIds('src')).toEqual(['A', 'C', 'E']);
    expect(cardIds('dst')).toEqual(['B', 'D']);

    // Intervening mutation: insert Z at the FRONT of the source column, so the
    // saved absolute positions (1, 3) now point at the wrong slots.
    boardCacheStore.persistAddKanbanPlacement('kb', 'src', cardDef('Z', 'Z'), 0);
    expect(cardIds('src')).toEqual(['Z', 'A', 'C', 'E']);

    cmd.undo();

    // M3 — anchors restore B before C and D before E despite the shift.
    // Absolute-only undo would scramble this to [Z,B,A,D,C,E].
    expect(cardIds('src')).toEqual(['Z', 'A', 'B', 'C', 'D', 'E']);
    expect(cardIds('dst')).toEqual([]);
  });

  it('falls back to the absolute position when an anchor sibling is gone', () => {
    const cmd = new MoveCardsCommand('kb', ['B', 'D'], 'dst', 0, [
      { tileId: 'B', fromColumnId: 'src', fromPosition: 1 },
      { tileId: 'D', fromColumnId: 'src', fromPosition: 3 },
    ]);
    cmd.execute();
    expect(cardIds('src')).toEqual(['A', 'C', 'E']);

    // Delete B's anchor sibling C → src=[A,E]. B's 'C' anchor is unresolvable.
    boardCacheStore.removeKanbanPlacement('kb', 'C');
    expect(cardIds('src')).toEqual(['A', 'E']);

    cmd.undo();
    // B: anchor gone → clamp absolute fromPosition 1 (after A). D: anchor E still
    // present → before E. Ascending replay: B first → [A,B,E]; then D → [A,B,D,E].
    expect(cardIds('src')).toEqual(['A', 'B', 'D', 'E']);
  });

  it('plain construct → execute → undo round-trips with no intervening mutation', () => {
    const cmd = new MoveCardsCommand('kb', ['B', 'D'], 'dst', 0, [
      { tileId: 'B', fromColumnId: 'src', fromPosition: 1 },
      { tileId: 'D', fromColumnId: 'src', fromPosition: 3 },
    ]);
    cmd.execute();
    expect(cardIds('src')).toEqual(['A', 'C', 'E']);
    expect(cardIds('dst')).toEqual(['B', 'D']);
    cmd.undo();
    expect(cardIds('src')).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(cardIds('dst')).toEqual([]);
  });
});

// ── Audit-14 2.2 — DeleteCardCommand neighbour-anchored undo ──────────────────
//
// DeleteCardCommand.undo restored the card at its absolute snapshotPosition,
// which goes stale if a sibling is added/removed between the delete and the
// undo (the move commands already got the next-surviving-sibling anchor;
// delete did not). The command now captures the card immediately AFTER the
// deleted one and undo inserts before that anchor, falling back to the clamped
// absolute position when the deleted card was the column tail.

describe('Audit-14 2.2 — DeleteCardCommand neighbour-anchored undo', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanWithCards() }, { kb: 'k.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('undo lands a deleted mid-column card before its original sibling after an intervening insert', () => {
    // src = [A,B,C,D,E]; delete C (idx 2). Construction captures anchor C→D.
    const cmd = new DeleteCardCommand('kb', 'C');
    cmd.execute();
    expect(cardIds('src')).toEqual(['A', 'B', 'D', 'E']);

    // Intervening mutation: insert Z at the FRONT of the column, so the saved
    // absolute position (2) now points at the wrong slot.
    boardCacheStore.persistAddKanbanPlacement('kb', 'src', cardDef('Z', 'Z'), 0);
    expect(cardIds('src')).toEqual(['Z', 'A', 'B', 'D', 'E']);

    cmd.undo();

    // 2.2 — the D anchor restores C immediately before D despite the shift.
    // Absolute-only undo (insert at index 2) would scramble this to
    // [Z,A,C,B,D,E].
    expect(cardIds('src')).toEqual(['Z', 'A', 'B', 'C', 'D', 'E']);
  });

  it('falls back to the absolute position when the anchor sibling is gone', () => {
    // Delete C (anchor → D), then delete D so the anchor is unresolvable.
    const cmd = new DeleteCardCommand('kb', 'C');
    cmd.execute();
    boardCacheStore.removeKanbanPlacement('kb', 'D');
    expect(cardIds('src')).toEqual(['A', 'B', 'E']);

    cmd.undo();
    // Anchor gone → clamp the absolute snapshotPosition (2): A,B,[C],E.
    expect(cardIds('src')).toEqual(['A', 'B', 'C', 'E']);
  });

  it('plain construct → execute → undo round-trips a tail card with no intervening mutation', () => {
    // E is the column tail → no anchor (null) → absolute-position fallback.
    const cmd = new DeleteCardCommand('kb', 'E');
    cmd.execute();
    expect(cardIds('src')).toEqual(['A', 'B', 'C', 'D']);
    cmd.undo();
    expect(cardIds('src')).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
