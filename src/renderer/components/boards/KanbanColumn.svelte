<script lang="ts">
  /**
   * KanbanColumn — V7 Kanban column.
   *
   * Receives the resolved `Tile` objects (def + style + boardId) for each
   * placement and mounts the matching tile body inside a flow-layout
   * `TileContainer`. Drag/drop reorders placements between columns; the
   * Add-Tile button opens the type-picker modal upstream.
   */
  import { untrack, getContext } from 'svelte';
  import {
    dndzone,
    SHADOW_ITEM_MARKER_PROPERTY_NAME,
    type DndEvent,
  } from 'svelte-dnd-action';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const selectionStore = scope.selection;

  // When General settings → Toggle Hover Buttons → Columns is Off, the
  // column header's 3-dot menu button stays permanently visible. By default
  // the toggle is On (hover-to-show), bringing column header buttons in line
  // with the rest of the surfaces.
  let forceShowButtons = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.columns === false,
  );
  import type { Tile, KanbanTilePlacement } from '../../schema/index';
  import type {
    ResolvedColumnStyle,
    ResolvedCardStyle,
  } from '../../lib/styles/effectiveStyle';
  import type { KanbanCardDndItem } from '../../lib/kanban/kanbanDragController.svelte';
  import KanbanCard from './KanbanCard.svelte';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { handleListKeyNav, focusFirstItem } from '../../lib/utils/listKeyNav';
  import { tick } from 'svelte';

  type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

  // True when the dragover/drop payload is either an OS file drag or a
  // vault-sidebar drag. During `dragover`, browsers withhold
  // `dataTransfer.files` for OS file drags (security) — only `types` carries
  // the sentinel `'Files'`. Reading `files?.length` instead made
  // `preventDefault` skip for OS drags, so the browser painted the no-entry
  // cursor and refused the drop. Test `types` only.
  function dragHasFiles(e: DragEvent): boolean {
    const t = e.dataTransfer?.types;
    if (!t) return false;
    return (
      t.includes('Files') ||
      t.includes('application/x-vault-file') ||
      t.includes('application/x-vault-files')
    );
  }

  let isDragOver = $state(false);
  let dragCounter = 0;

  function handleDragEnter(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    isDragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      isDragOver = false;
    }
  }

  function handleDrop(_e: DragEvent) {
    dragCounter = 0;
    isDragOver = false;
  }

  // Outer wrapper dragover/drop — covers the column header which sits
  // outside `.column-body`. Without these, dragging over the header paints
  // the no-entry cursor and snaps the file back. Inner handlers already
  // preventDefault when the pointer is over them; `defaultPrevented` keeps
  // us from double-importing.
  function handleOuterDragOver(e: DragEvent) {
    if (dragHasFiles(e)) e.preventDefault();
  }
  function handleOuterDrop(e: DragEvent) {
    handleDrop(e);
    if (dragHasFiles(e) && !e.defaultPrevented) {
      e.preventDefault();
      onColumnFileDrop(e);
    }
  }

  interface Column {
    id: string;
    title: string;
    collapsed?: boolean;
    wipLimit?: number;
  }

  let {
    column,
    placements,
    placementsByTileId,
    visibleTileIds,
    dragTileId,
    dragBlockIds,
    clearStaleDndCardStyles,
    cardItems,
    tilesById,
    accentColor,
    columnStyle,
    resolveCardStyle,
    totalCount = 0,
    filterActive = false,
    cardDragDisabled = true,
    cardFlipDurationMs = 180,
    onRename,
    onDelete,
    onAddTile,
    onDeleteTile,
    onCardPointerDown,
    onConsiderCards,
    onFinalizeCards,
    transformDraggedCard,
    onToggleCollapse,
    onColumnFileDrop,
    onColumnHeaderPointerDown,
    onSetDueDate,
    onSetPriority,
    onPickCoverImage,
    onClearCoverImage,
    onSetWipLimit,
    onTileClick,
    onBulkContextMenu,
    onOpenAsDocument,
    onMoveColumn,
    onOpenColumnStyle,
    onOpenCardStyle,
  }: {
    column: Column;
    /** Filtered placements for this column. Used for the empty-state count
     *  and the filter-active hint; the render loop uses
     *  `placementsByTileId` so cross-column drags can resolve placements. */
    placements: KanbanTilePlacement[];
    /** Board-wide placement lookup keyed by tileId. Lets the destination
     *  column resolve the dragged tile's placement mid-drag (when its
     *  canonical placement still lives in the source column). */
    placementsByTileId: Record<string, KanbanTilePlacement>;
    /** Board-wide set of tileIds that pass the active filter. */
    visibleTileIds: ReadonlySet<string>;
    /** The tile currently being dragged, or null. Forces render of the
     *  dragged tile even if it would otherwise be filtered out — keeps the
     *  drag visually coherent across columns. */
    dragTileId: string | null;
    /** Ordered tile IDs in the current multi-card drag block. Single-card
     *  drags pass `[anchor]`; multi-card drags pass every selected unlocked
     *  card. Used to dim non-anchor members in source columns during the drag. */
    dragBlockIds: string[];
    /** Svelte action exposed by `KanbanDragController` that sweeps inline
     *  visibility/opacity/transform off card wrappers after each consider
     *  event. svelte-dnd-action writes those styles directly during the
     *  drag and the keyed `{#each}` reuses the DOM nodes afterwards. */
    clearStaleDndCardStyles: (
      node: HTMLElement,
      trigger: unknown,
    ) => { update(t: unknown): void; destroy(): void };
    /** dndzone items mirror for this column (controller-owned). */
    cardItems: KanbanCardDndItem[];
    /** Map of tileId → resolved Tile, supplied by parent. */
    tilesById: Record<string, Tile>;
    accentColor: string;
    columnStyle?: ResolvedColumnStyle;
    /** Per-card cascade resolver supplied by <KanbanBoard>. Called with each
     *  placement's `style` so per-card overrides win over the column / global
     *  card defaults. Replaces the previous board-level `cardStyle` prop
     *  which forced the column to hand-merge a subset of placement.style. */
    resolveCardStyle: (placementStyle?: Record<string, unknown> | null) => ResolvedCardStyle;
    /** Number of placements before filtering — used by the empty state to
     *  distinguish "truly empty" from "hidden by filter". */
    totalCount?: number;
    /** Whether any board-level filter is currently narrowing the column. */
    filterActive?: boolean;
    /** Per-zone drag-disabled gate — flipped to `false` by `onCardPointerDown`
     *  for one gesture, mirroring how `columnDragDisabled` gates column drag. */
    cardDragDisabled?: boolean;
    /** Per-zone FLIP animation duration. The controller drops this to 0
     *  under `prefers-reduced-motion: reduce` so the OS pref wins. */
    cardFlipDurationMs?: number;
    onRename: (title: string) => void;
    onDelete: () => void;
    onAddTile: () => void;
    onDeleteTile: (tileId: string) => void;
    /** Pointerdown on a card wrapper — arms `cardDragDisabled = false` if the
     *  target isn't editable / a button (so TipTap text selection still works). */
    onCardPointerDown: (e: PointerEvent, tileId: string, locked: boolean) => void;
    onConsiderCards: (e: CustomEvent<DndEvent<KanbanCardDndItem>>) => void;
    onFinalizeCards: (e: CustomEvent<DndEvent<KanbanCardDndItem>>) => void;
    transformDraggedCard: (el?: HTMLElement) => void;
    onToggleCollapse: () => void;
    /** OS / vault-file drop on this column (e.g. .png, .md). */
    onColumnFileDrop: (e: DragEvent) => void;
    /**
     * Header pointerdown — enables column-level drag in the parent's
     * svelte-dnd-action zone for the next pointer gesture. The header is the
     * explicit drag handle; pointerdowns on interactive children (collapse
     * btn, rename input, menu btn) are filtered out before this fires so
     * those gestures keep their click behaviour. Card-within-column dragging
     * uses its own dndzone on `.column-cards-zone`.
     */
    onColumnHeaderPointerDown: (e: PointerEvent) => void;
    onSetDueDate: (tileId: string, dueDate: string) => void;
    onSetPriority: (tileId: string, priority: Priority) => void;
    onPickCoverImage: (tileId: string) => void;
    onClearCoverImage: (tileId: string) => void;
    /** Sets (or clears, with `null`) the WIP limit for this column. */
    onSetWipLimit: (wipLimit: number | null) => void;
    /**
     * Bubbles a card click to the parent so it can update the global
     * selection (Ctrl-toggle, Shift-range, plain single-select). Events from
     * editable targets and interactive children are filtered out before
     * dispatch.
     */
    onTileClick: (e: MouseEvent, tileId: string) => void;
    /**
     * Opens the bulk-action context menu when the right-clicked card is part
     * of a multi-item selection. The parent owns the menu items so the move/
     * delete/tag handlers can reach board-level state.
     */
    onBulkContextMenu: (e: MouseEvent, tileId: string) => void;
    /**
     * Opens the tile's backing `.md` file as a Document board in a new tab.
     * Provided by the parent so the open path (documentStore.loadDocument
     * + tabStore.open) stays in one place. Only meaningful for text tiles;
     * the column hides the menu item for non-text tiles before dispatch.
     */
    onOpenAsDocument: (tileId: string) => void;
    /**
     * Keyboard column reorder (a11y companion to pointer drag). The column
     * fires this from its focused title with Alt+Arrow; the parent looks
     * up the column's position and swaps with the adjacent column.
     * `direction: -1` = move left, `+1` = move right.
     */
    onMoveColumn: (direction: -1 | 1) => void;
    /** Opens the per-column Style popup at the given viewport coordinates. */
    onOpenColumnStyle?: (x: number, y: number) => void;
    /** Opens the per-card Style popup. The popup writes to placement.style. */
    onOpenCardStyle?: (tileId: string, x: number, y: number) => void;
  } = $props();

  let columnInlineStyle = $derived.by(() => {
    if (!columnStyle) return '';
    const parts: string[] = [];
    if (columnStyle.bodyColor) parts.push(`background-color: ${columnStyle.bodyColor}`);
    if (columnStyle.borderColor) parts.push(`border-color: ${columnStyle.borderColor}`);
    if (columnStyle.borderStyle) parts.push(`border-style: ${columnStyle.borderStyle}`);
    if (columnStyle.borderWidth >= 0) parts.push(`border-width: ${columnStyle.borderWidth}px`);
    if (columnStyle.shadowIntensity >= 0) parts.push(`box-shadow: 0 2px ${8 * columnStyle.shadowIntensity}px rgba(0,0,0,${0.3 * columnStyle.shadowIntensity})`);
    if (columnStyle.bodyTextColor) parts.push(`color: ${columnStyle.bodyTextColor}`);
    const widthPx = columnStyle.width > 0 ? columnStyle.width : 380;
    parts.push(`--column-width: ${widthPx}px`);
    return parts.join('; ');
  });

  let headerInlineStyle = $derived.by(() => {
    if (!columnStyle) return '';
    const parts: string[] = [];
    if (columnStyle.headerColor) parts.push(`background-color: ${columnStyle.headerColor}`);
    if (columnStyle.headerTextColor) parts.push(`color: ${columnStyle.headerTextColor}`);
    return parts.join('; ');
  });

  // Resolved accent: per-column override wins, then the board-level
  // `settings.accentColor` (passed as the `accentColor` prop). Empty falls
  // through to the theme default via the `--accent-primary` CSS variable.
  // Drives the accent bar and the per-column card-count badge.
  let resolvedAccent = $derived(
    columnStyle?.accent || accentColor || 'var(--accent-primary)',
  );


  let isEditingTitle = $state(false);
  let editTitle = $state(untrack(() => column.title));
  let showMenu = $state(false);
  let showWipEditor = $state(false);
  let wipDraft = $state<string>(untrack(() => (column.wipLimit ?? 0).toString()));

  // ── Column action menu a11y ──
  // The menu opens from the "…" trigger button. Arrow keys cycle items,
  // Escape closes + returns focus to the trigger. Items use role=menuitem
  // so AT readers announce them as menu items rather than plain buttons.
  let columnMenuEl: HTMLElement | null = $state(null);
  let columnMenuTriggerEl: HTMLButtonElement | null = $state(null);

  function onColumnMenuKeydown(e: KeyboardEvent): void {
    if (!columnMenuEl) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      showMenu = false;
      columnMenuTriggerEl?.focus();
      return;
    }
    if (handleListKeyNav(e, columnMenuEl, { selector: '[role="menuitem"]', orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  $effect(() => {
    if (showMenu && columnMenuEl) {
      void tick().then(() => {
        if (columnMenuEl) focusFirstItem(columnMenuEl, '[role="menuitem"]');
      });
    }
  });

  // WIP limit derived state. `wipLimit > 0` is treated as active — `0` and
  // `undefined` both mean "no limit". `wipExceeded` drives the column's red
  // border + count badge styling. We use placement count rather than visible
  // count so filters can't mask an over-limit column.
  //
  // Optimistic preview: while the WIP popover is open, the user's typed
  // draft drives the exceeded preview so the column border tints red the
  // moment they type "3" into a column of 5. After Apply/close, the
  // persisted value takes over again.
  let wipLimit = $derived<number>(typeof column.wipLimit === 'number' ? column.wipLimit : 0);
  let wipDraftPreview = $derived.by<number>(() => {
    if (!showWipEditor) return wipLimit;
    const parsed = parseInt(wipDraft, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  });
  let wipActive = $derived<boolean>(
    showWipEditor ? wipDraftPreview > 0 : wipLimit > 0,
  );
  let wipExceeded = $derived<boolean>(
    wipActive && totalCount > (showWipEditor ? wipDraftPreview : wipLimit),
  );

  function startEditWip() {
    wipDraft = wipLimit > 0 ? wipLimit.toString() : '';
    showWipEditor = true;
  }

  function commitWipLimit() {
    const parsed = parseInt(wipDraft, 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    onSetWipLimit(next);
    showWipEditor = false;
  }

  function clearWipLimit() {
    onSetWipLimit(null);
    showWipEditor = false;
  }

  function onWipKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitWipLimit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showWipEditor = false;
    }
  }

  function startEditTitle() {
    editTitle = column.title;
    isEditingTitle = true;
  }

  function commitTitle() {
    isEditingTitle = false;
    if (editTitle.trim() && editTitle !== column.title) {
      onRename(editTitle.trim());
    }
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      commitTitle();
    } else if (e.key === 'Escape') {
      isEditingTitle = false;
      editTitle = column.title;
    }
  }

  function handleContextMenu(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const menuX = e.clientX;
    const menuY = e.clientY;
    uiStore.showContextMenu(menuX, menuY, [
      { id: 'add-tile', label: 'Add Card', icon: 'M12 5v14M5 12h14', action: onAddTile },
      { id: 'rename', label: 'Rename Column', icon: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z', action: startEditTitle },
      { id: 'style', label: 'Style', icon: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z', action: () => onOpenColumnStyle?.(menuX, menuY) },
      { id: 'collapse', label: column.collapsed ? 'Expand' : 'Collapse', icon: column.collapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6', action: onToggleCollapse },
      { id: 'wip', label: wipActive ? `WIP Limit: ${wipLimit}` : 'Set WIP Limit…', action: startEditWip },
      { id: 'div', label: '', divider: true },
      { id: 'delete', label: 'Delete Column', icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', danger: true, action: onDelete },
    ], column.id);
  }

  function handleTileContextMenu(e: MouseEvent, tileId: string) {
    if (isEditableTextTarget(e.target)) return;
    // Multi-select: when the right-clicked card is part of a selection of
    // 2+, defer to the parent's bulk menu (Move / Delete / Add tag against
    // every selected card). A right-click on a card OUTSIDE the current
    // selection still gets the single-card menu — that matches every other
    // multi-select UI we have.
    if (selectionStore.count > 1 && selectionStore.isSelected(tileId)) {
      e.preventDefault();
      e.stopPropagation();
      onBulkContextMenu(e, tileId);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // DESIGN: the Kanban tile right-click menu is intentionally minimal.
    // Tag editing, properties, style, locking, and sync-to-disk all live on
    // the tile's own TileHeader (visible on hover/focus), so duplicating
    // them here would just be noise. The Mind Map context menu is richer
    // because canvas tiles support actions (auto-layout, copy/paste,
    // connection mode) that don't apply to a column-bound flow layout.
    //
    // The one spec affordance kept: Open as Document, since TileHeader does
    // NOT provide it (it's a tab-level navigation, not a tile-level edit).
    const items: Array<{ id: string; label: string; icon?: string; danger?: boolean; divider?: boolean; action?: () => void }> = [];
    const t = tilesById[tileId];
    if (t?.type === 'text') {
      items.push({
        id: 'open-as-document',
        label: 'Open as Document',
        icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
        action: () => onOpenAsDocument(tileId),
      });
      items.push({ id: 'div', label: '', divider: true });
    }
    const menuX = e.clientX;
    const menuY = e.clientY;
    items.push({
      id: 'card-style',
      label: 'Card Style',
      icon: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z',
      action: () => onOpenCardStyle?.(tileId, menuX, menuY),
    });
    items.push({
      id: 'delete',
      label: 'Remove from Column',
      icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      danger: true,
      action: () => onDeleteTile(tileId),
    });
    uiStore.showContextMenu(menuX, menuY, items, tileId);
  }

  /**
   * Click on a card body. Ignores clicks on editable targets, buttons, and
   * links so editing / inline action buttons aren't hijacked by selection.
   */
  function handleTileClick(e: MouseEvent, tileId: string) {
    if (isEditableTextTarget(e.target)) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    onTileClick(e, tileId);
  }

  // Iterate placements directly so the rendering order matches the
  // canonical `column.tilePlacements` ordering. A placement with no def
  // resolved (e.g. broken reference, mid-migration race) is silently
  // skipped here; the broken-ref badge inside `TileContainer` flags the
  // mismatch elsewhere.
  let visiblePlacements = $derived(
    placements.filter((p) => tilesById[p.tileId] !== undefined),
  );

  /**
   * Header pointerdown guard. The header is the only column drag handle, but
   * pointer events on interactive children (collapse btn, rename input, menu
   * btn, count badge) must not start a column drag — those gestures already
   * have their own click behaviour. Same `closest(...)` guard the tile click
   * handler uses.
   */
  function handleColumnHeaderPointerDown(e: PointerEvent) {
    if (isEditingTitle) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    onColumnHeaderPointerDown(e);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="kanban-column"
  class:collapsed={column.collapsed}
  class:wip-exceeded={wipExceeded}
  class:menu-open={showMenu || showWipEditor}
  class:drag-over={isDragOver}
  class:drag-active={dragTileId !== null}
  class:force-show-buttons={forceShowButtons}
  style:--accent={resolvedAccent}
  style={columnInlineStyle}
  oncontextmenu={handleContextMenu}
  ondragenter={handleDragEnter}
  ondragover={handleOuterDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleOuterDrop}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="column-header"
    class:editing={isEditingTitle}
    style={headerInlineStyle}
    onpointerdown={handleColumnHeaderPointerDown}
  >
    <div class="column-header-left">
      <button
        class="column-collapse-btn"
        onclick={onToggleCollapse}
        title={column.collapsed ? 'Expand column' : 'Collapse column'}
        aria-label={column.collapsed ? 'Expand column' : 'Collapse column'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if column.collapsed}
            <polyline points="9 18 15 12 9 6" />
          {:else}
            <polyline points="6 9 12 15 18 9" />
          {/if}
        </svg>
      </button>
      <div class="column-accent-bar" style:background-color={resolvedAccent}></div>
      {#if isEditingTitle}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="column-title-input"
          style={columnStyle?.fontSizeTitle != null ? `font-size: ${columnStyle.fontSizeTitle}px;` : ''}
          type="text"
          bind:value={editTitle}
          onblur={commitTitle}
          onkeydown={onTitleKeydown}
          autofocus
        />
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <h3
          class="column-title"
          style={columnStyle?.fontSizeTitle != null ? `font-size: ${columnStyle.fontSizeTitle}px;` : ''}
          tabindex="0"
          aria-label={`Column "${column.title}"`}
          aria-keyshortcuts="F2 Enter Alt+ArrowLeft Alt+ArrowRight"
          ondblclick={startEditTitle}
          onkeydown={(e) => {
            if (e.key === 'F2' || e.key === 'Enter') {
              e.preventDefault();
              startEditTitle();
              return;
            }
            // Alt+Arrow reorders columns from the keyboard. Mirrors the
            // pointer-drag affordance for keyboard-only users.
            if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault();
              onMoveColumn(e.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        >{column.title}</h3>
      {/if}
      <span
        class="column-count"
        class:wip-exceeded={wipExceeded}
        class:wip-active={wipActive && !wipExceeded}
        aria-live="polite"
        aria-atomic="true"
        aria-label={wipActive
          ? `${visiblePlacements.length} cards. ${totalCount} of ${wipLimit} against WIP limit${wipExceeded ? ', exceeded' : ''}.`
          : `${visiblePlacements.length} cards`}
        title={wipActive ? `${totalCount}/${wipLimit} (WIP limit ${wipExceeded ? 'exceeded' : 'set'})` : undefined}
      >
        {visiblePlacements.length}{#if wipActive}<span class="column-count-limit">/{wipLimit}</span>{/if}
      </span>
    </div>
    <div class="column-header-actions">
      <button
        class="column-action-btn"
        bind:this={columnMenuTriggerEl}
        onclick={() => showMenu = !showMenu}
        title="Column menu"
        aria-label="Column menu"
        aria-haspopup="menu"
        aria-expanded={showMenu}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {#if showMenu}
        <div
          class="column-menu"
          role="menu"
          tabindex="-1"
          bind:this={columnMenuEl}
          onkeydown={onColumnMenuKeydown}
        >
          <button role="menuitem" class="column-menu-item" onclick={() => { showMenu = false; onAddTile(); }}>Add Card</button>
          <button role="menuitem" class="column-menu-item" onclick={(e) => { showMenu = false; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onOpenColumnStyle?.(r.left, r.bottom + 4); }}>Style</button>
          <button role="menuitem" class="column-menu-item" onclick={() => { showMenu = false; startEditTitle(); }}>Rename</button>
          <button role="menuitem" class="column-menu-item" onclick={() => { showMenu = false; onToggleCollapse(); }}>
            {column.collapsed ? 'Expand' : 'Collapse'}
          </button>
          <button role="menuitem" class="column-menu-item" onclick={() => { showMenu = false; startEditWip(); }}>
            {wipActive ? `WIP Limit: ${wipLimit}` : 'Set WIP Limit…'}
          </button>
          <button role="menuitem" class="column-menu-item danger" onclick={() => { showMenu = false; onDelete(); }}>
            Delete Column
          </button>
        </div>
      {/if}
      {#if showWipEditor}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="column-wip-popover"
          role="group"
          tabindex="-1"
          aria-label="Set WIP limit"
          onclick={(e) => e.stopPropagation()}
          onkeydown={onWipKeydown}
        >
          <label class="column-wip-label" for="column-wip-input-{column.id}">
            WIP limit (cards)
          </label>
          <input
            id="column-wip-input-{column.id}"
            class="column-wip-input"
            type="number"
            min="0"
            placeholder="No limit"
            bind:value={wipDraft}
          />
          <div class="column-wip-actions">
            <button class="column-wip-btn" onclick={clearWipLimit}>Clear</button>
            <button class="column-wip-btn primary" onclick={commitWipLimit}>Apply</button>
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#if !column.collapsed}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="column-body"
      ondragover={(e) => {
        // File-drag visual cue only. Card drags are owned by the inner
        // dndzone (cross-column moves land via dnd-action's shared
        // `type: 'kanban-cards'` glue); the bubbled events from cards are
        // synthetic and don't carry `Files` / `application/x-vault-file`,
        // so this `preventDefault` is harmless for them.
        if (dragHasFiles(e)) e.preventDefault();
      }}
      ondrop={(e) => {
        // Only treat as a file drop when the payload actually is a file.
        // Card moves bubble up here too but svelte-dnd-action has already
        // committed them by the time the synthetic drop fires.
        if (dragHasFiles(e)) {
          e.preventDefault();
          onColumnFileDrop(e);
        }
      }}
    >
      <!--
        Card dndzone. `type: 'kanban-cards'` is shared across every column so
        the library auto-handles cross-column moves. Empty zones (column with
        no cards) are still valid drop targets because the dndzone wrapper
        renders even when `cardItems` is empty.
      -->
      <div
        class="column-cards-zone"
        class:is-empty={visiblePlacements.length === 0}
        data-column-id={column.id}
        use:dndzone={{
          items: cardItems,
          type: 'kanban-cards',
          dragDisabled: cardDragDisabled,
          flipDurationMs: cardFlipDurationMs,
          dropTargetStyle: {},
          transformDraggedElement: transformDraggedCard,
        }}
        use:clearStaleDndCardStyles={cardItems}
        onconsider={onConsiderCards}
        onfinalize={onFinalizeCards}
        ondragover={(e) => {
          // Duplicate of the column-body file-drop guard. The library can
          // call `stopPropagation()` on its internal dragover handler, which
          // would prevent the parent column-body's handler from firing —
          // binding here too guarantees `preventDefault` runs for file drags.
          if (dragHasFiles(e)) e.preventDefault();
        }}
        ondrop={(e) => {
          if (dragHasFiles(e)) {
            e.preventDefault();
            onColumnFileDrop(e);
          }
        }}
      >
        {#if visiblePlacements.length === 0 && dragTileId === null}
          <div class="column-empty-state" aria-live="polite">
            {#if filterActive && totalCount > 0}
              <p class="empty-title">No matches</p>
              <p class="empty-hint">{totalCount} tile(s) hidden by current filter.</p>
            {:else}
              <p class="empty-title">Empty column</p>
              <p class="empty-hint">Drop a file or click + to add a card.</p>
            {/if}
          </div>
        {/if}
        <!-- Branch on the shadow marker so the placeholder gets its own DOM
             node — otherwise svelte-dnd-action writes `visibility:hidden` to
             a sibling card via Svelte's keyed `{#each}` reuse, making cards go
             invisible mid-drag. Key suffix is
             required per dnd-action README v0.9.42+. -->
        {#each cardItems as item (`${item.id}${item[SHADOW_ITEM_MARKER_PROPERTY_NAME] ? '_shadow' : ''}`)}
          {#if item[SHADOW_ITEM_MARKER_PROPERTY_NAME]}
            <div
              class="kanban-drop-slot"
              data-is-dnd-shadow-item-hint={true}
              aria-hidden="true"
            ></div>
          {:else}
            {@const placement = placementsByTileId[item.id]}
            {@const tile = placement ? tilesById[placement.tileId] : undefined}
            {@const isShown = placement && tile && (visibleTileIds.has(item.id) || dragTileId === item.id)}
            {#if isShown}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="tile-drop-zone"
                class:selected={selectionStore.isSelected(placement.tileId)}
                class:locked={tile.locked === true}
                class:in-drag-block={dragBlockIds.length > 1
                  && placement.tileId !== dragTileId
                  && dragBlockIds.includes(placement.tileId)}
                data-tile-id={placement.tileId}
                onpointerdown={(e) => onCardPointerDown(e, placement.tileId, tile.locked === true)}
                onclick={(e) => handleTileClick(e, placement.tileId)}
                oncontextmenu={(e) => handleTileContextMenu(e, placement.tileId)}
              >
                <KanbanCard
                  {tile}
                  {placement}
                  cardStyle={resolveCardStyle(placement.style as Record<string, unknown> | null | undefined)}
                  onSetDueDate={(d) => onSetDueDate(placement.tileId, d)}
                  onSetPriority={(p) => onSetPriority(placement.tileId, p)}
                  onPickCoverImage={() => onPickCoverImage(placement.tileId)}
                  onClearCoverImage={() => onClearCoverImage(placement.tileId)}
                  onOpenAsDocument={() => onOpenAsDocument(placement.tileId)}
                />
              </div>
            {/if}
          {/if}
        {/each}
      </div>

      <button class="add-tile-btn" onclick={onAddTile}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add Card
      </button>
    </div>
  {/if}
</div>

<style>
  .kanban-column {
    position: relative;
    width: var(--column-width, 380px);
    max-height: calc(100vh - 140px);
    display: flex;
    flex-direction: column;
    background: var(--ui-surface);
    border-radius: 10px;
    border: 1px solid var(--ui-border-light);
    box-shadow: var(--ui-shadow);
    transition: box-shadow 0.2s ease;
  }

  .kanban-column.drag-over {
    outline: 2px dashed var(--accent-primary, #3a86ff);
    outline-offset: -2px;
    background-color: color-mix(in srgb, var(--accent-primary, #3a86ff) 5%, var(--ui-surface));
  }

  .kanban-column.collapsed {
    width: var(--column-width, 380px);
  }

  /* While the column "…" / WIP popover is open, raise this column above
     its right-hand siblings so the popover can paint over neighbouring
     cards instead of being masked by them. */
  .kanban-column.menu-open {
    z-index: 50;
  }

  .kanban-column.wip-exceeded {
    border-color: var(--accent-danger);
    box-shadow: 0 0 0 1px var(--accent-danger);
  }

  .column-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--ui-border-light);
    position: relative;
    cursor: grab;
    user-select: none;
    /* Match the column's rounded corners so removing `overflow:hidden` from
       the parent (needed so the column menu can paint outside the column
       bounds) doesn't expose square corners under the header background. */
    border-top-left-radius: 10px;
    border-top-right-radius: 10px;
  }

  .column-header:active {
    cursor: grabbing;
  }

  /* Disable the grab cursor + selection lock while the title is being
     edited so the input behaves like a normal text field. */
  .column-header.editing {
    cursor: text;
    user-select: text;
  }

  .column-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .column-collapse-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
  }

  .column-collapse-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .column-accent-bar {
    width: 3px;
    height: 18px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .column-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .column-title-input {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border-focus);
    border-radius: 4px;
    padding: 2px 6px;
    flex: 1;
    min-width: 0;
  }

  .column-title-input:focus:not(:focus-visible) {
    outline: none;
  }

  .column-count {
    font-size: 11px;
    font-weight: 500;
    /* Text + chip-tint inherit the per-column accent set via `--accent` on
       the column root. `color-mix` falls back to a subtle wash of the accent
       behind the digit; on theme/accent change everything re-tints in one
       step. The WIP states below override both. */
    color: var(--accent, var(--text-tertiary));
    background: color-mix(in srgb, var(--accent, var(--text-tertiary)) 14%, transparent);
    padding: 1px 6px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  .column-count.wip-active {
    /* Keep the accent text colour; deepen the tint so "WIP limit set but
       not exceeded" still reads as a soft signal. */
    background: color-mix(in srgb, var(--accent, var(--text-secondary)) 22%, transparent);
  }

  .column-count.wip-exceeded {
    /* Exceeded WIP is a stronger signal than the column accent — danger
       red wins so the user can't miss it. */
    color: var(--text-inverse, #fff);
    background: var(--accent-danger);
    font-weight: 600;
  }

  .column-count-limit {
    opacity: 0.7;
    margin-left: 1px;
  }

  .column-header-actions {
    position: relative;
  }

  .column-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    color: var(--text-tertiary);
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  /* Reveal the 3-dot menu button on hover/focus of the column or while the
     menu is already open (so the trigger stays visible while you use it).
     `.force-show-buttons` pins it on regardless. Keyboard focus also reveals
     it so Tab order still surfaces the button. */
  .kanban-column:hover .column-action-btn,
  .kanban-column:focus-within .column-action-btn,
  .kanban-column.menu-open .column-action-btn,
  .kanban-column.force-show-buttons .column-action-btn {
    opacity: 1;
  }

  .column-action-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .column-menu {
    position: absolute;
    top: 100%;
    right: 0;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    z-index: var(--z-column-menu, 2450);
    padding: 4px;
    min-width: 160px;
    animation: popIn 0.15s ease;
  }

  .column-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    font-size: 13px;
    color: var(--text-primary);
    border-radius: 4px;
    transition: background-color 0.1s ease;
  }

  .column-menu-item:hover {
    background: var(--menu-hover);
  }

  .column-menu-item.danger {
    color: var(--accent-danger);
  }

  .column-menu-item.danger:hover {
    background: var(--menu-danger-bg);
  }

  .column-wip-popover {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    z-index: var(--z-column-menu, 2450);
    padding: 10px;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    animation: popIn 0.15s ease;
  }

  .column-wip-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .column-wip-input {
    padding: 6px 8px;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
  }

  .column-wip-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .column-wip-input:focus:not(:focus-visible) {
    outline: none;
  }

  .column-wip-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .column-wip-btn {
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .column-wip-btn:hover {
    background: var(--ui-surface-hover);
  }

  .column-wip-btn.primary {
    color: var(--text-inverse, #fff);
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    font-weight: 600;
  }

  .column-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* Pair with `.column-header`'s top corners so the column's outer
       rounded edge is preserved without relying on `overflow:hidden` on
       the parent (which would clip the column menu). */
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
  }

  /* Card dndzone wrapper. Inherits the vertical-flow gap from `.column-body`
     but keeps its own gap too so dnd-action's FLIP animations have stable
     row spacing when items reflow on consider/finalize. */
  .column-cards-zone {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 4px; /* gives dnd-action a positive bounding box when empty */
  }

  .column-cards-zone.is-empty {
    flex-grow: 1;
    min-height: 150px;
  }

  .tile-drop-zone {
    position: relative;
    cursor: grab;
    border-radius: 8px;
    transition: box-shadow 0.12s ease;
  }

  .tile-drop-zone:active {
    cursor: grabbing;
  }

  .tile-drop-zone.selected {
    box-shadow: 0 0 0 2px var(--accent-primary);
  }

  .tile-drop-zone.locked {
    cursor: default;
  }

  /* Non-anchor members of a multi-card drag block. The library only knows
     about the anchor; these cards stay in their source columns until drop,
     so we dim them to signal "going somewhere when the anchor lands". */
  .tile-drop-zone.in-drag-block {
    opacity: 0.4;
    transition: opacity 0.12s ease;
    pointer-events: none;
  }

  /* Dnd-action shadow placeholder. Library writes `visibility:hidden`; we
     override so users see the drop slot. Height is set inline by the lib to
     match the source card. */
  .kanban-drop-slot {
    visibility: visible !important;
    border: 2px dashed color-mix(in srgb, var(--accent, var(--accent-primary)) 55%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent, var(--accent-primary)) 8%, transparent);
    box-sizing: border-box;
    pointer-events: none;
  }

  /* Accent wash on every column while any card drag is in flight, stronger
     on empty destinations so the slot reads clearly. */
  .kanban-column.drag-active {
    background-color: color-mix(in srgb, var(--accent-primary) 3%, var(--ui-surface));
  }
  .kanban-column.drag-active .column-cards-zone.is-empty {
    background-color: color-mix(in srgb, var(--accent-primary) 5%, transparent);
    border-radius: 6px;
  }

  .add-tile-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px;
    border-radius: 6px;
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 500;
    border: 1px dashed var(--ui-border-light);
    transition: background-color 0.15s ease, color 0.15s ease;
    margin-top: 4px;
    cursor: pointer;
  }

  .add-tile-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .column-empty-state {
    text-align: center;
    padding: 18px 8px 12px;
    color: var(--text-tertiary);
    border: 1px dashed var(--ui-border-light);
    border-radius: 6px;
    background: transparent;
  }

  .column-empty-state .empty-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .column-empty-state .empty-hint {
    margin: 4px 0 0;
    font-size: 11px;
  }

</style>
