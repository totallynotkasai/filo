<script lang="ts">
  /**
   * TaskListBoard — placement-based task list.
   *
   * Each entry in `board.tasks` is a placement that points at a `text` tile
   * def in `boardCacheStore.cache[boardId].tileDefs`. The task's reactive
   * fields (completed / priority / dueDate / status / tags) all live in the
   * backing `.md`'s YAML frontmatter and come through `noteFrontmatter`,
   * not the board JSON.
   *
   * Group / sort / filter happens at render time. The active board's
   * `settings.groupBy` and `settings.sortBy` are persisted; the filter
   * panel's transient state is local.
   */
  import { buildSectionContextMenu } from '../../lib/tasklist/taskContextMenus';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, isActiveScope, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import type {
    TaskListBoard as TaskListBoardType,
    TaskListSection,
    TaskPlacement,
    Tile,
    PartialTaskStyle,
  } from '../../schema/index';
  import TaskListSectionComponent from './TaskListSection.svelte';
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import type {
    TaskListRowCallbacks,
    TaskListSectionCallbacks,
    TaskListSectionControllers,
  } from './taskListRowProps';
  import FloatingTocPanel from './FloatingTocPanel.svelte';
  import TaskListSideToolbar from './TaskListSideToolbar.svelte';

  // Per-pane scope; alias `boardStore` so call sites stay unchanged. See boardScope.svelte.ts.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  let { tabId: _tabId }: { tabId?: string } = $props(); // pane-correct via scope; accepted + ignored
  const boardStore = scope.board;
  import ElementStylePopup from './ElementStylePopup.svelte';
  import TagEditor from '../tags/TagEditor.svelte';
  import TaskQuickAddInput from './TaskQuickAddInput.svelte';
  import SmartListTabs from './SmartListTabs.svelte';
  import TaskBulkActionBar from './TaskBulkActionBar.svelte';
  import { statusFilterOptions, type TaskRow, type GroupBy, type SortBy } from '../../lib/tasks/taskListModel';
  import {
    TaskListFiltersAndViews,
    type LastViewSlice,
  } from '../../lib/tasklist/filtersAndViews.svelte';
  import {
    effectiveTaskStyle,
    effectiveTaskSectionStyle,
    taskListTitleFontSize,
    type ResolvedTaskStyle,
  } from '../../lib/styles/effectiveStyle';
  import { resolveTextTileVaultPath } from '../../lib/boards/textTilePath';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { renameTaskTitle } from '../../lib/tasklist/taskRename';
  import { noteFrontmatter } from '../../stores/noteMeta';
  import { flushLastViewForBoard } from '../../lib/boards/lastViewFlush';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { createAriaAnnouncer } from '../../lib/utils/ariaAnnouncer.svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import { registerCommandWithShortcut } from '../../core/commandRegistry';
  import type { ShortcutBinding } from '../../core/hotkeys';
  import { moveTaskBlock } from '../../lib/tasks/taskMove';
  import { sectionIdForPlacementIndex } from '../../lib/tasklist/sectionMath';
  import {
    collectDescendantIds,
    type RowDndItem,
  } from '../../lib/tasklist/blockMove';
  import {
    TaskDragController,
    type SectionItemsSnapshot,
  } from '../../lib/tasklist/taskDragController.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import {
    MoveTaskBlockCommand,
    ReorderSectionCommand,
    BatchCommand,
    ToggleSubtaskCollapsedCommand,
    TogglePlacementLockCommand,
  } from '../../commands/index';
  import { executeReorderSwitchingToManual } from '../../lib/tasklist/manualSortSwitch';
  import { makeTaskCreator } from '../../lib/tasklist/taskCreation';
  import { makeTaskDeleter } from '../../lib/tasklist/taskDeletion';
  import { makeFrontmatterWriter } from '../../lib/tasklist/frontmatterWriter';
  import { noteStore } from '../../stores/notes.svelte';
  import { makeFileDropHandler } from '../../lib/tasklist/fileDropHandler';
  // `clearStaleDndStyles` is consumed inside <TaskListSection>.
  // The host still passes its trigger (`dndSections`) via the
  // `dndSectionsTrigger` prop so the action re-runs after every reorder.
  import {
    TaskListViewModel,
    type FlatRowEntry,
    type SectionView,
  } from '../../lib/tasklist/taskListViewModel.svelte';
  import { MultiSelectController } from '../../lib/tasklist/multiSelectController.svelte';
  import { TaskListKeyboardNav } from '../../lib/tasklist/taskListKeyboardNav.svelte';
  import { makeSectionOps } from '../../lib/tasklist/sectionOps';
  import { buildSetParentCommand } from '../../lib/tasklist/taskParent';

  let board = $derived(boardStore.current as TaskListBoardType | null);
  let placements = $derived<TaskPlacement[]>(((board?.tasks ?? []) as TaskPlacement[]));
  // User-defined sections, the top-level structure; a Group By groups the
  // rows inside each section.
  let sections = $derived<TaskListSection[]>(
    (((board as TaskListBoardType & { sections?: TaskListSection[] } | null)?.sections) ?? []) as TaskListSection[],
  );
  // Task List Boards always render at least one section. When the persisted
  // `sections` array is empty (legacy boards, or boards whose sections were
  // all deleted) we surface a virtual "Task List" section with the sentinel
  // id `__default__`. Any mutation that targets it materialises a real
  // section via `ensureDefaultSectionMaterialized()` before applying the
  // change, so disk state catches up on first interaction.
  const DEFAULT_SECTION_ID = '__default__';
  // Keys the drawn leading bucket (rows before the first persisted section);
  // distinct from the synthetic default above.
  const LEADING_SECTION_ID = '__leading__';
  let displaySections = $derived<TaskListSection[]>(
    sections.length > 0
      ? sections
      : [{ id: DEFAULT_SECTION_ID, title: 'Task List', position: 0, collapsed: false }],
  );
  let settings = $derived(
    board?.settings ?? {
      backgroundColor: '',
      // Default to 'none' for non-canvas boards.
      backgroundPattern: 'none' as const,
      accentColor: '',
      groupBy: 'status' as GroupBy,
      sortBy: 'priority' as SortBy,
    },
  );
  let accent = $derived(settings.accentColor || vaultStore.project?.settings?.tasklist?.accentColor || 'var(--accent-primary)'); // blank ⇒ Global Defaults, then theme
  let listTitleSize = $derived(taskListTitleFontSize(board, vaultStore.project?.settings));
  // Whitelist known groupBys defensively — a hand-edited or future-version
  // .board.json could store a value we don't render; fall back to 'status'
  // instead of letting downstream `GROUP_ORDER[groupBy]` undefined-crash.
  const KNOWN_GROUP_BYS: readonly GroupBy[] = ['status', 'priority', 'tag', 'dueDate', 'category', 'none'];
  let groupBy = $derived<GroupBy>(
    (() => {
      const raw = (settings as { groupBy?: string }).groupBy;
      return raw && (KNOWN_GROUP_BYS as readonly string[]).includes(raw) ? (raw as GroupBy) : 'status';
    })(),
  );
  let sortBy = $derived<SortBy>(((settings as { sortBy?: SortBy }).sortBy ?? 'priority'));

  // Per-row cascade resolver. Walks placement.style (per-element layer) →
  // board.settings.defaults.task (board layer) → settings.tasklist.task
  // (global layer). Used by the `renderSection` snippet and
  // forwarded into <TaskListSection> so the per-section row loop can
  // resolve each row's style against its own placement.style.
  function resolveTaskStyle(
    placementStyle?: Record<string, unknown> | null,
  ): ResolvedTaskStyle {
    return effectiveTaskStyle(
      placementStyle ?? null,
      vaultStore.project?.settings,
      board,
    );
  }

  /**
   * Resolves the per-section style for a given section, walking the
   * cascade (per-section style > board → global section defaults).
   * The synthetic "Unsectioned" bucket (id === null) and persisted
   * sections both flow through the same resolver; the empty per-element
   * layer for the leading bucket is fine because there's no section
   * style block to source from.
   */
  function styleForSection(sectionId: string | null) {
    const sections = ((board as TaskListBoardType | null)?.sections ?? []) as Array<{
      id: string;
      style?: Record<string, unknown>;
    }>;
    const found = sectionId ? sections.find((s) => s.id === sectionId) : undefined;
    return effectiveTaskSectionStyle(
      (found?.style as Record<string, unknown> | undefined) ?? null,
      vaultStore.project?.settings,
      board,
    );
  }

  // ── Cached tile views for the active board ──
  let tilesById = $derived<Record<string, Tile>>(
    board ? boardCacheStore.getFullTasksForBoard(board.id) : {},
  );

  // ── Filter UI state + savedViews + lastView (non-persistent) ──
  // Lives in `lib/tasklist/filtersAndViews.svelte.ts`. The controller owns the 5 transient filter dimensions, the lastView
  // hydration gate, and the saved-views CRUD. Effects (hydrate / persist)
  // remain in this file because Svelte's `$effect` registration is tied to
  // component lifecycle.
  const filters = new TaskListFiltersAndViews({
    getSavedViewsRaw: () => (settings as Record<string, unknown>).savedViews,
    // allow-direct-mutation: pass-through for transient lastView/filter UI state debounced by the controller; saved-view CRUD goes through UpdateSavedViewsCommand below.
    updateSettings: (patch) => boardStore.updateSettings(patch),
    setSavedViews: (next) => {
      if (!board) return;
      // allow-direct-mutation: fallback callback used by the controller only when boardId is null; the undoable path executes UpdateSavedViewsCommand.
      boardCacheStore.setTaskListSavedViews(board.id, next);
    },
    tickAndPersist: () => tickAndPersist(),
    getGroupBy: () => groupBy,
    getSortBy: () => sortBy,
    announce: (msg) => announce(msg),
    getBoardId: () => board?.id ?? null,
  });

  // ── Reactivity tick: bump local cacheVersion after cache mutations ──
  //
  // The local `cacheVersion` is a coarse signal for derivations that key off
  // it; `boardStore.current` is itself a `$derived` view of the cache.
  let cacheVersion = $state(0);

  function tickAndPersist(): void {
    cacheVersion++;
  }

  // ── Screen-reader announcement region ──
  //
  // Toasts (`uiStore.toast(...)`) already carry `role=status` and
  // `aria-live=polite` (see Toast.svelte), so bulk actions that toast are
  // covered. The local `announcement` text fills the gap for single-row
  // ops (add task, delete task, toggle complete) where no toast fires —
  // SR users would otherwise hear nothing when the row list mutates.
  // Auto-clearing aria-live announcer; announcer.dispose() in onDestroy.
  const announcer = createAriaAnnouncer();
  function announce(message: string): void {
    announcer.announce(message);
  }

  function vaultPathForTile(tile: Tile): string {
    return resolveTextTileVaultPath(tile) ?? '';
  }

  // ── Frontmatter readers (canonical fields) ──
  // Per-field readers live in `lib/tasks/frontmatterReaders.ts` and are
  // shared with KanbanCard so both list-style boards agree on field
  // interpretation. `noteFrontmatter` prefers the live document cache —
  // writers (toggleCompleted, setDueDate, etc.) merge into it synchronously,
  // so a row reflects a click without waiting on the debounced write — and
  // falls back to the vault index.
  function readFrontmatter(tile: Tile): Record<string, unknown> {
    return noteFrontmatter(vaultPathForTile(tile)) as Record<string, unknown>;
  }

  // ── Derived row / group / section pipeline ──
  //
  // The 14-cluster `$derived` chain (rows → filteredRows → sortedRows →
  // nestedView → groups / sectionedView / availableSectionsForMove + the
  // smart-list counts side-channel) lives as `$derived` fields on
  // `TaskListViewModel`. Reactivity is preserved because:
  //   - the class is declared in `lib/tasklist/taskListViewModel.svelte.ts`
  //     (rune-aware), and
  //   - instantiated here in the component `<script>` (the only valid spot
  //     for runes to compile).
  // The deps closure reads stay live: each accessor below is invoked inside
  // the class's `$derived.by` callbacks, so the rune compiler tracks the
  // host's `$state` reads through them.
  const viewModel = new TaskListViewModel({
    getPlacements: () => placements,
    getTilesById: () => tilesById,
    getDisplaySections: () => displaySections,
    getCacheVersion: () => cacheVersion,
    readFrontmatter,
    getActiveSmartList: () => filters.activeSmartList,
    getShowCompleted: () => filters.showCompleted,
    getActiveFilterPriority: () => filters.activeFilterPriority,
    getActiveFilterStatus: () => filters.activeFilterStatus,
    getActiveFilterTags: () => filters.activeFilterTags,
    getSortBy: () => sortBy,
    getGroupBy: () => groupBy,
    getDefaultSectionId: () => DEFAULT_SECTION_ID,
    getCollapsedSubtasks: () => collapsedSubtasks,
    getLeadingSectionId: () => LEADING_SECTION_ID,
  });

  // ── Section CRUD ──
  //
  // The persist/snapshot helpers + section CRUD ops (add / rename /
  // toggle-collapsed / delete / move) live in the `sectionOps` slice. Each
  // undoable op dispatches an `historyStore.execute(...)` of the appropriate
  // structural Command; collapse toggling is intentionally non-undoable
  // (transient UI preference) and skips the command stack.
  //
  // Section `position` values are absolute indices into `tasks`, so an
  // inconsistent update can split a board's task list from its section
  // markers — funnelling every section mutation through
  // `sectionOps.persistSections` keeps the two arrays in lock-step.

  // Snapshot helper stays in the host because it's also consumed by the
  // dndzone reorder finalize, drag-controller commits, keyboard moves, and
  // moveTaskToSection. Each returns a deep-cloned pair so structural
  // Commands can replay without later mutations bleeding into the captured
  // state.
  function snapshotSections(): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
    return {
      sections: sections.map((s) => ({ ...s })),
      tasks: placements.map((p) => ({ ...p })),
    };
  }

  // ── Section inline-rename state ──
  // Read by the section header markup; written by the double-click handler.
  let editingSectionId = $state<string | null>(null);
  let editingSectionTitle = $state('');

  const sectionOps = makeSectionOps({
    getBoard: () => board,
    getSections: () => sections,
    getPlacements: () => placements,
    tickAndPersist,
    snapshotSections,
    defaultSectionId: DEFAULT_SECTION_ID,
  });
  const ensureDefaultSectionMaterialized = sectionOps.ensureDefaultSectionMaterialized;
  const addSection = sectionOps.addSection;
  const renameSection = sectionOps.renameSection;
  const toggleSectionCollapsed = sectionOps.toggleSectionCollapsed;
  const deleteSection = sectionOps.deleteSection;
  const moveSection = sectionOps.moveSection;

  // ── Section reorder via svelte-dnd-action ──
  //
  // Header acts as the drag handle: `sectionDragDisabled` starts true so a
  // pointerdown anywhere inside a section body (rows, task text, buttons)
  // never initiates a section drag. The header's pointerdown flips it false
  // for the next gesture; pointerup or finalize resets it. Mirrors the
  // KanbanBoard column-reorder pattern.
  let sectionDragDisabled = $state(true);

  // Items the dndzone sees. Only *real* sections (and the synthetic default
  // placeholder) participate — the leading "Unsectioned" bucket renders
  // outside the dndzone since it isn't a draggable section.
  interface DndSectionItem { id: string; title: string }
  let dndSections = $state<DndSectionItem[]>([]);

  // Mirrors the KanbanBoard column-reorder pattern. The dndzone's items must
  // be the *single* source of truth for its keyed each block — mutating the
  // mirror from an external $effect during a drag confuses svelte-dnd-action
  // and surfaced as a `getBoundingClientRect` crash in
  // `animateDraggedToFinalPosition`. We track only `sectionedView` (the
  // canonical source) and read `sectionDragDisabled` inside `untrack` so a
  // flag flip on its own never re-fires the effect — the resync only runs
  // when the canonical sections change AND we're outside a drag.
  $effect(() => {
    const next = viewModel.sectionedView
      .filter((s): s is SectionView & { id: string } => !!s.id)
      .map((s) => ({ id: s.id, title: s.title }));
    untrack(() => {
      if (sectionDragDisabled) dndSections = next;
    });
  });

  function onSectionHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const tgt = e.target as HTMLElement | null;
    // Interactive children (rename input, collapse button) take precedence —
    // a pointerdown on those shouldn't arm a section drag.
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    sectionDragDisabled = false;
    window.addEventListener(
      'pointerup',
      () => {
        sectionDragDisabled = true;
        // The `use:clearStaleDndStyles` action attached per-section re-runs on
        // every render and cleans inline styles left by svelte-dnd-action.
        // Cancelled drags (Esc, drop-outside, window blur) don't trigger a
        // reorder commit, so no stale styles are written in the first place.
      },
      { once: true },
    );
  }

  function onConsiderSections(e: CustomEvent<DndEvent<DndSectionItem>>) {
    // Pure mirror update — no flag flips. The resync $effect already skips
    // while sectionDragDisabled is false (set on header pointerdown).
    dndSections = e.detail.items;
  }

  function onFinalizeSections(e: CustomEvent<DndEvent<DndSectionItem>>) {
    // Important: do NOT mutate sectionDragDisabled here. The pointerup
    // handler installed by onSectionHeaderPointerDown flips it AFTER svelte-
    // dnd-action's drop animation has finished reading the dragged element's
    // bounding rect. Flipping it in finalize was the cause of the
    // `getBoundingClientRect` undefined crash. The per-section
    // `use:clearStaleDndStyles` action sweeps inline drag-leftover styles
    // off every rendered node on the post-finalize rerender.
    if (!board) {
      // No board → nothing to commit. The pointerup gate flip will resync
      // dndSections from sectionedView via the $effect.
      dndSections = e.detail.items;
      return;
    }
    const newOrderedIds = e.detail.items.map((s) => s.id);
    if (sections.length === 0 || newOrderedIds.every((id) => id === DEFAULT_SECTION_ID)) {
      // Synthetic-only drop — nothing to persist. Same story: pointerup
      // resyncs.
      dndSections = e.detail.items;
      return;
    }

    // ReorderSectionCommand consumes ONLY the new section ID ORDER (it sorts
    // `after.sections` by position; `applySectionOrderLive` then recomputes
    // every position AND re-slices `tasks` from the live cache). So emit just the
    // real sections renumbered into the dropped order.
    const realById = new SvelteMap(sections.map((s) => [s.id, s]));
    const nextSections: TaskListSection[] = [];
    let pos = 0;
    for (const id of newOrderedIds) {
      if (id === DEFAULT_SECTION_ID) continue;
      const oldSection = realById.get(id);
      if (oldSection) nextSections.push({ ...oldSection, position: pos++ });
    }
    const beforeSnap = snapshotSections();
    historyStore.execute(
      new ReorderSectionCommand(board.id, beforeSnap, { sections: nextSections, tasks: [] }),
    );
    tickAndPersist();
    // Mirror the committed order so the dndzone's keyed each renders the
    // new layout on the next tick.
    dndSections = e.detail.items;
  }

  function transformDraggedSection(el?: HTMLElement) {
    if (!el) return;
    el.classList.add('tasklist-section-dragging');
    // Some svelte-dnd-action failure modes leave the source element opacity-0
    // when a drag is cancelled (Esc, window blur, Alt-Tab). Force-clear those
    // styles defensively so the dropped clone is always visible.
    el.style.opacity = '';
    el.style.visibility = '';
  }

  // `clearStaleDndStyles` (Svelte action used in section template) lives in
  // `lib/tasklist/clearStaleDndStyles.ts`. See that file for the why.

  // ── Section inline-rename commit/cancel ──
  // `editingSectionId` / `editingSectionTitle` are declared earlier so the
  // sectionOps slice can poke them on add-then-rename. The commit/cancel
  // helpers below stay in the host because they're wired directly into
  // the section header's input event handlers.
  function commitSectionRename() {
    if (editingSectionId && editingSectionTitle.trim()) {
      renameSection(editingSectionId, editingSectionTitle.trim());
    }
    editingSectionId = null;
    editingSectionTitle = '';
  }
  function cancelSectionRename() {
    editingSectionId = null;
    editingSectionTitle = '';
  }

  // Per-section Style popup state. Mounted at the end of this component
  // so the popup escapes the scroll container's clip context.
  let sectionStylePopup = $state<{ sectionId: string; style?: Record<string, unknown>; x: number; y: number } | null>(null);

  function openSectionStylePopup(sectionId: string, x: number, y: number) {
    if (!board) return;
    const sections = ((board as TaskListBoardType).sections ?? []) as Array<{ id: string; style?: Record<string, unknown> }>;
    const section = sections.find((s) => s.id === sectionId);
    sectionStylePopup = { sectionId, style: section?.style, x, y };
  }

  function openSectionContextMenu(e: MouseEvent, section: SectionView) {
    if (!section.id) return; // unsectioned bucket has no menu
    e.preventDefault();
    e.stopPropagation();
    const sid = section.id;
    const menuX = e.clientX;
    const menuY = e.clientY;
    // The synthetic default isn't persisted, so it can only be renamed.
    const isDefault = sid === DEFAULT_SECTION_ID;
    uiStore.showContextMenu(menuX, menuY, buildSectionContextMenu({
      isDefault,
      onRename: () => { editingSectionId = sid; editingSectionTitle = section.title; },
      onStyle: () => openSectionStylePopup(sid, menuX, menuY),
      onMoveUp: () => moveSection(sid, -1),
      onMoveDown: () => moveSection(sid, 1),
      onDeleteKeepTasks: () => deleteSection(sid, 'keep-tasks'),
      onDeleteWithTasks: () => deleteSection(sid, 'delete-tasks'),
    }));
  }

  // ── Subtask collapse state (persisted to the board JSON) ──
  //
  // Derived directly from `board.collapsedSubtasks` so undo/redo of a
  // ToggleSubtaskCollapsedCommand (or the auto-expand wrapped into an indent
  // BatchCommand) flows back into the UI without a manual re-hydration step.
  // Writes go through `boardCache.setTaskListCollapsedSubtasks`; the cached
  // board mutation propagates through the shared reactive proxy.
  let collapsedSubtasks = $derived(
    new Set<string>(
      Array.isArray(
        (board as TaskListBoardType & { collapsedSubtasks?: string[] } | null)?.collapsedSubtasks,
      )
        ? ((board as TaskListBoardType & { collapsedSubtasks: string[] }).collapsedSubtasks)
        : [],
    ),
  );

  function persistCollapsedSubtasks(next: Set<string>): void {
    if (!board) return;
    // Route through ToggleSubtaskCollapsedCommand so the auto-expand on
    // subtask creation participates in undo (otherwise Ctrl+Z would only undo
    // the AddTaskCommand and leave the parent expanded).
    const before = Array.from(collapsedSubtasks);
    const after = Array.from(next);
    // Skip the redundant push when nothing actually changed (no-op writes
    // happen when the caller passes an unchanged set, e.g. on re-hydrate).
    if (before.length === after.length) {
      const beforeSet = new Set(before);
      if (after.every((id) => beforeSet.has(id))) return;
    }
    historyStore.execute(
      new ToggleSubtaskCollapsedCommand(board.id, before, after),
    );
  }

  function toggleSubtaskCollapsed(tileId: string) {
    if (!board) return;
    const before = Array.from(collapsedSubtasks);
    const nextSet = new SvelteSet(collapsedSubtasks);
    if (nextSet.has(tileId)) nextSet.delete(tileId);
    else nextSet.add(tileId);
    const after = Array.from(nextSet);
    historyStore.execute(
      new ToggleSubtaskCollapsedCommand(board.id, before, after),
    );
    tickAndPersist();
  }

  // ── Multi-select (UI-only, non-persistent) ──
  //
  // The selection set + bulk handlers are owned by `MultiSelectController`.
  // The store-based `selectionStore` is canvas-scoped (mind-map tile
  // selection) so a per-surface controller keeps the two from stepping on
  // each other. The floating action bar becomes visible whenever the
  // controller's `selectedTaskIds` is non-empty.
  //
  // `buildTaskFieldCommand` is exposed by the frontmatter-writer slice
  // (instantiated below). The controller references it at call time so the
  // temporal ordering is fine: every call site fires from a user event,
  // well after the factory binds its const.
  const multiSelect = new MultiSelectController({
    getBoard: () => board,
    getRows: () => viewModel.rows,
    getRenderedRows: () => viewModel.renderedRows,
    getPlacements: () => placements,
    getSections: () => sections,
    buildTaskFieldCommand: (r, p, d) => buildTaskFieldCommand(r, p, d),
    bumpCacheVersion: () => { cacheVersion++; },
    tickAndPersist,
    announce,
    ensureDefaultSectionMaterialized: () => ensureDefaultSectionMaterialized(),
  });

  /**
   * Clears the multi-selection on a board-background click. Mirrors the
   * Kanban pattern (`multiSelect.clearSelectionOnBoardClick`). The row /
   * button / input filters mean a click on any interactive child is
   * left alone — only clicks on the truly inert background dismiss the
   * selection.
   */
  function clearSelectionOnBoardClick(e: MouseEvent): void {
    if (multiSelect.selectedTaskIds.size === 0) return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (
      t.closest(
        '.task-item-wrap, .tasklist-section-header, .side-toolbar, .bulk-bar, .add-section-btn, button, a, input, textarea, select, [role="dialog"], [role="menu"]',
      )
    ) {
      return;
    }
    multiSelect.clearSelection();
  }

  // ── Stats ──
  let totalTasks = $derived(viewModel.rows.length);
  let completedCount = $derived(viewModel.rows.filter((r) => r.completed).length);
  let progressPercent = $derived(
    totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0,
  );

  /**
   * Tracks the section the user last interacted with (added a task to, dropped
   * into, or pointer-pressed inside). The global sidebar "Add Task" button
   * uses this to decide where to land instead of always appending to the
   * end-of-board (which forced new tasks into the visually-last section, the
   * "most recent section" bug). Reset to `null` when the active board
   * changes — see the $effect just below.
   */
  let lastTargetedSectionId = $state<string | null>(null);
  $effect(() => {
    const id = board?.id;
    untrack(() => {
      if (id) lastTargetedSectionId = null;
    });
    void id;
  });

  // Task creation, deletion, frontmatter writes, and file drops are owned by
  // factory slices in `lib/tasklist/` closing over the host's reactive accessors,
  // so the helpers always see live board state (same slice pattern as Kanban).
  //
  // Order matters: `frontmatterWriter` exposes `buildTaskFieldCommand`, which
  // both the deleter (cascade "keep subtasks" branch) and the bulk-action
  // helpers in this file consume — so it's instantiated first.
  const frontmatterWriter = makeFrontmatterWriter({
    getBoard: () => board,
    vaultPathForTile,
    readFrontmatter,
    bumpCacheVersion: () => { cacheVersion++; },
    announce,
  });
  const buildTaskFieldCommand = frontmatterWriter.buildTaskFieldCommand;
  function markAllIncomplete(): void {
    frontmatterWriter.markAllIncomplete(viewModel.rows);
  }

  const taskCreator = makeTaskCreator({
    getBoard: () => board,
    getSections: () => sections,
    getPlacements: () => placements,
    getRows: () => viewModel.rows,
    getCollapsedSubtasks: () => collapsedSubtasks,
    getLastTargetedSectionId: () => lastTargetedSectionId,
    setLastTargetedSectionId: (next) => { lastTargetedSectionId = next; },
    ensureDefaultSectionMaterialized: () => ensureDefaultSectionMaterialized(),
    persistCollapsedSubtasks,
    tickAndPersist,
    announce,
    defaultSectionId: DEFAULT_SECTION_ID,
    expandSection: (id) => sectionOps.expandSection(id),
    isShown: (id) => viewModel.renderedRows.some((r) => r.tile.id === id),
  });
  const addTask = taskCreator.addTask;
  const addTaskToSection = taskCreator.addTaskToSection;
  const addTaskFromQuickAdd = taskCreator.addTaskFromQuickAdd;
  const addSubtaskFor = taskCreator.addSubtaskFor;

  const taskDeleter = makeTaskDeleter({
    getBoard: () => board,
    getRows: () => viewModel.rows,
    getTilesById: () => tilesById,
    tickAndPersist,
    announce,
    pruneSelection: (ids) => multiSelect.pruneSelection(ids),
  });
  const deleteTask = taskDeleter.deleteTask;
  const deleteTaskWithFile = taskDeleter.deleteTaskWithFile;
  const deleteAllCompleted = taskDeleter.deleteAllCompleted;

  const fileDropHandler = makeFileDropHandler({
    getBoard: () => board,
    getSections: () => sections,
    getPlacements: () => placements,
    getTilesById: () => tilesById,
    ensureDefaultSectionMaterialized: () => ensureDefaultSectionMaterialized(),
    tickAndPersist,
    defaultSectionId: DEFAULT_SECTION_ID,
  });
  const onSectionBodyDrop = fileDropHandler.onSectionBodyDrop;

  function openTaskAsDocument(tile: Tile) {
    openNoteInDocumentTab(vaultPathForTile(tile));
  }

  // Frontmatter writers (debounced per-task) are owned by the slice
  // `lib/tasklist/frontmatterWriter.ts`. The closure builds undoable field
  // commands (which queue frontmatter deltas on the note writer) and bumps
  // `cacheVersion` for optimistic re-render. See the slice's header comment for the full
  // architecture rationale.

  // ── Title edit (the note's frontmatter `title:`; see `taskRename.ts`) ──

  async function renameTask(row: TaskRow, newTitle: string) {
    if (!board) return;
    await renameTaskTitle(board.id, row.tile, vaultPathForTile(row.tile), newTitle);
    tickAndPersist();
  }

  // ── Drag state (svelte-dnd-action via TaskDragController) ──
  //
  // The controller owns the transient drag transaction (which tile is moving,
  // multi-select block ids, per-section dndzone items mirror, drag-handle
  // arming gate). Below lives only the wiring that bridges the controller to
  // the board's commit infrastructure — `buildSetParentCommand` for indent/outdent,
  // `MoveTaskBlockCommand` for reorder, plus snapshot derivation from
  // `sectionedView`.

  // Section currently under the cursor during a file drag (vault / OS .md).
  // Drives the dashed-outline drop highlight on the section wrapper. Tracks
  // `DEFAULT_SECTION_ID` for the synthetic default section. Task drags use
  // the dndzone's own FLIP feedback, not this flag.
  let dragOverSectionId = $state<string | null>(null);

  /**
   * O(1) row + depth lookup for the dndzone's `{#each items}` body. The
   * view model draws each section's rows flat (`flatSections`: a row, then
   * its shown subtasks), so each `.tasklist-row-wrap` maps 1:1 to one entry
   * in the zone's `items`.
   */
  let flatEntryByTileId = $derived.by(() => {
    const map = new SvelteMap<string, FlatRowEntry>();
    for (const { entries } of viewModel.flatSections) {
      for (const e of entries) map.set(e.row.tile.id, e);
    }
    return map;
  });

  /** Snapshot pushed into the controller every time `sectionedView` changes. */
  let dragSnapshot = $derived.by<SectionItemsSnapshot>(() => {
    const itemsBySection: Record<string, RowDndItem[]> = {};
    const displaySectionIds: string[] = [];
    for (const { sectionId, entries } of viewModel.flatSections) {
      itemsBySection[sectionId] = entries.map((e) => ({ id: e.row.tile.id }));
      displaySectionIds.push(sectionId);
    }
    return { itemsBySection, displaySectionIds, leadingSectionId: LEADING_SECTION_ID };
  });

  // Indent and outdent, shared by the drag and by Tab / Shift+Tab.
  const indentOps = {
    commitIndent: (tileId: string, newParent: string): void => {
      const row = viewModel.rows.find((r) => r.tile.id === tileId);
      if (!row || !board) return;
      const cmd = buildSetParentCommand(board.id, row, newParent);
      if (!cmd) return;
      // Expand a collapsed new parent in the same undo step, else the child
      // vanishes under it.
      if (collapsedSubtasks.has(newParent)) {
        const before = Array.from(collapsedSubtasks);
        const after = before.filter((id) => id !== newParent);
        const collapseCmd = new ToggleSubtaskCollapsedCommand(
          board.id,
          before,
          after,
          'Expand parent on indent',
        );
        historyStore.execute(new BatchCommand('Indent into collapsed parent', [cmd, collapseCmd]));
      } else {
        historyStore.execute(cmd);
      }
      tickAndPersist();
    },
    commitOutdent: (tileId: string): void => {
      const row = viewModel.rows.find((r) => r.tile.id === tileId);
      const cmd = row && board ? buildSetParentCommand(board.id, row, '') : null;
      if (cmd) { historyStore.execute(cmd); tickAndPersist(); }
    },
  };

  const dragController = new TaskDragController({
    getRows: () => viewModel.rows,
    getPlacements: () => placements,
    getSections: () => sections,
    getSelectedTaskIds: () => multiSelect.selectedTaskIds,
    getSnapshot: () => dragSnapshot,
    ...indentOps,
    commitReorder: ({ nextPlacements, nextSections, description, isCrossSection }) => {
      if (!board) return;
      // Same-section reorder under a non-manual sort: switch to manual AND
      // the reorder in one BatchCommand so a single Ctrl+Z reverses both.
      // Cross-section moves don't trigger the switch — they're a structural
      // change the sort modes already honour via section ranges.
      const before = snapshotSections();
      const reorderCmd = new MoveTaskBlockCommand(
        board.id,
        before,
        { sections: nextSections, tasks: nextPlacements },
        description,
      );
      if (!isCrossSection && sortBy !== 'manual') {
        executeReorderSwitchingToManual(reorderCmd, sortBy);
      } else {
        historyStore.execute(reorderCmd);
      }
      tickAndPersist();
    },
    announce: (msg) => announce(msg),
    toast: (msg, kind, dur) => uiStore.toast(msg, kind ?? 'info', dur ?? 2000),
    getTileTitle: (tileId) => tilesById[tileId]?.title,
    getSectionTitle: (sectionId) => sections.find((s) => s.id === sectionId)?.title,
    onDragStateChange: (_active) => {
      // Bump cacheVersion so derived counts (smart list badges, section
      // counts) re-evaluate mid-gesture. Without this, badges go stale
      // between drag-start and the commit.
      cacheVersion++;
    },
  });

  // Push the snapshot into the controller whenever `sectionedView` changes.
  // The controller no-ops the sync while a drag is in progress so we never
  // overwrite the in-flight items the dndzone is animating against.
  $effect(() => {
    void dragSnapshot;
    dragController.syncFromSnapshot();
  });

  // File-drop handling (OS markdown + vault sidebar) is owned by the
  // `fileDropHandler` slice (instantiated above). `onSectionBodyDrop`
  // becomes the slice's exported method.

  /**
   * Context-menu fallback for cross-section moves. Appends the task (and its
   * descendants) to the end of `targetSectionId`. Used when the drag UX feels
   * fiddly — e.g. moving into a fully-collapsed section, or with no rows to
   * aim at — so the user always has a discoverable, no-drag path.
   */
  function moveTaskToSection(tileId: string, targetSectionId: string): void {
    if (!board) return;
    // When the right-clicked row is part of a multi-selection, the
    // expected action mirrors Kanban: move the whole selection (plus
    // descendants), not just the clicked row. The controller wraps the
    // move in a single MoveTaskBlockCommand so one Ctrl+Z reverses it.
    if (multiSelect.selectedTaskIds.has(tileId) && multiSelect.selectedTaskIds.size > 1) {
      // Materialise the synthetic default here too, before delegating —
      // the controller knows nothing about host sentinels.
      let realTargetId: string | null = targetSectionId;
      if (targetSectionId === DEFAULT_SECTION_ID) {
        realTargetId = ensureDefaultSectionMaterialized();
      }
      if (!realTargetId) return;
      multiSelect.bulkMoveToSection(realTargetId);
      return;
    }

    // Resolve target id first (synthetic default ⇒ materialise into a real
    // section so the persisted move has a stable id to point at).
    let realTargetId: string | null = targetSectionId;
    if (targetSectionId === DEFAULT_SECTION_ID) {
      realTargetId = ensureDefaultSectionMaterialized();
    }
    if (!realTargetId) return;

    const sourceIdx = placements.findIndex((p) => p.tileId === tileId);
    if (sourceIdx < 0) return;
    const sourceSection = sectionIdForPlacementIndex(sections, sourceIdx);
    if (sourceSection === realTargetId) return;

    // Snapshot for undo before computing the move.
    const sortedLive = [...sections].sort((a, b) => a.position - b.position);
    const targetIdx = sortedLive.findIndex((s) => s.id === realTargetId);
    const sectionStart = targetIdx >= 0 ? (sortedLive[targetIdx]?.position ?? 0) : 0;
    const sectionEnd = targetIdx >= 0
      ? (sortedLive[targetIdx + 1]?.position ?? placements.length)
      : placements.length;
    const sectionSize = Math.max(0, sectionEnd - sectionStart);

    const descendantIds = collectDescendantIds(viewModel.rows, tileId).filter((id) => id !== tileId);
    const beforeMove = snapshotSections();
    const { placements: nextPlacements, sections: nextSections } = moveTaskBlock({
      placements,
      sections,
      draggedId: tileId,
      descendantIds,
      targetSectionId: realTargetId,
      insertOffset: sectionSize,
    });
    historyStore.execute(
      new MoveTaskBlockCommand(
        board.id,
        beforeMove,
        { sections: nextSections, tasks: nextPlacements },
        'Move task to section',
      ),
    );
    tickAndPersist();
    lastTargetedSectionId = realTargetId;
  }

  // ── Toolbar wiring ──

  function applyGroupBy(g: GroupBy) {
    if (!board) return;
    if ((settings as { groupBy?: GroupBy }).groupBy === g) return;
    boardStore.updateBoardSettingsWithHistory(
      { groupBy: g },
      settings as Record<string, unknown>,
      'Change group by',
    );
  }

  function applySortBy(s: SortBy) {
    if (!board) return;
    if ((settings as { sortBy?: SortBy }).sortBy === s) return;
    boardStore.updateBoardSettingsWithHistory(
      { sortBy: s },
      settings as Record<string, unknown>,
      'Change sort by',
    );
  }

  function openTagsBrowser() {
    uiStore.openModal('tags-browser');
  }

  // ── lastView hydration / persistence ──
  //
  // The transient filter / smart-list / showCompleted state hydrates from
  // `settings.lastView` on board open and persists back via a debounced
  // effect. State + helper methods live on the `filters` controller; only
  // the two lifecycle effects stay here so they participate in component
  // teardown.
  $effect(() => {
    const id = board?.id;
    if (!id || !filters.needsHydrate(id)) return;
    untrack(() => {
      const lv = ((settings as Record<string, unknown>).lastView ?? null) as
        | LastViewSlice
        | null;
      filters.hydrateFromLastView(id, lv);
    });
  });

  $effect(() => {
    // Track every dimension that drives lastView so the effect re-runs on
    // any change. `filters.*` access tracks the runes; the local reads
    // here keep the dependency closure tight.
    void filters.activeFilterTags;
    void filters.activeFilterStatus;
    void filters.activeFilterPriority;
    void filters.showCompleted;
    void filters.activeSmartList;
    // groupBy/sortBy aren't in lastView (canonical in board settings,
    // never hydrated back), so a sort/group change must not re-fire this persist.
    const id = board?.id;
    if (!id || id !== filters.hydratedForBoardId) return;
    // Snapshot at ARM time (a teardown can run after the next board's hydrate
    // re-seeded `filters`) and write keyed by the CAPTURED id via
    // flushLastViewForBoard — never the pane's live board, which may be a
    // different board by then. Its JSON-equality guard skips no-change writes.
    const nextLastView = filters.buildLastView();
    if (filters.lastViewPersistTimer) clearTimeout(filters.lastViewPersistTimer);
    filters.lastViewPersistTimer = setTimeout(() => {
      filters.lastViewPersistTimer = null;
      flushLastViewForBoard(id, nextLastView);
    }, 300);
    // Clear the debounce with the effect, but flush on a board switch: a filter
    // change within 300 ms of a switch would otherwise never be written (the
    // hydratedForBoardId guard blocks any re-fire after the switch). The cleanup
    // runs before EVERY re-execution, so flush ONLY when the live id moved off
    // the armed id — flushing unconditionally would defeat the debounce. A
    // same-board re-run just re-arms the timer; unmount is flushed by
    // `filters.dispose()` in onDestroy.
    return () => {
      if (filters.lastViewPersistTimer) {
        clearTimeout(filters.lastViewPersistTimer);
        filters.lastViewPersistTimer = null;
        if (board?.id !== id) {
          flushLastViewForBoard(id, nextLastView); // allow-teardown-save: `filters` registers this view's flush for a save or a leave
        }
      }
    };
  });

  // ── Keyboard shortcuts ──
  //
  // Two layers:
  //  1. `N` and `Ctrl+A` register via the global hotkey registry so they're
  //     discoverable in the Keyboard Shortcuts settings panel and obey the
  //     editable-target guard built into `handleKeyDown`.
  //  2. Row-focused keys (↑ / ↓ / Tab / Shift+Tab / Escape) are handled by a
  //     local listener that walks the DOM to find the focused row's
  //     data-task-id. Routing them through the global registry would race
  //     with text-input typing because the registry's guard skips inputs.

  let unregisterTaskListCommands: (() => void)[] = [];
  let sectionDragCancelCleanup: (() => void) | null = null;

  // Active-pane guard for the board-scoped shortcuts below. A split view can
  // mount two boards at once and both register the same bare key (`n` is also
  // claimed by Kanban). PaneView pins the active scope to the focused pane, so
  // gating each binding on "is my pane the active one" lets the global key
  // handler skip this binding when another pane is active and route the key to
  // the focused board instead.
  const isActivePane = (): boolean => isActiveScope(scope);
  let quickAddInputEl = $state<HTMLInputElement | null>(null);
  let scrollContainerEl: HTMLDivElement | undefined = $state();

  // ── Popups dispatched from row buttons ──
  //
  // TaskItem's Tags / Style buttons dispatch custom events that bubble up to
  // the board's scroll container. We listen for them once and mount the
  // TagEditor / ElementStylePopup components — same pattern used by
  // MindMapBoard.
  let tagEditorPopup = $state<{ tileId: string; x: number; y: number } | null>(null);
  let taskItemStylePopup = $state<{ tileId: string; style?: PartialTaskStyle; x: number; y: number } | null>(null);
  $effect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    function handleStylePopup(e: Event) {
      const detail = (e as CustomEvent).detail;
      const tile = detail.tile as Tile;
      const placement = placements.find((p) => p.tileId === tile.id);
      taskItemStylePopup = {
        tileId: tile.id,
        style: placement?.style as PartialTaskStyle | undefined,
        x: detail.x,
        y: detail.y,
      };
    }
    function handleTagEditor(e: Event) {
      const detail = (e as CustomEvent).detail;
      tagEditorPopup = { tileId: detail.tileId, x: detail.x, y: detail.y };
    }
    el.addEventListener('tile-style-popup', handleStylePopup);
    el.addEventListener('tile-tag-editor', handleTagEditor);
    return () => {
      el.removeEventListener('tile-style-popup', handleStylePopup);
      el.removeEventListener('tile-tag-editor', handleTagEditor);
    };
  });

  function toggleTaskLocked(tileId: string): void {
    if (!board) return;
    const tile = tilesById[tileId];
    if (!tile) return;
    // Placement-level lock: same .md referenced from another board stays
    // unlocked. Matches MindMapTilePlacement.locked semantics.
    const before = tile.locked === true;
    const after = !before;
    historyStore.execute(
      new TogglePlacementLockCommand(board.id, tileId, before, after),
    );
    tickAndPersist();
  }

  // Keyboard navigation — ↑/↓ row focus, Tab/Shift+Tab indent/outdent,
  // Alt+Up/Down row reorder. The capture-phase `handleBoardKeydown`
  // handler is bound to `scrollContainerEl` by the `$effect` below;
  // ownership stays in the host because the listener registration must
  // tear down with the board switch.
  const keyboardNav = new TaskListKeyboardNav({
    getBoard: () => board,
    getRows: () => viewModel.rows,
    getRenderedRows: () => viewModel.renderedRows,
    getPlacements: () => placements,
    getSections: () => sections,
    getSortBy: () => sortBy,
    snapshotSections,
    ...indentOps,
    tickAndPersist,
    getSelectionSize: () => multiSelect.selectedTaskIds.size,
    clearSelection: () => multiSelect.clearSelection(),
  });

  onMount(() => {
    // Ctrl+Enter and Ctrl+N (the Mind Map's New Tile, which stands aside off
    // the Mind Map) create a blank task; Alt+Up / Alt+Down reorder within the
    // section. Lock / style / collapse have no shortcut: they're invoked via
    // row props (`onToggleLocked` / `onToggleSubtaskCollapsed`).
    const newTask = (): void => { if (board) void addTask(); };
    const shortcuts: Array<[string, string, string, ShortcutBinding, () => void]> = [
      ['tasklist:focus-quick-add', 'Task List: Focus quick-add input', '', { key: 'n' }, () => quickAddInputEl?.focus()],
      ['tasklist:select-all', 'Task List: Select all visible', '', { key: 'a', ctrl: true }, () => { if (board) multiSelect.selectAllVisible(); }],
      ['tasklist:add-task', 'Task List: Add task', '', { key: 'Enter', ctrl: true }, newTask],
      ['tasklist:new-task', 'Task List: New task', '', { key: 'n', ctrl: true }, newTask],
      ['tasklist:move-up', 'Task List: Move task up', 'Task List: Move task up within section', { key: 'ArrowUp', alt: true }, () => keyboardNav.moveFocusedRow(-1)],
      ['tasklist:move-down', 'Task List: Move task down', 'Task List: Move task down within section', { key: 'ArrowDown', alt: true }, () => keyboardNav.moveFocusedRow(1)],
    ];
    unregisterTaskListCommands = shortcuts.map(([name, label, description, binding, execute]) =>
      registerCommandWithShortcut({ name, label, description: description || label, binding, enabled: isActivePane, execute }));
    // Recover from aborted section drags (Esc, Alt-Tab, window blur). The
    // gate flip alone is enough — the resync $effect tracks
    // `sectionDragDisabled` so flipping it true triggers a re-evaluation
    // that pulls the canonical order back from sectionedView. Also sweep
    // any stale inline styles svelte-dnd-action may have left on neighbour
    // sections so they don't end up invisible.
    const cancelSectionDrag = () => {
      // Skip the re-render-forcing recovery when no drag is in flight
      // (section drag active ⇔ `sectionDragDisabled` false; row drag ⇔ a live
      // `dragTileId`), so a bare Escape doesn't churn the list every keypress.
      if (sectionDragDisabled && dragController.dragTileId === null) return;
      sectionDragDisabled = true;
      // Re-assign by identity so the `use:clearStaleDndStyles` action's
      // `update` callback fires on every section. Cancelled drags don't
      // write a reorder commit, so this is the only path that sweeps
      // svelte-dnd-action's inline `visibility: hidden` off the source
      // section after Esc / pointercancel / dragend.
      dndSections = [...dndSections];
      // Same defensive sweep for in-flight row drags: forces a re-render
      // of the row dndzones so `clearStaleDndRowStyles` runs on every
      // section's rows.
      dragController.cancelDrag();
    };
    const onKeydownEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelSectionDrag();
    };
    window.addEventListener('dragend', cancelSectionDrag);
    window.addEventListener('pointercancel', cancelSectionDrag);
    window.addEventListener('keydown', onKeydownEsc);
    sectionDragCancelCleanup = () => {
      window.removeEventListener('dragend', cancelSectionDrag);
      window.removeEventListener('pointercancel', cancelSectionDrag);
      window.removeEventListener('keydown', onKeydownEsc);
    };
  });
  onDestroy(() => {
    // Drain any queued frontmatter writes so a board close during the
    // 300ms debounce window doesn't lose the user's last field edit.
    void noteStore.flushAll();
    // dispose() cancels the lastView debounce and FLUSHES the pending slice
    // (cache write keyed by the hydrated board id) instead of dropping it.
    filters.dispose();
    for (const fn of unregisterTaskListCommands) fn();
    unregisterTaskListCommands = [];
    sectionDragCancelCleanup?.();
    sectionDragCancelCleanup = null;
    dragController.cancelDrag();
    announcer.dispose();
  });

  // Bind the keydown handler to the scroll container in CAPTURE phase via an
  // effect so a board switch (which rebinds scrollContainerEl) re-registers
  // the listener cleanly. Capture-phase keeps Tab intercepted before any
  // descendant focus shift can occur.
  $effect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    el.addEventListener('keydown', keyboardNav.handleBoardKeydown, true);
    return () => {
      el.removeEventListener('keydown', keyboardNav.handleBoardKeydown, true);
    };
  });
