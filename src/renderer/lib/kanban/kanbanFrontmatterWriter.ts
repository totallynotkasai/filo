import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import {
  UpdateCardFieldCommand,
  UpdateCoverImageCommand,
  UpdateOrphanFrontmatterCommand,
} from '../../commands/index';
import { copyFileIntoVault } from '../vault/vaultOperations';
import { resolveTextTileVaultPath } from '../boards/textTilePath';
import { openNoteInDocumentTab } from '../notes/openNote';

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
  setTilePriority(tileId: string, priority: KanbanPriority): Promise<void>;
  openTileAsDocument(tileId: string): void;
  pickCoverImageForTile(tileId: string): Promise<void>;
  clearCoverImageForTile(tileId: string): void;
}

/**
 * Frontmatter writer for Kanban card mutations.
 *
 * Same pattern as TaskListBoard's per-row writer. Mutations land in
 * `documentStore.mergeFrontmatter` (shared live cache), then a 300ms
 * debounce assembles the `.md` and writes via `trackComponentWrite` so the
 * save-error pipeline catches failures.
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

  function ensureSeededFm(tile: Tile): string | null {
    const docId = (tile as Tile & { contentId?: string }).contentId ?? null;
    if (!docId) return null;
    if (!documentStore.getFrontmatter(docId)) {
      const path = vaultPathForTileSafe(tile);
      const fm = (vaultIndexStore.getMetadata(path)?.frontmatter ?? {}) as Record<string, unknown>;
      documentStore.setFrontmatter(docId, fm);
    }
    return docId;
  }

  async function updateTileFrontmatter(tileId: string, patch: Record<string, unknown>): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const tile = getAllTilesById()[tileId];
    if (!tile) return;
    const path = vaultPathForTileSafe(tile);
    const docId = (tile as Tile & { contentId?: string }).contentId ?? null;
    // Best-effort inverse from whatever's already in memory. The docId-backed
    // UpdateCardFieldCommand recomputes the inverse from a FRESH disk read on
    // execute (the disk pre-seed runs inside the command so the read joins the
    // history chain that save()/quit await); the orphan path uses this inverse
    // directly. Prefer the live cache (an open editor's in-memory state) over
    // the durably-stale vault index.
    const liveFm = docId ? documentStore.getFrontmatter(docId) : null;
    const fmBefore = (liveFm
      ?? vaultIndexStore.getMetadata(path)?.frontmatter
      ?? {}) as Record<string, unknown>;
    const inverse: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      inverse[k] = k in fmBefore ? fmBefore[k] : '';
    }
    const command = docId
      ? new UpdateCardFieldCommand(board.id, path, docId, patch, inverse)
      // Orphan-fm path (tile has no contentId). `scheduleSharedFrontmatterWrite(
      // path, null)` would be a silent no-op (the scheduler reads frontmatter
      // from vaultIndexStore when docId is null, so the patch never applies).
      // UpdateOrphanFrontmatterCommand writes directly via
      // vault:write-existing-file-text and supports undo.
      : new UpdateOrphanFrontmatterCommand(board.id, path, patch, inverse);
    // Await the chained command so this resolves only after the seed + merge +
    // schedule have run (callers and tests rely on the cache reflecting the
    // disk seed once this resolves). The history chain reports its own errors,
    // so swallow the rejection here to keep this fire-and-forget UI path quiet.
    await historyStore.execute(command).catch(() => {});
    bumpCacheVersion();
  }

  function setTileDueDate(tileId: string, dueDate: string): Promise<void> {
    return updateTileFrontmatter(tileId, { dueDate });
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
    // Drain pending writers before the copy so a debounced
    // card-cover update doesn't fire against a stale src before the new
    // image lands on disk.
    const src = paths[0];
    if (!src) return; // paths non-empty (checked above)
    const res = await copyFileIntoVault(src, vaultRoot);
    if (!res.success) {
      uiStore.toast(`Failed to import image: ${res.error ?? 'unknown error'}`, 'error', 3000);
      return;
    }
    const stored = res.relativePath ?? res.path ?? '';
    if (!stored) return;
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
    setTilePriority,
    openTileAsDocument,
    pickCoverImageForTile,
    clearCoverImageForTile,
  };
}
