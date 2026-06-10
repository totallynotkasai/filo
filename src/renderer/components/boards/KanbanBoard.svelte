<script lang="ts">
  /**
   * KanbanBoard — V7 column-based layout backed by `tileDefs` + per-column
   * `tilePlacements`. Each placement points at a tile def in
   * `boardCacheStore.cache[boardId].tileDefs`; per-element style overrides
   * cascade through `effectiveStyle`. Tiles' frontmatter (tags, properties)
   * comes from the backing `.md` files via `vaultIndexStore` so the same
   * file rendered as a Mind Map text tile and as a Kanban tile stay in sync.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, isActiveScope, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';

  // Per-pane scope; aliases preserve existing call sites. See boardScope.svelte.ts.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  let { tabId }: { tabId?: string } = $props(); // R1 (Audit-11): pane-correct via scope; accepted + ignored
  const boardStore = scope.board;
  const selectionStore = scope.selection;
  import { createId } from '../../lib/utils/ids';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import type {
    KanbanBoard as KanbanBoardType,
    KanbanTilePlacement,
    PartialKanbanCardStyle,
    Tile,
  } from '../../schema/index';
  import KanbanColumn from './KanbanColumn.svelte';
  import KanbanColumnStylePopup from './KanbanColumnStylePopup.svelte';
  import KanbanCardStylePopup from './KanbanCardStylePopup.svelte';
  import KanbanSideToolbar from './KanbanSideToolbar.svelte';
  import KanbanNewTileModal from './KanbanNewTileModal.svelte';
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import {
    effectiveColumnStyle,
    effectiveCardStyle,
    type ResolvedCardStyle,
  } from '../../lib/styles/effectiveStyle';
  import {
    inferKanbanTileType,
    buildTileDefForVaultFile,
    importKanbanFileTile,
  } from '../../lib/kanban/kanbanFileDropHandler';
  import { makeKanbanFrontmatterWriter } from '../../lib/kanban/kanbanFrontmatterWriter';
  import { makeKanbanTileCreator } from '../../lib/kanban/kanbanTileCreation';
  import { computeKanbanInsertIndex } from '../../lib/kanban/kanbanInsertPosition';
  import {
    KanbanFiltersAndSort,
    type KanbanLastView,
  } from '../../lib/kanban/kanbanFiltersAndSort.svelte';
  import { KanbanSavedViews } from '../../lib/kanban/kanbanSavedViews.svelte';
  import { KanbanMultiSelect } from '../../lib/kanban/kanbanMultiSelect.svelte';
  import { KanbanDragController } from '../../lib/kanban/kanbanDragController.svelte';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { registerCommandWithShortcut } from '../../core/commandRegistry';
  import KanbanFindBar from './KanbanFindBar.svelte';
  import KanbanTemplatePicker from './KanbanTemplatePicker.svelte';
  import TagEditor from '../tags/TagEditor.svelte';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { createAriaAnnouncer } from '../../lib/utils/ariaAnnouncer.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { dndzone } from 'svelte-dnd-action';
  import { historyStore, type Command } from '../../stores/history.svelte';
  import {
    AddCardCommand,
    DeleteCardCommand,
    AddColumnCommand,
    DeleteColumnCommand,
    RenameColumnCommand,
    ReorderColumnCommand,
    BatchCommand,
    UpdateKanbanColumnCommand,
    SetAllKanbanColumnsCollapsedCommand,
  } from '../../commands/index';
  import { flushAllPendingFrontmatterWrites } from '../../lib/boards/frontmatterWriteScheduler';

  let board = $derived(boardStore.current as KanbanBoardType | null);
  let columns = $derived(board?.columns ?? []);
  let settings = $derived(
    board?.settings ?? {
      backgroundColor: '',
      // Phase 1.2a — defaults align with the non-canvas board cascade
      // (kanban/tasklist/document default to 'none', mindmap defaults
      // to 'grid' via its own viewModel).
      backgroundPattern: 'none' as const,
      accentColor: ACCENT_COLOR,
    },
  );

  // Per-card cascade resolver. Walks placement.style (per-element layer) →
  // board.settings.defaults.card (board layer) → settings.kanban.card
  // (global layer). KanbanColumn calls this per card so each placement's
  // `style` overrides land in the resolved value <KanbanCard> consumes.
  function resolveCardStyle(
    placementStyle?: Record<string, unknown> | null,
  ): ResolvedCardStyle {
    return effectiveCardStyle(
      placementStyle ?? null,
      vaultStore.project?.settings,
      board,
    );
  }

  /**
   * Returns the column-level effective style with the column's own `style`
   * applied as the highest-priority override. Used so per-column width / colour
   * overrides actually paint without each column re-running the entire cascade
   * resolver in CSS land.
   */
  function styleForColumn(col: { style?: Record<string, unknown> | undefined }) {
    return effectiveColumnStyle(
      (col.style as Record<string, unknown> | undefined) ?? null,
      vaultStore.project?.settings,
      board,
    );
  }

  // ── Per-column / per-card style popup state ──
  let columnStylePopup = $state<{ columnId: string; style?: Record<string, unknown>; x: number; y: number } | null>(null);
  let cardStylePopup = $state<{ tileId: string; style?: Record<string, unknown>; x: number; y: number } | null>(null);
  // Tag editor popup — opened by the `tile-tag-editor` event dispatched from
  // `TileHeader.svelte` (the icon button rendered inside every card chrome
  // via `<TileContainer flowLayout=true>`). Same pattern as Mind Map / Task
  // List wiring so kanban cards share the unified TagEditor component.
  let tagEditorPopup = $state<{ tileId: string; x: number; y: number } | null>(null);
  function openColumnStyle(col: { id: string; style?: Record<string, unknown> }, x: number, y: number) {
    columnStylePopup = { columnId: col.id, style: col.style, x, y };
  }
  function openCardStyle(tileId: string, style: Record<string, unknown> | undefined, x: number, y: number) {
    cardStylePopup = { tileId, style, x, y };
  }

  // ── Cached tile views for the active board ──
  let allTilesById = $derived<Record<string, Tile>>(
    board ? boardCacheStore.getFullTilesForKanbanBoard(board.id) : {},
  );

  // ── Filter & sort UI state (non-persistent) ──
  //
  // Owned by `KanbanFiltersAndSort`. Instantiated below after `findQuery` /
  // `cacheVersion` are declared so the accessor closures see valid
  // references. Hydration timing stays in the host since it depends on
  // `hydratedForBoardId` (board-switch tracking) and a debounced
  // persistence $effect.

  // ── Find bar state ──
  let findBarOpen = $state(false);
  let findQuery = $state('');

  // ── Reactivity tick: bump after a cache mutation so derived state
  // recomputes. See `tickAndPersist` comment further down for the proxy
  // bridge rationale.
  let cacheVersion = $state(0);

  const filtersAndSort = new KanbanFiltersAndSort({
    getBoardColumns: () => columns,
    getAllTilesById: () => allTilesById,
    getFindQuery: () => findQuery,
    getCacheVersion: () => cacheVersion,
  });

  // Root element ref — used by `handleBoardKeydown` to scope its
  // window-level listener to events targeting this instance, so multi-tab
  // layouts don't run every mounted Kanban board's handler on every keypress.
  let boardRootEl: HTMLDivElement | null = $state(null);

  // ── Drag state for tile move + column reorder ──
  // Owned by `KanbanDragController`. The mirror sync $effect below tracks
  // canonical `columns` and forwards it via `dragController.syncColumns`
  // — keeping the effect inside the host because effects fired from external
  // class constructors don't unwrap reliably.
  const dragController = new KanbanDragController({
    getBoardId: () => board?.id ?? null,
    getColumns: () => columns,
    getAllTilesById: () => allTilesById,
    getActiveSortBy: () => filtersAndSort.activeSortBy,
    reorderColumns: (orderedIds) => reorderColumns(orderedIds),
    tickAndPersist,
    getSelectedTileIds: () => selectionStore.selectedIds,
    getFlatVisibleTileIds: () => flatVisibleTileIds,
  });

  // Sync the dnd mirror only when the canonical `columns` reference changes
  // (board switch, external file watcher, undo/redo, or our own finalize
  // commit). Tracking `columnDragDisabled` here would re-fire the effect on
  // every flag flip, and could overwrite the just-committed mirror with
  // stale `columns` before the store mutation propagates — that was the
  // snap-back bug. `untrack` keeps the read of `columnDragDisabled` and the
  // write to `dndColumns` outside the dependency graph.
  $effect(() => {
    const c = columns;
    untrack(() => dragController.syncColumns(c));
  });

  // Per-column card-dndzone items mirror. Mirrors the column-reorder sync
  // above: track canonical `columns` and rebuild `dndCardsByColumn`. The
  // controller skips this while a drag is in flight so the in-progress
  // items aren't snap-reset mid-gesture.
  $effect(() => {
    const c = columns;
    untrack(() => dragController.syncCards(c));
  });

  // ── New-tile modal state ──
  let newTileColumnId = $state<string | null>(null);
  let templatePickerColumnId = $state<string | null>(null);

  // ── Reactivity tick: bump local cacheVersion after cache mutations ──
  //
  // Phase R7 (Reactive BoardScope, 2026-05-26) — `boardStore.current` is now
  // a `$derived` view of `boardCacheStore.cache[currentBoardId].board`. The
  // pre-R7 dual-proxy bridge (`boardStore.setBoard({ ...cached.board }, ...)`)
  // is no longer required to propagate cache mutations to the active-board
  // derivation chain.
  //
  // `cacheVersion` is retained as a coarse local signal for consumers
  // (filter/sort controller, card-flow derivations) that key off it rather
  // than walking the deep cache proxy. Removing it is a separate cleanup; the
  // bump remains cheap and harmless.

  function tickAndPersist(): void {
    cacheVersion++;
  }

  // ── Screen-reader announcement region ──
  //
  // Phase C item 14: Toasts cover most bulk actions (Toast.svelte already
  // wires aria-live), but several Kanban mutations are silent — column
  // add/delete/rename, card add/move/delete on the row level. The local
  // announcement state fills that gap so SR users get parity with the
  // visible UI without duplicating toast traffic.
  // Auto-clearing aria-live announcer; announcer.dispose() in onDestroy (Audit 5.3).
  const announcer = createAriaAnnouncer();
  function announce(message: string): void {
    announcer.announce(message);
  }

  // ── Column lifecycle ──

  function addColumn() {
    if (!board) return;
    const id = createId();
    const colFontSize = vaultStore.project?.settings?.general?.defaultBoardFontSize?.kanbanColumnTitle;
    historyStore.execute(
      new AddColumnCommand(board.id, {
        id,
        title: 'New Column',
        ...(colFontSize !== undefined && { style: { fontSizeTitle: colFontSize } }),
      }),
    );
    tickAndPersist();
    announce('Column added');
  }

  function renameColumn(columnId: string, title: string) {
    if (!board) return;
    const col = columns.find((c) => c.id === columnId);
    if (!col || col.title === title) return;
    historyStore.execute(new RenameColumnCommand(board.id, columnId, col.title, title));
    tickAndPersist();
    announce(`Column renamed to ${title}`);
  }

  function deleteColumn(columnId: string) {
    if (!board) return;
    const col = columns.find((c) => c.id === columnId);
    if (!col) return;
    const tileCount = (col.tilePlacements ?? []).length;
    uiStore.openConfirm({
      title: `Delete column "${col.title}"?`,
      body: tileCount === 0
        ? 'This column will be removed. You can undo via the toolbar history if you change your mind.'
        : `This column has ${tileCount} tile placement(s). Removing the column drops those placements from this board; the backing vault files are preserved.`,
      confirmLabel: 'Delete column',
      danger: true,
      onConfirm: () => {
        if (!board) return;
        historyStore.execute(new DeleteColumnCommand(board.id, columnId, col.title));
        tickAndPersist();
        announce(`Column "${col.title}" removed`);
      },
    });
  }

  /**
   * Phase 7 / 7.2 — captures (collapsed, wipLimit, width) shape so the
   * UpdateKanbanColumnCommand inverse can restore the exact prior column
   * state (including absent fields, which read as null).
   */
  function snapshotColumnState(
    col: { collapsed?: boolean; wipLimit?: number | null; style?: Record<string, unknown> } | undefined,
  ): { collapsed: boolean; wipLimit: number | null; width: number | null } {
    if (!col) return { collapsed: false, wipLimit: null, width: null };
    const style = (col.style ?? {}) as Record<string, unknown>;
    const w = style.width;
    return {
      collapsed: col.collapsed ?? false,
      wipLimit: typeof col.wipLimit === 'number' ? col.wipLimit : null,
      width: typeof w === 'number' ? w : null,
    };
  }

  function toggleColumnCollapsed(columnId: string) {
    if (!board) return;
    const col = columns.find((c) => c.id === columnId);
    if (!col) return;
    const before = snapshotColumnState(col);
    const after = { ...before, collapsed: !before.collapsed };
    historyStore.execute(
      new UpdateKanbanColumnCommand(
        board.id,
        columnId,
        before,
        after,
        before.collapsed ? 'Expand column' : 'Collapse column',
      ),
    );
    tickAndPersist();
  }

  function setColumnWipLimit(columnId: string, wipLimit: number | null) {
    if (!board) return;
    const col = columns.find((c) => c.id === columnId);
    if (!col) return;
    const before = snapshotColumnState(col);
    if (before.wipLimit === wipLimit) return;
    const after = { ...before, wipLimit };
    historyStore.execute(
      new UpdateKanbanColumnCommand(board.id, columnId, before, after, 'Update WIP limit'),
    );
    tickAndPersist();
  }

  function collapseAll() {
    if (!board) return;
    const previousStates: Record<string, boolean> = {};
    for (const c of columns) previousStates[c.id] = c.collapsed ?? false;
    historyStore.execute(
      new SetAllKanbanColumnsCollapsedCommand(board.id, true, previousStates),
    );
    tickAndPersist();
  }

  function expandAll() {
    if (!board) return;
    const previousStates: Record<string, boolean> = {};
    for (const c of columns) previousStates[c.id] = c.collapsed ?? false;
    historyStore.execute(
      new SetAllKanbanColumnsCollapsedCommand(board.id, false, previousStates),
    );
    tickAndPersist();
  }

  function reorderColumns(orderedIds: string[]) {
    if (!board) return;
    const before = columns.map((c) => c.id);
    if (before.length === orderedIds.length && before.every((id, i) => id === orderedIds[i])) return;
    historyStore.execute(new ReorderColumnCommand(board.id, before, orderedIds));
    tickAndPersist();
  }

  /**
   * Keyboard column reorder (a11y). Looks up the column's current index in
   * the canonical `columns` array and swaps with its neighbour. No-op at
   * the boundaries.
   */
  function moveColumnByKey(columnId: string, direction: -1 | 1) {
    if (!board) return;
    const ids = columns.map((c) => c.id);
    const idx = ids.indexOf(columnId);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    const a = next[idx];
    const b = next[target];
    if (a === undefined || b === undefined) return; // idx/target bounds-checked above
    next[idx] = b;
    next[target] = a;
    reorderColumns(next);
  }

  function setColumnWidth(columnId: string, width: number | null) {
    if (!board) return;
    const col = columns.find((c) => c.id === columnId);
    if (!col) return;
    const before = snapshotColumnState(col);
    if (before.width === width) return;
    const after = { ...before, width };
    historyStore.execute(
      new UpdateKanbanColumnCommand(board.id, columnId, before, after, 'Resize column'),
    );
    tickAndPersist();
  }

  // ── Tile lifecycle ──

  function openNewTilePicker(columnId: string) {
    newTileColumnId = columnId;
  }

  function closeNewTilePicker() {
    newTileColumnId = null;
  }

  function closeTemplatePicker() {
    templatePickerColumnId = null;
  }

  const tileCreator = makeKanbanTileCreator({
    getBoard: () => board,
    getNewTileColumnId: () => newTileColumnId,
    setNewTileColumnId: (next) => { newTileColumnId = next; },
    getTemplatePickerColumnId: () => templatePickerColumnId,
    setTemplatePickerColumnId: (next) => { templatePickerColumnId = next; },
    tickAndPersist,
    announce,
  });

  const createTile = tileCreator.createTile;
  const createTileFromTemplate = tileCreator.createTileFromTemplate;

  function deleteTile(tileId: string) {
    if (!board) return;
    const title = allTilesById[tileId]?.title ?? 'card';
    historyStore.execute(new DeleteCardCommand(board.id, tileId));
    tickAndPersist();
    announce(`Card removed: ${title}`);
  }

  // ── Tile drag/drop + column reorder live in `KanbanDragController` ──

  // ── Column-level OS / vault file drop ──

  async function onColumnFileDrop(e: DragEvent, columnId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!board) return;

    const vaultRoot = vaultStore.path;
    if (!vaultRoot) {
      uiStore.toast('Open a vault first to import files', 'info', 2000);
      return;
    }

    const placements = (columns.find((c) => c.id === columnId)?.tilePlacements ?? []) as KanbanTilePlacement[];
    // Resolve the pointer-Y once up-front so all cards in this drop batch
    // anchor to the same insertion index (subsequent files in a multi-OS
    // drop get appended after the first via `+ cmds.length`).
    const baseInsertIndex = computeKanbanInsertIndex(columnId, e.clientY, placements.length);
    const cmds: Command[] = [];

    // Vault-sidebar drag carries application/x-vault-file
    const vaultFileData = e.dataTransfer?.getData('application/x-vault-file');
    if (vaultFileData) {
      try {
        const { path: filePath, name, extension } = JSON.parse(vaultFileData);
        const def = await buildTileDefForVaultFile({
          filePath,
          name,
          extension,
          vaultRoot,
          board,
          allTilesById,
        });
        if (def) {
          cmds.push(new AddCardCommand(board.id, columnId, def, baseInsertIndex + cmds.length));
        }
      } catch (err) {
        reportError('KanbanBoard.vault-drop', err, 'Failed to import vault file into Kanban');
      }
    }

    // OS file drops
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      try {
        const fileExt = (file.name.split('.').pop() || '').toLowerCase();
        // Electron 32+ removed the legacy `path` property from `File`. Read
        // it via a narrow projection and fall back to the preload bridge
        // (`webUtils.getPathForFile`) so newer Electron versions still
        // resolve the source path.
        const fileWithPath = file as File & { path?: unknown };
        let sourcePath: string | undefined =
          typeof fileWithPath.path === 'string' ? fileWithPath.path : undefined;
        if (!sourcePath) {
          try {
            sourcePath = window.filo.getPathForFile?.(file) ?? undefined;
          } catch {
            /* bridge unavailable in some windows */
          }
        }
        if (!sourcePath) continue;
        const tileType = inferKanbanTileType(file.type, fileExt);
        if (!tileType) {
          uiStore.toast(`Skipped ${file.name} — unsupported in Kanban`, 'warning', 2000);
          continue;
        }
        const tileId = createId();
        const def = await importKanbanFileTile({
          type: tileType,
          tileId,
          sourcePath,
          fileName: file.name,
          fileExt,
          vaultRoot,
          board,
          allTilesById,
          refreshTree: async () => { await vaultStore.refreshTree(); },
        });
        if (def) {
          cmds.push(new AddCardCommand(board.id, columnId, def, baseInsertIndex + cmds.length));
        }
      } catch (err) {
        reportError('KanbanBoard.os-drop', err, `Failed to import "${file.name}" into Kanban`);
      }
    }

    if (cmds.length > 0) {
      historyStore.execute(
        cmds.length === 1
          ? cmds[0]! // length === 1 guarantees index 0 is defined
          : new BatchCommand(`Import ${cmds.length} cards`, cmds),
      );
      tickAndPersist();
    }
  }

  // ── Find bar setters (state declared at top alongside filtersAndSort) ──

  function openFindBar() {
    findBarOpen = true;
  }

  function closeFindBar() {
    findBarOpen = false;
    findQuery = '';
  }

  function setFindQuery(q: string) {
    findQuery = q;
  }

  // ── Frontmatter writer (per text-tile card) ──
  //
  // Extracted into `lib/kanban/kanbanFrontmatterWriter.ts` as a factory that
  // closes over `getBoard` / `getAllTilesById` so it tracks the live reactive
  // board state. Mutations land in documentStore.mergeFrontmatter (shared
  // live cache), then a 300ms debounce assembles the .md and writes via
  // trackComponentWrite so the save-error pipeline catches failures.

  const fmWriter = makeKanbanFrontmatterWriter({
    getBoard: () => board,
    getAllTilesById: () => allTilesById,
    bumpCacheVersion: () => { cacheVersion++; },
    tickAndPersist,
  });

  const setTileDueDate = fmWriter.setTileDueDate;
  const setTilePriority = fmWriter.setTilePriority;
  const openTileAsDocument = fmWriter.openTileAsDocument;
  const pickCoverImageForTile = fmWriter.pickCoverImageForTile;
  const clearCoverImageForTile = fmWriter.clearCoverImageForTile;

  // ── Find bar shortcut (`/` when no input is focused) ──

  function handleBoardKeydown(e: KeyboardEvent) {
    // Scope to this instance's DOM subtree — a multi-tab layout can mount
    // more than one Kanban board, and a window-level listener would fire
    // every mounted handler on every keypress.
    const tgt = e.target as Node | null;
    if (!boardRootEl || !tgt || !boardRootEl.contains(tgt)) return;
    if (e.key === '/' && !findBarOpen && !isEditableTextTarget(e.target)) {
      e.preventDefault();
      openFindBar();
    }
    if (e.key === 'Escape' && !isEditableTextTarget(e.target) && selectionStore.count > 0) {
      multiSelect.clearSelectionAndAnchor();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')
        && !isEditableTextTarget(e.target)
        && selectionStore.count > 0) {
      e.preventDefault();
      multiSelect.deleteSelectedTiles();
    }

    // Phase 6.1 (IMPLEMENTATION_PLAN_2026-05-27) — arrow nav across cards
    // and columns. The focus model uses `selectionStore.selectedIds` as
    // the focused card surface (single-selection only — shift-arrow extend
    // is not implemented on Kanban yet). Arrow direction maps as:
    //   • Up / Down  — neighbour card in the same column
    //   • Left / Right — same-row card in the previous / next column
    //                    (or first card in that column if the row index
    //                    overshoots its placement count)
    if (
      !isEditableTextTarget(e.target)
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && !e.shiftKey
      && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      const ids = [...selectionStore.selectedIds];
      const flat = flatVisibleTileIds;
      if (flat.length === 0) return;
      if (ids.length === 0) {
        e.preventDefault();
        const first = flat[0];
        if (first) selectionStore.select(first); // flat non-empty (checked above)
        announce('Card focused');
        return;
      }
      const focusedId = ids[ids.length - 1];
      if (focusedId === undefined) return; // ids non-empty here
      const focusInfo = findColumnAndIndex(focusedId);
      if (!focusInfo) return;
      const target = neighbourTileId(focusInfo, e.key);
      if (target && target !== focusedId) {
        e.preventDefault();
        selectionStore.select(target);
        announce('Card focused');
      }
      return;
    }

    // Enter — open the focused card's backing document in a new tab.
    if (
      e.key === 'Enter'
      && !isEditableTextTarget(e.target)
      && !e.ctrlKey
      && !e.metaKey
      && !e.shiftKey
      && !e.altKey
      && selectionStore.count === 1
    ) {
      const ids = [...selectionStore.selectedIds];
      const firstId = ids[0];
      if (firstId === undefined) return; // count === 1 checked above
      const tile = allTilesById[firstId];
      if (!tile || tile.type !== 'text') return;
      e.preventDefault();
      openTileAsDocument(firstId);
      return;
    }
  }

  /**
   * Phase 6.1 helper — given a focused tileId, returns the column it sits
   * in (by columnId) AND the visible-row index within that column. Used
   * for arrow-key navigation across cards / columns.
   */
  function findColumnAndIndex(
    tileId: string,
  ): { columnId: string; rowIdx: number } | null {
    for (const col of columns) {
      const placements = filtersAndSort.visiblePlacementsForColumn(col.id);
      for (let i = 0; i < placements.length; i++) {
        if (placements[i]?.tileId === tileId) {
          return { columnId: col.id, rowIdx: i };
        }
      }
    }
    return null;
  }

  /**
   * Phase 6.1 helper — picks the neighbour tileId in the requested arrow
   * direction. Returns null at board boundaries (top of first column,
   * etc.) so the caller can decline to move focus.
   */
  function neighbourTileId(
    from: { columnId: string; rowIdx: number },
    key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
  ): string | null {
    const colIdx = columns.findIndex((c) => c.id === from.columnId);
    if (colIdx < 0) return null;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const placements = filtersAndSort.visiblePlacementsForColumn(from.columnId);
      const nextIdx = key === 'ArrowUp' ? from.rowIdx - 1 : from.rowIdx + 1;
      if (nextIdx < 0 || nextIdx >= placements.length) return null;
      return placements[nextIdx]?.tileId ?? null;
    }
    // Horizontal — walk left/right past empty columns until a visible card
    // is found. Clamp the row index against each column's visible length.
    let probe = colIdx + (key === 'ArrowRight' ? 1 : -1);
    while (probe >= 0 && probe < columns.length) {
      const col = columns[probe];
      if (!col) break; // probe bounds-checked by the while condition
      const placements = filtersAndSort.visiblePlacementsForColumn(col.id);
      if (placements.length > 0) {
        const targetIdx = Math.min(from.rowIdx, placements.length - 1);
        return placements[targetIdx]?.tileId ?? null;
      }
      probe += key === 'ArrowRight' ? 1 : -1;
    }
    return null;
  }

  // ── Tag editor event wiring ──
  //
  // TileHeader (rendered inside every card via TileContainer) dispatches a
  // `tile-tag-editor` custom event when its tag icon is clicked. Listen on
  // `boardRootEl` so a multi-board layout only fires this instance's popup.
  $effect(() => {
    const el = boardRootEl;
    if (!el) return;
    function handleTagEditor(raw: Event) {
      const detail = (raw as CustomEvent<{ tileId: string; x: number; y: number }>).detail;
      tagEditorPopup = { tileId: detail.tileId, x: detail.x, y: detail.y };
    }
    el.addEventListener('tile-tag-editor', handleTagEditor);
    return () => el.removeEventListener('tile-tag-editor', handleTagEditor);
  });

  // Phase C / C.11 — capture-phase Escape handler for the tag popup.
  //
  // The previous overlay-onkeydown only fired when focus was on the
  // overlay; once the user clicked into the TagEditor's input, Escape
  // was swallowed by the input element's own focus handling and the
  // popup wouldn't close. Window-level capture sees the key before
  // any focused descendant can stop propagation, so Escape closes
  // the popup regardless of where focus sits.
  $effect(() => {
    if (!tagEditorPopup) return;
    function onKeydownCapture(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      tagEditorPopup = null;
    }
    window.addEventListener('keydown', onKeydownCapture, true);
    return () => window.removeEventListener('keydown', onKeydownCapture, true);
  });

  // ── Style popup event wiring ──
  //
  // The gear icon in TileHeader dispatches `tile-style-popup` with the tile
  // and anchor coords. Without this listener the click on every Kanban card's
  // Style button was a no-op (the MindMap board has the matching listener).
  // Resolve the card's placement so its per-card style override travels into
  // the popup as the initial value, then route into the same `openCardStyle`
  // helper the right-click context menu uses.
  $effect(() => {
    const el = boardRootEl;
    if (!el) return;
    function handleStylePopup(raw: Event) {
      const detail = (raw as CustomEvent<{ tile: Tile; x: number; y: number }>).detail;
      const tileId = detail.tile.id;
      let placementStyle: Record<string, unknown> | undefined;
      for (const col of columns) {
        const placements = (col.tilePlacements ?? []) as Array<{ tileId: string; style?: Record<string, unknown> }>;
        const placement = placements.find((p) => p.tileId === tileId);
        if (placement) {
          placementStyle = placement.style;
          break;
        }
      }
      openCardStyle(tileId, placementStyle, detail.x, detail.y);
    }
    el.addEventListener('tile-style-popup', handleStylePopup);
    return () => el.removeEventListener('tile-style-popup', handleStylePopup);
  });

  // ── Kanban-scoped keyboard shortcuts ──
  //
  // Registered on mount and unregistered on destroy so the shortcuts only
  // fire while a Kanban board is the active surface. Both commands have
  // commandIds so they show up in the Keyboard Shortcuts settings panel
  // and can be rebound by the user.
  let unregisterAddTile: (() => void) | null = null;
  let unregisterAddColumn: (() => void) | null = null;

  // Active-pane guard for the board-scoped shortcuts below: a split view can
  // mount two boards sharing a bare key (`n` is also Task List's), so gating on
  // the focused pane lets the key handler skip inactive panes. See hotkeys.ts.
  const isActivePane = (): boolean => isActiveScope(scope);

  function shortcutAddTile() {
    if (!board) return;
    const targetId = newTileColumnId
      ?? (columns[0]?.id ?? null);
    if (!targetId) return;
    openNewTilePicker(targetId);
  }

  function shortcutAddColumn() {
    addColumn();
  }

  onMount(() => {
    // The board no longer registers its own flusher — `flushAllMarkdownWrites`
    // (in the gateway) drains `flushAllPendingFrontmatterWrites` as part of
    // its parallel drain step. Ctrl+S / tab close / vault swap all funnel
    // through the gateway flush and pick up kanban field updates without
    // this component participating in the registry.
    window.addEventListener('keydown', handleBoardKeydown);
    unregisterAddTile = registerCommandWithShortcut({
      name: 'kanban:add-tile',
      label: 'Kanban: Add tile',
      description: 'Kanban: Add tile',
      binding: { key: 'n' },
      enabled: isActivePane,
      execute: shortcutAddTile,
    });
    unregisterAddColumn = registerCommandWithShortcut({
      name: 'kanban:add-column',
      label: 'Kanban: Add column',
      description: 'Kanban: Add column',
      binding: { key: 'n', shift: true },
      enabled: isActivePane,
      execute: shortcutAddColumn,
    });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleBoardKeydown);
    unregisterAddTile?.();
    unregisterAddTile = null;
    unregisterAddColumn?.();
    unregisterAddColumn = null;
    dragController.dispose();
    announcer.dispose();
    // Drain any queued frontmatter writes so a board close during the
    // 300ms debounce window doesn't lose the user's last field edit.
    void flushAllPendingFrontmatterWrites();
  });

  // ── Filtering / sorting (applied per column at render time) ──
  //
  // Filter / sort logic + state lives in `KanbanFiltersAndSort` (instantiated
  // at the top of the script). Visible-placements derivation is exposed as
  // `filtersAndSort.visiblePlacementsForColumn(columnId)`.

  const vaultPathForTile = fmWriter.vaultPathForTile;

  // ── lastView persistence ──
  // Hydrate transient filter/sort state from `settings.lastView` on board
  // open; debounced effect persists changes back. Pattern mirrors
  // per-board viewport persistence. Host keeps the effects because they
  // depend on `hydratedForBoardId` (per-board hydration tracking).

  let hydratedForBoardId = $state<string | null>(null);

  $effect(() => {
    const id = board?.id;
    if (!id || id === hydratedForBoardId) return;
    untrack(() => {
      const lv = ((settings as Record<string, unknown>).lastView ?? null) as
        | KanbanLastView
        | null;
      filtersAndSort.hydrateFromLastView(lv);
      hydratedForBoardId = id;
    });
  });

  let lastViewPersistTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Track all three so the effect re-runs on any change.
    const sortBy = filtersAndSort.activeSortBy;
    const tags = filtersAndSort.activeFilterTags;
    const prop = filtersAndSort.activeFilterProp;
    const id = board?.id;
    if (!id || id !== hydratedForBoardId) return;
    if (lastViewPersistTimer) clearTimeout(lastViewPersistTimer);
    lastViewPersistTimer = setTimeout(() => {
      lastViewPersistTimer = null;
      // updateSettings accepts a partial that gets merged onto the
      // board's settings; pass only the lastView field, not the whole
      // settings object.
      // allow-direct-mutation: lastView is transient UI state restored on board reopen; deliberately not undoable.
      boardStore.updateSettings({
        lastView: {
          sortBy,
          filterTags: [...tags],
          filterProp: prop ? { ...prop } : null,
        },
      });
    }, 300);

    // 6.1.R2 (follow-up) — tear the debounce down with the effect. Without
    // this, a board close / vault swap inside the 300 ms window fires
    // `boardStore.updateSettings` against the swapped-in board ~300 ms later.
    // The cleanup also runs before each re-arm, which is harmless (the body
    // re-clears at the top before scheduling the next write).
    return () => {
      if (lastViewPersistTimer) clearTimeout(lastViewPersistTimer);
    };
  });

  function openTagsBrowser() {
    uiStore.openModal('tags-browser');
  }

  // ── Saved views ──
  // Owned by `KanbanSavedViews`. The host wires the controller's
  // `savedViews` derivation through `settings`, and its `applyToFilters`
  // hook routes saved views back into `filtersAndSort`.

  const savedViewsController = new KanbanSavedViews({
    getBoardId: () => board?.id ?? null,
    getSettings: () => settings as Record<string, unknown>,
    getCurrentSnapshot: () => filtersAndSort.snapshot(),
    applyToFilters: (view) => filtersAndSort.applyView(view),
    tickAndPersist,
  });

  // ── Multi-select + bulk actions ──
  //
  // Selection anchor + bulk handlers live in `KanbanMultiSelect`.
  // `flatVisibleTileIds` stays in the host because the derivation reads
  // the host's filter/sort visible-placements view, which is itself
  // computed inside the host's reactive scope.

  /**
   * Flat ordered list of visible tile IDs across every column. Drives
   * Shift-click range selection — the user picks an anchor and any
   * subsequent Shift-click selects every tile between the anchor and the
   * new click in this iteration order.
   */
  let flatVisibleTileIds = $derived.by<string[]>(() => {
    const out: string[] = [];
    for (const col of columns) {
      for (const p of filtersAndSort.visiblePlacementsForColumn(col.id)) out.push(p.tileId);
    }
    return out;
  });

  // Board-wide placement lookup keyed by tileId. The Kanban render loop
  // uses this so the destination column can always resolve the dragged
  // tile's placement during a cross-column drag — at that moment the
  // canonical placement still lives in the source column, so a per-column
  // `placements.find()` would return undefined and the `{#if}` guard
  // would skip rendering, making the dragged card vanish mid-drag.
  let placementsByTileId = $derived.by<Record<string, KanbanTilePlacement>>(() => {
    const map: Record<string, KanbanTilePlacement> = {};
    for (const col of columns) {
      for (const p of (col.tilePlacements ?? []) as KanbanTilePlacement[]) {
        map[p.tileId] = p;
      }
    }
    return map;
  });

  // Set of tile IDs that should currently render (after filter+sort).
  // Paired with `placementsByTileId` to preserve filter semantics that
  // were previously encoded covertly via the missing-placement lookup.
  let visibleTileIds = $derived.by<SvelteSet<string>>(() => {
    const set = new SvelteSet<string>();
    for (const col of columns) {
      for (const p of filtersAndSort.visiblePlacementsForColumn(col.id)) set.add(p.tileId);
    }
    return set;
  });

  const multiSelect = new KanbanMultiSelect({
    selection: selectionStore,
    getBoardId: () => board?.id ?? null,
    getColumns: () => columns,
    getAllTilesById: () => allTilesById,
    getFlatVisibleTileIds: () => flatVisibleTileIds,
    bumpCacheVersion: () => { cacheVersion++; },
    tickAndPersist,
    ensureSeededFm: (tile) => fmWriter.ensureSeededFm(tile),
    vaultPathForTile,
  });

  // ── Floating-vault offset ──
  //
  // When the vault sidebar is in floating mode (`uiStore.sidebarFloating`),
  // its `FloatingVaultPanel` is `position: fixed` and overlays whatever's
  // beneath it — including the left edge of the Kanban columns. Shift the
  // columns right of the panel ONLY when the panel's left edge sits in the
  // viewport's left half; if the user has dragged the panel to the right
  // side of the screen, no shift is needed.
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 0);
  $effect(() => {
    const onResize = (): void => { viewportWidth = window.innerWidth; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  let floatingShiftPx = $derived.by<number>(() => {
    if (!uiStore.sidebarFloating) return 0;
    const { x, width } = uiStore.floatingBounds;
    if (x >= viewportWidth / 2) return 0;
    return Math.max(0, x + width + 16);
  });

  let dockedShiftPx = $derived.by<number>(() => {
    if (uiStore.sidebarFloating || !uiStore.sidebarOpen) return 0;
    return uiStore.sidebarWidth;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!--
  Phase 6.1 (IMPLEMENTATION_PLAN_2026-05-27) — keyboard-operable Kanban.
  `role="application"` + `tabindex="0"` makes the surface a screen-reader
  application widget; the per-handler keyboard shortcuts (N / Shift+N /
  Arrow keys / Enter / Delete / Escape / "/") are documented inside
  `handleBoardKeydown` above and registered through `commandRegistry` so
  they appear in the Keyboard Shortcuts settings panel.
-->
<div
  class="kanban-board"
  bind:this={boardRootEl}
  role="application"
  aria-label="Kanban board"
  aria-roledescription="Kanban board. Arrow keys navigate cards, Enter opens, N adds a card, Shift+N adds a column, Delete removes."
  tabindex="0"
  onclick={(e) => multiSelect.clearSelectionOnBoardClick(e)}
>
  <BoardBackground
    pattern={settings.backgroundPattern ?? vaultStore.project?.settings?.kanban?.backgroundPattern}
    bgColor={settings.backgroundColor}
  />

  {#if findBarOpen}
    <KanbanFindBar query={findQuery} onQueryChange={setFindQuery} onClose={closeFindBar} />
  {/if}
  <div class="kanban-track" style:padding-left="{24 + floatingShiftPx + dockedShiftPx}px">
    <div
      class="kanban-columns"
      use:dndzone={{
        items: dragController.dndColumns,
        dragDisabled: dragController.columnDragDisabled,
        flipDurationMs: 220,
        type: 'kanban-columns',
        dropTargetStyle: {},
        transformDraggedElement: dragController.transformDraggedColumn,
      }}
      onconsider={dragController.onConsiderColumns}
      onfinalize={dragController.onFinalizeColumns}
    >
      {#each dragController.dndColumns as column (column.id)}
        <div class="kanban-column-wrapper">
          <KanbanColumn
            column={{ id: column.id, title: column.title, collapsed: column.collapsed, wipLimit: column.wipLimit }}
            placements={filtersAndSort.visiblePlacementsForColumn(column.id)}
            {placementsByTileId}
            {visibleTileIds}
            dragTileId={dragController.dragTileId}
            dragBlockIds={dragController.dragBlockIds}
            clearStaleDndCardStyles={dragController.clearStaleDndCardStyles}
            cardItems={dragController.dndCardsByColumn[column.id] ?? []}
            tilesById={allTilesById}
            accentColor={settings.accentColor}
            columnStyle={styleForColumn(column)}
            {resolveCardStyle}
            totalCount={(column.tilePlacements ?? []).length}
            filterActive={filtersAndSort.isFilterActive()}
            cardDragDisabled={dragController.cardDragDisabled}
            cardFlipDurationMs={dragController.cardFlipDurationMs}
            onRename={(title) => renameColumn(column.id, title)}
            onDelete={() => deleteColumn(column.id)}
            onAddTile={() => openNewTilePicker(column.id)}
            onDeleteTile={(tileId) => deleteTile(tileId)}
            onCardPointerDown={dragController.onCardPointerDown}
            onConsiderCards={(e) => dragController.onConsiderCards(column.id, e)}
            onFinalizeCards={(e) => dragController.onFinalizeCards(column.id, e)}
            transformDraggedCard={dragController.transformDraggedCard}
            onColumnFileDrop={(e) => onColumnFileDrop(e, column.id)}
            onColumnHeaderPointerDown={dragController.onColumnHeaderPointerDown}
            onToggleCollapse={() => toggleColumnCollapsed(column.id)}
            onSetDueDate={setTileDueDate}
            onSetPriority={setTilePriority}
            onPickCoverImage={pickCoverImageForTile}
            onClearCoverImage={clearCoverImageForTile}
            onSetWipLimit={(limit) => setColumnWipLimit(column.id, limit)}
            onTileClick={(e, tileId) => multiSelect.handleTileClick(e, tileId)}
            onBulkContextMenu={(e, tileId) => multiSelect.openBulkContextMenu(e, tileId)}
            onOpenAsDocument={openTileAsDocument}
            onMoveColumn={(dir) => moveColumnByKey(column.id, dir)}
            onOpenColumnStyle={(mx, my) => openColumnStyle(column, mx, my)}
            onOpenCardStyle={(tileId, mx, my) => {
              const placements = (column.tilePlacements ?? []) as Array<{ tileId: string; style?: Record<string, unknown> }>;
              const placement = placements.find((p) => p.tileId === tileId);
              openCardStyle(tileId, placement?.style, mx, my);
            }}
          />
        </div>
      {/each}
    </div>

    <button class="add-column-btn" onclick={addColumn}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      Add Column
    </button>
  </div>

  {#if columns.length === 0}
    <!-- Phase C / C.9 — empty-state card. Sits absolute over the board so
         it doesn't interfere with the "Add Column" dashed button (still
         visible for users who know about it). The centered card gives
         a first-time user a clear next step without having to spot the
         dashed corner. -->
    <div class="kanban-empty-state" role="status">
      <h3 class="empty-state-headline">No columns yet</h3>
      <p class="empty-state-subhead">Columns group your tasks. Add one to get started.</p>
      <button class="empty-state-cta" onclick={addColumn}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add column
      </button>
    </div>
  {/if}

  {#if uiStore.boardToolbarVisible}
    <KanbanSideToolbar
      onCollapseAll={collapseAll}
      onExpandAll={expandAll}
      onReorderColumns={(ids) => reorderColumns(ids)}
      onSetColumnWidth={setColumnWidth}
      currentColumns={columns.map((c) => ({
        id: c.id,
        title: c.title,
        width: typeof c.style?.width === 'number' ? (c.style.width as number) : null,
      }))}
      onOpenTagsBrowser={openTagsBrowser}
      activeSortBy={filtersAndSort.activeSortBy}
      onSortChange={(s) => filtersAndSort.applySortBy(s)}
      activeFilterTags={filtersAndSort.activeFilterTags}
      onFilterTagsChange={(t) => filtersAndSort.applyFilterTags(t)}
      activeFilterProp={filtersAndSort.activeFilterProp}
      onFilterPropChange={(p) => filtersAndSort.applyFilterProperty(p)}
      savedViews={savedViewsController.savedViews}
      onApplyView={(v) => savedViewsController.applySavedView(v)}
      onSaveView={(n) => savedViewsController.saveCurrentView(n)}
      onDeleteView={(id) => savedViewsController.deleteSavedView(id)}
      bind:filterMenuOpen={filtersAndSort.activeFilterMenu}
      bind:sortMenuOpen={filtersAndSort.activeSortMenu}
    />
  {/if}

  <KanbanNewTileModal
    open={newTileColumnId !== null}
    onSelect={(type) => createTile(type)}
    onClose={closeNewTilePicker}
  />

  <KanbanTemplatePicker
    open={templatePickerColumnId !== null}
    boardType="kanban"
    onSelect={(ref, content, raw) => void createTileFromTemplate(ref, content, raw)}
    onClose={closeTemplatePicker}
  />

  <!--
    Screen-reader-only live region. See announce() in the script block —
    fires on column/card add, rename, delete, where the visual UI updates
    but no toast is dispatched. Phase C item 14.
  -->
  <div class="kanban-sr-live" aria-live="polite" aria-atomic="true">{announcer.message}</div>
</div>

{#if columnStylePopup && board}
  <KanbanColumnStylePopup
    boardId={board.id}
    column={{ id: columnStylePopup.columnId, style: columnStylePopup.style }}
    x={columnStylePopup.x}
    y={columnStylePopup.y}
    onclose={() => columnStylePopup = null}
  />
{/if}

{#if cardStylePopup && board}
  <KanbanCardStylePopup
    boardId={board.id}
    tileId={cardStylePopup.tileId}
    style={cardStylePopup.style as PartialKanbanCardStyle | undefined}
    x={cardStylePopup.x}
    y={cardStylePopup.y}
    onclose={() => cardStylePopup = null}
  />
{/if}

{#if tagEditorPopup}
  <!-- Click-outside overlay sits below the popup (z 2300) so clicks inside
       the popup land on it, not on the overlay. Mirror of the Mind Map /
       Task List wiring. -->
  <div
    class="kanban-tag-popup-overlay"
    role="presentation"
    onclick={() => tagEditorPopup = null}
    onkeydown={(e) => { if (e.key === 'Escape') tagEditorPopup = null; }}
  ></div>
  <div class="kanban-tag-popup-anchor" style="position: fixed; left: {tagEditorPopup.x}px; top: {tagEditorPopup.y}px;">
    <TagEditor tileId={tagEditorPopup.tileId} onClose={() => tagEditorPopup = null} />
  </div>
{/if}

<style>
  .kanban-board {
    width: 100%;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    position: relative;
  }

  /* Screen-reader-only live region — visually hidden, always announced. */
  .kanban-sr-live {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
    padding: 0;
    margin: -1px;
  }

  .kanban-track {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 16px;
    padding: 24px;
    height: 100%;
    align-items: flex-start;
    min-width: min-content;
    /* No padding-left transition: animating a layout prop breaks the GPU-only rule (and would desync horizontal scrollWidth mid-shift). */
  }

  .kanban-columns {
    display: flex;
    gap: 16px;
    height: 100%;
    align-items: flex-start;
    min-width: min-content;
  }

  .kanban-column-wrapper {
    flex-shrink: 0;
  }

  /* The cursor-following clone, tagged via the dndzone's
     `transformDraggedElement` hook above. Lifts the column off the row so
     it visibly hangs off the user's cursor. */
  :global(.kanban-column-dragging) {
    cursor: grabbing !important;
  }
  :global(.kanban-column-dragging .kanban-column) {
    transform: rotate(2deg) scale(1.04);
    box-shadow:
      0 24px 48px rgba(0, 0, 0, 0.28),
      0 8px 16px rgba(0, 0, 0, 0.18) !important;
    opacity: 0.95;
    transition: transform 120ms ease, box-shadow 120ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.kanban-column-dragging .kanban-column) {
      transform: none;
      transition: none;
    }
  }

  /* Cursor-following card clone tagged by `transformDraggedCard`. Mirrors
     the column-drag treatment so the lifted card sits visibly above the
     column it's leaving. */
  :global(.kanban-card-dragging) {
    cursor: grabbing !important;
  }
  :global(.kanban-card-dragging .kanban-card-shell) {
    transform: rotate(1.5deg) scale(1.03);
    box-shadow:
      0 18px 36px rgba(0, 0, 0, 0.26),
      0 6px 12px rgba(0, 0, 0, 0.16) !important;
    opacity: 0.96;
    transition: transform 120ms ease, box-shadow 120ms ease;
    /* Block pointer events on the clone so the cursor-following element
       doesn't enter its own :hover state mid-drag. Without this, the
       base `.kanban-card-shell:hover` translateY(-1px) fights the drag's
       rotate+scale every frame the cursor passes over the clone — what
       reads to users as "drag jankiness" and a flicker on the footer
       hover-only buttons (priority, due-date, cover toggle). */
    pointer-events: none;
  }

  /* Footer hover-revealed buttons should stay hidden on the cursor-following
     clone — they're an interaction affordance for the static card, not
     decoration. Without this, dnd-action's transform on the cloned subtree
     can briefly trigger the parent's :hover and reveal the buttons mid-
     drag, which is what the "weird transparency on the bottom section"
     complaint was about. */
  :global(.kanban-card-dragging .card-priority-empty),
  :global(.kanban-card-dragging .card-due-btn),
  :global(.kanban-card-dragging .cover-toggle-btn) {
    opacity: 0 !important;
  }

  /* Multi-card drag badge. `data-drag-count` is stamped on the outer clone
     wrapper by `transformDraggedCard` — count is the number of extra cards
     travelling with the anchor (zero for single-card, suppressed here). */
  :global(.kanban-card-dragging[data-drag-count]:not([data-drag-count='0'])) {
    position: relative;
  }
  :global(.kanban-card-dragging[data-drag-count]:not([data-drag-count='0'])::after) {
    content: '+' attr(data-drag-count);
    position: absolute;
    top: -10px;
    right: -10px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    pointer-events: none;
    z-index: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.kanban-card-dragging .kanban-card-shell) {
      transform: none;
      transition: none;
    }
  }

  .add-column-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-radius: 8px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    border: 1px dashed var(--ui-border);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;
    min-height: 44px;
  }

  /* Phase C / C.9 — first-time empty-state card. Centred over the board
     when there are no columns; the "Add Column" dashed button stays in
     the track so the existing affordance isn't removed. */
  .kanban-empty-state {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 28px 32px;
    background: var(--modal-bg, var(--ui-surface));
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow);
    text-align: center;
    max-width: 360px;
    pointer-events: auto;
  }

  .empty-state-headline {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-state-subhead {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .empty-state-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 8px 14px;
    border-radius: 6px;
    border: 1px solid var(--accent-primary);
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
    font-size: var(--font-size-base);
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.1s ease, opacity 0.1s ease;
  }

  .empty-state-cta:hover {
    opacity: 0.92;
  }

  .add-column-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  /* Tag editor popup overlay — catches click-outside so the popup dismisses
     when the user clicks elsewhere on the board. Z-index pair mirrors the
     canvas tile popup (overlay below, anchor above). */
  .kanban-tag-popup-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-tile-popup-overlay);
  }
  .kanban-tag-popup-anchor {
    z-index: var(--z-tile-popup);
  }
</style>
