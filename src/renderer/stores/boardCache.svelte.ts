import type {
  Board,
  MindMapBoard,
  KanbanBoard,
  TaskListBoard,
  TileDefinition,
  Connection,
  Frame,
} from '../schema/index';
import { vaultStore } from './vault.svelte';
import {
  type BoardFileData,
  scheduleBoardWrite,
  flushBoardWrite,
  getViewportFromCache,
  setViewport,
  markRecentSelfWrite,
} from '../lib/boards/boardSaver';
import { flushAllScheduledBoards } from '../lib/boards/boardWriteScheduler';
import { loadBoard } from '../lib/boards/boardLoader';
import { baselineSeq, noteBaseline } from '../lib/vault/fileBaselineRegistry';
import { adoptLoadedBoardBaseline } from '../lib/boards/boardBaseline';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { boardNameProblem, plannedBoardPlace } from '../lib/boards/boardNaming';
import { normalizePath, toPosix, normalizeVaultRelative, stripLeadingSlash } from '../lib/utils/path';
import { createId } from '../lib/utils/ids';
import { uiStore } from './ui.svelte';
import type { CacheContext } from './boardCacheTypes';
import { makeConnectionsFramesSlice } from './boardCacheConnectionsFrames';
import { makeTaskListSlice } from './boardCacheTaskList';
import { makeKanbanSlice } from './boardCacheKanban';
import { makeTilesSlice } from './boardCacheTiles';
import { makeFrontmatterSlice } from './boardCacheFrontmatter';
import { makeBoardDeleteSlice } from './boardCacheDelete';
import { CURRENT_BOARD_FILE_VERSION } from '../schema/boardFile';
import { onVaultSwap } from '../core/vaultLifecycle';
import { bumpBoardViewRevision } from './boardViewRevision.svelte';
import { boardDefaults } from '../core/boardDefaults';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { catchUpLoadedBoard, markBoardUnloaded } from './unloadedBoards';

/**
 * Board cache store — owns the per-board on-disk snapshot used to schedule
 * debounced writes back to `.board.json`. Operates only on cache state and
 * the virtual Project's connections/frames; never touches the active-board
 * runtime state (that lives in `board.svelte.ts`).
 */

let boardCache = $state<Record<string, BoardFileData>>({});
let boardPaths = $state<Record<string, string>>({});

/**
 * Counter + one-shot toast guard for "couldn't resolve owning board"
 * warnings inside the persist* methods. Without a user-visible surface
 * an off-board tile/connection/frame can silently fail to persist its edit.
 *
 * We coalesce: the FIRST unresolved warn in a session surfaces a single
 * low-severity toast; subsequent warns increment the counter (visible in
 * console) but don't keep popping toasts. Reset via
 * `resetUnresolvedWarnState` on vault close.
 */
let unresolvedWarnCount = 0;
let unresolvedToastShown = false;

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
): { vaultRoot: string; boardPath: string; cached: BoardFileData } | null {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return null;
  const boardPath = boardPaths[boardId];
  const cached = boardCache[boardId];
  if (!boardPath || !cached) return null;
  return { vaultRoot, boardPath, cached };
}

/**
 * Reverse-index memos (id → owning boardId) for the keyless
 * persist paths. A tile / connection / frame / kanban column / task is created
 * on exactly one board and never re-parented (an invariant), so a successful
 * scan result stays valid for the entity's life. `resolveOwnerCached` caches
 * scan hits and verifies-on-hit (O(1)) before trusting the memo — on a miss
 * OR a stale hit it falls back to a full scan — so the memo can NEVER return
 * a wrong board; it only turns the repeated O(boards×entities) scans on every
 * keyless persist into O(1) after the first lookup. Cleared on vault close.
 *
 * Plain (non-reactive) Maps: consulted imperatively during persist, never in a
 * reactive ($derived/$effect) context — so SvelteMap isn't required (mirrors
 * the tabs.svelte.ts reverse-index convention).
 */
/* eslint-disable svelte/prefer-svelte-reactivity */
const tileBoardMemo = new Map<string, string>();
const connectionBoardMemo = new Map<string, string>();
const frameBoardMemo = new Map<string, string>();
const kanbanColumnBoardMemo = new Map<string, string>();
const taskBoardMemo = new Map<string, string>();
/* eslint-enable svelte/prefer-svelte-reactivity */

function resetBoardOwnerMemos(): void {
  tileBoardMemo.clear();
  connectionBoardMemo.clear();
  frameBoardMemo.clear();
  kanbanColumnBoardMemo.clear();
  taskBoardMemo.clear();
}

