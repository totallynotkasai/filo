import type { Connection, Frame, Tile, TileGroup } from '../schema/index';
import { historyStore } from './history.svelte';
import {
  AddTileCommand,
  AddTilesCommand,
  DeleteTilesCommand,
  type DeleteTilesOptions,
  AddConnectionCommand,
  DeleteConnectionCommand,
  AddFrameCommand,
  DeleteFrameCommand,
  AlignTilesCommand,
  LayoutTilesCommand,
  ToggleGroupCommand,
  ToggleLockCommand,
  AddWaypointCommand,
  RemoveWaypointCommand,
  RenameWaypointCommand,
  MoveWaypointCommand,
  UpdateWaypointIconCommand,
  ToggleWaypointLockCommand,
  UpdateBoardSettingsCommand,
} from '../commands/index';

/**
 * Board slice — undoable wrappers around the runtime tile / connection /
 * frame mutators. Each method builds the corresponding command and pushes
 * it onto the per-board history stack; `execute()` runs the forward action
 * synchronously so the UI reflects the change immediately.
 */
export function makeHistorySlice() {
  return {
    addTileWithHistory(tile: Tile): void {
      historyStore.execute(new AddTileCommand(tile));
    },

    addTilesWithHistory(tiles: Tile[], description?: string): void {
      if (tiles.length === 0) return;
      historyStore.execute(new AddTilesCommand(tiles, description));
    },

    /**
     * Adds tiles AND the connections between them in a single undo step.
     * Used by Layout Template insertion so a template with edges between its
     * tiles is reverted in one Ctrl+Z, its new notes with it. `sharedNotes`
     * lists the tiles that show another one's note (see `AddTilesCommand`).
     */
    addTilesAndConnectionsWithHistory(
      tiles: Tile[],
      connections: Connection[],
      description: string,
      sharedNotes?: ReadonlyMap<string, string>,
    ): void {
      if (tiles.length === 0) return;
      historyStore.execute(new AddTilesCommand(tiles, description, { connections, sharedNotes }));
    },

    removeTilesWithHistory(tileIds: string[], options?: DeleteTilesOptions): void {
      historyStore.execute(new DeleteTilesCommand(tileIds, options));
    },

    addConnectionWithHistory(conn: Connection): void {
      historyStore.execute(new AddConnectionCommand(conn));
    },

    removeConnectionWithHistory(connId: string): void {
      historyStore.execute(new DeleteConnectionCommand(connId));
    },

    addFrameWithHistory(frame: Frame): void {
      historyStore.execute(new AddFrameCommand(frame));
    },

    removeFrameWithHistory(frameId: string): void {
      historyStore.execute(new DeleteFrameCommand(frameId));
    },

    alignTilesWithHistory(
      positionMap: Map<
        string,
        { before: { x: number; y: number }; after: { x: number; y: number } }
      >,
    ): void {
      historyStore.execute(new AlignTilesCommand(positionMap));
    },

    layoutTilesWithHistory(
      positionMap: Map<
        string,
        { before: { x: number; y: number }; after: { x: number; y: number } }
      >,
      description: string,
    ): void {
      historyStore.execute(new LayoutTilesCommand(positionMap, description));
    },

    groupTilesWithHistory(tileIds: string[], groupsBefore: TileGroup[]): void {
      if (tileIds.length < 2) return;
      historyStore.execute(new ToggleGroupCommand(tileIds, 'group', groupsBefore));
    },

    ungroupTilesWithHistory(tileIds: string[], groupsBefore: TileGroup[]): void {
      if (tileIds.length === 0) return;
      historyStore.execute(new ToggleGroupCommand(tileIds, 'ungroup', groupsBefore));
    },

    /**
     * Locks/unlocks the given tiles in one undoable step. `previousStates`
     * captures per-tile lock state at the call site so undo restores a
     * mixed-lock selection exactly.
     */
    setTilesLockedWithHistory(
      previousStates: Map<string, boolean>,
      nextLocked: boolean,
    ): void {
      if (previousStates.size === 0) return;
      historyStore.execute(new ToggleLockCommand(previousStates, nextLocked));
    },

    addWaypointWithHistory(waypoint: {
      id: string; name: string; x: number; y: number;
      zoom?: number; icon?: string; locked?: boolean;
    }): void {
      historyStore.execute(new AddWaypointCommand(waypoint));
    },

    removeWaypointWithHistory(waypoint: {
      id: string; name: string; x: number; y: number;
      zoom?: number; icon?: string; locked?: boolean;
    }): void {
      historyStore.execute(new RemoveWaypointCommand(waypoint));
    },

    renameWaypointWithHistory(waypointId: string, before: string, after: string): void {
      if (before === after) return;
      historyStore.execute(new RenameWaypointCommand(waypointId, before, after));
    },

    moveWaypointWithHistory(
      waypointId: string,
      before: { x: number; y: number },
      after: { x: number; y: number },
    ): void {
      if (before.x === after.x && before.y === after.y) return;
      historyStore.execute(new MoveWaypointCommand(waypointId, before, after));
    },

    updateWaypointIconWithHistory(waypointId: string, before: string, after: string): void {
      if (before === after) return;
      historyStore.execute(new UpdateWaypointIconCommand(waypointId, before, after));
    },

    toggleWaypointLockWithHistory(waypointId: string): void {
      historyStore.execute(new ToggleWaypointLockCommand(waypointId));
    },

    /**
     * Merges a partial settings patch into the active board's settings via an
     * undoable command. The caller supplies both `patch` and `previous` (a
     * snapshot of the active settings object); we compute the inverse and
     * the "delete on undo" set so undo cleanly restores the prior shape.
     *
     * `previousSettings` is typed as a readonly record because each board
     * type has its own concrete settings schema — the helper only reads keys,
     * never writes, so the wider type accepts any of them.
     */
    updateBoardSettingsWithHistory(
      patch: Record<string, unknown>,
      previousSettings: Readonly<Record<string, unknown>> | null | undefined,
      description?: string,
    ): void {
      if (Object.keys(patch).length === 0) return;
      const prev = previousSettings ?? {};
      const inversePatch: Record<string, unknown> = {};
      const deleteOnUndo: string[] = [];
      for (const k of Object.keys(patch)) {
        if (k in prev) {
          // Deep-clone the inverse via JSON round-trip: `prev[k]` may be a
          // $state Proxy on a nested settings object, so a shallow copy would
          // let later mutations corrupt what undo restores. structuredClone
          // throws DataCloneError on $state Proxies.
          //
          // DECISION: the JSON round-trip drops nested `undefined` values.
          // Accepted: undo replaces the whole top-level key and every reader
          // treats a missing key the same as `undefined`.
          const v = prev[k];
          inversePatch[k] = (v !== null && typeof v === 'object')
            ? JSON.parse(JSON.stringify(v))
            : v;
        } else {
          deleteOnUndo.push(k);
        }
      }
      historyStore.execute(
        new UpdateBoardSettingsCommand(patch, inversePatch, deleteOnUndo, description),
      );
    },
  };
}
