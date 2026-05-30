import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
import { tabStore } from '../../stores/tabs.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import {
  UpdateCardFieldCommand,
  UpdateCoverImageCommand,
  UpdateOrphanFrontmatterCommand,
} from '../../commands/index';
import { copyFileIntoVault } from '../vault/vaultOperations';

export type KanbanPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/**
 * Returns the vault-relative path for a text tile's backing `.md` file, or
 * `null` for non-text tiles. Resolves through `documentStore` when a
 * `contentId` is set so unsaved-title renames don't desync the lookup,
 * falling back to `${title}.md` when no document record exists yet.
 */
export function vaultPathForTile(tile: Tile): string | null {
  if (tile.type !== 'text') return null;
  const t = tile as Tile & { contentId?: string };
  if (t.contentId) {
    const doc = documentStore.getDocument(t.contentId);
    if (doc?.filename) return doc.filename;
  }
  return `${tile.title || 'Untitled'}.md`;
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
  updateTileFrontmatter(tileId: string, patch: Record<string, unknown>): void;
  setTileDueDate(tileId: string, dueDate: string): void;
  setTilePriority(tileId: string, priority: KanbanPriority): void;
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
    return vaultPathForTile(tile) ?? `${tile.title || 'Untitled'}.md`;
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

  function updateTileFrontmatter(tileId: string, patch: Record<string, unknown>): void {
    const board = getBoard();
    if (!board) return;
    const tile = getAllTilesById()[tileId];
    if (!tile) return;
    const path = vaultPathForTileSafe(tile);
    const docId = ensureSeededFm(tile);
    // Prefer the live documentStore cache when seeded so a rapid second mutation
    // captures the previous in-memory state, not the still-debounced disk snapshot.
    // Falls back to vaultIndexStore when no docId is set yet (rare, predates the cache).
    const liveFm = docId ? documentStore.getFrontmatter(docId) : null;
    const fmBefore = (liveFm
      ?? vaultIndexStore.getMetadata(path)?.frontmatter
      ?? {}) as Record<string, unknown>;
    const inverse: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      inverse[k] = k in fmBefore ? fmBefore[k] : '';
    }
    if (docId) {
      historyStore.execute(new UpdateCardFieldCommand(board.id, path, docId, patch, inverse));
    } else {
      // Phase 5 / 5.5 — orphan-fm path (tile has no contentId). The old
      // fallback called `scheduleSharedFrontmatterWrite(path, null)`,
      // which was a silent no-op: the scheduler reads frontmatter from
      // vaultIndexStore when docId is null, so the patch was never applied.
      // UpdateOrphanFrontmatterCommand writes directly via
      // vault:write-existing-file-text and supports undo.
      historyStore.execute(new UpdateOrphanFrontmatterCommand(board.id, path, patch, inverse));
    }
    bumpCacheVersion();
  }

  function setTileDueDate(tileId: string, dueDate: string): void {
    updateTileFrontmatter(tileId, { dueDate });
  }

  function setTilePriority(tileId: string, priority: KanbanPriority): void {
    updateTileFrontmatter(tileId, { priority: priority === 'none' ? '' : priority });
  }

  function openTileAsDocument(tileId: string): void {
    const tile = getAllTilesById()[tileId];
    if (!tile || tile.type !== 'text') return;
    const t = tile as Tile & { contentId?: string; content?: string };
    const docId = t.contentId || tile.id;
    const filename = vaultPathForTileSafe(tile);
    documentStore.loadDocument({
      docId,
      filename,
      title: tile.title || 'Untitled',
      body: '',
      htmlContent: t.content || '',
      richText: [],
    });
    documentStore.openDocumentTab(docId);
    tabStore.open(docId, tile.title || 'Document', 'document');
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
    // Phase R2 — drain pending writers before the copy so a debounced
    // card-cover update doesn't fire against a stale src before the new
    // image lands on disk.
    const res = await copyFileIntoVault(paths[0], vaultRoot);
    if (!res.success) {
      uiStore.toast(`Failed to import image: ${res.error ?? 'unknown error'}`, 'error', 3000);
      return;
    }
    const stored = res.relativePath ?? res.path ?? '';
    if (!stored) return;
    // Phase 5 / 5.4 — route through UpdateCoverImageCommand so Ctrl+Z
    // restores the prior cover (or no-cover state).
    const before = getCurrentCoverImage(board.id, tileId);
    historyStore.execute(new UpdateCoverImageCommand(board.id, tileId, before, stored));
    tickAndPersist();
  }

  function clearCoverImageForTile(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    // Phase 5 / 5.4 — same undoable wrapper as pick. No-op when nothing
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
