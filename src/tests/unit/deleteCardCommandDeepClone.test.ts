/**
 * `DeleteCardCommand` snapshot deep-clone.
 *
 * Pre-fix the command captured snapshots via shallow `{ ...placement }` and
 * `{ ...def }`. Any tag/style mutation on the same tile between the
 * command's construction and its `undo()` mutated the snapshot's shared
 * inner references (because the spread only copies top-level keys — nested
 * arrays and objects are still aliased). On undo the restored card would
 * carry the *current* nested state, not the delete-time state.
 *
 * The fix mirrors `AddCardCommand`'s pattern: deep-clone via
 * `JSON.parse(JSON.stringify(...))` so the snapshot is fully isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { DeleteCardCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function makeKanbanWithCard(): BoardFileData {
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
        filePath: 'Card A.md',
        style: { headerColor: '#111111', bodyColor: '', borderColor: '' } as never,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('DeleteCardCommand — deep-clone snapshot', () => {
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

  it('snapshot is isolated from the original def — mutating the def style before execute does not corrupt the restore', () => {
    const fixture = makeKanbanWithCard();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new DeleteCardCommand('kb', 't1');

    // BEFORE execute, mutate the original cached def's nested style object —
    // this is the race the deep-clone defends against (a style edit on the
    // same tile landing between command construction and execute). With a
    // shallow clone the snapshot would alias this object and the restored
    // card would inherit the mutation.
    const cached = boardCacheStore.cache.kb!;
    const liveDef = cached.tileDefs.t1 as { style: { headerColor: string } };
    liveDef.style.headerColor = '#hijacked';

    // Also mutate the placement's style object.
    const livePlacement = (cached.board as KanbanBoard).columns[0].tilePlacements[0] as {
      style?: { headerColor?: string };
    };
    if (livePlacement.style) livePlacement.style.headerColor = '#000000';

    cmd.execute();
    cmd.undo();

    const restoredKb = boardCacheStore.cache.kb!.board as KanbanBoard;
    const restoredDef = boardCacheStore.cache.kb!.tileDefs.t1 as { style: { headerColor: string } };
    const restoredPlacement = restoredKb.columns[0].tilePlacements[0] as {
      style?: { headerColor?: string };
    };

    // The snapshot's def and placement styles must reflect the delete-time
    // state (`'#111111'`, `'#aaaaaa'`), not the post-mutation state.
    expect(restoredDef.style.headerColor).toBe('#111111');
    expect(restoredPlacement.style?.headerColor).toBe('#aaaaaa');
  });
});
