import type { Connection, Frame, Tile, TileGroup } from '../schema/index';
import { historyStore, type Command } from './history.svelte';
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
  BatchCommand,
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
     * Adds tiles AND connections in a single atomic undo step. Used by
     * Layout Template insertion so a template with edges between its tiles
     * is reverted in one Ctrl+Z. When `connections` is empty this is
     * equivalent to `addTilesWithHistory`.
     */
    addTilesAndConnectionsWithHistory(
      tiles: Tile[],
      connections: Connection[],
      description: string,
    ): void {
      if (tiles.length === 0 && connections.length === 0) return;
      const commands: Command[] = [];
      if (tiles.length > 0) commands.push(new AddTilesCommand(tiles, description));
      for (const conn of connections) commands.push(new AddConnectionCommand(conn));
      if (commands.length === 1) {
        historyStore.execute(commands[0]);
        return;
      }
      historyStore.execute(new BatchCommand(description, commands));
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
          // Phase 6 / 6.3 — deep-clone the inverse value via JSON
          // round-trip. `prev[k]` may be a Svelte 5 $state Proxy on a
          // nested settings object (e.g. defaults.tile.text); a shallow
          // assignment leaves the inverse referencing the live store,
          // so any mutation between execute and undo silently corrupts
          // what undo would restore. structuredClone throws
          // DataCloneError on $state Proxies — JSON is the documented
          // safe pattern (see [[feedback-no-structuredclone-on-state-proxies]]).
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
