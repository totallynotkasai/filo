/**
 * boardMoveHold — boards whose `.board.json` is being moved by an in-app
 * rename (its own file, or a folder it is in) while the move runs.
 *
 * Until the move is done the board's path in memory is its old one, and the
 * file may be at either place. A write in that window could recreate the old
 * file after the move, or land in a folder the move then finds taken. So the
 * write waits: an armed write is re-armed when it comes due (the scheduler's
 * `deferFire`), and one forced out by a save meanwhile (Ctrl+S, quit) is
 * refused with `BoardMoveHeldError`, which the scheduler keeps for a retry.
 * The rename re-arms every held board once the move settled, at the path it
 * ended at.
 *
 * Keyed by board id, so the hold doesn't care which spelling of the path a
 * write carries.
 */
import { registerResetCallback, registerTestResetCallback } from './writeStateTracking';

// allow-module-state: reset via registerResetCallback (vault swap)
const held = new Map<string, number>();

/** Holds the writes of `boardIds` until the returned release is called (once). */
export function holdBoardMoves(boardIds: readonly string[]): () => void {
  for (const id of boardIds) held.set(id, (held.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of boardIds) {
      const depth = (held.get(id) ?? 0) - 1;
      if (depth > 0) held.set(id, depth);
      else held.delete(id);
    }
  };
}

/** True while an in-app rename is moving the board's file. */
export function isBoardMoveHeld(boardId: string): boolean {
  return held.has(boardId);
}

/** Refused because the board's file is being moved; kept and written once the move is done. */
export class BoardMoveHeldError extends Error {
  readonly code = 'BOARD_MOVE_HELD';
  constructor(boardPath: string) {
    super(`Board "${boardPath}" is being moved; its write waits until the move is done.`);
    this.name = 'BoardMoveHeldError';
  }
}

registerResetCallback(() => held.clear());
registerTestResetCallback(() => held.clear());
