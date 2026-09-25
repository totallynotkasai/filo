import type {
  Connection,
  TaskListBoard,
  TaskPlacement,
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
 * Task List tile ops — dispatches Task-List-specific add/remove/update.
 * Placements live in `board.tasks[]` and section ownership is encoded by
 * absolute index in `board.sections[]`. `persistAddTaskPlacement` is the
 * canonical insert path because it carries the section / position args; this
 * dispatcher only handles the board-agnostic `Tile` shape (def add on
 * `addTile`, def + connection sweep on `removeTile`).
 *
 *  - `addTile` seeds the text-tile backing file (shared helper) and writes
 *    the def into `tileDefs`. Does NOT insert into `tasks[]` — callers that
 *    need a placement use `persistAddTaskPlacement` directly (so a
 *    cascade-delete undo restores defs without placements).
 *
 *  - `removeTile` drops the `tasks[]` entry referencing the tileId, shifts
 *    section positions to stay anchored, removes the def, and sweeps both
 *    per-board (`cached.connections`) and cross-board (project) connections.
 *
 *  - `updateTile` applies definition-level fields to `tileDefs`. Position /
 *    size / locked / faded skipped — Task List rows have no canvas
 *    geometry; `locked` lives on the per-task placement and routes through
 *    `setTaskPlacementLocked`.
 */
export const tasklistTileOps: BoardTileOps<TaskListBoard> = {
  type: 'tasklist',

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
    const tl = cached.board as TaskListBoard;

    const original = ((tl.tasks ?? []) as TaskPlacement[]);
    const removedAt = original.findIndex((p) => p.tileId === tileId);

    // Even if the placement isn't there (def-only orphan, mid-race state)
    // the def + connections still need cleaning, so don't bail out on
    // removedAt < 0 — only skip the tasks/sections rewrite.
    if (removedAt >= 0) {
      const placements = original.filter((p) => p.tileId !== tileId);
      (tl as Record<string, unknown>).tasks = placements.map((p, i) => ({ ...p, position: i }));

      // Mirror the insert path: any section whose start sits above the
      // removed task's index drifts down one slot to stay anchored to the
      // same boundary.
      const sections = ((tl.sections ?? []) as Array<{ position: number }>);
      if (sections.length > 0) {
        (tl as Record<string, unknown>).sections = sections.map((s) =>
          s.position > removedAt ? { ...s, position: s.position - 1 } : s,
        );
      }
    }

    const { [tileId]: _removed, ...restDefs } = cached.tileDefs;
    void _removed;

    const updatedConns = { ...cached.connections };
    for (const [key, c] of Object.entries(updatedConns)) {
      if ((c as Connection).fromTileId === tileId || (c as Connection).toTileId === tileId) {
        delete updatedConns[key];
      }
    }
    // Refresh the board identity alongside the in-place
    // `tasks`/`sections` rewrites above (cache-identity convention).
    ctx.updateEntry(boardId, { board: { ...tl }, tileDefs: restDefs, connections: updatedConns });

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
    if (b.type !== 'tasklist') return {};
    const tl = b as TaskListBoard;
    const defs = cached.tileDefs ?? {};
    const result: Record<string, Tile> = {};

    for (const p of (tl.tasks ?? []) as TaskPlacement[]) {
      const def = defs[p.tileId];
      if (!def) continue;
      result[p.tileId] = {
        ...projectDef(def),
        position: { x: 0, y: 0 },
        size: { width: 240, height: 160 },
        locked: p.locked === true,
        faded: false,
        boardId,
      } as Tile;
    }
    return result;
  },

  listPlacementIds(cached: BoardFileData): string[] {
    const b = cached.board;
    if (b.type !== 'tasklist') return [];
    const tl = b as TaskListBoard;
    return ((tl.tasks ?? []) as TaskPlacement[]).map((p) => p.tileId);
  },
};
