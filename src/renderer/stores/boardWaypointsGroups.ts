import type { MindMapBoard, TileGroup } from '../schema/index';
import { createId } from '../lib/utils/ids';
import { boardCacheStore } from './boardCache.svelte';
import type { BoardContext } from './boardStoreTypes';

/**
 * Board slice — Mind Map waypoints and tile groups.
 *
 * `boardStore.current` is a `$derived` view of
 * `boardCacheStore.cache[currentBoardId].board`. Mutators write directly into
 * the cached `MindMapBoard` (waypoints / groups arrays) and call
 * `boardCacheStore.persistWaypoints` (for waypoints) or `markDirty` (for
 * groups) to schedule the debounced `.board.json` write; no re-publish is
 * needed because the per-pane derived view watches the cache directly.
 */
export function makeWaypointsGroupsSlice(ctx: BoardContext) {
  function mindMapBoardOrNull(): MindMapBoard | null {
    const current = ctx.getCurrent();
    if (!current || current.type !== 'mindmap') return null;
    return current as MindMapBoard;
  }

  return {
    addWaypoint(waypoint: {
      id: string; name: string; x: number; y: number;
      zoom?: number; icon?: string; locked?: boolean;
    }): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = [
        ...(board.waypoints || []),
        { locked: false, zoom: 1, icon: '📌', ...waypoint },
      ] as MindMapBoard['waypoints'];
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    removeWaypoint(waypointId: string): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).filter((w) => w.id !== waypointId);
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    renameWaypoint(waypointId: string, newName: string): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).map((w) =>
        w.id === waypointId ? { ...w, name: newName } : w,
      );
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    updateWaypointIcon(waypointId: string, icon: string): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).map((w) =>
        w.id === waypointId ? { ...w, icon } : w,
      );
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    moveWaypoint(waypointId: string, x: number, y: number): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).map((w) =>
        w.id === waypointId ? { ...w, x, y } : w,
      );
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    toggleWaypointLock(waypointId: string): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).map((w) =>
        w.id === waypointId ? { ...w, locked: !w.locked } : w,
      );
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    /**
     * Explicit setter used by `ToggleWaypointLockCommand`
     * so undo/redo restores the snapshotted boolean rather than running
     * the toggle twice. Without this, an external mutation between
     * execute and undo (sync-client edit, concurrent toggle) would desync
     * the state by flipping it again instead of returning to `before`.
     */
    setWaypointLock(waypointId: string, locked: boolean): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.waypoints = (board.waypoints || []).map((w) =>
        w.id === waypointId ? { ...w, locked } : w,
      );
      boardCacheStore.persistWaypoints(board.id, board.waypoints ?? []);
    },

    get waypoints() {
      const board = mindMapBoardOrNull();
      return board?.waypoints ?? [];
    },

    get groups(): TileGroup[] {
      const board = mindMapBoardOrNull();
      return board?.groups ?? [];
    },

    getGroupForTile(tileId: string): TileGroup | undefined {
      const board = mindMapBoardOrNull();
      return (board?.groups ?? []).find((g) => g.tileIds.includes(tileId));
    },

    getGroupedTileIds(tileId: string): string[] {
      const group = this.getGroupForTile(tileId);
      return group ? group.tileIds : [tileId];
    },

    groupTiles(tileIds: string[]): void {
      const board = mindMapBoardOrNull();
      if (!board || tileIds.length < 2) return;
      const existingGroups = board.groups || [];

      const affectedGroupIds = new Set<string>();
      const mergedTileIds = new Set(tileIds);
      for (const g of existingGroups) {
        for (const id of tileIds) {
          if (g.tileIds.includes(id)) {
            affectedGroupIds.add(g.id);
            g.tileIds.forEach((tid) => mergedTileIds.add(tid));
          }
        }
      }

      const remainingGroups = existingGroups.filter((g) => !affectedGroupIds.has(g.id));
      // Monotonic per-board counter: max(existing displayIndex) + 1, falling
      // back to 0 for groups loaded from older `.board.json` files that
      // never had the field (the boardLoader backfill normally handles this
      // before we get here, but the `?? 0` keeps the math safe regardless).
      // A merge always mints a fresh index because the merged set is
      // semantically a *new* group, not a continuation of the old one.
      const nextDisplayIndex =
        existingGroups.reduce((max, g) => Math.max(max, g.displayIndex ?? 0), 0) + 1;
      const newGroup: TileGroup = {
        id: createId(),
        tileIds: [...mergedTileIds],
        boardId: board.id,
        displayIndex: nextDisplayIndex,
      };
      board.groups = [...remainingGroups, newGroup];
      boardCacheStore.markDirty(board.id);
    },

    ungroupTiles(tileIds: string[]): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      const existingGroups = board.groups || [];

      board.groups = existingGroups.filter(
        (g) => !g.tileIds.some((id) => tileIds.includes(id)),
      );
      boardCacheStore.markDirty(board.id);
    },

    /**
     * Replaces the active mind-map board's `groups` array wholesale. Used by
     * `ToggleGroupCommand.undo` to restore the pre-group/ungroup snapshot
     * exactly — including the displayIndex of pre-existing groups affected by
     * the merge heuristic.
     */
    replaceGroups(groups: TileGroup[]): void {
      const board = mindMapBoardOrNull();
      if (!board) return;
      board.groups = groups.map((g) => ({ ...g, tileIds: [...g.tileIds] }));
      boardCacheStore.markDirty(board.id);
    },
  };
}
