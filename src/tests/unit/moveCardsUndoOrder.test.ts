/**
 * Audit 5.1 — MoveCardsCommand.undo restores same-column order correctly.
 *
 * The remediation plan flagged `MoveCardsCommand.undo` as sorting its
 * snapshots ASCENDING by `fromPosition` and recommended switching to
 * DESCENDING. First-party verification (these tests) shows the opposite:
 * ascending is CORRECT and descending would corrupt the order.
 *
 * Root cause of the plan's false positive: `moveKanbanPlacement` does a
 * REMOVE-then-INSERT (it filters the tile out of every column, splices it
 * into the target at the clamped index, then renumbers). It is NOT a naive
 * growing splice. Replaying the snapshots in ascending source-position order
 * therefore lands each restored card at its original ABSOLUTE index — even
 * when the moved cards were interleaved with cards that stayed put. Descending
 * order breaks exactly that interleaved case.
 *
 * These tests pin the correct (ascending) behaviour so a future "fix" to
 * descending fails loudly. See Appendix C of the audit plan: be skeptical of
 * sweep-sourced items; reproduce before "fixing".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { MoveCardsCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    title: id,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function col(id: string, tileIds: string[]) {
  return {
    id,
    title: id,
    position: 0,
    collapsed: false,
    tilePlacements: tileIds.map((tileId, position) => ({ tileId, position })),
  };
}

function hydrate(columns: ReturnType<typeof col>[], tileIds: string[]): void {
  const fixture: V7BoardFileData = {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns,
    } as unknown as KanbanBoard,
    tileDefs: Object.fromEntries(tileIds.map((t) => [t, mkDef(t)])),
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });
}

function order(columnId: string): string[] {
  const kb = boardCacheStore.cache.kb.board as KanbanBoard;
  const c = (kb.columns ?? []).find((x) => x.id === columnId);
  return (c?.tilePlacements ?? []).map((p) => p.tileId);
}

describe('Audit 5.1 — MoveCardsCommand.undo preserves order (ascending is correct)', () => {
  beforeEach(() => {
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('restores original order after a same-column reorder', () => {
    // Original X = [A, B, C]; post-move scrambled to [C, A, B].
    hydrate([col('X', ['C', 'A', 'B'])], ['A', 'B', 'C']);
    const cmd = new MoveCardsCommand('kb', ['A', 'B', 'C'], 'X', 0, [
      { tileId: 'A', fromColumnId: 'X', fromPosition: 0 },
      { tileId: 'B', fromColumnId: 'X', fromPosition: 1 },
      { tileId: 'C', fromColumnId: 'X', fromPosition: 2 },
    ]);
    cmd.undo();
    expect(order('X')).toEqual(['A', 'B', 'C']);
  });

  it('restores interleaved positions when moved cards are pulled back among cards that stayed put', () => {
    // Original X = [A, X1, B, X2, C] (A,B,C originally at indices 0,2,4). They
    // were moved out to column Y; X now holds only the non-moved [X1, X2].
    // Undo must put A,B,C back at their original ABSOLUTE indices 0,2,4.
    //
    //   Ascending replay  -> [A, X1, B, X2, C]   (correct)
    //   Descending replay -> [A, X1, X2, B, C]   (WRONG — the plan's suggestion)
    hydrate(
      [col('X', ['X1', 'X2']), col('Y', ['A', 'B', 'C'])],
      ['A', 'B', 'C', 'X1', 'X2'],
    );
    const cmd = new MoveCardsCommand('kb', ['A', 'B', 'C'], 'Y', 0, [
      { tileId: 'A', fromColumnId: 'X', fromPosition: 0 },
      { tileId: 'B', fromColumnId: 'X', fromPosition: 2 },
      { tileId: 'C', fromColumnId: 'X', fromPosition: 4 },
    ]);
    cmd.undo();
    expect(order('X')).toEqual(['A', 'X1', 'B', 'X2', 'C']);
    expect(order('Y')).toEqual([]);
  });
});
