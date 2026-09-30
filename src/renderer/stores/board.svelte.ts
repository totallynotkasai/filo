import type {
  Board,
  Tile,
  TileDefinition,
  Connection,
  Frame,
  MindMapBoard,
  TileGroup,
} from '../schema/index';
import type { SpatialScope } from './spatial.svelte';
import type { CanvasScope } from './canvas.svelte';
import type { SelectionScope } from './selection.svelte';
import { historyStore, type Command } from './history.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { boardRefIntegrityStore } from './boardRefIntegrity.svelte';
import { tabStore } from './tabs.svelte';
import { restoreTrashedItem, toastMovedToTrash } from './trash.svelte';
import type { BoardFileData } from '../lib/boards/boardSaver';
import {
  buildBoardSettingsFromGlobal,
  buildBoardSettingsFromTheme,
  mergeBoardStyleSettings,
} from '../lib/styles/buildBoardDefaults';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { vaultStore } from './vault.svelte';
import { normalizePath, samePath, stripLeadingSlash, toVaultRelative } from '../lib/utils/path';
import { rebasePin } from '../lib/vault/folderPinPaths';
import type { BoardContext } from './boardStoreTypes';
import { makeHistorySlice } from './boardHistory';
import { makeConnectionsSlice } from './boardConnections';
import { makeFramesSlice } from './boardFrames';
import { makeWaypointsGroupsSlice } from './boardWaypointsGroups';
import { makeTilesSlice } from './boardTiles';
import { makeFrontmatterSyncSlice } from './boardFrontmatterSync';
import { getActiveScope, makeFacade } from '../lib/boards/boardScope.svelte';
import { opsFor } from '../core/boardTileOps';

/**
 * Board store — owns the per-pane VIEW of a single board. The view is built
 * by `$derived` projections of `boardCacheStore.cache[currentBoardId]`, which
 * means two `BoardScope` instances pointed at the same boardId reactively
 * share the same tiles / connections / frames / settings state.
 *
 * The cache is the single source of truth; the scope tracks only
 * `currentBoardId` (the pane's pinned board) and `settingsVersion` (a separate
 * signal for settings mutations that prefer imperative bumps over deep-proxy
 * tracking).
 *
 * Each `BoardScope` calls `createBoardScopeBoard()`. The exported `boardStore`
 * is a global facade Proxy that delegates to the active pane's instance, so
 * workspace-level call sites (GlobalToolbar, hotkeys, command registry) keep
 * their existing `boardStore.foo` calls and transparently target the active
 * pane. Cache state (per-board file snapshots, dirty scheduler, persist*
 * methods) lives in `boardCache.svelte.ts` and is *shared across panes*.
 * Broken-reference tracking in `boardRefIntegrity.svelte.ts` is similarly
 * global. Per-concern slices (tiles, connections, frames, waypoints/groups,
 * history, frontmatter-sync) live in sibling `board*.ts` files and receive
 * the scope's `spatial`/`canvas`/`selection` via `BoardContext`.
 */

export interface BoardScopeBoardDeps {
  spatial: SpatialScope;
  canvas: CanvasScope;
  selection: SelectionScope;
}

/**
 * Post-removal cleanup shared by `deleteBoard` (user-initiated delete via
 * the in-app UI) and `cleanupMissingBoard` (reconciliation when the file
 * was removed out from under us). Both paths must close any open tab on
 * the board and release the per-board undo/redo stack; only the cache
 * + path + project.boards trio differs (deleteBoard handles those via
 * the IPC; cleanupMissingBoard via `removeBoardFromCache`).
 *
 * Walks tabs by `boardId` rather than tab id because a board can be
 * pinned in multiple panes simultaneously — each open tab needs to
 * close.
 */