function resolveOwnerCached(
  memo: Map<string, string>,
  id: string,
  owns: (data: BoardFileData) => boolean,
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
 * Invariant: a `tile.id` is unique across all boards. When the same `.md`
 * file appears on multiple boards each placement creates a fresh tile def
 * with its own `tile.id`; cross-board sharing is via the note's path (which
 * keys the shared `DocumentState`), never via a shared `tile.id`.
 * Returning the first hit is therefore correct and unambiguous.
 */
function findBoardIdForTile(tileId: string): string | null {
  return resolveOwnerCached(tileBoardMemo, tileId, (data) => {
    const b = data.board;
    if (b.type === 'mindmap') {
      const mm = b as MindMapBoard;
      return Boolean((mm.placements ?? {})[tileId] || (mm.inlineTiles ?? {})[tileId]);
    }
    // Non-mind-map boards have no placements/inlineTiles. Tile
    // identity is the tileDefs key; whichever board owns the def owns the tile.
    return Boolean((data.tileDefs ?? {})[tileId]);
  });
}

/**
 * Resolves a connection's owning board ID by scanning the cache.
 *
 * Used as a fallback when the connection object's `boardId` field is empty
 * (legacy data, or a connection created while no board was active), so an
 * empty `conn.boardId` isn't a silent no-op.
 */
function findBoardIdForConnection(connId: string): string | null {
  return resolveOwnerCached(connectionBoardMemo, connId, (data) =>
    Boolean((data.connections ?? {})[connId]),
  );
}

