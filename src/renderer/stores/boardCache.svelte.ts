import type {
  Board,
  MindMapBoard,
  KanbanBoard,
  TaskListBoard,
  TileDefinition,
  Connection,
  Frame,
} from '../schema/index';
import { documentStore } from './document.svelte';
import { vaultStore } from './vault.svelte';
import { promptExternalEditOnSync } from './vaultExternalChanges';
import { parseMarkdownFile } from '../lib/editor/markdownSync';
import {
  writeMarkdownFile,
  markHydrated,
  isHydrated,
} from '../lib/vault/markdownFileWriter';
import {
  type V7BoardFileData,
  scheduleBoardWrite,
  cancelBoardWrite,
  flushBoardWrite,
  getViewportFromCache,
  setViewport,
  removeViewport,
} from '../lib/boards/boardSaver';
import { flushAllScheduledBoards } from '../lib/boards/boardWriteScheduler';
import { loadBoard } from '../lib/boards/boardLoader';
import { fileNameSafe } from '../lib/vault/conventionPaths';
import { reportError } from '../lib/utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../lib/utils/invokeOk';
import { normalizePath, toPosix } from '../lib/utils/path';
import { createId } from '../lib/utils/ids';
import { uiStore } from './ui.svelte';
import type { CacheContext } from './boardCacheTypes';
import { makeConnectionsFramesSlice } from './boardCacheConnectionsFrames';
import { makeTaskListSlice } from './boardCacheTaskList';
import { makeKanbanSlice } from './boardCacheKanban';
import { makeTilesSlice } from './boardCacheTiles';
import { makeFrontmatterSlice } from './boardCacheFrontmatter';
import { onVaultSwap } from '../core/vaultLifecycle';
import { boardDefaults } from '../core/boardDefaults';

/**
 * Board cache store — owns the per-board on-disk snapshot used to schedule
 * debounced writes back to `.board.json`. Operates only on cache state and
 * the virtual Project's connections/frames; never touches the active-board
 * runtime state (that lives in `board.svelte.ts`).
 */

let boardCache = $state<Record<string, V7BoardFileData>>({});
let boardPaths = $state<Record<string, string>>({});

/**
 * Counter + one-shot toast guard for "couldn't resolve owning board"
 * warnings inside the persist* methods. Without a user-visible surface
 * an off-board tile/connection/frame can silently fail to persist its
 * edit — the original symptom of an unresolvable boardId is the kind of
 * thing the audit flagged as a hidden data-loss path.
 *
 * We coalesce: the FIRST unresolved warn in a session surfaces a single
 * low-severity toast; subsequent warns increment the counter (visible in
 * console) but don't keep popping toasts. Reset via
 * `resetUnresolvedWarnState` on vault close.
 */
let unresolvedWarnCount = 0;
let unresolvedToastShown = false;

/**
 * Builds the `{ activeRootFolder, boardDefaultFolders }` option bag that the
 * cascade-aware fileRefIntegrity helpers expect. Sourced fresh on every call
 * so the latest pin state on every cached board is reflected — pinning state
 * changes during a rename/delete are rare but cheap to handle this way.
 */
function collectFolderPinOptions(): {
  activeRootFolder: string;
  boardDefaultFolders: Record<string, string | undefined>;
} {
  const boardDefaultFolders: Record<string, string | undefined> = {};
  for (const [boardId, data] of Object.entries(boardCache)) {
    const pin = (data.board as { settings?: { defaultFolder?: string } })
      .settings?.defaultFolder;
    if (typeof pin === 'string' && pin.length > 0) {
      boardDefaultFolders[boardId] = pin;
    }
  }
  return {
    activeRootFolder: vaultStore.activeRootFolder,
    boardDefaultFolders,
  };
}

function warnUnresolved(kind: string, id: string): void {
  unresolvedWarnCount++;
  console.warn(
    `[boardCache] ${kind}: cannot resolve boardId for ${id}; not persisted (#${unresolvedWarnCount} this session)`,
  );
  if (unresolvedToastShown) return;
  unresolvedToastShown = true;
  uiStore.pushToast({
    text:
      "A change couldn't be saved because its target board couldn't be resolved. " +
      'Switch to the relevant board and re-apply the change. (See console for details.)',
    type: 'warning',
    duration: 6000,
  });
}

