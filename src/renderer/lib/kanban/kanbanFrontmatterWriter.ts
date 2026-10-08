import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { noteFrontmatter } from '../../stores/noteMeta';
import { vaultStore } from '../../stores/vault.svelte';
import {
  UpdateCardFieldCommand,
  UpdateCoverImageCommand,
} from '../../commands/index';
import { bringPickedFileIn } from '../vault/pickedFile';
import { getActiveContentFolder } from '../vault/conventionPaths';
import { resolveTextTileVaultPath } from '../boards/textTilePath';
import { openNoteInDocumentTab } from '../notes/openNote';
import { FIELD_READERS } from '../tasks/frontmatterReaders';

export type KanbanPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/** The note path of a text card, or `null` for non-text cards. */
export function vaultPathForTile(tile: Tile): string | null {
  return resolveTextTileVaultPath(tile);
}

export interface KanbanFrontmatterWriterDeps {
  getBoard: () => KanbanBoardType | null;
  getAllTilesById: () => Record<string, Tile>;
  bumpCacheVersion: () => void;
  tickAndPersist: () => void;
}

export interface KanbanFrontmatterWriter {
  vaultPathForTile(tile: Tile): string | null;
  vaultPathForTileSafe(tile: Tile): string;
  ensureSeededFm(tile: Tile): string | null;
  updateTileFrontmatter(tileId: string, patch: Record<string, unknown>): Promise<void>;
  setTileDueDate(tileId: string, dueDate: string): Promise<void>;
  setTileDueTime(tileId: string, dueTime: string): Promise<void>;
  setTilePriority(tileId: string, priority: KanbanPriority): Promise<void>;
  openTileAsDocument(tileId: string): void;
  pickCoverImageForTile(tileId: string): Promise<void>;
  clearCoverImageForTile(tileId: string): void;
}

/**
 * Frontmatter writer for Kanban card mutations.
 *
 * Same pattern as TaskListBoard's per-row writer: each edit is an undoable
 * `UpdateCardFieldCommand`, which sends it to the note writer as a
 * frontmatter delta.
 *
 * Factory closes over `getBoard` / `getAllTilesById` accessors so the
 * writer always sees the live reactive board state from the calling
 * component without capturing a stale snapshot.
 */
export function makeKanbanFrontmatterWriter(
  deps: KanbanFrontmatterWriterDeps,
): KanbanFrontmatterWriter {
  const { getBoard, getAllTilesById, bumpCacheVersion, tickAndPersist } = deps;

  function vaultPathForTileSafe(tile: Tile): string {
    return resolveTextTileVaultPath(tile) ?? '';
  }

  /** The card's note path (the note store answers its frontmatter directly). */
  function ensureSeededFm(tile: Tile): string | null {
    return resolveTextTileVaultPath(tile);
  }

  async function updateTileFrontmatter(tileId: string, patch: Record<string, unknown>): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const tile = getAllTilesById()[tileId];
    if (!tile) return;
    // Only a text card has a note to hold fields.
    const path = resolveTextTileVaultPath(tile);
    if (!path) return;
    // Best-effort inverse from what's shown; the command recomputes it from
    // the note as it stands on execute.
    const fmBefore = noteFrontmatter(path);
    const inverse: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      inverse[k] = k in fmBefore ? fmBefore[k] : '';
    }
    const command = new UpdateCardFieldCommand(board.id, path, patch, inverse);
    // Await the chained command so this resolves once the change is queued
    // and shows on the card. The history chain reports its own errors, so
    // swallow the rejection here to keep this fire-and-forget UI path quiet.
    await historyStore.execute(command).catch(() => {});
    bumpCacheVersion();
  }

  function setTileDueDate(tileId: string, dueDate: string): Promise<void> {
    // Clearing the date clears its time too, in one undo step, as on a task:
    // a time with no date shows nowhere.
    const tile = getAllTilesById()[tileId];
    const path = tile ? resolveTextTileVaultPath(tile) : null;
    if (!dueDate && path && FIELD_READERS.dueTime(noteFrontmatter(path))) return updateTileFrontmatter(tileId, { dueDate: '', dueTime: '' });
    return updateTileFrontmatter(tileId, { dueDate });
  }

  function setTileDueTime(tileId: string, dueTime: string): Promise<void> {
    return updateTileFrontmatter(tileId, { dueTime });
  }

  function setTilePriority(tileId: string, priority: KanbanPriority): Promise<void> {
    return updateTileFrontmatter(tileId, { priority: priority === 'none' ? '' : priority });
  }

  function openTileAsDocument(tileId: string): void {
    const tile = getAllTilesById()[tileId];
    if (!tile || tile.type !== 'text') return;
    openNoteInDocumentTab(vaultPathForTileSafe(tile));
  }

  /**
   * Reads the current coverImage from the cache. The placement lives inside
   * the column array, so a scan-by-tileId is the simplest reliable lookup.
   * Returns `null` when not set (matches the cache mutator's contract).
   */
  function getCurrentCoverImage(boardId: string, tileId: string): string | null {
    const cached = boardCacheStore.cache[boardId];
    if (!cached || cached.board.type !== 'kanban') return null;
    const kb = cached.board as KanbanBoardType;
    for (const col of kb.columns ?? []) {
      const p = (col.tilePlacements ?? []).find((pl) => pl.tileId === tileId);
      if (p) return (p as { coverImage?: string | null }).coverImage ?? null;
    }
    return null;
  }

  async function pickCoverImageForTile(tileId: string): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) {
      uiStore.toast('Open a vault first to add a cover image', 'info', 2000);
      return;
    }
    const paths = await window.filo.invoke('dialog:open-file', {
      title: 'Choose Cover Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    if (!paths || paths.length === 0) return;
    const src = paths[0];
    if (!src) return; // paths non-empty (checked above)
    // An image already in the vault is linked; one from outside is copied in
    // (after pending writes land, so none fires against a stale cover).
    const res = await bringPickedFileIn(src, vaultRoot, getActiveContentFolder(board));
    if (!res.success) {
      uiStore.toast(`Failed to import image: ${res.error}`, 'error', 3000);
      return;
    }
    const stored = res.relPath;
    // Route through UpdateCoverImageCommand so Ctrl+Z
    // restores the prior cover (or no-cover state).
    const before = getCurrentCoverImage(board.id, tileId);
    historyStore.execute(new UpdateCoverImageCommand(board.id, tileId, before, stored));
    tickAndPersist();
  }

  function clearCoverImageForTile(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    // Same undoable wrapper as pick. No-op when nothing
    // was set in the first place so we don't push an empty history entry.
    const before = getCurrentCoverImage(board.id, tileId);
    if (before === null) return;
    historyStore.execute(new UpdateCoverImageCommand(board.id, tileId, before, null));
    tickAndPersist();
  }

  return {
    vaultPathForTile,
    vaultPathForTileSafe,
    ensureSeededFm,
    updateTileFrontmatter,
    setTileDueDate,
    setTileDueTime,
    setTilePriority,
    openTileAsDocument,
    pickCoverImageForTile,
    clearCoverImageForTile,
  };
}
