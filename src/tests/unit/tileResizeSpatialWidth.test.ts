import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { setActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';

/**
 * REFUTED claim: "On manual resize of an auto-width text tile,
 * the commit sets `userResizedWidth: true` and the re-measure effect only
 * rewrites `renderedHeight`, leaving a stale auto `renderedWidth` in the rbush
 * index forever, so marquee / hit-testing / guides disagree on the X axis."
 *
 * The mechanism does not exist in the current code:
 *   - There is NO `userResizedWidth` field anywhere (tile.ts has none); both
 *     proposed fixes were written around that hallucinated field.
 *   - `renderedWidth` / `renderedHeight` have ZERO production writers (grep:
 *     the only `:=` sites are the schema definitions). They are only ever READ
 *     in `renderedWidth ?? size.width`, which therefore always collapses to
 *     `size.width` at runtime. Placements never persist them either.
 *   - The ResizeObserver "re-measure effect" (TileContainer.svelte) writes BOTH
 *     measured axes straight to the spatial index via `updateOrDefer`, not
 *     "only renderedHeight".
 *   - `tileResize.ts` commits `size: { width, height }` — both axes.
 *
 * So the realistic resize path keeps the spatial footprint exact on the X axis.
 * This guard locks that in: a normal tile resized wider then narrower has its
 * rbush entry track `size.width` with no stale extent lingering. It PASSES
 * against unmodified code — reproduce first: the lead is refuted.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeTextTile(id: string, x = 0, y = 0): Tile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    faded: false,
    tags: [],
    filePath: `${id}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tile;
}

describe('Tile resize spatial width (no stale extent)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('a manual resize tracks size.width on the X axis with no stale extent', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    const pane = createBoardScope();
    pane.board.setBoard(fixture.board);
    setActiveScope(pane);

    // A real tile: 200×100 at (100,100) → rbush footprint x ∈ [100, 300].
    // Production tiles never carry renderedWidth, so the index tracks size.width.
    // skipEmptySeed avoids the backing-.md write (irrelevant to spatial geometry).
    await pane.board.addTile(makeTextTile('t1', 100, 100), { skipEmptySeed: true });
    expect(pane.spatial.queryViewport({ left: 150, top: 120, right: 160, bottom: 130 }))
      .toContain('t1');
    expect(pane.spatial.queryViewport({ left: 350, top: 120, right: 360, bottom: 130 }))
      .not.toContain('t1');

    // Grow to 400 wide — the exact size-only update tileResize.ts commits.
    pane.board.updateTile('t1', { size: { width: 400, height: 100 } });
    // New footprint (x ≈ 450, within [100, 500]) hits…
    expect(pane.spatial.queryViewport({ left: 450, top: 120, right: 460, bottom: 130 }))
      .toContain('t1');
    // …and just beyond the new 400-wide extent misses.
    expect(pane.spatial.queryViewport({ left: 550, top: 120, right: 560, bottom: 130 }))
      .not.toContain('t1');

    // Shrink back to 200 wide. The X axis must follow: the OLD 400-wide extent
    // must NOT linger ("stale renderedWidth forever" would leave it). This is
    // the assertion that refutes the claim.
    pane.board.updateTile('t1', { size: { width: 200, height: 100 } });
    expect(pane.spatial.queryViewport({ left: 150, top: 120, right: 160, bottom: 130 }))
      .toContain('t1'); // within the new 200-wide footprint
    expect(pane.spatial.queryViewport({ left: 350, top: 120, right: 360, bottom: 130 }))
      .not.toContain('t1'); // old wider extent is gone — no stale width
  });
});