</script>

{#snippet renderSection(section: SectionView, draggable: boolean)}
  <TaskListSectionComponent
    {section}
    {draggable}
    defaultSectionId={DEFAULT_SECTION_ID}
    leadingSectionId={LEADING_SECTION_ID}
    {collapsedSubtasks}
    accentColor={accent}
    {resolveTaskStyle}
    sectionStyle={styleForSection(section.id)}
    titleFontSize={listTitleSize ?? undefined}
    {flatEntryByTileId}
    dndSectionsTrigger={dndSections}
    viewModel={viewModel}
    controllers={{
      drag: dragController,
      multiSelect,
      writers: frontmatterWriter,
    } satisfies TaskListSectionControllers}
    callbacks={{
      toggleSectionCollapsed,
      commitSectionRename,
      cancelSectionRename,
      openSectionContextMenu,
      openSectionStylePopup,
      onSectionHeaderPointerDown,
      addTaskToSection,
      onSectionBodyDrop,
    } satisfies TaskListSectionCallbacks}
    rowCallbacks={{
      onRenameTask: renameTask,
      onDeleteTask: deleteTask,
      onDeleteWithFile: deleteTaskWithFile,
      onOpenTask: openTaskAsDocument,
      onAddSubtask: addSubtaskFor,
      onToggleLocked: toggleTaskLocked,
      onMoveToSection: moveTaskToSection,
      onToggleSubtaskCollapsed: toggleSubtaskCollapsed,
      onEditTags: (tileId, anchor) => {
        tagEditorPopup = { tileId, x: anchor.x, y: anchor.y };
      },
    } satisfies TaskListRowCallbacks}
    boardCtx={{ placements, sections }}
    bind:editingSectionId
    bind:editingSectionTitle
    bind:dragOverSectionId
    bind:lastTargetedSectionId
  />
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="tasklist-board"
  bind:this={scrollContainerEl}
  role="region"
  aria-label="Task List"
  onclick={clearSelectionOnBoardClick}
>
  <BoardBackground
    pattern={settings.backgroundPattern ?? vaultStore.project?.settings?.tasklist?.backgroundPattern}
    bgColor={settings.backgroundColor || vaultStore.project?.settings?.tasklist?.backgroundColor || ''}
  />
  <div class="tasklist-content">
    <div class="tasklist-quick-add-wrap">
      <TaskQuickAddInput
        accentColor={accent}
        onSubmit={addTaskFromQuickAdd}
        bind:inputRef={quickAddInputEl}
      />
    </div>

    <div class="tasklist-smart-tabs-wrap">
      <SmartListTabs
        active={filters.activeSmartList}
        counts={viewModel.smartListCounts}
        accentColor={accent}
        onSelect={(id) => (filters.activeSmartList = id)}
      />
    </div>

    <div class="tasklist-progress-bar">
      <div class="progress-info">
        <span class="progress-label">Progress</span>
        <span class="progress-count">{completedCount}/{totalTasks} tasks ({progressPercent}%)</span>
      </div>
      <div class="progress-track">
        <div
          class="progress-fill"
          style:transform="scaleX({progressPercent / 100})"
          style:background-color={accent}
        ></div>
      </div>
    </div>

    <div class="tasklist-groups">
        <!-- Leading bucket (tasks before the first persisted section) renders
             outside the dndzone — it's not a draggable section, just a
             carryover from legacy boards. -->
        {#each viewModel.sectionedView as section (section.id ?? '__leading__')}
          {#if !section.id}
            {@render renderSection(section, false)}
          {/if}
        {/each}

        <div
          class="tasklist-section-dnd"
          use:dndzone={{
            items: dndSections,
            dragDisabled: sectionDragDisabled,
            flipDurationMs: 220,
            type: 'tasklist-sections',
            dropTargetStyle: {},
            transformDraggedElement: transformDraggedSection,
          }}
          onconsider={onConsiderSections}
          onfinalize={onFinalizeSections}
        >
          {#each dndSections as item (item.id)}
            {@const section = viewModel.sectionedView.find((s) => s.id === item.id)}
            {#if section}
              {@render renderSection(section, true)}
            {/if}
          {/each}
        </div>

        <button class="add-section-btn" onclick={() => addSection()} title="Add section">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>Add section</span>
        </button>

      {#if viewModel.filteredRows.length === 0 && filters.hasActiveFilter}
        <!-- Filtered to empty: distinct from "no tasks" so the CTA pair makes
             sense — primary action is to clear filters (recover the view),
             secondary is to add a task anyway. -->
        <div class="empty-board" role="status">
          <svg class="empty-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          <p class="empty-title">No tasks match these filters</p>
          <p class="empty-hint">
            {#if filters.activeSmartList !== 'all'}Smart list "{filters.activeSmartList}" is active.{/if}
            Try clearing filters to bring everything back.
          </p>
          <div class="empty-actions">
            <button class="empty-add-btn" onclick={() => filters.clearAllFilters()}>Clear filters</button>
            <button class="empty-add-btn ghost" onclick={addTask}>Add task</button>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <FloatingTocPanel
    sections={viewModel.sectionedView.flatMap((s) => (s.id ? [{ id: s.id, title: s.title }] : []))}
    {scrollContainerEl}
    onAddSection={addSection}
  />

  {#if multiSelect.selectedTaskIds.size > 0}
    <TaskBulkActionBar
      count={multiSelect.selectedTaskIds.size}
      onClear={() => multiSelect.clearSelection()}
      onSetPriority={(p) => multiSelect.bulkSetPriority(p)}
      onSetDueDate={(d) => multiSelect.bulkSetDueDate(d)}
      onMarkComplete={() => multiSelect.bulkMarkComplete()}
      onMarkIncomplete={() => multiSelect.bulkMarkIncomplete()}
      onDelete={() => multiSelect.bulkDelete()}
      availableSections={viewModel.availableSectionsForMove}
      onMoveToSection={(sectionId) => {
        // Resolve the synthetic default-section id before delegating —
        // the controller intentionally doesn't know about host sentinels.
        let realId: string | null = sectionId;
        if (sectionId === DEFAULT_SECTION_ID) {
          realId = ensureDefaultSectionMaterialized();
        }
        if (realId) multiSelect.bulkMoveToSection(realId);
      }}
    />
  {/if}

  {#if uiStore.boardToolbarVisible}
    <TaskListSideToolbar
      onAddTask={addTask}
      activeGroupBy={groupBy}
      onGroupByChange={applyGroupBy}
      activeSortBy={sortBy}
      onSortByChange={applySortBy}
      statusOptions={statusFilterOptions(viewModel.rows, filters.activeFilterStatus)}
      activeFilterTags={filters.activeFilterTags}
      onFilterTagsChange={(tags) => filters.applyFilterTags(tags)}
      activeFilterStatus={filters.activeFilterStatus}
      onFilterStatusChange={(s) => filters.applyFilterStatus(s)}
      activeFilterPriority={filters.activeFilterPriority}
      onFilterPriorityChange={(p) => filters.applyFilterPriority(p)}
      showCompleted={filters.showCompleted}
      onShowCompletedChange={(v) => filters.setShowCompleted(v)}
      onOpenTagsBrowser={openTagsBrowser}
      onMarkAllIncomplete={markAllIncomplete}
      onDeleteAllCompleted={deleteAllCompleted}
      savedViews={filters.savedViews}
      onApplyView={(view) => filters.applySavedView(view)}
      onSaveView={(name) => filters.saveCurrentView(name)}
      onDeleteView={(id) => filters.deleteSavedView(id)}
    />
  {/if}

  <!-- Task-item style popup (placement override) -->
  {#if taskItemStylePopup && board}
    <ElementStylePopup kind="task"
      boardId={board.id}
      elementId={taskItemStylePopup.tileId}
      style={taskItemStylePopup.style}
      x={taskItemStylePopup.x}
      y={taskItemStylePopup.y}
      onclose={() => (taskItemStylePopup = null)}
    />
  {/if}

  <!-- Section-style popup -->
  {#if sectionStylePopup && board}
    <ElementStylePopup kind="taskSection"
      boardId={board.id}
      elementId={sectionStylePopup.sectionId}
      style={sectionStylePopup.style}
      x={sectionStylePopup.x}
      y={sectionStylePopup.y}
      onclose={() => (sectionStylePopup = null)}
    />
  {/if}

  <!-- Tag editor popup -->
  {#if tagEditorPopup}
    <div
      class="tasklist-tag-editor-overlay"
      style="position: fixed; left: {tagEditorPopup.x}px; top: {tagEditorPopup.y}px; z-index: var(--z-context-menu-overlay);"
    >
      <TagEditor
        tileId={tagEditorPopup.tileId}
        onClose={() => (tagEditorPopup = null)}
      />
    </div>
  {/if}

  <!--
    Screen-reader-only live region. Adds (or aria-presence-bumps) text on
    add / delete / bulk actions so SR users get parity with the visual
    toast queue, covering the operations that DON'T toast (single-row
    add, subtask add, single delete).
  -->
  <div class="tasklist-sr-live" aria-live="polite" aria-atomic="true">{announcer.message}</div>

  <!--
    Persistent keyboard hint footer — small, low-contrast, discoverable
    without being noisy. Surfaces the row-level shortcuts so users
    notice them on first run without an explicit overlay.
  -->
  <div class="tasklist-kbd-hints" aria-hidden="true">
    <span><kbd>Space</kbd> Toggle</span>
    <span><kbd>Enter</kbd> Rename</span>
    <span><kbd>D</kbd> Due date</span>
    <span><kbd>1</kbd>–<kbd>4</kbd> Priority</span>
    <span><kbd>Del</kbd> Remove</span>
    <span><kbd>Ctrl</kbd>+<kbd>A</kbd> Select all</span>
  </div>
</div>

<style>
  .tasklist-board {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    position: relative;
    padding: 24px;
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 16px;
  }

  /**
   * Holds the quick-add / smart-tabs / progress / groups column. Width-
   * capped so reading width matches the pre-ToC layout; flex:1 absorbs
   * leftover horizontal space when the ToC is hidden on narrow viewports.
   */
  .tasklist-content {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 800px;
    margin: 0 auto;
  }

  .tasklist-quick-add-wrap {
    margin: 0 0 12px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--ui-border-light);
  }

  .tasklist-smart-tabs-wrap {
    margin: 0 0 16px;
  }

  .tasklist-progress-bar {
    margin: 0 0 20px;
  }

  .progress-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .progress-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .progress-count {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .progress-track {
    height: 4px;
    background: var(--ui-border-light);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    width: 100%;
    height: 100%;
    border-radius: 2px;
    transform-origin: left center;
    transition: transform 0.3s ease;
    will-change: transform;
  }

  .tasklist-groups {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Container that holds all draggable sections. Mirrors `.tasklist-groups`
     flex layout so sections inside the dndzone wrap the same as those
     outside (the leading "Unsectioned" bucket). */
  .tasklist-section-dnd {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Cursor-following clone while dragging — svelte-dnd-action tags it via
     `transformDraggedSection`. Lifts it slightly so the user can see the
     drop slot underneath. */
  :global(.tasklist-section-dragging) {
    transform: rotate(0.5deg) scale(1.01);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
    cursor: grabbing !important;
  }

  /* Defensive: svelte-dnd-action marks the source element as a "shadow item"
     during a drag and applies visibility: hidden via inline style. If the
     `use:clearStaleDndStyles` action misses for any reason, this rule keeps
     the in-flight shadow visible at a dimmed opacity rather than
     disappearing. The `:global` wrapper is required because Svelte's
     compiler scopes attribute selectors and doesn't see svelte-dnd-action's
     runtime-applied `data-is-dnd-shadow-item` attribute. */
  :global(.tasklist-section-dnd .tasklist-section[data-is-dnd-shadow-item]) {
    visibility: visible !important;
    opacity: 0.35;
  }

  /* Section header / title / draggable cursor / rename input / drop-target /
     add-task buttons / inline quick-add / row dndzone styles live in
     `TaskListSection.svelte`. Only selectors still rendered by
     the host template (`.add-section-btn`, the non-sectioned `groupBy`
     header chrome — `.tasklist-group / .group-header / .group-collapse-btn /
     .group-title / .group-count / .group-rows / .empty-group`) remain. */

  .add-section-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px dashed var(--ui-border);
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 12px;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
  }

  .add-section-btn:hover {
    color: var(--text-primary);
    border-color: var(--ui-border-focus, var(--accent-primary));
    background: var(--ui-surface-hover);
  }

  /* `.tasklist-row-wrap` styles live in TaskListRow.svelte.
     `.row-dnd-zone` styles live in TaskListSection.svelte. */

  /* Cursor-following clone tagged by `transformDraggedRow` on every
     dragmove tick. svelte-dnd-action clones the immediate child of the
     dndzone (the `.tasklist-row-wrap` itself) so the class lands on that
     wrapper. Mirrors the Kanban-column held-visual exactly so the user's
     reference for "right" stays consistent across board types.
     `!important` on the shadow because svelte-dnd-action stamps its own
     inline shadow during the drop animation — ours overrides theirs. */
  :global(.tasklist-row-dragging) {
    transform: rotate(0.5deg) scale(1.01);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18) !important;
    transition: transform 120ms ease, box-shadow 120ms ease;
    z-index: 2;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.tasklist-row-dragging) {
      transform: none;
      transition: none;
    }
  }

  .empty-board {
    text-align: center;
    padding: 64px 16px;
    color: var(--text-tertiary);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .empty-icon {
    color: var(--text-tertiary);
    opacity: 0.55;
    margin-bottom: 4px;
  }

  .empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0;
  }

  .empty-hint {
    max-width: 360px;
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0 0 8px;
    line-height: 1.5;
  }

  .empty-actions {
    display: inline-flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .empty-add-btn {
    padding: 8px 16px;
    border: 1px solid var(--accent-primary);
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
  }

  .empty-add-btn:hover {
    opacity: 0.9;
  }

  .empty-add-btn.ghost {
    background: transparent;
    color: var(--accent-primary);
  }

  .empty-add-btn.ghost:hover {
    background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
    opacity: 1;
  }

  /* Screen-reader-only live region — visually hidden but always announced. */
  .tasklist-sr-live {
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

  /* Persistent kbd-hint footer — pinned to the board floor, kept low-key
     so it doesn't fight for attention but stays in the user's peripheral
     vision. Hidden on narrow viewports where the toolbar already crowds
     the view. */
  .tasklist-kbd-hints {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 6px;
    display: flex;
    gap: 14px;
    justify-content: center;
    flex-wrap: wrap;
    pointer-events: none;
    font-size: 10px;
    color: var(--text-tertiary);
    padding: 4px 16px;
  }

  .tasklist-kbd-hints:hover {
    pointer-events: auto;
  }

  .tasklist-kbd-hints span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .tasklist-kbd-hints kbd {
    display: inline-block;
    padding: 1px 5px;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    color: var(--text-secondary);
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border-light);
    border-radius: 3px;
  }

  @media (max-width: 640px) {
    .tasklist-kbd-hints { display: none; }
  }
</style>
