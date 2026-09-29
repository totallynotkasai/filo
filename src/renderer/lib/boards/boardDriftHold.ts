/**
 * boardDriftHold — boards whose write waits for a Reload / Keep local answer.
 *
 * A board file changed outside Filo while Filo has unsaved changes to it is a
 * question only the user can answer. While it is open, no retry can save the
 * board, so the board writer refuses at once (no stat, no prompt awaited)
 * instead of re-firing into the same question on every save: a quit, a Ctrl+S
 * or a Retry then reaches its answer in moments, and raises no "couldn't
 * save" toast on top of the question.
 *
 * A hold follows renames and is released by Reload, Keep local, or the board
 * leaving the cache (closed as missing, deleted). Dismissing the question
 * keeps it: the save indicator lists it until it is answered.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { registerPathRenamable, rebasePath } from '../vault/renamePathKeys';
import { registerResetCallback, registerTestResetCallback } from './writeStateTracking';

export interface BoardDriftHold {
  /** Stable for the hold's life, across renames. */
  readonly id: number;
  /** The board file, in its latest spelling. */
  path: string;
}

// allow-module-state: reset via registerResetCallback (vault swap)
const holds = new Map<VaultPath, BoardDriftHold>();
let nextId = 1;
let releasedListener: ((hold: BoardDriftHold) => void) | null = null;

/** Told when a hold is released, so the held decision it registered goes too. */
export function setBoardDriftReleasedListener(listener: ((hold: BoardDriftHold) => void) | null): void {
  releasedListener = listener;
}

/** Holds `path`'s writes for a drift answer; returns the hold (the existing one if already held). */
export function holdBoardDrift(path: string): BoardDriftHold {
  const key = vaultPath(path);
  const existing = holds.get(key);
  if (existing) return existing;
  const hold: BoardDriftHold = { id: nextId++, path };
  holds.set(key, hold);
  return hold;
}

/** The drift question for `path` was answered, or the board is gone. */
export function releaseBoardDrift(path: string): void {
  const key = vaultPath(path);
  const hold = holds.get(key);
  if (!hold) return;
  holds.delete(key);
  try {
    releasedListener?.(hold);
  } catch (err) {
    console.error('[boardDriftHold] release listener threw:', err);
  }
}

export function isBoardDriftHeld(path: string): boolean {
  return holds.has(vaultPath(path));
}

/** The hold for `path`, if any. */
export function boardDriftHold(path: string): BoardDriftHold | undefined {
  return holds.get(vaultPath(path));
}

/** Refused because the board's write waits for a Reload / Keep local answer. */
export class BoardDriftHeldError extends Error {
  readonly code = 'BOARD_DRIFT_HELD';
  constructor(boardPath: string) {
    super(`Board "${boardPath}" was changed outside Filo; its write waits for Reload or Keep local.`);
    this.name = 'BoardDriftHeldError';
  }
}

registerPathRenamable('boardDriftHold', (oldRel, newRel) => {
  for (const [key, hold] of [...holds]) {
    const next = rebasePath(hold.path, oldRel, newRel);
    if (next === null) continue;
    holds.delete(key);
    hold.path = next;
    holds.set(vaultPath(next), hold);
  }
});

registerResetCallback(() => holds.clear());
registerTestResetCallback(() => holds.clear());
