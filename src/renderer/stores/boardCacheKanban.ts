import type {
  KanbanBoard,
  KanbanTilePlacement,
  PartialKanbanCardStyle,
  Tile,
  TileDefinition,
} from '../schema/index';

type PartialColumnStyle = Record<string, unknown>;
import { TileDefinitionSchema } from '../schema/index';
import type { CacheContext } from './boardCacheTypes';

/**
 * Cache slice — Kanban board mutations (columns, placements, cover images,
 * saved views, WIP limits). All mutations route through `ctx.markDirty` so
 * the debounced board write picks them up.
 *
 * Active-proxy reactivity contract (Phase 1.1 / 2.2 sweep)
 * --------------------------------------------------------
 * Every mutator below writes through the **cache** `$state` proxy. The
 * **active** `boardStore.current` is a *separate* `$state` proxy wrapping the
 * same underlying Board object; Svelte 5 does not propagate writes between
 * the two. The Kanban host repairs that with `tickAndPersist()`, which
 * shallow-clones `cached.board` and re-publishes it as the active board so
 * Svelte's identity check re-fires every active-side derivation.
 *
 * **All mutators in this file rely on the caller to invoke `tickAndPersist()`
 * after the write.** The standard call paths are:
 *
 * - Direct calls from `KanbanBoard.svelte` (toggle collapse, WIP, width,
 *   collapse-all/expand-all, …) — caller ticks immediately after the mutator.
 * - Indirect calls from history commands in `commands/kanbanCommands.ts`
 *   (AddCard, DeleteCard, MoveCard, AddColumn, RenameColumn, DeleteColumn,
 *   ReorderColumns, …) — the call site that dispatches `historyStore.execute`
 *   ticks immediately after the dispatch.
 * - Indirect calls from `kanbanFrontmatterWriter.ts` (cover-image picker /
 *   clear) — the writer ticks immediately after the cache mutator.
 *
 * Two exceptions worth noting (no per-write tick; rely on `cacheVersion++`
 * inside the popup OR on Svelte's nested-leaf reactivity):
 * - `updateKanbanColumnStyle` and `updateKanbanCardPlacementStyle` are
 *   driven by their respective Style popups, which write per-pick without
 *   ticking and only push a single `Update*StyleCommand` on close. The
 *   visual change reaches the rendered card because the popup is mounted
 *   inside the board's reactive subtree — the cache write reaches the
 *   active proxy via the shared nested children, not via a fresh top-level
 *   identity. If a future refactor moves the popup to a portal *outside*
 *   the board scope, those popups will need to tick explicitly.
 */
