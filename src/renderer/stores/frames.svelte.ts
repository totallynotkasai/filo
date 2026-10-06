/**
 * Frames store — UI-specific frame state (containment detection).
 * Complements boardStore's frame CRUD.
 */

import { SvelteSet } from 'svelte/reactivity';
import { boardStore } from './board.svelte';

export const framesStore = {
  /** IDs of all tiles currently sitting inside a collapsed frame. */
  get hiddenTileIds(): Set<string> {
    const hidden = new SvelteSet<string>();
    for (const f of boardStore.frames) {
      if (!f.collapsed) continue;
      for (const id of f.tileIds) hidden.add(id);
    }
    return hidden;
  },

  /**
   * Detects which tiles are contained within a frame's bounds.
   * Updates the frame's tileIds accordingly.
   */
  updateContainment(frameId: string) {
    const frame = boardStore.frames.find((f) => f.id === frameId);
    if (!frame) return;

    const fx = frame.position.x;
    const fy = frame.position.y;
    const fw = frame.size.width;
    const fh = frame.size.height;

    const containedIds: string[] = [];
    for (const tile of Object.values(boardStore.tiles)) {
      const tx = tile.position.x;
      const ty = tile.position.y;
      const tw = tile.size.width;
      const th = tile.size.height;

      // Tile center must be inside the frame
      const cx = tx + tw / 2;
      const cy = ty + th / 2;
      if (cx >= fx && cx <= fx + fw && cy >= fy && cy <= fy + fh) {
        containedIds.push(tile.id);
      }
    }

    boardStore.updateFrame(frameId, { tileIds: containedIds });
  },

  /**
   * Moves the given tiles by the given delta (a frame drag's tiles: those of
   * the frame and of the frames nested in it). A locked tile stays put.
   */
  moveTiles(tileIds: readonly string[], dx: number, dy: number) {
    for (const tileId of tileIds) {
      const tile = boardStore.getTile(tileId);
      if (tile && !tile.locked) {
        boardStore.updateTile(tileId, {
          position: {
            x: tile.position.x + dx,
            y: tile.position.y + dy,
          },
        });
      }
    }
  },

  /**
   * After frames and tiles moved together (a frame drag, its undo or redo):
   * each moved frame takes the tiles now inside it, and each moved tile
   * leaves the frames it left and joins those it landed in, wherever they are.
   */
  refreshMembership(frameIds: readonly string[], tileIds: readonly string[]) {
    for (const frameId of frameIds) framesStore.updateContainment(frameId);
    for (const tileId of tileIds) framesStore.syncTileMembership(tileId);
  },

  /**
   * Recomputes frame membership for a single tile. Adds it to every frame
   * whose bounds contain the tile's centre (a frame and the frames nested in
   * it alike), and removes it from any frame that no longer contains it.
   */
  syncTileMembership(tileId: string) {
    const tile = boardStore.getTile(tileId);
    if (!tile) return;
    const cx = tile.position.x + tile.size.width / 2;
    const cy = tile.position.y + tile.size.height / 2;

    for (const frame of boardStore.frames) {
      const inside =
        cx >= frame.position.x &&
        cx <= frame.position.x + frame.size.width &&
        cy >= frame.position.y &&
        cy <= frame.position.y + frame.size.height;
      const listed = frame.tileIds.includes(tileId);
      if (inside && !listed) {
        boardStore.updateFrame(frame.id, { tileIds: [...frame.tileIds, tileId] });
      } else if (!inside && listed) {
        boardStore.updateFrame(frame.id, { tileIds: frame.tileIds.filter((id) => id !== tileId) });
      }
    }
  },
};
