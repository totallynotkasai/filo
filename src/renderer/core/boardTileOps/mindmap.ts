import type {
  Connection,
  InlineTile,
  MindMapBoard,
  Tile,
  TileDefinition,
} from '../../schema/index';
import {
  isInlineTileType,
  buildTileDefinition,
  buildInlineTileFromTile,
} from '../../lib/boards/tileDefBuilder';
import {
  seedTextFileForNewTile,
  stampTextTileSeedPath,
} from '../../lib/boards/seedTextFileForNewTile';
import type { CacheContext, V7BoardFileData } from '../../stores/boardCacheTypes';
import type { AddTileOpts, BoardTileOps } from '../boardTileOps';

/**
 * Mind Map tile ops — walks `.placements` / `.inlineTiles` on a
 * `MindMapBoard`. Dispatch is gated on `board.type === 'mindmap'` via the
 * registry.
 */
export const mindmapTileOps: BoardTileOps<MindMapBoard> = {
  type: 'mindmap',

  async addTile(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    tile: Tile,
    opts?: AddTileOpts,
  ): Promise<void> {
    // Stamp the backing-file path synchronously so the cache write
    // below reflects the resolved `filePath` immediately. The deferred disk
    // write (file existence check, `.md` seed, doc registration) still goes
    // through `seedTextFileForNewTile` at the end of the function.
    stampTextTileSeedPath(tile, boardId);

    const def = buildTileDefinition(tile);
    const updatedDefs = { ...cached.tileDefs, [tile.id]: def };

    if (isInlineTileType(tile.type)) {
      const mm = cached.board as MindMapBoard;
      const inlineTiles = {
        ...(mm.inlineTiles ?? {}),
        [tile.id]: buildInlineTileFromTile(tile),
      };
      (cached.board as Record<string, unknown>).inlineTiles = inlineTiles;
    } else {
      const mm = cached.board as MindMapBoard;
      const placements = {
        ...(mm.placements ?? {}),
        [tile.id]: {
          x: tile.position.x,
          y: tile.position.y,
          width: tile.size.width,
          height: tile.size.height,
          locked: tile.locked,
          faded: tile.faded,
          frameless: tile.frameless,
        },
      };
      (cached.board as Record<string, unknown>).placements = placements;
    }

    ctx.updateEntry(boardId, { tileDefs: updatedDefs });
    ctx.markDirty(boardId);

    // Deferred disk seed — derived consumers (and the test harness running
    // synchronous assertions) already see the new tile via the cache write
    // above; this runs in the background to write the backing `.md` and
    // register the document state.
    await seedTextFileForNewTile(tile, boardId, opts);
  },

  removeTile(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    tileId: string,
  ): void {
    const mm = cached.board as MindMapBoard;
    const isInline = !!(mm.inlineTiles ?? {})[tileId];

    if (isInline) {
      delete (cached.board as Record<string, Record<string, unknown> | undefined>).inlineTiles?.[
        tileId
      ];
      const { [tileId]: _d, ...restDefs } = cached.tileDefs;
      void _d;
      // Refresh the board's identity alongside the def update: the in-place
      // `delete` above doesn't change the `board` reference, so spread a fresh
      // copy for identity-comparison consumers (cache-identity convention).
      ctx.updateEntry(boardId, { board: { ...mm }, tileDefs: restDefs });
      ctx.markDirty(boardId);
      return;
    }

    // NOTE: deleting the backing .md file is a UI-layer decision (gated by
    // the "Delete file too" checkbox in TileHeader.confirmDelete and
    // AppShell.confirmDelete). The persistence layer must NOT delete files
    // — doing so makes Ctrl+Z unrecoverable and ignores user intent.
    const { [tileId]: _removed, ...restDefs } = cached.tileDefs;
    void _removed;
    delete (cached.board as Record<string, Record<string, unknown> | undefined>).placements?.[
      tileId
    ];

    const updatedConns = { ...cached.connections };
    for (const [key, c] of Object.entries(updatedConns)) {
      if ((c as Connection).fromTileId === tileId || (c as Connection).toTileId === tileId) {
        delete updatedConns[key];
      }
    }
    // Fresh `board` ref alongside the in-place `delete` of the
    // placement above (cache-identity convention).
    ctx.updateEntry(boardId, { board: { ...mm }, tileDefs: restDefs, connections: updatedConns });

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
    cached: V7BoardFileData,
    boardId: string,
    tileId: string,
    updates: Partial<Tile>,
  ): void {
    const mm = cached.board as MindMapBoard;

    const inlineTile = (mm.inlineTiles ?? {})[tileId] as Record<string, unknown> | undefined;
    if (inlineTile) {
      const t = updates as Record<string, unknown>;
      const patch: Record<string, unknown> = { updatedAt: Date.now() };
      if (updates.title !== undefined) patch.title = updates.title;
      if ('titleHtml' in updates) patch.titleHtml = (updates as { titleHtml?: string }).titleHtml;
      if (updates.style !== undefined) patch.style = updates.style;
      if (updates.tags !== undefined) patch.tags = updates.tags;
      if (updates.position) {
        patch.x = updates.position.x;
        patch.y = updates.position.y;
      }
      if (updates.size) {
        patch.width = updates.size.width;
        patch.height = updates.size.height;
      }
      if (updates.locked !== undefined) patch.locked = updates.locked;
      if (updates.faded !== undefined) patch.faded = updates.faded;
      if (t.url !== undefined) patch.url = t.url;
      if (t.duration !== undefined) patch.duration = t.duration;
      if (t.remaining !== undefined) patch.remaining = t.remaining;
      if (t.mode !== undefined) patch.mode = t.mode;
      if (t.isRunning !== undefined) patch.isRunning = t.isRunning;
      (cached.board as { inlineTiles: Record<string, Record<string, unknown>> }).inlineTiles[tileId] = {
        ...inlineTile,
        ...patch,
      };

      ctx.markDirty(boardId);
      return;
    }

    const DEFINITION_KEYS = new Set([
      'title', 'titleHtml', 'style', 'tags', 'contentId', 'content', 'src',
      'isPlaying', 'isRecording', 'filePath', 'fileName', 'fileExtension',
      'metadata',
    ]);

    const def = cached.tileDefs[tileId];
    const placement = (mm.placements ?? {})[tileId];
    if (!def && !placement) return;

    const defPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (DEFINITION_KEYS.has(k)) defPatch[k] = v;
    }
    if (Object.keys(defPatch).length > 0 && def) {
      cached.tileDefs = {
        ...cached.tileDefs,
        [tileId]: { ...def, ...defPatch, updatedAt: Date.now() } as TileDefinition,
      };
    }

    if (placement) {
      const { position, size, locked, faded, frameless } = updates;
      if (position) {
        placement.x = position.x;
        placement.y = position.y;
      }
      if (size) {
        placement.width = size.width;
        placement.height = size.height;
      }
      if (locked !== undefined) placement.locked = locked;
      if (faded !== undefined) placement.faded = faded;
      if (frameless !== undefined) placement.frameless = frameless;
      (cached.board as { placements: Record<string, typeof placement> }).placements[tileId] = {
        ...placement,
      };
    }

    ctx.markDirty(boardId);
  },

  getFullTiles(cached: V7BoardFileData, boardId: string): Record<string, Tile> {
    const b = cached.board;
    if (b.type !== 'mindmap') return {};
    const mm = b as MindMapBoard;
    const defs = cached.tileDefs ?? {};
    const result: Record<string, Tile> = {};

    for (const [tileId, placement] of Object.entries(mm.placements ?? {})) {
      const def = defs[tileId];
      if (!def) continue;
      result[tileId] = {
        ...def,
        position: { x: placement.x, y: placement.y },
        size: { width: placement.width, height: placement.height },
        locked: placement.locked,
        faded: placement.faded,
        frameless: placement.frameless,
        boardId,
      } as Tile;
    }

    for (const [id, inline] of Object.entries(mm.inlineTiles ?? {})) {
      // InlineTile (link/iframe/timer) stores position as x/y and size as
      // width/height; reshape into the canvas Tile contract. The schema is
      // .passthrough() so url/style/duration/etc. live alongside the
      // declared fields — read them through this narrow projection rather
      // than re-casting the whole inline tile to a raw record.
      const extra = inline as InlineTile & Record<string, unknown>;
      const merged: Record<string, unknown> = {
        ...extra,
        position: { x: inline.x, y: inline.y },
        size: { width: inline.width, height: inline.height },
        boardId,
      };
      result[id] = merged as Tile;
    }

    return result;
  },

  listPlacementIds(cached: V7BoardFileData): string[] {
    const b = cached.board;
    if (b.type !== 'mindmap') return [];
    const mm = b as MindMapBoard;
    return [
      ...Object.keys(mm.placements ?? {}),
      ...Object.keys(mm.inlineTiles ?? {}),
    ];
  },
};
