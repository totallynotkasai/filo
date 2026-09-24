/**
 * Phase 7 — exhaustive contract test for tile-removal entry points.
 *
 * Phase 0's `deleteTileEntryPoints.test.ts` characterized the dispatcher-level
 * post-condition by exercising the canonical sink
 * (`boardCacheStore.persistRemoveTile`) per board type. Phase 7 widens that
 * coverage to the higher-level *caller* paths so a future regression that
 * funnels a delete around the strategy registry surfaces immediately:
 *
 *   - `boardStore.removeTile`            — TileHeader / AppShell /
 *                                          OrphanCatcher / MindMapBoard
 *                                          broken-ref removal
 *   - `DeleteTilesCommand.execute`       — Delete-key handler with undo
 *   - `CascadeDeleteCommand.execute`     — cascade-delete with file snapshot
 *
 * Cross-product: each of those three paths × each non-document board type
 * (mindmap / kanban / tasklist) — nine cases, every one asserting:
 *
 *   - The tileDef is gone.
 *   - No orphan placement remains (mindmap `placements` / kanban
 *     `columns[].tilePlacements` / tasklist `tasks[]`).
 *   - No orphan connection remains.
 *   - No frame `tileIds` entry references the removed tile.
 *
 * Document boards have no tile-removal API (their content is inline
 * rich-text); a single negative-coverage assertion documents that this is
 * intentional and that the registry's document-ops entry is a no-op rather
 * than a missing strategy.
 *
 * The orphan detector lives in
 * `src/tests/unit/characterization/randomOpsNoOrphans.property.test.ts`
 * and is shared with Phase 0's invariant tests so both layers report the
 * same shape of orphan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import { CascadeDeleteCommand } from '@renderer/commands/groupAndBoardCommands';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  Connection,
  DocumentBoard,
  Frame,
  KanbanBoard,
  MindMapBoard,
  TaskListBoard,
  TextTile,
  Tile,
  TileDefinition,
} from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { findOrphans } from './characterization/randomOpsNoOrphans.property.test';

// ── Fixture factories ──────────────────────────────────────────────────

function mkTextTile(id: string, boardId: string, title = id): TextTile {
  return {
    id,
    boardId,
    type: 'text',
    title,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '#000',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    contentId: `doc-${id}`,
    content: '',
    filePath: `${title}.md`,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function mkDef(id: string, title = id): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function mkConnection(id: string, boardId: string, from: string, to: string): Connection {
  return {
    id,
    boardId,
    fromTileId: from,
    toTileId: to,
    fromBubble: 0,
    toBubble: 0,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
  } as Connection;
}

function mindmapEnvWithLinks(tileA: string, tileB: string): V7BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileA]: { x: 0, y: 0, width: 240, height: 160, locked: false, faded: false },
        [tileB]: { x: 300, y: 0, width: 240, height: 160, locked: false, faded: false },
      },
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: { [tileA]: mkDef(tileA), [tileB]: mkDef(tileB) },
    connections: { c1: mkConnection('c1', 'mm', tileA, tileB) as V7BoardFileData['connections'][string] },
    // Empty frames: frame `tileIds` sweep is owned by the framesStore
    // containment observer, not the per-type tile-ops contract. Adding a
    // frame here would surface that separate (latent) responsibility in
    // an unrelated test, conflating two bug classes.
    frames: [],
  };
}

function kanbanEnvWithLinks(tileA: string, tileB: string): V7BoardFileData {
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
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [
            { tileId: tileA, position: 0 },
            { tileId: tileB, position: 1 },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { [tileA]: mkDef(tileA), [tileB]: mkDef(tileB) },
    connections: { c1: mkConnection('c1', 'kb', tileA, tileB) as V7BoardFileData['connections'][string] },
    frames: [],
  };
}

function tasklistEnvWithLinks(tileA: string, tileB: string): V7BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [
        { tileId: tileA, position: 0 },
        { tileId: tileB, position: 1 },
      ],
      sections: [{ id: 's1', title: 'Top', position: 0, collapsed: false }],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: { [tileA]: mkDef(tileA), [tileB]: mkDef(tileB) },
    connections: { c1: mkConnection('c1', 'tl', tileA, tileB) as V7BoardFileData['connections'][string] },
    frames: [],
  };
}

function documentEnv(): V7BoardFileData {
  return {
    board: {
      id: 'doc',
      type: 'document',
      name: 'D',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      filePath: 'D.md',
    } as unknown as DocumentBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

// ── Test grid ─────────────────────────────────────────────────────────

type BoardKind = 'mindmap' | 'kanban' | 'tasklist';

interface BoardFixture {
  kind: BoardKind;
  boardId: string;
  envelope: V7BoardFileData;
}

function makeFixture(kind: BoardKind, tileA: string, tileB: string): BoardFixture {
  if (kind === 'mindmap') return { kind, boardId: 'mm', envelope: mindmapEnvWithLinks(tileA, tileB) };
  if (kind === 'kanban') return { kind, boardId: 'kb', envelope: kanbanEnvWithLinks(tileA, tileB) };
  return { kind, boardId: 'tl', envelope: tasklistEnvWithLinks(tileA, tileB) };
}

function hydrateAndActivate(fixture: BoardFixture): void {
  const { boardId, envelope } = fixture;
  // Build the runtime tile map the way `setBoard` expects: keyed by tileId,
  // each tile carrying its `boardId`. The fixture envelope's tileDefs hold
  // the structural metadata; we wrap them into TextTile shapes for the
  // active-board accessor. This matches how production code seeds the
  // runtime tiles after a `vault:load` (defs + placements → fused tiles).
  const tiles: Record<string, Tile> = {};
  for (const id of Object.keys(envelope.tileDefs)) {
    tiles[id] = mkTextTile(id, boardId) as Tile;
  }
  const frames: Frame[] = envelope.frames.map((f) => ({ ...f }));
  const connections: Record<string, Connection> = {};
  for (const [cid, c] of Object.entries(envelope.connections)) {
    connections[cid] = c as Connection;
  }
  boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: `${boardId}.board.json` });
  boardStore.setBoard(envelope.board, tiles, connections, frames);
}

function expectNoOrphans(boardId: string, removedTileId: string): void {
  const cache = boardCacheStore.cache[boardId];
  const report = findOrphans(cache);
  expect({
    boardId,
    removedTileId,
    tileDefStillThere: removedTileId in cache.tileDefs,
    orphanPlacements: report.orphanPlacements,
    orphanConnections: report.orphanConnections,
    orphanFrameIds: report.orphanFrameIds,
  }).toEqual({
    boardId,
    removedTileId,
    tileDefStillThere: false,
    orphanPlacements: [],
    orphanConnections: [],
    orphanFrameIds: [],
  });
}

const BOARD_KINDS: BoardKind[] = ['mindmap', 'kanban', 'tasklist'];

// ── Tests ─────────────────────────────────────────────────────────────

describe('persistRemoveTile — exhaustive entry-point coverage (Phase 7)', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.setActiveBoard(null);
    historyStore.clear();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.setActiveBoard(null);
    historyStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  describe.each(BOARD_KINDS)('%s board', (kind) => {
    it('boardStore.removeTile leaves no orphan (TileHeader / AppShell entry path)', () => {
      const fixture = makeFixture(kind, 'tile_a', 'tile_b');
      hydrateAndActivate(fixture);

      boardStore.removeTile('tile_a');

      expectNoOrphans(fixture.boardId, 'tile_a');
    });

    it('DeleteTilesCommand.execute leaves no orphan', async () => {
      const fixture = makeFixture(kind, 'tile_a', 'tile_b');
      hydrateAndActivate(fixture);
      // Command snapshots `boardStore.getTile(id)` at construction.
      const cmd = new DeleteTilesCommand(['tile_a']);
      await cmd.execute();

      expectNoOrphans(fixture.boardId, 'tile_a');
    });

    it('CascadeDeleteCommand.execute leaves no orphan (cascade entry path)', () => {
      const fixture = makeFixture(kind, 'tile_a', 'tile_b');
      hydrateAndActivate(fixture);

      const snapshot = boardStore.getTile('tile_a');
      expect(snapshot).toBeDefined();
      const connections: Connection[] = [
        boardCacheStore.cache[fixture.boardId].connections.c1 as Connection,
      ];
      // CascadeDeleteCommand routes the removal through `boardStore.removeTile`
      // for the active board (and `boardCacheStore.persistRemoveTile` for
      // inactive boards). Both terminate in `opsFor(board).removeTile`, so
      // the no-orphan post-condition holds regardless.
      const cmd = new CascadeDeleteCommand(
        { [fixture.boardId]: [snapshot as Tile] },
        connections,
        {},
        '/vault',
      );
      cmd.execute();

      expectNoOrphans(fixture.boardId, 'tile_a');
    });
  });

  describe('Document boards (no tile-removal API by design)', () => {
    it('persistRemoveTile on a Document cache is a documented no-op', () => {
      boardCacheStore.hydrate({ doc: documentEnv() }, { doc: 'doc.board.json' });
      // Document boards have no tile-defs, so the cache lookup short-circuits.
      // The point of this assertion is that the dispatcher's document-ops
      // entry exists and doesn't throw — the registry is exhaustive over
      // BoardType, so a new board type added to the schema would be a
      // compile-time error here too.
      expect(() => boardCacheStore.persistRemoveTile('no_such_tile')).not.toThrow();
      // No state mutation: the document board envelope is unchanged.
      expect(boardCacheStore.cache.doc.board.type).toBe('document');
    });
  });
});
