/**
 * Lock / Unlock for a set of tiles, shared by Ctrl+L and the Mind Map's tile
 * and canvas context menus so all three follow one rule: if any tile is
 * unlocked, lock them all; otherwise unlock them all. Every tile's previous
 * state is recorded so one undo restores a mixed selection exactly.
 */
import type { Tile } from '../../schema/index';
import { uiStore } from '../../stores/ui.svelte';

export interface LockableBoard {
  getTile(id: string): Tile | undefined;
  setTilesLockedWithHistory(previousStates: Map<string, boolean>, nextLocked: boolean): void;
}

/**
 * Locks or unlocks `ids` in one undoable step and shows a short toast.
 * Returns the new locked state, or `null` when none of the ids is a tile.
 */
export function toggleLockSelection(board: LockableBoard, ids: Iterable<string>): boolean | null {
  const tiles: Tile[] = [];
  for (const id of ids) {
    const tile = board.getTile(id);
    if (tile) tiles.push(tile);
  }
  if (tiles.length === 0) return null;
  const nextLocked = tiles.some((t) => !t.locked);
  const previousStates = new Map<string, boolean>(tiles.map((t) => [t.id, t.locked === true]));
  board.setTilesLockedWithHistory(previousStates, nextLocked);
  const noun = tiles.length === 1 ? 'Tile' : 'Tiles';
  uiStore.toast(nextLocked ? `${noun} locked` : `${noun} unlocked`, 'info', 1500);
  return nextLocked;
}
