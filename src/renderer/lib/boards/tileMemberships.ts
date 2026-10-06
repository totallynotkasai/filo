/**
 * The frames and groups a Mind Map tile belongs to, kept across a delete.
 *
 * Deleting a tile takes it out of every frame's `tileIds` and every group
 * (`mindmapTileOps.removeTile`); a reference left behind would make the next
 * open report "orphan tile refs" and write a recovery snapshot for a routine
 * delete. Undo puts the tile back into the frames and groups it was in, from
 * a snapshot the delete command takes before it runs.
 */
import type { MindMapBoard, TileGroup } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';

export interface TileMemberships {
  boardId: string;
  /** The deleted tiles: the only ones undo puts into a frame or group. */
  tileIds: string[];
  /** frameId → the deleted tiles it held. */
  frames: Record<string, string[]>;
  /** Every group that held one of the tiles, as it was. */
  groups: TileGroup[];
}

/** What `tileIds` belong to on `boardId`, before they are deleted. */
export function captureTileMemberships(boardId: string, tileIds: readonly string[]): TileMemberships {
  const ids = new Set(tileIds);
  const cached = boardCacheStore.cache[boardId];
  const frames: Record<string, string[]> = {};
  for (const frame of cached?.frames ?? []) {
    const held = frame.tileIds.filter((id) => ids.has(id));
    if (held.length > 0) frames[frame.id] = held;
  }
  const groups: TileGroup[] = [];
  if (cached?.board.type === 'mindmap') {
    for (const group of (cached.board as MindMapBoard).groups ?? []) {
      if (group.tileIds.some((id) => ids.has(id))) groups.push({ ...group, tileIds: [...group.tileIds] });
    }
  }
  return { boardId, tileIds: [...ids], frames, groups };
}

/**
 * Puts the tiles back into their frames and groups, once the tiles themselves
 * are back. A tile that didn't come back is left out; a frame deleted since
 * stays deleted; a group that emptied out with the delete is recreated.
 */
export function restoreTileMemberships(m: TileMemberships): void {
  const cached = boardCacheStore.cache[m.boardId];
  if (!cached) return;
  const deleted = new Set(m.tileIds);
  // A note-backed tile is back once its def is; a link, embed or timer tile
  // once its inline tile is.
  const inline = cached.board.type === 'mindmap' ? (cached.board as MindMapBoard).inlineTiles ?? {} : {};
  const present = (id: string): boolean => deleted.has(id) && (id in cached.tileDefs || id in inline);
  for (const [frameId, held] of Object.entries(m.frames)) {
    const frame = cached.frames.find((f) => f.id === frameId);
    if (!frame) continue;
    const add = held.filter((id) => present(id) && !frame.tileIds.includes(id));
    if (add.length > 0) boardCacheStore.persistUpdateFrame(frameId, { ...frame, tileIds: [...frame.tileIds, ...add] });
  }
  if (m.groups.length === 0 || cached.board.type !== 'mindmap') return;
  const mm = cached.board as MindMapBoard;
  const groups = [...(mm.groups ?? [])];
  for (const snap of m.groups) {
    const idx = groups.findIndex((g) => g.id === snap.id);
    const existing = idx >= 0 ? groups[idx] : undefined;
    const current = existing?.tileIds ?? [];
    const tileIds = [...current, ...snap.tileIds.filter((id) => present(id) && !current.includes(id))];
    if (tileIds.length === 0) continue;
    if (existing) groups[idx] = { ...existing, tileIds };
    else groups.push({ ...snap, tileIds });
  }
  boardCacheStore.updateEntry(m.boardId, { board: { ...mm, groups } });
  boardCacheStore.markDirty(m.boardId);
}
