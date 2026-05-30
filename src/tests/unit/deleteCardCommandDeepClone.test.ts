/**
 * IMPL_PLAN_2026-05-23_v2 P1.5 — `DeleteCardCommand` snapshot deep-clone.
 *
 * Pre-fix the command captured snapshots via shallow `{ ...placement }` and
 * `{ ...def }`. Any tag/style mutation on the same tile between the
 * command's construction and its `undo()` mutated the snapshot's shared
 * inner references (because the spread only copies top-level keys — nested
 * arrays and objects are still aliased). On undo the restored card would
 * carry the *current* nested state, not the delete-time state.
 *
 * The fix mirrors `AddCardCommand`'s Phase 31 B4.4 pattern: deep-clone via
 * `JSON.parse(JSON.stringify(...))` so the snapshot is fully isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { DeleteCardCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function makeKanbanWithCard(): V7BoardFileData {
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
          id: 'col-1',
          title: 'Todo',
          position: 0,
          collapsed: false,
          tilePlacements: [
            {
              tileId: 't1',
              position: 0,
              style: { headerColor: '#aaaaaa' },
            },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        title: 'Card A',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        tags: ['original'],
        contentId: 'doc_t1',
        content: '',
        createdAt: 0,
        updatedAt: 0,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('DeleteCardCommand — deep-clone snapshot (P1.5)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    historyStore.clear();
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    historyStore.clear();
  });

  it('snapshot is isolated from the original def — mutating original tags before execute does not corrupt the restore', () => {
    const fixture = makeKanbanWithCard();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new DeleteCardCommand('kb', 't1');

    // BEFORE execute, mutate the original cached def's tags array — this is
    // the race the deep-clone defends against (a tag-rewrite sweep landing
    // between command construction and execute, or a TileHeader edit on the
    // same tile). With a shallow clone the snapshot would alias this array
    // and the restored card would inherit the mutation.
    const cached = boardCacheStore.cache.kb!;
    const liveDef = cached.tileDefs.t1 as { tags: string[] };
    liveDef.tags.push('hijacked');

    // Also mutate the placement's style object.
    const livePlacement = (cached.board as KanbanBoard).columns[0].tilePlacements[0] as {
      style?: { headerColor?: string };
    };
    if (livePlacement.style) livePlacement.style.headerColor = '#000000';

    cmd.execute();
    cmd.undo();

    const restoredKb = boardCacheStore.cache.kb!.board as KanbanBoard;
    const restoredDef = boardCacheStore.cache.kb!.tileDefs.t1 as { tags: string[] };
    const restoredPlacement = restoredKb.columns[0].tilePlacements[0] as {
      style?: { headerColor?: string };
    };

    // The snapshot's tags and style must reflect the delete-time state
    // (`['original']`, `'#aaaaaa'`), not the post-mutation state.
    expect(restoredDef.tags).toEqual(['original']);
    expect(restoredPlacement.style?.headerColor).toBe('#aaaaaa');
  });
});