function cleanupAfterBoardRemoved(boardId: string): Promise<void> {
  // Snapshot tab ids first: `tabStore.close` rebuilds the tabs array,
  // so iterating live would skip entries when consecutive tabs match.
  // `tabStore.close` is async (drains pending writes before unmount), so
  // return the aggregate promise for callers that must observe the cleanup
  // landing (e.g. vault folder delete). Sync callers can `void` it.
  const tabIds = tabStore.tabs.filter((t) => t.boardId === boardId).map((t) => t.id);
  historyStore.clearBoard(boardId);
  return Promise.all(tabIds.map((id) => tabStore.close(id))).then(() => undefined);
}

/**
 * Factory: creates a fresh per-pane board scope. Each scope holds its own
 * `currentBoardId` and `settingsVersion` `$state`; everything else (tiles,
 * connections, frames, currentBoard) is a `$derived` projection of the shared
 * `boardCacheStore.cache[currentBoardId]`. The factory is bound to its
 * pane's spatial/canvas/selection scopes.
 */
/**
 * Merges the style block `build` returns into every board of the project.
 * The board cache's entry is the one a board renders from and saves, so
 * writing it updates an open board too.
 */
async function applyStyleToAllBoards(
  build: (type: Board['type']) => Record<string, unknown> | null,
): Promise<{ updated: number; skipped: string[] }> {
  const identity = captureVaultIdentity();
  await boardCacheStore.ensureAllLoaded();
  const project = vaultStore.project;
  if (!project || !isStillSameVault(identity)) return { updated: 0, skipped: [] };
  let updated = 0;
  const skipped: string[] = [];
  for (const b of project.boards ?? []) {
    const cached = boardCacheStore.cache[b.id];
    const built = build(b.type);
    if (!cached || !built) {
      skipped.push(b.name);
      continue;
    }
    const existing = (cached.board.settings ?? {}) as Record<string, unknown>;
    boardCacheStore.updateBoardSettings(b.id, mergeBoardStyleSettings(existing, built));
    updated++;
  }
  return { updated, skipped };
}