function resetUnresolvedWarnState(): void {
  unresolvedWarnCount = 0;
  unresolvedToastShown = false;
}

function getBoardWriteArgs(
  boardId: string,
): { vaultRoot: string; boardPath: string; cached: V7BoardFileData } | null {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return null;
  const boardPath = boardPaths[boardId];
  const cached = boardCache[boardId];
  if (!boardPath || !cached) return null;
  return { vaultRoot, boardPath, cached };
}

/**
 * Phase 7.5 — reverse-index memos (id → owning boardId) for the keyless
 * persist paths. A tile / connection / frame / kanban column is created on
 * exactly one board and never re-parented (V7 invariant), so a successful
 * scan result stays valid for the entity's life. `resolveOwnerCached` caches
 * scan hits and verifies-on-hit (O(1)) before trusting the memo — on a miss
 * OR a stale hit it falls back to a full scan — so the memo can NEVER return
 * a wrong board; it only turns the repeated O(boards×entities) scans on every
 * keyless persist into O(1) after the first lookup. Cleared on vault close.
 */
const tileBoardMemo = new Map<string, string>();
const connectionBoardMemo = new Map<string, string>();
const frameBoardMemo = new Map<string, string>();
const kanbanColumnBoardMemo = new Map<string, string>();

function resetBoardOwnerMemos(): void {
  tileBoardMemo.clear();
  connectionBoardMemo.clear();
  frameBoardMemo.clear();
  kanbanColumnBoardMemo.clear();
}

function resolveOwnerCached(
  memo: Map<string, string>,
  id: string,
  owns: (data: V7BoardFileData) => boolean,
): string | null {
  const cached = memo.get(id);
  if (cached !== undefined) {
    const data = boardCache[cached];
    if (data && owns(data)) return cached;
    memo.delete(id); // stale — fall through to a fresh scan
  }
  for (const [boardId, data] of Object.entries(boardCache)) {
    if (owns(data)) {
      memo.set(id, boardId);
      return boardId;
    }
  }
  return null;
}

/**
 * Resolves a tile's owning board ID.
 *
 * V7 invariant: a `tile.id` is unique across all boards. When the same `.md`
 * file appears on multiple boards each placement creates a fresh tile def
 * with its own `tile.id`; cross-board sharing is via `contentId` (which
 * points at a shared `DocumentState`), never via a shared `tile.id`.
 * Returning the first hit is therefore correct and unambiguous.
 */
function findBoardIdForTile(tileId: string): string | null {
  return resolveOwnerCached(tileBoardMemo, tileId, (data) => {
    const b = data.board;
    if (b.type === 'mindmap') {
      const mm = b as MindMapBoard;
      return Boolean((mm.placements ?? {})[tileId] || (mm.inlineTiles ?? {})[tileId]);
    }
    // V7: non-mind-map boards no longer have placements/inlineTiles. Tile
    // identity is the tileDefs key; whichever board owns the def owns the tile.
    return Boolean((data.tileDefs ?? {})[tileId]);
  });
}

/**
 * Resolves a connection's owning board ID by scanning the cache.
 *
 * Used as a fallback when the connection object's `boardId` field is empty
 * (legacy data, or a connection created while no board was active). Tile
 * persistence already uses the same scan pattern — extending it to
 * connections eliminates the silent no-op when `conn.boardId === ''`.
 */
function findBoardIdForConnection(connId: string): string | null {
  return resolveOwnerCached(connectionBoardMemo, connId, (data) =>
    Boolean((data.connections ?? {})[connId]),
  );
}

/**
 * Resolves a frame's owning board ID by scanning the cache.
 *
 * Replaces the previous `vaultStore.project.frames.find(...)` lookup which
 * depended on the project store being in sync with the board cache. The
 * cache is the authoritative source for "which board owns this frame".
 */
function findBoardIdForFrame(frameId: string): string | null {
  return resolveOwnerCached(frameBoardMemo, frameId, (data) =>
    (data.frames ?? []).some((f) => f.id === frameId),
  );
}

function kanbanBoard(boardId: string): KanbanBoard | null {
  const cached = boardCache[boardId];
  if (!cached || cached.board.type !== 'kanban') return null;
  return cached.board as KanbanBoard;
}

/**
 * Cache-scan fallback: locates the Kanban board that owns a given column id.
 * Mirrors `findBoardIdForTile` for the column-only persistence path
 * (`persistAddKanbanPlacement` accepts a columnId without a boardId in the
 * rare race where the active board is null when the mutation lands).
 */
