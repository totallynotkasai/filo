import type {
  Connection,
  KanbanBoard,
  KanbanTilePlacement,
  Tile,
  TileDefinition,
} from '../../schema/index';
import { buildTileDefinition, defPatchFor } from '../../lib/boards/tileDefBuilder';
import {
  seedTextFileForNewTile,
  stampTextTileSeedPath,
} from '../../lib/boards/seedTextFileForNewTile';
import type { CacheContext, BoardFileData } from '../../stores/boardCacheTypes';
import { projectDef } from './projectTile';
import type { AddTileOpts, BoardTileOps } from '../boardTileOps';

/**
 * Kanban tile ops — dispatches Kanban-specific add/remove/update behaviour.
 * Kanban placement (columns + per-column `tilePlacements[]`) is mutated via
 * the dedicated `boardCacheStore.persistAddKanbanPlacement` /
 * `moveKanbanPlacement` API surface; this dispatcher only handles the
 * board-agnostic `Tile` shape:
 *
 *  - `addTile` seeds the text-tile backing file (shared helper), inserts the
 *    def into `tileDefs`, and does NOT touch column placements. The caller
 *    is responsible for `persistAddKanbanPlacement` if a placement is needed:
 *    restoring a column placement (e.g. cascade-delete undo) requires column +
 *    position info the `Tile` shape doesn't carry.
 *
 *  - `removeTile` sweeps every column for a tilePlacements entry referencing
 *    the tileId, removes the def, and cleans both per-board (`cached
 *    .connections`) and cross-board (project) connections referencing the
 *    tile, so no orphan placement is left on disk.
 *
 *  - `updateTile` applies definition-level fields (title, tags, style, …) to
 *    `tileDefs`. Position / size / locked / faded are skipped — Kanban cards
 *    have no canvas geometry and locked/faded fall through column placement
 *    style.
 */
export const kanbanTileOps: BoardTileOps<KanbanBoard> = {
  type: 'kanban',

  async addTile(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    tile: Tile,
    opts?: AddTileOpts,
  ): Promise<void> {
    // Stamp filePath synchronously so the cache def reflects the
    // resolved path immediately; defer the disk seed.
    stampTextTileSeedPath(tile, boardId);
    const def = buildTileDefinition(tile);
    const updatedDefs = { ...cached.tileDefs, [tile.id]: def };
    ctx.updateEntry(boardId, { tileDefs: updatedDefs });
    ctx.markDirty(boardId);
    await seedTextFileForNewTile(tile, boardId, opts);
  },

  removeTile(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    tileId: string,
  ): void {
    const kb = cached.board as KanbanBoard;

    // Drop the tile from every column's tilePlacements list, renumbering
    // surviving entries so positions stay contiguous. Matches the body of
    // `boardCacheStore.removeKanbanPlacement` so post-conditions remain
    // identical when dispatched via the registry.
    (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
      const placements = (c.tilePlacements ?? []).filter((p) => p.tileId !== tileId);
      return {
        ...c,
        tilePlacements: placements.map((p, i) => ({ ...p, position: i } as KanbanTilePlacement)),
      };
    });

    const { [tileId]: _removed, ...restDefs } = cached.tileDefs;
    void _removed;

    // Sweep per-board connections + project-level connections referencing
    // this tile. Kanban boards don't usually own connections (mindmap is
    // the canvas surface) but the cache map exists for every board type
    // and a hand-edited / migrated file could in principle host them.
    const updatedConns = { ...cached.connections };
    for (const [key, c] of Object.entries(updatedConns)) {
      if ((c as Connection).fromTileId === tileId || (c as Connection).toTileId === tileId) {
        delete updatedConns[key];
      }
    }
    // Refresh the board identity alongside the in-place
    // `columns` rewrite above (cache-identity convention).
    ctx.updateEntry(boardId, { board: { ...kb }, tileDefs: restDefs, connections: updatedConns });

    ctx.updateProjectConnectionsFrames(({ connections: projConns }) => {
      for (const [key, c] of Object.entries(projConns)) {
        if (c.fromTileId === tileId || c.toTileId === tileId) {
          delete projConns[key];
        }
      }
    });

    ctx.markDirty(boardId);
  },

  updateTile(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    tileId: string,
    updates: Partial<Tile>,
  ): void {
    const def = cached.tileDefs[tileId];
    if (!def) return;

    const defPatch = defPatchFor(def, updates);
    if (Object.keys(defPatch).length === 0) {
      ctx.markDirty(boardId);
      return;
    }

    cached.tileDefs = {
      ...cached.tileDefs,
      [tileId]: { ...def, ...defPatch, updatedAt: Date.now() } as TileDefinition,
    };

    ctx.markDirty(boardId);
  },

  getFullTiles(cached: BoardFileData, boardId: string): Record<string, Tile> {
    const b = cached.board;
    if (b.type !== 'kanban') return {};
    const kb = b as KanbanBoard;
    const defs = cached.tileDefs ?? {};
    const result: Record<string, Tile> = {};

    for (const col of kb.columns ?? []) {
      const placements = (col.tilePlacements ?? []) as KanbanTilePlacement[];
      for (const p of placements) {
        const def = defs[p.tileId];
        if (!def) continue;
        // Preserve def-level locked/faded flags (set by TileHeader's lock
        // toggle / fade affordance) so the flow-layout card honours them.
        const defLocked = (def as Partial<Tile>).locked === true;
        const defFaded = (def as Partial<Tile>).faded === true;
        result[p.tileId] = {
          ...projectDef(def),
          position: { x: 0, y: 0 },
          size: { width: 240, height: 160 },
          locked: defLocked,
          faded: defFaded,
          boardId,
        } as Tile;
      }
    }
    return result;
  },

  listPlacementIds(cached: BoardFileData): string[] {
    const b = cached.board;
    if (b.type !== 'kanban') return [];
    const kb = b as KanbanBoard;
    const ids: string[] = [];
    for (const col of kb.columns ?? []) {
      for (const p of (col.tilePlacements ?? []) as KanbanTilePlacement[]) {
        ids.push(p.tileId);
      }
    }
    return ids;
  },
};
