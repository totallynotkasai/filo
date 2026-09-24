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
    // Deep-clone for consistency with other Add*Commands. Waypoint is
    // primitives-only today, but this keeps future nested fields safe.
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
    // Deep-clone for consistency with other Add*Commands.
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
  // Snapshot the lock state at construction so undo restores the captured
  // boolean rather than re-toggling — a re-toggle would desync after any
  // out-of-band change between execute and undo.
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