function findBoardIdForKanbanColumn(columnId: string): string | null {
  return resolveOwnerCached(kanbanColumnBoardMemo, columnId, (data) => {
    if (data.board.type !== 'kanban') return false;
    const kb = data.board as KanbanBoard;
    return (kb.columns ?? []).some((c) => c.id === columnId);
  });
}

/**
 * Resolves a Kanban board for a given boardId, surfacing a console warn +
 * one-shot toast on failure rather than silently dropping the mutation.
 * Matches the `warnUnresolved` pattern used by `persistAddTile` / frame /
 * connection paths so race-class drops are no longer invisible.
 */
function kanbanBoardOrWarn(boardId: string, method: string): KanbanBoard | null {
  const kb = kanbanBoard(boardId);
  if (kb) return kb;
  warnUnresolved(`kanban:${method}`, boardId || '<empty>');
  return null;
}

function tasklistBoard(boardId: string): TaskListBoard | null {
  const cached = boardCache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return null;
  return cached.board as TaskListBoard;
}

/**
 * Cache-scan fallback: locates the Task List board that owns a given task
 * placement by tileId. Mirrors `findBoardIdForKanbanColumn` so the same
 * race-class drops (empty/wrong boardId from drag-drop or template insertion
 * mid-tab-switch) self-heal rather than silently no-op.
 */
function findBoardIdForTask(tileId: string): string | null {
  for (const [id, data] of Object.entries(boardCache)) {
    if (data.board.type !== 'tasklist') continue;
    const tl = data.board as TaskListBoard;
    if ((tl.tasks ?? []).some((p) => p.tileId === tileId)) return id;
  }
  return null;
}

/**
 * Resolves a Task List board for a given boardId, surfacing a console warn +
 * one-shot toast on failure rather than silently dropping the mutation.
 * Mirrors `kanbanBoardOrWarn` — used by every TaskList mutator so race-class
 * drops are no longer invisible.
 */
function tasklistBoardOrWarn(boardId: string, method: string): TaskListBoard | null {
  const tl = tasklistBoard(boardId);
  if (tl) return tl;
  warnUnresolved(`tasklist:${method}`, boardId || '<empty>');
  return null;
}

function updateProjectConnectionsFrames(
  mutator: (project: { connections: Record<string, Connection>; frames: Frame[] }) => void,
) {
  const project = vaultStore.getProject();
  if (!project) return;
  mutator({ connections: project.connections, frames: project.frames });
}

function markDirty(boardId: string): void {
  scheduleBoardWrite(boardId, () => getBoardWriteArgs(boardId));
}

function touchBoard(boardId: string): void {
  const cached = boardCache[boardId];
  if (!cached) return;
  boardCache = { ...boardCache, [boardId]: cached };
  markDirty(boardId);
}

function updateEntry(boardId: string, updates: Partial<V7BoardFileData>): void {
  const existing = boardCache[boardId];
  if (!existing) return;
  boardCache = { ...boardCache, [boardId]: { ...existing, ...updates } };
}

const cacheCtx: CacheContext = {
  getCache: () => boardCache,
  setCache: (next) => { boardCache = next; },
  markDirty,
  touchBoard,
  updateEntry,
  findBoardIdForTile,
  findBoardIdForConnection,
  findBoardIdForFrame,
  findBoardIdForKanbanColumn,
  findBoardIdForTask,
  warnUnresolved,
  kanbanBoardOrWarn,
  tasklistBoardOrWarn,
  updateProjectConnectionsFrames,
  collectFolderPinOptions,
};

const connectionsFramesSlice = makeConnectionsFramesSlice(cacheCtx);
const taskListSlice = makeTaskListSlice(cacheCtx);
const kanbanSlice = makeKanbanSlice(cacheCtx);
const tilesSlice = makeTilesSlice(cacheCtx);
const frontmatterSlice = makeFrontmatterSlice(cacheCtx);