export function createBoardScopeBoard(deps: BoardScopeBoardDeps) {
  // ── Pane state (the only $state in the scope) ──
  let currentBoardId = $state<string | null>(null);

  // Bumped on every settings mutation. Consumers that read board settings
  // indirectly (via getters that chain through `currentBoard?.settings`) can
  // touch this in their reactive scope to guarantee re-evaluation even when
  // Svelte's nested proxy tracking misses an in-place property assignment.
  let settingsVersion = $state(0);

  // ── Derived views of the cache ──
  const currentBoard = $derived.by((): Board | null => {
    if (!currentBoardId) return null;
    return boardCacheStore.cache[currentBoardId]?.board ?? null;
  });

  const tiles = $derived.by((): Record<string, Tile> => {
    if (!currentBoardId) return {};
    const cached = boardCacheStore.cache[currentBoardId];
    if (!cached) return {};
    return opsFor(cached.board).getFullTiles(cached, currentBoardId);
  });

  const connections = $derived.by((): Record<string, Connection> => {
    if (!currentBoardId) return {};
    return boardCacheStore.cache[currentBoardId]?.connections ?? {};
  });

  const frames = $derived.by((): Frame[] => {
    if (!currentBoardId) return [];
    return boardCacheStore.cache[currentBoardId]?.frames ?? [];
  });

  const boardCtx: BoardContext = {
    getCurrent: () => currentBoard,
    getTiles: () => tiles,
    getConnections: () => connections,
    getFrames: () => frames,
    bumpSettingsVersion: () => { settingsVersion++; },
    // Cross-slice helpers — resolved lazily after the store is built.
    removeTile: (tileId) => store.removeTile(tileId),
    updateTile: (tileId, updates) => store.updateTile(tileId, updates),
    updateSettings: (patch) => store.updateSettings(patch),
    spatial: deps.spatial,
    canvas: deps.canvas,
    selection: deps.selection,
  };

  const historySlice = makeHistorySlice();
  const connectionsSlice = makeConnectionsSlice(boardCtx);
  const framesSlice = makeFramesSlice(boardCtx);
  const waypointsGroupsSlice = makeWaypointsGroupsSlice(boardCtx);
  const tilesSlice = makeTilesSlice(boardCtx);
  const frontmatterSyncSlice = makeFrontmatterSyncSlice(boardCtx);

  /**
   * Rebuilds the pane's spatial index from the current derived tiles. Called
   * imperatively whenever the active board changes (`setBoard` / `clearBoard`)
   * and from the tiles slice when a tile mutation lands on this scope (so the
   * same-pane drag/select interactions still see fresh spatial entries).
   *
   * Cross-pane spatial drift is an accepted limitation: pane B's spatial index will not reflect pane A's edits until pane B reactivates.
   * The reactive `tiles` derivation guarantees the visual rendering does
   * reflect pane A's edits in real time — hit-testing within pane B for
   * rubber-band selection of pane-A-added tiles is the residual gap.
   */
  function rehydrateSpatialFromCache(): void {
    deps.spatial.clear();
    for (const t of Object.values(tiles)) {
      const w = t.renderedWidth ?? t.size.width;
      const h = t.renderedHeight ?? t.size.height;
      deps.spatial.insert(t.id, t.position.x, t.position.y, w, h);
    }
  }

  const store = {
    // ── Active board getters ──
    get current() { return currentBoard; },
    get tiles() { return tiles; },
    get connections() { return connections; },
    get frames() { return frames; },
    get boardType() { return currentBoard?.type ?? null; },
    get settings() {
      void settingsVersion;
      return currentBoard?.settings ?? null;
    },
    get settingsVersion() { return settingsVersion; },

    // ── Cache getters (delegated) ──
    get cache() { return boardCacheStore.cache; },
    get paths() { return boardCacheStore.paths; },
    get allTileDefs(): Record<string, TileDefinition> { return boardCacheStore.allTileDefs; },

    // ── Broken-ref getters (delegated) ──
    get brokenTilesByBoard() { return boardRefIntegrityStore.brokenTilesByBoard; },
    isBrokenTile(tileId: string): boolean { return boardRefIntegrityStore.isBrokenTile(tileId); },

    // ── Active board setters ──

    /**
     * Pins this scope to a board.
     *
     * The per-pane view is `$derived` from the shared cache and follows
     * whatever the cache holds for `board.id`, which the caller has already
     * hydrated (`boardLoader` → `boardCacheStore.hydrate`): the cache is the
     * source of truth.
     *
     * The pane's spatial index and canvas viewport are still hydrated
     * imperatively here so single-pane drag/select continues to work
     * without waiting for a reactive recompute.
     */
    setBoard(board: Board) {
      currentBoardId = board.id;

      rehydrateSpatialFromCache();

      // Sync the per-board semanticZoom flag into the pane's canvas scope so
      // the LOD threshold respects the active board's preference. Mind-map
      // boards expose this in `settings.semanticZoom`; other board types
      // don't have a canvas, so we default to true.
      const settings = (board as { settings?: { semanticZoom?: boolean; snapToGrid?: boolean } }).settings;
      deps.canvas.setSemanticZoomEnabled(settings?.semanticZoom ?? true);
      deps.canvas.setSnapEnabled(settings?.snapToGrid ?? false);

      // Hydrate the canvas viewport from this board's persisted camera.
      deps.canvas.setBoard(board.type === 'mindmap' ? board.id : null);

      // PaneView owns the global `historyStore.activeBoardId` signal via its
      // `isActive`-gated $effect. Calling `setActiveBoard` here unconditionally
      // races that effect when an inactive pane's `BoardRouter` re-derives its
      // tab (tab rename, reorder, project shape change), letting a background
      // pane hijack which board's undo stack Ctrl+Z hits. PaneView.svelte owns
      // this signal.
    },

    clearBoard() {
      currentBoardId = null;
      deps.spatial.clear();
      deps.canvas.setBoard(null);
    },

    // ── Cache delegation ──

    hydrateCache(cache: Record<string, BoardFileData>, paths: Record<string, string>) {
      boardCacheStore.hydrate(cache, paths);
    },

    clearCache() { boardCacheStore.clear(); },

    updateCacheEntry(boardId: string, updates: Partial<BoardFileData>) {
      boardCacheStore.updateEntry(boardId, updates);
    },

    markDirty(boardId: string) { boardCacheStore.markDirty(boardId); },

    findTileBoardId(tileId: string): string | null {
      return boardCacheStore.findTileBoardId(tileId);
    },

    getTilePlacement(tileId: string, boardId: string) {
      return boardCacheStore.getTilePlacement(tileId, boardId);
    },

    getViewport(boardId: string) { return boardCacheStore.getViewport(boardId); },

    updateViewport(boardId: string, viewport: { x: number; y: number; scale: number }) {
      boardCacheStore.updateViewport(boardId, viewport);
    },

    persistWaypoints(
      boardId: string,
      waypoints: Array<{
        id: string; name: string; x: number; y: number;
        zoom?: number; icon?: string; locked?: boolean;
      }>,
    ) {
      boardCacheStore.persistWaypoints(boardId, waypoints);
    },

    getFullTilesForBoard(boardId: string): Record<string, Tile> {
      return boardCacheStore.getFullTilesForBoard(boardId);
    },

    // ── Frontmatter / rename / cascade-delete (slice) ──
    ...frontmatterSyncSlice,

    recomputeBrokenRefs(knownVaultPaths: ReadonlySet<string>): void {
      boardRefIntegrityStore.recompute(knownVaultPaths);
    },

    /**
     * Removes every tile flagged as broken on the given board (or every board
     * if omitted). Returns the removed tile ids so callers can route them
     * through `removeTilesWithHistory`.
     */
    removeBrokenTiles(boardId?: string): string[] {
      const targets = boardRefIntegrityStore.getBrokenTileIds(boardId);
      for (const id of targets) store.removeTile(id);
      if (targets.length > 0) boardRefIntegrityStore.clear(boardId);
      return targets;
    },

    /**
     * Merges a partial settings patch into the active board and schedules a
     * debounced write.
     *
     * Writes only the cache; `boardStore.current` is `$derived` from it.
     * `settingsVersion++` is kept because some downstream derivations key
     * off it instead of the deep settings proxy.
     */
    updateSettings(patch: Record<string, unknown>): void {
      if (!currentBoard) return;
      const boardId = currentBoard.id;
      const merged = { ...(currentBoard.settings ?? {}), ...patch };
      boardCacheStore.updateBoardSettings(boardId, merged);
      settingsVersion++;
    },

    /**
     * Removes the given keys from the active board's `settings`. Paired with
     * `updateSettings` and used by `UpdateBoardSettingsCommand.undo` to fully
     * revert keys that didn't exist before the command ran — without this,
     * undo would leave a phantom `key: undefined` in the merged object.
     */
    deleteSettingsKeys(keys: string[]): void {
      if (!currentBoard) return;
      const boardId = currentBoard.id;
      const merged = { ...(currentBoard.settings ?? {}) } as Record<string, unknown>;
      for (const k of keys) delete merged[k];
      boardCacheStore.updateBoardSettings(boardId, merged);
      settingsVersion++;
    },

    /**
     * Toggles the per-board default folder for the *currently active* board.
     */
    setBoardDefaultFolder(absPath: string): void {
      if (!currentBoard) return;
      const vp = vaultStore.path;
      if (!vp) return;
      const rel = toVaultRelative(absPath, vp) ?? '';
      const current = (currentBoard.settings as { defaultFolder?: string }).defaultFolder ?? '';
      const next = samePath(rel, current) ? '' : rel;
      store.updateSettings({ defaultFolder: next });
    },

    /**
     * Walks every cached board and clears `settings.defaultFolder` on any
     * board whose pin matches `deletedPath` (or is a descendant of it),
     * case-folded. When `newPath` is provided, the pin is rewritten with the
     * new prefix instead of cleared.
     */
    clearBoardDefaultFolderIfMatches(deletedPath: string, newPath?: string): string[] {
      const vp = vaultStore.path;
      if (!vp) return [];
      const toRel = (p: string): string =>
        toVaultRelative(p, vp) ?? stripLeadingSlash(normalizePath(p));
      const deletedRel = toRel(deletedPath);
      if (!deletedRel) return [];
      const newRel = newPath ? toRel(newPath) : '';
      const touched: string[] = [];
      for (const [boardId, data] of Object.entries(boardCacheStore.cache)) {
        const settings = (data.board as { settings?: { defaultFolder?: string } }).settings;
        const current = settings?.defaultFolder ?? '';
        if (!current) continue;
        const next = rebasePin(current, deletedRel, newRel);
        if (next === null || next === current) continue;
        const merged = { ...(settings ?? {}), defaultFolder: next };
        boardCacheStore.updateBoardSettings(boardId, merged);
        touched.push(boardId);
      }
      return touched;
    },

    /**
     * Toggles per-board semantic zoom (LOD) and mirrors the new value into
     * the pane's canvas scope so the rendering threshold respects the change
     * immediately.
     */
    toggleSemanticZoom(): void {
      if (!currentBoard) return;
      const current = (currentBoard.settings as { semanticZoom?: boolean })?.semanticZoom ?? true;
      const next = !current;
      store.updateSettings({ semanticZoom: next });
      deps.canvas.setSemanticZoomEnabled(next);
    },

    /**
     * Toggles the Mind Map's grid snap ("Snap Tiles"), saved on the board
     * (`settings.snapToGrid`) so it survives a relaunch. Smart Guides run
     * whenever grid snap is off.
     */
    toggleSnapToGrid(): void {
      if (!currentBoard) return;
      const current = (currentBoard.settings as { snapToGrid?: boolean })?.snapToGrid ?? false;
      const next = !current;
      store.updateSettings({ snapToGrid: next });
      deps.canvas.setSnapEnabled(next);
    },

    /**
     * Writes the current Global Defaults' style fields into every board's
     * settings, keeping each board's other settings (saved views, default
     * folder, Mind Map toggles, Task List group / sort). Per-tile / per-frame /
     * per-connection overrides are not touched. Boards not yet in the cache
     * are loaded first; the names of any that still can't be updated (their
     * file failed to load) are returned so the caller can say so.
     */
    async applyGlobalDefaultsToAllBoards(): Promise<{ updated: number; skipped: string[] }> {
      return applyStyleToAllBoards((type) => {
        const globals = vaultStore.project?.settings;
        return globals ? buildBoardSettingsFromGlobal(type, globals) : null;
      });
    },

    /**
     * Same as `applyGlobalDefaultsToAllBoards` but with the schema-default
     * style (empty colours, which fall back to the active theme's variables).
     */
    async applyThemeDefaultsToAllBoards(): Promise<{ updated: number; skipped: string[] }> {
      return applyStyleToAllBoards((type) => buildBoardSettingsFromTheme(type));
    },

    // ── Board CRUD (delegated) ──

    async createBoard(
      name: string, type: string, settings?: Record<string, unknown>,
    ): Promise<Board | null> {
      return boardCacheStore.createBoard(name, type, settings);
    },

    /** Persists a fully-formed Board (preserves type-specific fields). */
    async persistNewBoard(board: Board): Promise<boolean> {
      return boardCacheStore.persistNewBoard(board);
    },

    /**
     * Moves the board's file into Filo's trash and closes it everywhere. The
     * toast offers Undo; Settings → Trash can restore it later.
     */
    async deleteBoard(boardId: string): Promise<boolean> {
      const name = boardCacheStore.cache[boardId]?.board.name ?? 'Board';
      const trashed = await boardCacheStore.deleteBoard(boardId);
      if (!trashed) return false;
      await cleanupAfterBoardRemoved(boardId);
      toastMovedToTrash(
        name,
        async () => {
          if (await restoreTrashedItem(name, trashed.boardPath, trashed.trashId)) boardCacheStore.putBackBoardView(boardId, trashed.view);
        },
        trashed.rescueDir
          ? `Its last changes couldn't be saved to the board file first; a copy with them is in ${trashed.rescueDir}.`
          : undefined,
      );
      return true;
    },

    /**
     * Reconciles cache + workspace state when a board's `.board.json` is
     * no longer on disk — typically because an external process (OS file
     * explorer, git, sync client) deleted it, or because the in-app vault
     * sidebar `delete` removed the file directly. The on-disk file is
     * already gone (or never existed), so this path SKIPS the
     * `board:delete` IPC and just drops the in-memory traces:
     *
     *   - boardCache + boardPaths + project.boards entry (via
     *     boardCacheStore.removeBoardFromCache, which also cancels any
     *     pending debounced write and removes the viewport entry);
     *   - any open tab pointing at the board (closes silently — the
     *     change listener writes the updated workspace.json so the next
     *     vault open doesn't try to resurrect it);
     *   - the per-board undo/redo stack.
     *
     * Returns true when an entry was found and cleaned. False is a no-op
     * (board wasn't tracked here, or already cleaned by a prior call —
     * the watcher + sidebar-delete + BoardBrowser paths can all race for
     * the same boardId on the same gesture).
     */
    cleanupMissingBoard(boardId: string): boolean {
      const removed = boardCacheStore.removeBoardFromCache(boardId);
      if (!removed) return false;
      // Fire-and-forget the tab close — callers that need to observe the
      // close landing should await `cleanupMissingBoardAsync` instead.
      void cleanupAfterBoardRemoved(boardId);
      return true;
    },

    /**
     * Awaitable variant of `cleanupMissingBoard` — returns a promise that
     * resolves once the board's pending markdown/frontmatter writes have
     * drained AND its open tabs have actually unmounted. Used by the
     * vault-folder delete path where the user-visible state must reflect
     * the closed tab before the function returns.
     */
    async cleanupMissingBoardAsync(boardId: string): Promise<boolean> {
      const removed = boardCacheStore.removeBoardFromCache(boardId);
      if (!removed) return false;
      await cleanupAfterBoardRemoved(boardId);
      return true;
    },

    // ── Tile CRUD (slice) ──
    ...tilesSlice,

    // ── Connection CRUD (slice) ──
    ...connectionsSlice,

    // ── Frame CRUD (slice) ──
    ...framesSlice,

    // ── Waypoints + groups (slice) ──
    ...waypointsGroupsSlice,

    // ── History-aware CRUD (slice) ──
    ...historySlice,
  };

  // Mind-map `waypoints` / `groups` must be live getters off `currentBoard`.
  // The slice exposes them as getters too, but `...waypointsGroupsSlice`
  // invokes each getter once during facade construction (when `currentBoard`
  // is still null) and copies the resulting empty arrays as static
  // properties — every later read returns the stale empty array. Defining
  // the getters here, on the facade itself, replaces those frozen values
  // with live property descriptors.
  Object.defineProperties(store, {
    waypoints: {
      enumerable: true,
      configurable: true,
      get() {
        if (!currentBoard || currentBoard.type !== 'mindmap') return [];
        return (currentBoard as MindMapBoard).waypoints ?? [];
      },
    },
    groups: {
      enumerable: true,
      configurable: true,
      get(): TileGroup[] {
        if (!currentBoard || currentBoard.type !== 'mindmap') return [];
        return (currentBoard as MindMapBoard).groups ?? [];
      },
    },
  });

  return store;
}

/**
 * Type of the per-scope board store, derived from the factory's return
 * type. `waypoints` and `groups` are present in the type because the
 * waypoints/groups slice declares them as getters — the spread surfaces
 * those as regular properties at the type level. The runtime
 * `Object.defineProperties` call in the factory redefines them as *live*
 * getters (the spread otherwise freezes them at construction time).
 */
export type BoardScopeBoard = ReturnType<typeof createBoardScopeBoard>;

/**
 * Global facade — every property access delegates to the active pane's
 * board scope. Workspace-level call sites keep importing `boardStore` and
 * get the active scope's board view transparently.
 */
export const boardStore: BoardScopeBoard = makeFacade(() => getActiveScope().board);

// Re-export Command type for downstream consumers that import it from board.svelte.
export type { Command };
