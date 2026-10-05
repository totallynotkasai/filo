<script lang="ts">
  /**
   * KanbanBoard — column-based layout backed by `tileDefs` + per-column
   * `tilePlacements`. Each placement points at a tile def in
   * `boardCacheStore.cache[boardId].tileDefs`; per-element style overrides
   * cascade through `effectiveStyle`. Tiles' frontmatter (tags, properties)
   * comes from the backing `.md` files via `vaultIndexStore` so the same
   * file rendered as a Mind Map text tile and as a Kanban tile stay in sync.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, isActiveScope, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { ViewHydration } from '../../stores/boardViewRevision.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';

  // Per-pane scope; aliases preserve existing call sites. See boardScope.svelte.ts.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  let { tabId: _tabId }: { tabId?: string } = $props(); // pane-correct via scope; accepted + ignored
  const boardStore = scope.board;
  const selectionStore = scope.selection;
  import { createId } from '../../lib/utils/ids';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import type {
    KanbanBoard as KanbanBoardType,
    KanbanTilePlacement,
    Tile,
  } from '../../schema/index';
  import KanbanColumn from './KanbanColumn.svelte';
  import ElementStylePopup from './ElementStylePopup.svelte';
  import KanbanSideToolbar from './KanbanSideToolbar.svelte';
  import KanbanNewTileModal from './KanbanNewTileModal.svelte';
  import TagPromptPopup from './TagPromptPopup.svelte';
  import { cardPosition, neighbourCard, revealCard, type KanbanNavColumns } from '../../lib/kanban/kanbanKeyboardNav';
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
  import { classifyDroppedFile } from '../../lib/vault/droppedFiles';
  import { makeKanbanFrontmatterWriter } from '../../lib/kanban/kanbanFrontmatterWriter';
  import { makeKanbanTileCreator, newCardFolder } from '../../lib/kanban/kanbanTileCreation';
  import { computeKanbanInsertIndex } from '../../lib/kanban/kanbanInsertPosition';
  import { flushLastViewForBoard } from '../../lib/boards/lastViewFlush';
  import { registerComponentFlush } from '../../lib/boards/componentFlush';
  import {
    KanbanFiltersAndSort,
    type KanbanLastView,
  } from '../../lib/kanban/kanbanFiltersAndSort.svelte';
  import { KanbanSavedViews } from '../../lib/kanban/kanbanSavedViews.svelte';
  import { KanbanMultiSelect } from '../../lib/kanban/kanbanMultiSelect.svelte';
  import { KanbanDragController } from '../../lib/kanban/kanbanDragController.svelte';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { registerKanbanShortcuts } from '../../lib/kanban/kanbanShortcuts';
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
  import { noteStore } from '../../stores/notes.svelte';

  let board = $derived(boardStore.current as KanbanBoardType | null);
  let columns = $derived(board?.columns ?? []);
  let settings = $derived(
    board?.settings ?? {
      backgroundColor: '',
      // Defaults align with the non-canvas board cascade
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
  // In-app tag-input prompt for the bulk "Add tag" action. The controller
  // (`KanbanMultiSelect`) awaits the injected `promptForTag()`; it mounts
  // <TagPromptPopup> and resolves on Add / Cancel / Escape. (`window.prompt`
  // throws in Electron's renderer.)
  let tagPromptResolve = $state<((value: string | null) => void) | null>(null);
  function promptForTag(): Promise<string | null> {
    if (tagPromptResolve) tagPromptResolve(null); // never strand a prior prompt
    return new Promise<string | null>((resolve) => { tagPromptResolve = resolve; });
  }
  function resolveTagPrompt(value: string | null): void {
    const resolve = tagPromptResolve;
    tagPromptResolve = null;
    resolve?.(value);
  }
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
  // `cacheVersion` are declared so the accessor closures see valid references.
  // Hydration timing stays in the host (`hydration`, a debounced $effect).

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

  // Per-column card-dndzone items: the cards each column shows, filtered and
  // sorted, so the items and the DOM match one to one. The controller skips
  // this while a drag is in flight so the items aren't snap-reset mid-gesture;
  // reading `dragTileId` here re-runs it once the gesture ends.
  $effect(() => {
    void dragController.dragTileId;
    const shown =Object.fromEntries(columns.map((col) => [col.id, filtersAndSort.visiblePlacementsForColumn(col.id).map((p) => p.tileId)]));
    untrack(() => dragController.syncCards(shown));
  });

  // ── New-tile modal state ──
  let newTileColumnId = $state<string | null>(null);
  let templatePickerColumnId = $state<string | null>(null);

  // ── Reactivity tick: bump local cacheVersion after cache mutations ──
  //
  // `boardStore.current` is a `$derived` view of
  // `boardCacheStore.cache[currentBoardId].board`, so cache mutations propagate
  // on their own. `cacheVersion` is a coarse local signal for consumers
  // (filter/sort controller, card-flow derivations) that key off it rather
  // than walking the deep cache proxy; the bump is cheap and harmless.

  function tickAndPersist(): void {
    cacheVersion++;
  }

  // ── Screen-reader announcement region ──
  //
  // Toasts cover most bulk actions (Toast.svelte already
  // wires aria-live), but several Kanban mutations are silent — column
  // add/delete/rename, card add/move/delete on the row level. The local
  // announcement state fills that gap so SR users get parity with the
  // visible UI without duplicating toast traffic.
  // Auto-clearing aria-live announcer; announcer.dispose() in onDestroy.
  const announcer = createAriaAnnouncer();
  function announce(message: string): void {
    announcer.announce(message);
  }

  // ── Column lifecycle ──

  function addColumn() {
    if (!board) return;
    // No style: the column's title size follows the column cascade.
    historyStore.execute(new AddColumnCommand(board.id, { id: createId(), title: 'New Column' }));
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
        : `This column holds ${tileCount === 1 ? '1 card' : `${tileCount} cards`}. They leave this board with it; their notes stay in the vault. Undo puts them back.`,
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
   * Captures (collapsed, wipLimit, width) shape so the
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
    const baseInsertIndex = computeKanbanInsertIndex(columnId, e.clientY, placements.map((p) => p.tileId));
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
        // A file already in the vault is linked by its path, as a sidebar
        // drop is; only one from outside is copied in.
        const dropped = classifyDroppedFile(file, vaultRoot);
        if (!dropped) continue;
        const tileType = inferKanbanTileType(file.type, fileExt);
        if (!tileType) {
          uiStore.toast(`Skipped ${file.name} — unsupported in Kanban`, 'warning', 2000);
          continue;
        }
        const def = dropped.kind === 'in-vault'
          ? await buildTileDefForVaultFile({ filePath: dropped.relPath, name: file.name, extension: fileExt, vaultRoot, allTilesById })
          : await importKanbanFileTile({
            type: tileType, tileId: createId(), drop: dropped, vaultRoot, destFolder: newCardFolder(board),
            allTilesById, refreshTree: async () => { await vaultStore.refreshTree(); },
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
  // board state. Each field edit is an undoable command that sends a
  // frontmatter delta to the note writer.

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
    // every mounted handler on every keypress. A key a global shortcut
    // already handled (it called preventDefault) must not act twice.
    if (e.defaultPrevented) return;
    const tgt = e.target as Node | null;
    if (!boardRootEl || !tgt || !boardRootEl.contains(tgt)) return;
    if (e.key === '/' && !findBarOpen && !isEditableTextTarget(e.target)) {
      e.preventDefault();
      openFindBar();
    }
    if (e.key === 'Escape' && !isEditableTextTarget(e.target) && selectionStore.count > 0) {
      e.preventDefault();
      multiSelect.clearSelectionAndAnchor();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')
        && !isEditableTextTarget(e.target)
        && selectionStore.count > 0) {
      e.preventDefault();
      multiSelect.deleteSelectedTiles();
    }

    // Arrow nav across cards
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
      const focusedId = ids[ids.length - 1];
      const from = focusedId === undefined ? null : cardPosition(navColumns, focusedId);
      // No card selected yet: the first one; else the neighbour (none at an edge).
      const target = focusedId === undefined ? flat[0] : from ? neighbourCard(navColumns, from, e.key) : null;
      if (target && target !== focusedId) {
        e.preventDefault();
        selectionStore.select(target);
        revealCard(boardRootEl, target);
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

  /** The cards each column shows, for the arrow keys (`kanbanKeyboardNav.ts`). */
  const navColumns: KanbanNavColumns = {
    get ids() { return columns.map((c) => c.id); },
    cardsIn: (columnId) => filtersAndSort.visiblePlacementsForColumn(columnId).map((p) => p.tileId),
  };

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

  // Capture-phase Escape handler for the tag popup. An overlay onkeydown
  // only fires when focus is on the overlay; once the user clicks into the
  // TagEditor's input, the input swallows Escape. Window-level capture sees
  // the key before any focused descendant can stop propagation, so Escape
  // closes the popup regardless of where focus sits.
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
  // The Style button in TileHeader dispatches `tile-style-popup` with the tile
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

  // ── Kanban-scoped keyboard shortcuts (`kanbanShortcuts.ts`) ──
  // Registered on mount and removed on destroy, so they fire only while a
  // Kanban board is mounted, and only for the focused pane.
  let unregisterShortcuts: () => void = () => {};

  function shortcutAddTile() {
    if (!board) return;
    const targetId = newTileColumnId
      ?? (columns[0]?.id ?? null);
    if (!targetId) return;
    openNewTilePicker(targetId);
  }

  onMount(() => {
    window.addEventListener('keydown', handleBoardKeydown);
    unregisterShortcuts = registerKanbanShortcuts({
      isActivePane: () => isActiveScope(scope),
      boardRoot: () => boardRootEl,
      addCard: shortcutAddTile,
      addColumn: () => addColumn(),
    });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleBoardKeydown);
    unregisterShortcuts();
    dragController.dispose();
    announcer.dispose();
    // Drain any queued frontmatter writes so a board close during the
    // 300ms debounce window doesn't lose the user's last field edit.
    void noteStore.flushAll();
    flushLastView();
  });

  // Writes the filter/sort state now: on a true unmount (the persist $effect
  // cleanup flushes only on a real board switch) and from a save or a leave,
  // which run before the unmount. Keyed by the hydrated id through the cache
  // (teardown-safe; a no-change flush is a no-op).
  function flushLastView(): void {
    if (!hydration.boardId) return;
    const prop = filtersAndSort.activeFilterProp;
    const view = { sortBy: filtersAndSort.activeSortBy, filterTags: [...filtersAndSort.activeFilterTags], filterProp: prop ? { ...prop } : null };
    flushLastViewForBoard(hydration.boardId, view);
  }
  $effect(() => registerComponentFlush('kanban view', flushLastView));

  // ── Filtering / sorting (applied per column at render time) ──
  //
  // Filter / sort logic + state lives in `KanbanFiltersAndSort` (instantiated
  // at the top of the script). Visible-placements derivation is exposed as
  // `filtersAndSort.visiblePlacementsForColumn(columnId)`.

  const vaultPathForTile = fmWriter.vaultPathForTile;

  // ── lastView persistence ──
  // Hydrate transient filter/sort state from `settings.lastView` on board
  // open; debounced effect persists changes back. Pattern mirrors
  // per-board viewport persistence. Hydrates again when the board's view
  // revision moves (a reload from disk, a tag rename rewrote `lastView`).

  const hydration = new ViewHydration();

  $effect(() => {
    const id = board?.id;
    if (!id || !hydration.needs(id)) return;
    untrack(() => {
      const lv = ((settings as Record<string, unknown>).lastView ?? null) as
        | KanbanLastView
        | null;
      filtersAndSort.hydrateFromLastView(lv);
      hydration.mark(id);
    });
  });

  let lastViewPersistTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Track all three so the effect re-runs on any change.
    const sortBy = filtersAndSort.activeSortBy;
    const tags = filtersAndSort.activeFilterTags;
    const prop = filtersAndSort.activeFilterProp;
    const id = board?.id;
    if (!id || id !== hydration.boardId) return;
    // Snapshot at ARM time (a teardown can run after the next board's hydrate
    // re-seeded the filters) and write keyed by the CAPTURED id via
    // flushLastViewForBoard — never the live board, which may have changed.
    // Its JSON-equality guard skips no-change writes.
    const nextLastView = { sortBy, filterTags: [...tags], filterProp: prop ? { ...prop } : null };
    if (lastViewPersistTimer) clearTimeout(lastViewPersistTimer);
    lastViewPersistTimer = setTimeout(() => {
      lastViewPersistTimer = null;
      flushLastViewForBoard(id, nextLastView);
    }, 300);
    // Tear the debounce down with the effect (a board close / vault swap
    // mid-window must not fire a stale write), but flush on a board switch: a
    // change within 300 ms of a switch would otherwise never be written
    // (`hydration` blocks any re-fire after). The cleanup runs before
    // EVERY re-execution, so flush ONLY when the live id moved off the armed
    // id — flushing unconditionally would defeat the debounce. A same-board
    // re-run just re-arms the timer. Unmount is flushed in onDestroy below.
    return () => {
      if (lastViewPersistTimer) {
        clearTimeout(lastViewPersistTimer);
        lastViewPersistTimer = null;
        if (board?.id !== id) {
          flushLastViewForBoard(id, nextLastView);
        }
      }
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
  // would otherwise be encoded covertly via the missing-placement lookup.
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
    promptForTag,
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

  // A docked sidebar that pushes the workspace aside already clears the columns.
  let dockedShiftPx = $derived.by<number>(() => {
    if (uiStore.sidebarFloating || !uiStore.sidebarOpen || uiStore.sidebarPushesWorkspace) return 0;
    return uiStore.sidebarWidth;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!--
  Keyboard-operable Kanban.
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
    bgColor={settings.backgroundColor || vaultStore.project?.settings?.kanban?.backgroundColor || ''}
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
            accentColor={settings.accentColor || vaultStore.project?.settings?.kanban?.accentColor || ''}
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
            moveTargets={columns.filter((c) => c.id !== column.id).map((c) => ({ id: c.id, title: c.title }))}
            onMoveTile={(tileId, columnId) => multiSelect.moveTilesToColumn([tileId], columnId)}
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
    <!-- Empty-state card. Sits absolute over the board so
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
    but no toast is dispatched.
  -->
  <div class="kanban-sr-live" aria-live="polite" aria-atomic="true">{announcer.message}</div>
</div>

{#if columnStylePopup && board}
  <ElementStylePopup kind="kanbanColumn"
    boardId={board.id}
    elementId={columnStylePopup.columnId}
    style={columnStylePopup.style}
    x={columnStylePopup.x}
    y={columnStylePopup.y}
    onclose={() => columnStylePopup = null}
  />
{/if}

{#if cardStylePopup && board}
  <ElementStylePopup kind="kanbanCard"
    boardId={board.id}
    elementId={cardStylePopup.tileId}
    style={cardStylePopup.style}
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

{#if tagPromptResolve}
  <!-- Bulk "Add tag" prompt (in place of window.prompt). -->
  <TagPromptPopup onResolve={resolveTagPrompt} />
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

  /* First-time empty-state card. Centred over the board
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