export function makeKanbanSlice(ctx: CacheContext) {
  return {
    getFullTilesForKanbanBoard(boardId: string): Record<string, Tile> {
      const cached = ctx.getCache()[boardId];
      if (!cached || cached.board.type !== 'kanban') return {};

      const kb = cached.board as KanbanBoard;
      const defs = cached.tileDefs ?? {};
      const result: Record<string, Tile> = {};

      for (const col of kb.columns ?? []) {
        const placements = (col.tilePlacements ?? []) as KanbanTilePlacement[];
        for (const p of placements) {
          const def = defs[p.tileId];
          if (!def) continue;
          // Preserve def-level locked/faded flags (set by TileHeader's lock
          // toggle / fade affordance) so the flow-layout card honours them.
          // Hardcoding false here previously erased the lock when the same
          // contentId surfaced on a Kanban board (hidden divergence).
          const defLocked = (def as Partial<Tile>).locked === true;
          const defFaded = (def as Partial<Tile>).faded === true;
          result[p.tileId] = {
            ...def,
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

    addKanbanColumn(
      boardId: string,
      column: {
        id: string;
        title: string;
        position?: number;
        collapsed?: boolean;
        style?: Record<string, unknown>;
      },
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'addKanbanColumn');
      if (!kb) return;
      const cols = (kb.columns ?? []) as KanbanBoard['columns'];
      const next = [
        ...cols,
        {
          id: column.id,
          title: column.title,
          position: column.position ?? cols.length,
          collapsed: column.collapsed ?? false,
          tilePlacements: [],
          ...(column.style && { style: column.style }),
        },
      ];
      (kb as Record<string, unknown>).columns = next;
      ctx.markDirty(boardId);
    },

    removeKanbanColumn(boardId: string, columnId: string): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'removeKanbanColumn');
      if (!kb) return;
      (kb as Record<string, unknown>).columns =
        (kb.columns ?? []).filter((c) => c.id !== columnId);
      ctx.markDirty(boardId);
    },

    renameKanbanColumn(boardId: string, columnId: string, title: string): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'renameKanbanColumn');
      if (!kb) return;
      (kb as Record<string, unknown>).columns =
        (kb.columns ?? []).map((c) => (c.id === columnId ? { ...c, title } : c));
      ctx.markDirty(boardId);
    },

    reorderKanbanColumns(boardId: string, orderedIds: string[]): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'reorderKanbanColumns');
      if (!kb) return;
      const byId = new Map((kb.columns ?? []).map((c) => [c.id, c]));
      const reordered = orderedIds
        .map((id, idx) => {
          const col = byId.get(id);
          return col ? { ...col, position: idx } : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      (kb as Record<string, unknown>).columns = reordered;
      ctx.markDirty(boardId);
    },

    setKanbanColumnCollapsed(boardId: string, columnId: string, collapsed: boolean): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setKanbanColumnCollapsed');
      if (!kb) return;
      (kb as Record<string, unknown>).columns =
        (kb.columns ?? []).map((c) => (c.id === columnId ? { ...c, collapsed } : c));
      ctx.markDirty(boardId);
    },

    setKanbanSavedViews(
      boardId: string,
      savedViews: Array<{
        id: string;
        name: string;
        sortBy: string;
        filterTags: string[];
        filterProp: { key: string; value: string } | null;
      }>,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setKanbanSavedViews');
      if (!kb) return;
      const current = (kb.settings ?? {}) as Record<string, unknown>;
      (kb as Record<string, unknown>).settings = { ...current, savedViews };
      ctx.markDirty(boardId);
    },

    setKanbanColumnWipLimit(boardId: string, columnId: string, wipLimit: number | null): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setKanbanColumnWipLimit');
      if (!kb) return;
      const normalised = typeof wipLimit === 'number' && wipLimit > 0 ? Math.floor(wipLimit) : null;
      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
        if (c.id !== columnId) return c;
        const next: Record<string, unknown> = { ...c };
        if (normalised === null) {
          delete next.wipLimit;
        } else {
          next.wipLimit = normalised;
        }
        return next as typeof c;
      });
      ctx.markDirty(boardId);
    },

    /**
     * Merge a partial style override onto a column. Pass `null` or an empty
     * object to clear the override entirely (so the column falls through to
     * board / global defaults via the cascade).
     */
    updateKanbanColumnStyle(
      boardId: string,
      columnId: string,
      style: PartialColumnStyle | null,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'updateKanbanColumnStyle');
      if (!kb) return;
      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
        if (c.id !== columnId) return c;
        const prevStyle = (c as Record<string, unknown>).style as
          | Record<string, unknown>
          | undefined;
        const next: Record<string, unknown> = { ...c };
        if (!style || Object.keys(style).length === 0) {
          delete next.style;
        } else {
          next.style = { ...(prevStyle ?? {}), ...style };
        }
        return next as typeof c;
      });
      ctx.markDirty(boardId);
    },

    /**
     * Merge a partial style override onto a Kanban card placement. Pass
     * `null` or an empty object to clear the override.
     */
    updateKanbanCardPlacementStyle(
      boardId: string,
      tileId: string,
      style: PartialKanbanCardStyle | null,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'updateKanbanCardPlacementStyle');
      if (!kb) return;
      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => ({
        ...c,
        tilePlacements: (c.tilePlacements ?? []).map((p) => {
          if (p.tileId !== tileId) return p;
          const next: KanbanTilePlacement = { ...p };
          if (!style || Object.keys(style).length === 0) {
            delete next.style;
          } else {
            next.style = { ...(p.style ?? {}), ...style } as PartialKanbanCardStyle;
          }
          return next;
        }),
      }));
      ctx.markDirty(boardId);
    },

    setKanbanColumnWidth(boardId: string, columnId: string, width: number | null): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setKanbanColumnWidth');
      if (!kb) return;
      const normalised = typeof width === 'number' && width > 0 ? Math.round(width) : null;
      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
        if (c.id !== columnId) return c;
        const prevStyle = (c as Record<string, unknown>).style as
          | Record<string, unknown>
          | undefined;
        const nextStyle: Record<string, unknown> = { ...(prevStyle ?? {}) };
        if (normalised === null) {
          delete nextStyle.width;
        } else {
          nextStyle.width = normalised;
        }
        const next: Record<string, unknown> = { ...c };
        if (Object.keys(nextStyle).length === 0) {
          delete next.style;
        } else {
          next.style = nextStyle;
        }
        return next as typeof c;
      });
      ctx.markDirty(boardId);
    },

    setAllKanbanColumnsCollapsed(boardId: string, collapsed: boolean): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setAllKanbanColumnsCollapsed');
      if (!kb) return;
      (kb as Record<string, unknown>).columns =
        (kb.columns ?? []).map((c) => ({ ...c, collapsed }));
      ctx.markDirty(boardId);
    },

    persistAddKanbanPlacement(
      boardId: string,
      columnId: string,
      def: TileDefinition,
      position: number,
      style?: PartialKanbanCardStyle,
      coverImage?: string,
    ): void {
      // Zod-validate the def before it enters the cache. Mirrors the
      // updateTile P0-6 fix: a corrupt def would otherwise persist to disk
      // and replicate the failure mode silently.
      const parsed = TileDefinitionSchema.safeParse(def);
      if (!parsed.success) {
        console.warn(
          '[boardCache] persistAddKanbanPlacement: invalid TileDefinition; not persisted',
          { issues: parsed.error.issues, def },
        );
        return;
      }
      const validDef = parsed.data as TileDefinition;

      // Cache-scan fallback: if the caller passed an empty/unresolvable
      // boardId (race during tab switch or template insertion), locate the
      // owning board by columnId. Self-heals the silent-drop class.
      const resolvedBoardId =
        (ctx.getCache()[boardId]?.board.type === 'kanban' ? boardId : '') ||
        ctx.findBoardIdForKanbanColumn(columnId) ||
        '';
      const cached = ctx.getCache()[resolvedBoardId];
      if (!cached || cached.board.type !== 'kanban') {
        ctx.warnUnresolved('kanban:persistAddKanbanPlacement', `column:${columnId}`);
        return;
      }
      const kb = cached.board as KanbanBoard;

      const updatedDefs = { ...cached.tileDefs, [validDef.id]: validDef };
      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
        if (c.id !== columnId) return c;
        const placements = [...(c.tilePlacements ?? [])];
        const placement: KanbanTilePlacement = { tileId: validDef.id, position };
        if (style) placement.style = style;
        // 6.4.M11 — restore a snapshotted coverImage atomically as part of the
        // placement add (used by DeleteCardCommand.undo). Set directly: the value
        // is a trusted snapshot of already-persisted state, and undo is not an
        // input boundary, so it intentionally does NOT re-run the
        // setKanbanPlacementCoverImage sanitizer (which would silently drop a
        // pre-existing value it deems unsafe, making undo unfaithful).
        if (typeof coverImage === 'string' && coverImage.length > 0) {
          placement.coverImage = coverImage;
        }
        placements.splice(Math.min(position, placements.length), 0, placement);
        return {
          ...c,
          tilePlacements: placements.map((p, i) => ({ ...p, position: i })),
        };
      });

      ctx.updateEntry(resolvedBoardId, { tileDefs: updatedDefs });
      ctx.markDirty(resolvedBoardId);
    },

    removeKanbanPlacement(boardId: string, tileId: string): void {
      const cached = ctx.getCache()[boardId];
      if (!cached || cached.board.type !== 'kanban') {
        ctx.warnUnresolved('kanban:removeKanbanPlacement', boardId || '<empty>');
        return;
      }
      const kb = cached.board as KanbanBoard;

      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => {
        const placements = (c.tilePlacements ?? []).filter((p) => p.tileId !== tileId);
        return { ...c, tilePlacements: placements.map((p, i) => ({ ...p, position: i })) };
      });

      const { [tileId]: _removed, ...restDefs } = cached.tileDefs;
      void _removed;
      // Audit 5.6 — refresh the board identity alongside the in-place
      // `columns` rewrite above (cache-identity convention).
      ctx.updateEntry(boardId, { board: { ...kb }, tileDefs: restDefs });
      ctx.markDirty(boardId);
    },

    setKanbanPlacementCoverImage(
      boardId: string,
      tileId: string,
      coverImage: string | null,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'setKanbanPlacementCoverImage');
      if (!kb) return;

      // Sanitize: only accept vault-relative POSIX-style paths. Reject
      // absolute paths (C:\… or /…), traversal segments (..), URL schemes
      // (file:, http:, blob:, data:), and Windows drive letters. The picker
      // happy path returns the relative path from vault:copy-file so the
      // common case is unaffected; this guard catches malformed callers.
      let sanitized: string | null = null;
      if (typeof coverImage === 'string' && coverImage.length > 0) {
        const c = coverImage;
        const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(c) || c.startsWith('/') || c.startsWith('\\');
        const hasTraversal = c.split(/[\\/]/).some((seg) => seg === '..');
        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(c);
        if (!looksAbsolute && !hasTraversal && !hasScheme) {
          sanitized = c;
        } else {
          console.warn(
            '[boardCache] setKanbanPlacementCoverImage: rejecting unsafe path',
            { boardId, tileId, coverImage },
          );
        }
      }

      (kb as Record<string, unknown>).columns = (kb.columns ?? []).map((c) => ({
        ...c,
        tilePlacements: (c.tilePlacements ?? []).map((p) => {
          if (p.tileId !== tileId) return p;
          const next: KanbanTilePlacement = { ...p };
          if (sanitized !== null) {
            next.coverImage = sanitized;
          } else {
            delete (next as Record<string, unknown>).coverImage;
          }
          return next;
        }),
      }));
      ctx.markDirty(boardId);
    },

    moveKanbanPlacement(
      boardId: string,
      tileId: string,
      targetColumnId: string,
      targetPosition: number,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'moveKanbanPlacement');
      if (!kb) return;

      let placement: KanbanTilePlacement | null = null;
      const cleared = (kb.columns ?? []).map((c) => {
        const found = (c.tilePlacements ?? []).find((p) => p.tileId === tileId);
        if (found) placement = { ...found };
        const placements = (c.tilePlacements ?? []).filter((p) => p.tileId !== tileId);
        return { ...c, tilePlacements: placements };
      });

      if (!placement) return;

      const final = cleared.map((c) => {
        if (c.id !== targetColumnId) {
          return {
            ...c,
            tilePlacements: (c.tilePlacements ?? []).map((p, i) => ({ ...p, position: i })),
          };
        }
        const placements = [...(c.tilePlacements ?? [])];
        const insertAt = Math.min(Math.max(targetPosition, 0), placements.length);
        placements.splice(insertAt, 0, placement!);
        return {
          ...c,
          tilePlacements: placements.map((p, i) => ({ ...p, position: i })),
        };
      });

      (kb as Record<string, unknown>).columns = final;
      ctx.markDirty(boardId);
    },

    /**
     * Bulk move — remove all listed tiles from their current columns and
     * re-insert them contiguous in `targetColumnId` starting at
     * `targetPosition`, preserving the input order. Used by multi-card drag.
     *
     * Tile IDs not present on the board are skipped silently. `targetPosition`
     * is clamped against the target column's length AFTER removal, so a
     * within-column reorder behaves correctly.
     */
    moveKanbanPlacements(
      boardId: string,
      tileIds: string[],
      targetColumnId: string,
      targetPosition: number,
    ): void {
      const kb = ctx.kanbanBoardOrWarn(boardId, 'moveKanbanPlacements');
      if (!kb) return;
      if (tileIds.length === 0) return;

      const idSet = new Set(tileIds);
      const removed = new Map<string, KanbanTilePlacement>();
      const cleared = (kb.columns ?? []).map((c) => {
        const next: KanbanTilePlacement[] = [];
        for (const p of (c.tilePlacements ?? []) as KanbanTilePlacement[]) {
          if (idSet.has(p.tileId)) {
            removed.set(p.tileId, { ...p });
          } else {
            next.push(p);
          }
        }
        return { ...c, tilePlacements: next };
      });

      // Re-insert in the order the caller asked for, skipping any tile that
      // wasn't actually on the board.
      const orderedPlacements: KanbanTilePlacement[] = [];
      for (const id of tileIds) {
        const found = removed.get(id);
        if (found) orderedPlacements.push(found);
      }
      if (orderedPlacements.length === 0) return;

      const final = cleared.map((c) => {
        if (c.id !== targetColumnId) {
          return {
            ...c,
            tilePlacements: (c.tilePlacements ?? []).map((p, i) => ({ ...p, position: i })),
          };
        }
        const placements = [...(c.tilePlacements ?? [])];
        const insertAt = Math.min(Math.max(targetPosition, 0), placements.length);
        placements.splice(insertAt, 0, ...orderedPlacements);
        return {
          ...c,
          tilePlacements: placements.map((p, i) => ({ ...p, position: i })),
        };
      });

      (kb as Record<string, unknown>).columns = final;
      ctx.markDirty(boardId);
    },
  };
}
