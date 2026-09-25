/**
 * 6.4.M16 — MoveCardCommand must anchor undo/redo to the moved card's original
 * sibling, not a stale absolute index.
 *
 * Pre-fix the command stored only absolute fromPosition/toPosition. If the
 * target column was mutated (a card added/removed) between the move and a later
 * undo/redo, the absolute index pointed at the wrong slot and the card landed
 * next to an unrelated sibling. The command now records the sibling each insert
 * should sit immediately before and resolves its live index at apply time,
 * falling back to the absolute position only when that sibling is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { MoveCardCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function def(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${id}.md`,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function makeKanban(): BoardFileData {
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
          id: 'A',
          title: 'A',
          position: 0,
          collapsed: false,
          tilePlacements: [
            { tileId: 'X', position: 0 },
            { tileId: 'Y', position: 1 },
            { tileId: 'Z', position: 2 },
          ],
        },
        {
          id: 'B',
          title: 'B',
          position: 1,
          collapsed: false,
          tilePlacements: [
            { tileId: 'P', position: 0 },
            { tileId: 'Q', position: 1 },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: Object.fromEntries(
      ['X', 'Y', 'Z', 'P', 'Q'].map((id) => [id, def(id)]),
    ) as unknown as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

function order(columnId: string): string[] {
  const kb = boardCacheStore.cache.kb!.board as KanbanBoard;
  const col = kb.columns.find((c) => c.id === columnId)!;
  return (col.tilePlacements ?? []).map((p) => p.tileId);
}

describe('MoveCardCommand — neighbour-anchored undo (6.4.M16)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('undo lands the card next to its original sibling after an intervening insert', () => {
    boardCacheStore.hydrate({ kb: makeKanban() }, { kb: 'k.board.json' });

    // Move X from A(0) to B(1) → B=[P,X,Q], A=[Y,Z]. Anchors captured: undo→Y, redo→Q.
    const cmd = new MoveCardCommand('kb', 'X', 'A', 0, 'B', 1);
    cmd.execute();
    expect(order('B')).toEqual(['P', 'X', 'Q']);
    expect(order('A')).toEqual(['Y', 'Z']);

    // Intervening mutation: insert W at the FRONT of A → A=[W,Y,Z]. The stale
    // absolute fromPosition (0) now points at W, not X's original slot.
    boardCacheStore.persistAddKanbanPlacement('kb', 'A', def('W'), 0);
    expect(order('A')).toEqual(['W', 'Y', 'Z']);

    cmd.undo();

    // M16 — X re-inserts immediately BEFORE its original sibling Y (anchor),
    // not at the stale absolute index 0 (which would strand it before W).
    const a = order('A');
    expect(a.indexOf('X') + 1).toBe(a.indexOf('Y'));
    expect(a).toEqual(['W', 'X', 'Y', 'Z']);
  });

  it('falls back to the absolute position when the anchor sibling is gone', () => {
    boardCacheStore.hydrate({ kb: makeKanban() }, { kb: 'k.board.json' });

    const cmd = new MoveCardCommand('kb', 'X', 'A', 0, 'B', 1);
    cmd.execute();
    expect(order('A')).toEqual(['Y', 'Z']);

    // Delete the anchor sibling Y → A=[Z]. Anchor 'Y' no longer resolvable.
    boardCacheStore.removeKanbanPlacement('kb', 'Y');
    expect(order('A')).toEqual(['Z']);

    cmd.undo();
    // Anchor gone → clamp the absolute fromPosition (0): X inserts at the front.
    expect(order('A')).toEqual(['X', 'Z']);
  });
});