/**
 * Resolves a frame's owning board ID by scanning the cache.
 *
 * The cache (not the project store, which may lag) is the authoritative
 * source for "which board owns this frame".
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
 * connection paths so race-class drops aren't invisible.
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
  return resolveOwnerCached(taskBoardMemo, tileId, (data) => {
    if (data.board.type !== 'tasklist') return false;
    return ((data.board as TaskListBoard).tasks ?? []).some((p) => p.tileId === tileId);
  });
}

/**
 * Resolves a Task List board for a given boardId, surfacing a console warn +
 * one-shot toast on failure rather than silently dropping the mutation.
 * Mirrors `kanbanBoardOrWarn` — used by every TaskList mutator so race-class
 * drops aren't invisible.
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
  // Nothing to write for an id with no board file: a Document tab opened on a
  // note has its own undo stack under an id no `.board.json` carries. Arming
  // a write for it would report a lost save and leave the crash sentinel dirty.
  if (!boardCache[boardId]) return;
  scheduleBoardWrite(boardId, () => getBoardWriteArgs(boardId));
}

function touchBoard(boardId: string): void {
  const cached = boardCache[boardId];
  if (!cached) return;
  boardCache = { ...boardCache, [boardId]: cached };
  markDirty(boardId);
}

function updateEntry(boardId: string, updates: Partial<BoardFileData>): void {
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
};

const connectionsFramesSlice = makeConnectionsFramesSlice(cacheCtx);
const taskListSlice = makeTaskListSlice(cacheCtx);
const kanbanSlice = makeKanbanSlice(cacheCtx);
const tilesSlice = makeTilesSlice(cacheCtx);
const frontmatterSlice = makeFrontmatterSlice(cacheCtx);
const deleteSlice = makeBoardDeleteSlice({
  getCache: () => boardCache,
  setCache: (next) => { boardCache = next; },
  getPaths: () => boardPaths,
  setPaths: (next) => { boardPaths = next; },
  flushWrite: (boardId) => flushBoardWrite(boardId, () => getBoardWriteArgs(boardId)),
  markDirty,
});

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
  hydrate(cache: Record<string, BoardFileData>, paths: Record<string, string>) {
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
   * Without this, a `.board.json` rename leaves the cache keyed against the
   * old path: the next debounced write recreates a phantom file AND tree
   * reconciliation flags the board "missing on disk" and drops it. Update
   * before the cascade so propagateRename + tree reconcile both see the truth.
   *
   * Returns the list of board IDs whose path changed so callers can
   * trigger any post-rename housekeeping (e.g. mark dirty so the
   * relocated `.board.json` rewrites under its new name).
   */
  renameBoardPath(oldPath: string, newPath: string): string[] {
    if (!oldPath || !newPath) return [];
    // Strip leading slashes so the case-preserving `oldPrefix`
    // and case-folded `foldedPrefix` (below) share a length (else `slice` desyncs).
    const normalisedOld = stripLeadingSlash(normalizePath(oldPath));
    const normalisedNew = stripLeadingSlash(normalizePath(newPath));
    // Only a TRUE no-op (identical bytes after normalisation) returns early. A
    // case-ONLY rename folds equal but must still rebind `boardPaths` to the new
    // casing, else a phantom-file write + "missing on disk" eviction follows.
    if (normalisedOld === normalisedNew) return [];
    // Compare case-INSENSITIVELY (Windows/macOS aren't case-sensitive) so an
    // OS-reported rename whose casing diverges from the stored casing still
    // rebinds. The descendant SLICE uses the case-preserving `oldPrefix` length
    // so the suffix keeps its on-disk casing — board paths carry no leading
    // slash, so the folded and unfolded prefixes share the same length.
    const oldPrefix = `${normalisedOld}/`;
    const foldedOld = normalizeVaultRelative(normalisedOld);
    const foldedPrefix = `${foldedOld}/`;
    const updates: Record<string, string> = {};
    const changedIds: string[] = [];
    for (const [boardId, relPath] of Object.entries(boardPaths)) {
      const norm = toPosix(relPath);
      const folded = normalizeVaultRelative(norm);
      if (folded === foldedOld) {
        updates[boardId] = normalisedNew;
        changedIds.push(boardId);
      } else if (folded.startsWith(foldedPrefix)) {
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
   * Replaces the entire cache with the given snapshot. Used
   * by vaultFolderOps.rename to roll back a half-mutated cache after the
   * `vault:rename` IPC fails. Does NOT touch `boardPaths` (paths are stable
   * across the rename — the IPC determines whether anything moved). Does NOT
   * mark dirty / schedule writes — the caller is responsible for cancelling
   * any debounced writes that captured the renamed snapshot.
   */
  replaceCache(snapshot: Record<string, BoardFileData>): void {
    const previous = boardCache;
    boardCache = snapshot;
    // A mounted view of a replaced board hydrates its filters from the new data.
    for (const [id, data] of Object.entries(snapshot)) {
      if (previous[id] !== undefined && previous[id] !== data) bumpBoardViewRevision(id);
    }
  },

  /**
   * Replaces the `boardPaths` map with a captured snapshot. Mirrors
   * `replaceCache` for the path map. Paired with
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
   * Returns `{ failed }` so multi-stage cascades (tag rewrite, folder rename)
   * can toast the boards whose `.board.json` write failed. Callers that ignore
   * it are still covered: failures are already in `failedVaultPaths` via
   * `endWrite(..., false)`.
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
   *
   * Returns the paths of the boards it couldn't load, so a sweep can say
   * which boards it didn't reach.
   */
  async ensureAllLoaded(): Promise<string[]> {
    const vaultRoot = vaultStore.path;
    const project = vaultStore.project;
    if (!vaultRoot || !project) return [];
    // A vault swap (or close → reopen) mid-loop must NOT inject the OUTGOING
    // vault's `.board.json` into the NEW vault's cache: the read is anchored to
    // the captured `vaultRoot` but the cache is live. Re-check after each await.
    const identity = captureVaultIdentity();

    const missing = project.boards.filter((b) => !boardCache[b.id]);
    const failed: string[] = [];
    if (missing.length === 0) return failed;

    for (const board of missing) {
      const relPath = boardPaths[board.id];
      if (!relPath) {
        console.warn(
          `[boardCache.ensureAllLoaded] No path recorded for board ${board.id} (${board.name}); skipping.`,
        );
        continue;
      }
      const result = await loadBoard(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return failed;
      if (!result.ok) {
        console.warn(
          `[boardCache.ensureAllLoaded] Failed to load ${relPath}: ${result.error} — ${result.message}`,
        );
        markBoardUnloaded(relPath);
        failed.push(relPath);
        continue;
      }
      // Renames made while it was unloaded are applied, then saved.
      const caughtUp = catchUpLoadedBoard(relPath, result.data) > 0;
      boardCache = { ...boardCache, [board.id]: result.data };
      adoptLoadedBoardBaseline(relPath, result.baseline);
      if (caughtUp) markDirty(board.id);
    }
    return failed;
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
   * Single write path: this is the canonical sink for board settings mutations whether or not the target
   * board is active. Active-board callers use `boardStore.updateSettings`,
   * which calls this method first and then mirrors the merged object onto
   * `boardStore.current.settings` for immediate reactivity.
   */
  updateBoardSettings(boardId: string, settings: Record<string, unknown>) {
    const cached = boardCache[boardId];
    if (!cached) return;
    // Build a fresh `board` (and entry) rather than mutating settings in place:
    // no transient window where the map points at the old entry with changed
    // settings, and identity-comparison consumers see a real change.
    const nextBoard = { ...cached.board, settings } as typeof cached.board;
    boardCache = { ...boardCache, [boardId]: { ...cached, board: nextBoard } };
    this.markDirty(boardId);
  },

  /**
   * Sets the board's name and/or emoji and schedules its write. They live in
   * the `.board.json`, so this is the change that lasts; the project list and
   * tab labels are copies (`stores/boardIdentity.ts` updates those too).
   */
  updateBoardIdentity(boardId: string, patch: { name?: string; emoji?: string }) {
    const cached = boardCache[boardId];
    if (!cached) return;
    const nextBoard = { ...cached.board, ...patch } as typeof cached.board;
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

  // ── Kanban — slice ──
  ...kanbanSlice,

  // ── Task List — slice ──
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

    // The name is the file stem, used as typed: refused, never rewritten.
    board.name = board.name.trim();
    const problem = boardNameProblem(board.name);
    if (problem) {
      uiStore.toast(`Couldn't create the board: ${problem}`, 'error');
      return false;
    }
    const place = plannedBoardPlace(board.name, {
      boardFolders: vaultStore.project?.settings?.general?.boardFolders === true,
      rootFolder: vaultStore.activeRootFolder,
    });
    // A board with its own folder keeps everything it creates there.
    if (place.defaultFolder) {
      board.settings = { ...board.settings, defaultFolder: place.defaultFolder } as typeof board.settings;
    }

    // Stamp the version on the very first write: the loader accepts only the
    // current format, so a version-less file would be refused on reload.
    const fileData: BoardFileData = {
      version: CURRENT_BOARD_FILE_VERSION,
      board,
      tileDefs: {},
      connections: {},
      frames: [],
    };

    const identity = captureVaultIdentity();
    try {
      const result = await invokeOk(
        'board:create',
        vaultRoot,
        board.name,
        JSON.stringify(fileData, null, 2),
        place.folder || undefined,
      );
      // The vault was let go while the file was created: the board belongs to
      // that vault, where it is on disk and loads next time; registering it
      // here would put it in the next vault's cache and project.
      if (!isStillSameVault(identity)) return false;

      // The create is Filo's own write: its watcher echo is not an external
      // edit, and its stat is the first save's drift anchor. Unmarked, the echo
      // of a board edited within a second or two of its creation reads as an
      // external edit and asks "modified externally". No save of the new path
      // can have run yet (it had no path until now), so the ticket is taken
      // here.
      markRecentSelfWrite(result.path);
      noteBaseline(result.path, result.mtimeMs, result.size, { ifUnchangedSince: baselineSeq(result.path) });

      boardPaths = { ...boardPaths, [board.id]: result.path };
      boardCache = { ...boardCache, [board.id]: fileData };

      const project = vaultStore.getProject();
      if (project && !project.boards.some((b) => b.id === board.id)) {
        project.boards = [...project.boards, board];
      }

      // List the new file in the sidebar now rather than when the watcher
      // reports it: a recursive watch can report a new file late, or not at
      // all (Node's recursive fs.watch on Linux).
      void vaultStore.refreshTree();

      return true;
    } catch (err) {
      const code = err instanceof IpcEnvelopeError ? err.code : undefined;
      if (code === 'EEXIST' || code === 'TARGET_EXISTS') {
        const where = place.folder ? ` in "${place.folder}"` : '';
        uiStore.toast(`A board named "${board.name}" already exists${where}. Choose another name.`, 'error');
        return false;
      }
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
   * persists it. The Kanban-folder freeze happens inside
   * `persistNewBoard` so every caller (this wrapper, BoardBrowser, TabBar
   * new-tab, templates, BoardRouter auto-create) gets the same on-disk
   * shape — the registry is the single source of truth for default board
   * fields per type.
   */
  async createBoard(
    name: string,
    type: string,
    settings?: Record<string, unknown>,
  ): Promise<Board | null> {
    const factory = boardDefaults[type as Board['type']];
    if (!factory) return null;
    // The id is an opaque cache/path key (nothing parses its structure), so
    // boards with older-format ids keep working alongside this shape.
    const boardId = `${type}_${createId()}`;
    const board = factory(boardId, name, settings);

    const ok = await this.persistNewBoard(board);
    return ok ? board : null;
  },

  // ── Board delete (slice): the file goes to Filo's trash ──
  ...deleteSlice,

  // ── Tile persistence — slice ──
  ...tilesSlice,

  // ── Connection + frame persistence (slice) ──
  ...connectionsFramesSlice,
};

// Vault-swap reset: drops the per-board cache + paths + the unresolved-warn coalesce state
// so the next vault opens against a clean slate.
onVaultSwap('pre-swap', 'boardCache', () => {
  boardCacheStore.clear();
});
