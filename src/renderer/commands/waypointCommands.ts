import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';

/**
 * Adds a waypoint to the active mind-map board.
 */
export class AddWaypointCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypoint: {
    id: string; name: string; x: number; y: number;
    zoom?: number; icon?: string; locked?: boolean;
  };

  constructor(
    waypoint: {
      id: string; name: string; x: number; y: number;
      zoom?: number; icon?: string; locked?: boolean;
    },
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // M24 — `this.snapshot(...)` deep-clones for consistency with other
    // Add*Commands. Waypoint is primitives-only today, but the pattern keeps
    // future nested-field additions safe by default.
    this.waypoint = this.snapshot(waypoint);
    this.description = `Add waypoint "${waypoint.name}"`;
  }

  execute() {
    boardStore.addWaypoint(this.snapshot(this.waypoint));
  }

  undo() {
    boardStore.removeWaypoint(this.waypoint.id);
  }
}

/**
 * Removes a waypoint. Snapshots the full waypoint so undo restores its name,
 * icon, position, zoom, and locked state exactly.
 */
export class RemoveWaypointCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypoint: {
    id: string; name: string; x: number; y: number;
    zoom?: number; icon?: string; locked?: boolean;
  };

  constructor(
    waypoint: {
      id: string; name: string; x: number; y: number;
      zoom?: number; icon?: string; locked?: boolean;
    },
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // M24 — `this.snapshot(...)` for consistency with other Add*Commands.
    this.waypoint = this.snapshot(waypoint);
    this.description = `Remove waypoint "${waypoint.name}"`;
  }

  execute() {
    boardStore.removeWaypoint(this.waypoint.id);
  }

  undo() {
    boardStore.addWaypoint(this.snapshot(this.waypoint));
  }
}

export class RenameWaypointCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypointId: string;
  private before: string;
  private after: string;

  constructor(waypointId: string, before: string, after: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.waypointId = waypointId;
    this.before = before;
    this.after = after;
    this.description = `Rename waypoint to "${after}"`;
  }

  execute() {
    boardStore.renameWaypoint(this.waypointId, this.after);
  }

  undo() {
    boardStore.renameWaypoint(this.waypointId, this.before);
  }
}

export class MoveWaypointCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypointId: string;
  private before: { x: number; y: number };
  private after: { x: number; y: number };

  constructor(
    waypointId: string,
    before: { x: number; y: number },
    after: { x: number; y: number },
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.waypointId = waypointId;
    // allow-shallow: {x, y} primitives only.
    this.before = { ...before };
    this.after = { ...after };
    this.description = 'Move waypoint';
  }

  execute() {
    boardStore.moveWaypoint(this.waypointId, this.after.x, this.after.y);
  }

  undo() {
    boardStore.moveWaypoint(this.waypointId, this.before.x, this.before.y);
  }
}

export class UpdateWaypointIconCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypointId: string;
  private before: string;
  private after: string;

  constructor(waypointId: string, before: string, after: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.waypointId = waypointId;
    this.before = before;
    this.after = after;
    this.description = 'Update waypoint icon';
  }

  execute() {
    boardStore.updateWaypointIcon(this.waypointId, this.after);
  }

  undo() {
    boardStore.updateWaypointIcon(this.waypointId, this.before);
  }
}

export class ToggleWaypointLockCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private waypointId: string;
  // Sprint B / B11 — snapshot the lock state at construction time so undo
  // restores the captured boolean rather than re-toggling. Without the
  // snapshot, any out-of-band mutation between execute and undo (sync
  // client edit, concurrent toggle from another window, etc.) would
  // desync — the second `toggleWaypointLock()` would flip from the new
  // state instead of returning to the original.
  private before: boolean;
  private after: boolean;

  constructor(waypointId: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.waypointId = waypointId;
    const wp = boardStore.waypoints.find((w) => w.id === waypointId);
    this.before = wp?.locked ?? false;
    this.after = !this.before;
    this.description = this.after ? 'Lock waypoint' : 'Unlock waypoint';
  }

  execute() {
    boardStore.setWaypointLock(this.waypointId, this.after);
  }

  undo() {
    boardStore.setWaypointLock(this.waypointId, this.before);
  }
}
