/**
 * True-cancel for a frame drag torn down mid-gesture.
 *
 * Frame.svelte's drag writes positions incrementally per RAF (`updateFrame`
 * + `moveContainedTiles`); only `handleDragEnd` records the MoveFrameCommand.
 * When the component unmounts mid-drag (frame deleted by an external reload,
 * board switch, pane close), keeping what had already been written would leave
 * a persisted frame+tile move with NO undo entry. This helper reverts the frame to its drag-start position and moves the
 * captured contained tiles back by the inverse delta, mirroring
 * `tileDrag.destroy()`'s cancel-not-commit ("a half-committed move would
 * corrupt undo").
 *
 * Deps are injected because the right write surface depends on teardown
 * timing: the pane's scope stores while the board is still active (keeps the
 * spatial index in sync), the board cache keyed by the drag-start home board
 * once the scope has already moved on (the very board switch that unmounted
 * the frame).
 */

import type { Tile } from '../../schema/index';

export interface FrameDragRevertArgs {
  frameId: string;
  /** Frame position captured at drag start. */
  startX: number;
  startY: number;
  /** Last position the drag's RAF wrote (the canonical "where we put it"). */
  lastX: number;
  lastY: number;
  /** Tile ids captured at drag start (the set the undo command would move). */
  containedTileIds: string[];
  /** The frames nested in it that moved with it, at their drag-start positions. */
  nestedFrames?: ReadonlyArray<{ id: string; startX: number; startY: number }>;
}

export interface FrameDragRevertDeps {
  updateFramePosition: (frameId: string, position: { x: number; y: number }) => void;
  getTile: (tileId: string) => Tile | undefined;
  moveTile: (tileId: string, position: { x: number; y: number }) => void;
}

export function revertFrameDragOnTeardown(
  args: FrameDragRevertArgs,
  deps: FrameDragRevertDeps,
): void {
  const dx = args.lastX - args.startX;
  const dy = args.lastY - args.startY;
  // Jitter / never-moved drag: nothing was written, nothing to revert.
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
  deps.updateFramePosition(args.frameId, { x: args.startX, y: args.startY });
  for (const nested of args.nestedFrames ?? []) {
    deps.updateFramePosition(nested.id, { x: nested.startX, y: nested.startY });
  }
  for (const tileId of args.containedTileIds) {
    const tile = deps.getTile(tileId);
    // Locked tiles never moved with the drag (`moveContainedTiles` skips
    // them) — shoving them by the inverse delta would corrupt their position.
    if (!tile || tile.locked) continue;
    deps.moveTile(tileId, {
      x: tile.position.x - dx,
      y: tile.position.y - dy,
    });
  }
}