export const boardCacheStore = {
  // ── Cache getters ──
  get cache() { return boardCache; },
  get paths() { return boardPaths; },

  /** Flattened view of every tile definition across every loaded board. */
  get allTileDefs(): Record<string, TileDefinition> {
    const all: Record<string, TileDefinition> = {};
    for (const data of Object.values(boardCache)) {
      Object.assign(all, data.tileDefs ?? {});
    }
    return all;
  },

  // ── Cache lifecycle ──

  /** Seeds the cache from a freshly-opened vault. */
  hydrate(cache: Record<string, V7BoardFileData>, paths: Record<string, string>) {
    boardCache = cache;
    boardPaths = paths;
  },

  /**
   * Rewrites the vault-relative path stored for one or more boards when a
   * `.board.json` file (or its parent folder) moves on disk. Walks
   * `boardPaths` looking for entries whose path exactly equals `oldPath`
   * (single-file rename) OR whose path is rooted under `oldPath + '/'`
   * (folder rename — every descendant `.board.json` follows).
   *
   * Phase 31 A3.1 — without this, a `.board.json` rename leaves the cache
   * still keyed against the old path: the next debounced write fires
   * against the stale path (recreating a phantom file) AND the vault
   * tree reconciliation in `listenForChanges` flags the board as
   * "missing on disk" and calls `cleanupMissingBoard`, dropping it from
   * the project. Update before the cascade so propagateRename + tree
   * reconcile both see the truth.
   *
   * Returns the list of board IDs whose path changed so callers can
   * trigger any post-rename housekeeping (e.g. mark dirty so the
   * relocated `.board.json` rewrites under its new name).
   */
  renameBoardPath(oldPath: string, newPath: string): string[] {
    if (!oldPath || !newPath || oldPath === newPath) return [];
    const normalisedOld = normalizePath(oldPath);
    const normalisedNew = normalizePath(newPath);
    const oldPrefix = `${normalisedOld}/`;
    const updates: Record<string, string> = {};
    const changedIds: string[] = [];
    for (const [boardId, relPath] of Object.entries(boardPaths)) {
      const norm = toPosix(relPath);
      if (norm === normalisedOld) {
        updates[boardId] = normalisedNew;
        changedIds.push(boardId);
      } else if (norm.startsWith(oldPrefix)) {
        updates[boardId] = normalisedNew + '/' + norm.slice(oldPrefix.length);
        changedIds.push(boardId);
      }
    }
    if (changedIds.length === 0) return [];
    boardPaths = { ...boardPaths, ...updates };
    return changedIds;
  },

  /** Drops all cache entries (e.g. when closing a vault). */
  clear() {
    boardCache = {};
    boardPaths = {};
    resetBoardOwnerMemos();
    resetUnresolvedWarnState();
  },

  /**
   * Replaces the entire cache with the given snapshot. Phase 22 M10 — used
   * by vaultFolderOps.rename to roll back a half-mutated cache after the
   * `vault:rename` IPC fails. Does NOT touch `boardPaths` (paths are stable
   * across the rename — the IPC determines whether anything moved). Does NOT
   * mark dirty / schedule writes — the caller is responsible for cancelling
   * any debounced writes that captured the renamed snapshot under Phase 22
   * M6 scheduling.
   */
  replaceCache(snapshot: Record<string, V7BoardFileData>): void {
    boardCache = snapshot;
  },

  /**
   * Replaces the `boardPaths` map with a captured snapshot. Mirrors
   * `replaceCache` for the path map. Phase 31 A3.1 — paired with
   * `renameBoardPath` so the rename revert path can roll back the path
   * rebind without restoring the entire cache.
   */
  replacePaths(snapshot: Record<string, string>): void {
    boardPaths = snapshot;
  },

  /** Replaces the cache entry for a specific board with a partial update. */
  updateEntry,

  /** Schedules a debounced write for the given board's .board.json file. */
  markDirty,

  /**
   * Forces any pending debounced write for the given board to commit
   * to disk immediately. Used on tab close so a queued write can't
   * fire after the cache entry has changed or under stale state.
   */
  async flushDirty(boardId: string): Promise<{ ok: boolean }> {
    return flushBoardWrite(boardId, () => getBoardWriteArgs(boardId));
  },

  /**
   * Drains every queued board write immediately. Mirrors `vaultStore.save()`'s
   * top-level `flushAll`, but board-only (no config / misc), and reusing the
   * cache's own `getBoardWriteArgs`. Used by the rename / cascade-delete
   * propagation paths so a folder operation that touches many boards
   * persists synchronously — otherwise the user could close the app
   * inside the 300 ms debounce and lose the cascade entirely.
   *
   * Phase 23 M11: returns `{ failed }` so multi-stage cascades (tag rewrite,
   * folder rename) can surface a toast naming the boards whose `.board.json`
   * write failed. Existing callers that ignore the return value still get
   * the same fire-and-forget behaviour because the failed writes have
   * already been pushed into `failedVaultPaths` via `endWrite(..., false)`.
   */
  async flushAllDirty(): Promise<{ failed: string[] }> {
    const result = await flushAllScheduledBoards((boardId) => getBoardWriteArgs(boardId));
    return { failed: result.failed };
  },

  /**
   * Ensures every board in the active project is hydrated in the cache.
   *
   * `loadAllBoards` already runs at vault open and hydrates everything,
   * so under normal operation this is a no-op. The method exists as a
   * defense-in-depth backstop for whole-vault sweeps (tag rename / delete,
   * orphan detection) that must visit every `.board.json` on disk: a
   * future feature that lazy-loads boards, a partial-hydrate fallback
   * after a load failure, or a project mutation that adds boards from
   * outside the open flow won't silently skip uncached entries.
   */
  async ensureAllLoaded(): Promise<void> {
    const vaultRoot = vaultStore.path;
    const project = vaultStore.project;
    if (!vaultRoot || !project) return;

    const missing = project.boards.filter((b) => !boardCache[b.id]);
    if (missing.length === 0) return;

    for (const board of missing) {
      const relPath = boardPaths[board.id];
      if (!relPath) {
        console.warn(
          `[boardCache.ensureAllLoaded] No path recorded for board ${board.id} (${board.name}); skipping.`,
        );
        continue;
      }
      const result = await loadBoard(vaultRoot, relPath);
      if (!result.ok) {
        console.warn(
          `[boardCache.ensureAllLoaded] Failed to load ${relPath}: ${result.error} — ${result.message}`,
        );
        continue;
      }
      boardCache = { ...boardCache, [board.id]: result.data };
    }
  },

  // ── Cache lookups ──

  findTileBoardId(tileId: string): string | null {
    return findBoardIdForTile(tileId);
  },

  getViewport(boardId: string): { x: number; y: number; scale: number } | null {
    const cached = boardCache[boardId];
    if (!cached || cached.board.type !== 'mindmap') return null;
    const vp = getViewportFromCache(boardId);
    return vp ? { x: vp.x, y: vp.y, scale: vp.scale } : null;
  },

  updateViewport(boardId: string, viewport: { x: number; y: number; scale: number }) {
    const cached = boardCache[boardId];
    if (!cached || cached.board.type !== 'mindmap') return;
    // Viewports live in `.filo/viewports.json`, keyed by boardId. Stamping
    // the shared cache via setViewport schedules a debounced write of the
    // whole map so a chatty pan/zoom stream doesn't touch the board JSON.
    setViewport(boardId, { x: viewport.x, y: viewport.y, scale: viewport.scale });
  },

  /**
   * Wakes map consumers + schedules a debounced write WITHOUT touching
   * `cached.board`. Used by writers that have already mutated the cached
   * Board through another path (typically the per-slice cache mutators
   * inside `boardCacheTiles` / `boardCacheKanban` / etc., which write
   * directly into the live cache state).
   */
  touchBoard,

  /**
   * Mutates the cached board's settings IN PLACE and schedules a write.
   *
   * Phase 3 (Consolidation 2026-05-25) — single write path. This is the
   * canonical sink for board settings mutations whether or not the target
   * board is active. Active-board callers use `boardStore.updateSettings`,
   * which calls this method first and then mirrors the merged object onto
   * `boardStore.current.settings` for immediate reactivity.
   */
  updateBoardSettings(boardId: string, settings: Record<string, unknown>) {
    const cached = boardCache[boardId];
    if (!cached) return;
    // Audit 5.5 — build a fresh `board` (and entry) instead of mutating
    // `cached.board.settings` in place and then ref-copying the same entry.
    // The in-place path left a transient window where the cache map still
    // pointed at the old entry while `board.settings` had already changed,
    // and diverged from the spread-to-update convention used everywhere
    // else. The new board object also gives identity-comparison consumers
    // a real change to observe.
    const nextBoard = { ...cached.board, settings } as typeof cached.board;
    boardCache = { ...boardCache, [boardId]: { ...cached, board: nextBoard } };
    this.markDirty(boardId);
  },

  /** Persists waypoints for a mind-map board. */
  persistWaypoints(
    boardId: string,
    waypoints: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      zoom?: number;
      icon?: string;
      locked?: boolean;
    }>,
  ) {
    const cached = boardCache[boardId];
    if (!cached || cached.board.type !== 'mindmap') return;
    (cached.board as Record<string, unknown>).waypoints = waypoints;
    this.markDirty(boardId);
  },

  // ── Kanban (V7) — slice ──
  ...kanbanSlice,

  // ── Task List (V7) — slice ──
  ...taskListSlice,

  // ── External-edit reconciliation — slice ──
  ...frontmatterSlice,

  // ── Board lifecycle ──

  /**
   * Persists a fully-formed Board to disk and registers it in the cache.
   *
   * This is the canonical "create a new board" path: it writes the
   * .board.json file via the `board:create` IPC, registers the returned
   * vault-relative path in `boardPaths`, seeds an empty cache entry, and
   * appends the board to `project.boards`.
   *
   * Callers (BoardBrowser, BoardRouter auto-create, templates) MUST go
   * through this method — pushing directly to `project.boards` skips the
   * file write and leaves the cache empty, which silently breaks every
   * subsequent `markDirty(boardId)` (since `getBoardWriteArgs` returns
   * null without a path).
   */
  async persistNewBoard(board: Board): Promise<boolean> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return false;

    // Phase 2 / 2.3 — freeze the on-disk Kanban folder at create-time. The
    // folder name is the sanitised board name and stays put on subsequent
    // renames, so cards under `Kanban/<original-name>/*.md` keep resolving.
    // Idempotent — leaves an explicitly-set `kanbanFolder` alone (e.g. when
    // a template / migration seeded one already).
    if (board.type === 'kanban') {
      const b = board as { kanbanFolder?: string };
      if (!b.kanbanFolder) {
        b.kanbanFolder = fileNameSafe(board.name);
      }
    }

    const fileData: V7BoardFileData = {
      board,
      tileDefs: {},
      connections: {},
      frames: [],
    };

    try {
      const result = await invokeOk(
        'board:create',
        vaultRoot,
        board.name,
        JSON.stringify(fileData, null, 2),
      );

      boardPaths = { ...boardPaths, [board.id]: result.path };
      boardCache = { ...boardCache, [board.id]: fileData };

      const project = vaultStore.getProject();
      if (project && !project.boards.some((b) => b.id === board.id)) {
        project.boards = [...project.boards, board];
      }

      return true;
    } catch (err) {
      reportError(
        'boardCache.persist',
        err,
        `Failed to persist board "${board.name}" — not saved to disk`,
      );
      return false;
    }
  },

  /**
   * Convenience wrapper that builds a default Board via `boardRegistry` and
   * persists it. The Kanban-folder freeze (Phase 2 / 2.3) happens inside
   * `persistNewBoard` so every caller (this wrapper, BoardBrowser, TabBar
   * new-tab, templates, BoardRouter auto-create) gets the same on-disk
   * shape — the registry is the single source of truth for default board
   * fields per type (Phase 5).
   */
  async createBoard(
    name: string,
    type: string,
    settings?: Record<string, unknown>,
  ): Promise<Board | null> {
    const factory = boardDefaults[type as Board['type']];
    if (!factory) return null;
    // Phase 7.5 — `${type}_${createId()}` (collision-resistant nanoid) replaces
    // the old `${type}-${Date.now()}-${Math.random()}` recipe. The id is an
    // opaque cache/path key (nothing parses its structure), so existing boards
    // keep their old-format ids; only new boards get this shape.
    const boardId = `${type}_${createId()}`;
    const board = factory(boardId, name, settings);

    const ok = await this.persistNewBoard(board);
    return ok ? board : null;
  },

  /**
   * Drops every cache-side trace of a board: paths, cache map entry, the
   * Project's boards array entry, any pending debounced write, and the
   * viewport map entry. Does NOT touch disk — caller is responsible for
   * the `.board.json` file (either it never existed, was deleted via
   * `deleteBoard`, or disappeared externally and this is the
   * reconciliation path).
   *
   * Returns true when an entry was found and removed. False is a no-op
   * (already gone) — not an error.
   */
  removeBoardFromCache(boardId: string): boolean {
    if (!(boardId in boardPaths) && !(boardId in boardCache)) return false;

    const { [boardId]: _path, ...restPaths } = boardPaths;
    void _path;
    boardPaths = restPaths;
    const { [boardId]: _cache, ...restCache } = boardCache;
    void _cache;
    boardCache = restCache;

    const project = vaultStore.getProject();
    if (project) project.boards = project.boards.filter((b) => b.id !== boardId);

    cancelBoardWrite(boardId);
    // Drop the entry from the unified viewports map and schedule a
    // debounced flush so .filo/viewports.json reflects the deletion.
    removeViewport(boardId);
    return true;
  },

  /** Deletes a board file from the vault and drops its cache entry. */
  async deleteBoard(boardId: string): Promise<boolean> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return false;
    const boardPath = boardPaths[boardId];
    if (!boardPath) return false;

    // Phase 1.3 — cancel any pending debounced write BEFORE the delete IPC,
    // otherwise a 300ms-old setTimeout fires after the unlink and resurrects
    // the board file. The cancel is also treated as a successful endWrite
    // for sentinel purposes (see cancelBoardWrite).
    cancelBoardWrite(boardId, boardPath);

    try {
      await invokeOk('board:delete', vaultRoot, boardPath);
      this.removeBoardFromCache(boardId);
      return true;
    } catch (err) {
      reportError(
        'boardCache.delete',
        err,
        `Failed to delete board file ${boardPath}`,
      );
      return false;
    }
  },

  // ── Tile persistence — slice ──
  ...tilesSlice,

  // ── Connection + frame persistence (slice) ──
  ...connectionsFramesSlice,

  // ── Manual sync (recovery path when autosave silently failed) ──

  /**
   * Force-rewrites the backing `.md` file for a text tile from the current
   * in-memory document state (frontmatter from the vault index + body from
   * the document store), then commits any pending placement edits to disk.
   * For non-text tiles, just flushes the pending board JSON write.
   *
   * Returns `{ wrote, skippedReason? }`. Throws on hard errors (no vault, IPC failure).
   * Refuses to write when local body is empty but the disk file has content —
   * protects against wiping data when a text tile was never hydrated (LOD
   * block mode, `expandToDocument` seeding with body='', etc.).
   */
  async syncTile(tileId: string): Promise<{ wrote: boolean; skippedReason?: string }> {
    const boardId = findBoardIdForTile(tileId);
    if (!boardId) throw new Error(`Tile ${tileId} not found on any loaded board`);

    const cached = boardCache[boardId];
    const def = cached?.tileDefs?.[tileId];

    const result = await syncTileMarkdown(def);
    await flushBoardWrite(boardId, () => getBoardWriteArgs(boardId));
    return result;
  },

  /**
   * Syncs every tile on the given board, then flushes any pending board
   * JSON write. Returns counts so the caller can summarise.
   */
  async syncAllOnBoard(boardId: string): Promise<{ ok: number; skipped: number; failed: number }> {
    const cached = boardCache[boardId];
    if (!cached) return { ok: 0, skipped: 0, failed: 0 };

    let ok = 0;
    let skipped = 0;
    let failed = 0;

    for (const [tileId, def] of Object.entries(cached.tileDefs ?? {})) {
      try {
        const result = await syncTileMarkdown(def);
        if (result.skippedReason) skipped++;
        else ok++;
      } catch (err) {
        reportError(
          'boardCache.sync-tile',
          err,
          `Failed to sync tile ${tileId} — its backing file may be out of date`,
        );
        failed++;
      }
    }

    await flushBoardWrite(boardId, () => getBoardWriteArgs(boardId));
    return { ok, skipped, failed };
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the per-board cache + paths + the unresolved-warn coalesce state
// so the next vault opens against a clean slate.
onVaultSwap('pre-swap', 'boardCache', () => {
  boardCacheStore.clear();
});

/**
 * Inner sync helper used by both single-tile and bulk paths so behaviour
 * can't drift. Writes the tile's backing `.md` from the in-memory document
 * state, with a hard guard against emptying a non-empty file on disk.
 *
 * Returns `{ wrote }` when the file was written (or the tile is not a text
 * tile so nothing to write). Returns `{ wrote: false, skippedReason }` when
 * the write was deliberately refused.
 */
async function syncTileMarkdown(
  def: TileDefinition | undefined,
): Promise<{ wrote: boolean; skippedReason?: string }> {
  if (!def || def.type !== 'text') return { wrote: false };

  const vaultRoot = vaultStore.path;
  if (!vaultRoot) throw new Error('No vault open');

  const docId = (def as TileDefinition & { contentId?: string }).contentId || def.id;
  const doc = documentStore.getDocument(docId);
  if (!doc) return { wrote: false };

  const filename = doc.filename;
  const liveBody = doc.body ?? '';

  // Phase A.3 — capture the file's mtime before reading so we can detect
  // an external edit that lands in the read/write gap. The stat IPC
  // throws (via invokeOk) for missing files (new tile path); in that
  // case we skip the guard and proceed (no baseline to compare).
  let beforeMtime: number | undefined;
  try {
    const beforeStat = await invokeOk('vault:stat', vaultRoot, filename);
    beforeMtime = beforeStat.mtimeMs;
  } catch {
    // File doesn't exist (or stat failed) — no baseline; proceed without guard.
  }

  // Read the file fresh from disk so we never miss frontmatter the vault
  // index hasn't caught up to (e.g. external editor changes between watcher
  // events). Phase 37 / 37.6 — canonical two-arg form (vaultRoot, relPath);
  // the legacy single-arg branch has been removed from the IPC handler.
  let diskRaw = '';
  try {
    // syncTileMarkdown runs its own pre-read / pre-write mtime guard (see
    // syncTileMarkdownMtimeGuard.test.ts), so it deliberately does NOT route
    // through readMarkdownForHydrate — seeding the drift baseline here would
    // double-count against that guard and risk a redundant Reload prompt
    // (see the F1 note in markdownFileWriter.ts).
    const readResult = await invokeOk('vault:read-file-text', vaultRoot, filename); // allow-hydrate-read: own mtime guard
    diskRaw = readResult.content;
  } catch {
    // File doesn't exist (new tile) — write proceeds with empty disk content.
  }

  const diskParsed = parseMarkdownFile(diskRaw);

  // Hard guard: refuse to overwrite a non-empty disk file with an empty body.
  // This catches the LOD-block / expandToDocument-with-empty-body footgun
  // that would otherwise destroy user data.
  if (liveBody.trim().length === 0 && diskParsed.body.trim().length > 0) {
    return {
      wrote: false,
      skippedReason: 'Local content is empty; refusing to overwrite non-empty file',
    };
  }

  // Phase A.3 — re-stat before the write. If the mtime moved between the
  // pre-read stat and now, an external editor wrote to the file in our
  // read/write gap. Route through the Reload / Keep-local prompt so the
  // user explicitly chooses whether to clobber the external edit. The
  // unguarded path silently overwrote external changes — Filo's worst
  // class of data loss.
  if (beforeMtime !== undefined) {
    let writeMtime: number | undefined;
    try {
      const writeStat = await invokeOk('vault:stat', vaultRoot, filename);
      writeMtime = writeStat.mtimeMs;
    } catch {
      writeMtime = undefined;
    }
    if (writeMtime !== undefined && writeMtime !== beforeMtime) {
      const choice = await promptExternalEditOnSync({ path: filename });
      if (choice === 'reload') {
        // The prompt's Reload handler refreshed the vault index and
        // applied disk content to the editor. The caller's pending
        // markdown writer (if any) self-disarms when the doc transitions
        // to clean via `applyReloadFromDisk`.
        return {
          wrote: false,
          skippedReason: 'external-edit-reload',
        };
      }
      // 'keep-local' — fall through and proceed with the write.
    }
  }

  // Use the disk frontmatter as the base — preserves any external additions.
  // Orphan-fm semantics: the file just had its content read (or doesn't exist
  // and the gateway will reject the write). Mark hydrated with the BOM the
  // disk-read observed so the gateway's BOM preservation kicks in.
  if (!isHydrated(filename)) markHydrated(filename, diskParsed.hadBom);
  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath: filename,
      frontmatter: diskParsed.frontmatter,
      body: liveBody,
      callerId: `board-cache-sync-tile:${docId}`,
      docId,
    });
  } catch (err) {
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      reportError(
        'boardCache.sync-tile',
        err,
        `Skipped sync — file ${filename} no longer exists`,
      );
      return { wrote: false, skippedReason: 'file-missing' };
    }
    throw err;
  }
  documentStore.markClean(docId);
  return { wrote: true };
}
