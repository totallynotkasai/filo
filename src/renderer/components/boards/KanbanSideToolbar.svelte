<script lang="ts">
  /**
   * KanbanSideToolbar — the Kanban side toolbar.
   *
   * Buttons:
   *   - Manage Columns      (Reorder / Per-column width / Collapse All / Expand All)
   *   - View                (Tags Browser)
   *   - Filter & Sort       (Filter by tag, Filter by property, Sort by …)
   *   - Saved Views
   *
   * Card / column creation entry points live on the board itself (the inline
   * `+ Add Column` button at the end of the columns row and the per-column
   * `+ Add Tile` button inside each column body).
   */
  import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
  import { workspaceStore, type ToolbarPosition } from '../../stores/workspace.svelte';
  import { KANBAN_COLUMN_DEFAULTS } from '../../constants/defaults';
  import { handleListKeyNav, focusFirstItem } from '../../lib/utils/listKeyNav';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import { tick, onDestroy } from 'svelte';

  type SortBy = 'manual' | 'title' | 'created' | 'dueDate' | 'priority';

  interface SavedView {
    id: string;
    name: string;
    sortBy: SortBy;
    filterTags: string[];
    filterProp: { key: string; value: string } | null;
  }

  let {
    onCollapseAll,
    onExpandAll,
    onReorderColumns,
    onSetColumnWidth,
    currentColumns,
    onOpenTagsBrowser,
    activeSortBy,
    onSortChange,
    activeFilterTags,
    onFilterTagsChange,
    activeFilterProp,
    onFilterPropChange,
    savedViews,
    onApplyView,
    onSaveView,
    onDeleteView,
    filterMenuOpen = $bindable(false),
    sortMenuOpen = $bindable(false),
  }: {
    onCollapseAll: () => void;
    onExpandAll: () => void;
    onReorderColumns: (orderedIds: string[]) => void;
    /** Set per-column width override; `null` clears the override. */
    onSetColumnWidth: (columnId: string, width: number | null) => void;
    currentColumns: Array<{ id: string; title: string; width: number | null }>;
    onOpenTagsBrowser: () => void;
    activeSortBy: SortBy;
    onSortChange: (sort: SortBy) => void;
    activeFilterTags: string[];
    onFilterTagsChange: (tags: string[]) => void;
    activeFilterProp: { key: string; value: string } | null;
    onFilterPropChange: (prop: { key: string; value: string } | null) => void;
    savedViews: SavedView[];
    /** Apply the saved view's sort + filter state to the active board. */
    onApplyView: (view: SavedView) => void;
    /** Capture current sort + filter as a new saved view under `name`. */
    onSaveView: (name: string) => void;
    /** Remove a saved view by id. */
    onDeleteView: (id: string) => void;
    filterMenuOpen?: boolean;
    sortMenuOpen?: boolean;
  } = $props();

  let manageMenuOpen = $state(false);
  let viewMenuOpen = $state(false);
  let viewsMenuOpen = $state(false);
  let reorderOpen = $state(false);
  let savePromptOpen = $state(false);
  let saveDraftName = $state('');
  let propKey = $state('');
  let propValue = $state('');
  // Tag-list substring search inside the Filter menu. Auto-clears when the
  // menu closes so reopening always starts fresh.
  let tagSearch = $state('');

  // Drag state for movable toolbar. The resting position is layout state,
  // saved in `.filo/workspace.json` by the workspace store (main refuses
  // `.filo/` on the generic vault channels); reset via right-click.
  function clampToWindow(p: ToolbarPosition): ToolbarPosition {
    return { x: Math.max(0, Math.min(window.innerWidth - 60, p.x)), y: Math.max(0, Math.min(window.innerHeight - 60, p.y)) };
  }

  const savedPosition = workspaceStore.kanbanToolbar;
  let isDragging = $state(false);
  let dragPosition = $state<ToolbarPosition | null>(savedPosition ? clampToWindow(savedPosition) : null);
  let dragOffset = $state({ x: 0, y: 0 });

  function onDragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't drag if pressing inside a button, menu, or any group container
    if (target.closest('.toolbar-btn, .toolbar-menu, .toolbar-group')) return;
    isDragging = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    const maxX = window.innerWidth - 60;
    const maxY = window.innerHeight - 60;
    dragPosition = {
      x: Math.max(0, Math.min(maxX, e.clientX - dragOffset.x)),
      y: Math.max(0, Math.min(maxY, e.clientY - dragOffset.y)),
    };
  }

  function onDragEnd(e: PointerEvent) {
    if (!isDragging) return;
    isDragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    // Persist final position so the toolbar reopens at the saved spot
    // after a reload. Drag-in-flight intermediate positions are not
    // written — only the resting position.
    workspaceStore.setKanbanToolbar(dragPosition);
  }

  function onContextMenu(e: MouseEvent) {
    // Right-click the toolbar background (not buttons / menus) — reset
    // toolbar to its default docked position. Lightweight discoverable
    // affordance; no settings UI required.
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('.toolbar-btn, .toolbar-menu, .toolbar-group')) return;
    e.preventDefault();
    dragPosition = null;
    workspaceStore.setKanbanToolbar(null);
  }

  let positionStyle = $derived(
    dragPosition
      ? `left: ${dragPosition.x}px; top: ${dragPosition.y}px; right: auto; transform: none;`
      : ''
  );

  function closeAllMenusExcept(keep: 'manage' | 'view' | 'filter' | 'sort' | 'views' | null) {
    if (keep !== 'manage') manageMenuOpen = false;
    if (keep !== 'view') viewMenuOpen = false;
    if (keep !== 'filter') filterMenuOpen = false;
    if (keep !== 'sort') sortMenuOpen = false;
    if (keep !== 'views') viewsMenuOpen = false;
  }

  // ── Menu a11y: arrow-key nav + Escape returns focus to trigger ──
  // Each toolbar menu mounts as a sibling popover anchored to its trigger
  // button. We track the trigger element for each menu so Escape can
  // return focus there after closing.
  let manageMenuEl: HTMLElement | null = $state(null);
  let viewMenuEl: HTMLElement | null = $state(null);
  let filterMenuEl: HTMLElement | null = $state(null);
  let sortMenuEl: HTMLElement | null = $state(null);
  let viewsMenuEl: HTMLElement | null = $state(null);
  let manageTriggerEl: HTMLButtonElement | null = $state(null);
  let viewTriggerEl: HTMLButtonElement | null = $state(null);
  let filterTriggerEl: HTMLButtonElement | null = $state(null);
  let sortTriggerEl: HTMLButtonElement | null = $state(null);
  let viewsTriggerEl: HTMLButtonElement | null = $state(null);

  // Selector targets clickable menu items (buttons + interactive labels).
  // Text inputs inside the filter menu are reachable via Tab; we don't
  // include them in arrow-nav so Up/Down doesn't bounce focus into them.
  const MENU_ITEM_SELECTOR =
    'button, [role="menuitem"], input[type="checkbox"]';

  function menuKeydown(
    e: KeyboardEvent,
    menuEl: HTMLElement | null,
    trigger: HTMLButtonElement | null,
    close: () => void,
  ): void {
    if (!menuEl) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      trigger?.focus();
      return;
    }
    if (handleListKeyNav(e, menuEl, { selector: MENU_ITEM_SELECTOR, orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  // Each menu auto-focuses its first item on open so keyboard users land
  // somewhere actionable.
  async function focusMenuOnOpen(menuEl: HTMLElement | null) {
    if (!menuEl) return;
    await tick();
    focusFirstItem(menuEl, MENU_ITEM_SELECTOR);
  }

  $effect(() => { if (manageMenuOpen) void focusMenuOnOpen(manageMenuEl); });
  $effect(() => { if (viewMenuOpen) void focusMenuOnOpen(viewMenuEl); });
  $effect(() => { if (filterMenuOpen) void focusMenuOnOpen(filterMenuEl); });
  $effect(() => { if (sortMenuOpen) void focusMenuOnOpen(sortMenuEl); });
  $effect(() => { if (viewsMenuOpen) void focusMenuOnOpen(viewsMenuEl); });

  // Focus-trap for the Reorder Columns modal. Same pattern as Modal.svelte:
  // the cleanup releases the trap on close and on unmount.
  let reorderBackdropEl: HTMLElement | null = $state(null);
  $effect(() => {
    const el = reorderBackdropEl;
    if (!reorderOpen || !el) return;
    const reorderTrap: FocusTrap = createFocusTrap(el, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      fallbackFocus: el,
      preventScroll: true,
    });
    try {
      reorderTrap.activate();
    } catch {
      el.focus();
    }
    return () => safeDeactivateTrap(reorderTrap, { name: 'KanbanSideToolbar' });
  });

  function openSavePrompt() {
    viewsMenuOpen = false;
    saveDraftName = '';
    savePromptOpen = true;
  }

  function commitSaveView() {
    const name = saveDraftName.trim();
    if (!name) return;
    onSaveView(name);
    savePromptOpen = false;
    saveDraftName = '';
  }

  function cancelSaveView() {
    savePromptOpen = false;
    saveDraftName = '';
  }

  // Sync the local working copy when the active prop filter changes from
  // outside (e.g. cleared via "Clear All Filters"). Initial sync runs once
  // on mount; subsequent changes only reset when the prop is cleared so the
  // user's in-progress text isn't clobbered while typing.
  $effect(() => {
    if (!activeFilterProp) {
      propKey = '';
      propValue = '';
    }
  });

  let knownTags = $derived<Array<[string, number]>>(Array.from(vaultIndexStore.allTags()));

  // Substring filter applied to the rendered tag list. Vaults with 100+ tags
  // become unusable without a search field — typing here narrows the menu in
  // real time. Active filter chips remain unaffected.
  let filteredKnownTags = $derived.by<Array<[string, number]>>(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return knownTags;
    return knownTags.filter(([t]) => t.toLowerCase().includes(q));
  });

  // Clear the tag search whenever the filter menu closes so reopening starts
  // fresh. The $effect runs on menu open/close transitions; the second branch
  // is a no-op while open.
  $effect(() => {
    if (!filterMenuOpen) tagSearch = '';
  });

  function toggleTag(tag: string) {
    const norm = tag.replace(/^#/, '');
    const next = activeFilterTags.includes(norm)
      ? activeFilterTags.filter((t) => t !== norm)
      : [...activeFilterTags, norm];
    onFilterTagsChange(next);
  }

  function clearFilters() {
    onFilterTagsChange([]);
    onFilterPropChange(null);
    propKey = '';
    propValue = '';
    tagSearch = '';
    // Close the menu after clearing so the user sees their cleared state on
    // the toolbar (badge gone, button no longer "active") without an extra
    // click to dismiss the menu.
    filterMenuOpen = false;
  }

  // Live property filter: each keystroke schedules a debounced commit (no
  // Apply click needed). 200ms is short enough to feel responsive and long
  // enough to coalesce fast typing.
  let propDebounce: ReturnType<typeof setTimeout> | null = null;

  // Clear the live-filter debounce on unmount so a vault
  // swap (or toolbar teardown) mid-typing can't fire `onFilterPropChange`
  // ~200 ms later against a board that is no longer mounted.
  onDestroy(() => {
    if (propDebounce) clearTimeout(propDebounce);
  });

  function scheduleApplyPropFilter() {
    if (propDebounce) clearTimeout(propDebounce);
    propDebounce = setTimeout(() => {
      propDebounce = null;
      if (!propKey.trim()) {
        onFilterPropChange(null);
      } else {
        onFilterPropChange({ key: propKey.trim(), value: propValue });
      }
    }, 200);
  }

  function applyPropFilter() {
    if (propDebounce) {
      clearTimeout(propDebounce);
      propDebounce = null;
    }
    if (!propKey.trim()) {
      onFilterPropChange(null);
    } else {
      onFilterPropChange({ key: propKey.trim(), value: propValue });
    }
  }

  let activeFilterCount = $derived(activeFilterTags.length + (activeFilterProp ? 1 : 0));
  const sortLabels: Record<SortBy, string> = {
    manual: 'Manual',
    title: 'Title',
    created: 'Date Created',
    dueDate: 'Due Date',
    priority: 'Priority',
  };

  // Reorder modal — local working copies of column ids + per-column widths.
  // `null` width = "inherit" (no per-column override); a positive number is
  // the override in px. Committed atomically when the user clicks Apply.
  let reorderIds = $state<string[]>([]);
  let widthDrafts = $state<Record<string, string>>({});
  function openReorder() {
    reorderIds = currentColumns.map((c) => c.id);
    const drafts: Record<string, string> = {};
    for (const c of currentColumns) {
      drafts[c.id] = c.width != null ? String(c.width) : '';
    }
    widthDrafts = drafts;
    reorderOpen = true;
    manageMenuOpen = false;
  }
  function moveReorder(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= reorderIds.length) return;
    const next = [...reorderIds];
    const a = next[idx];
    const b = next[target];
    if (a === undefined || b === undefined) return; // target bounds-checked above
    next[idx] = b;
    next[target] = a;
    reorderIds = next;
  }
  function commitReorder() {
    onReorderColumns(reorderIds);
    for (const id of reorderIds) {
      const raw = widthDrafts[id] ?? '';
      const trimmed = raw.trim();
      const parsed = trimmed === '' ? null : Math.round(Number(trimmed));
      if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) continue;
      const original = currentColumns.find((c) => c.id === id)?.width ?? null;
      if (parsed === original) continue;
      onSetColumnWidth(id, parsed);
    }
    reorderOpen = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="side-toolbar"
  class:dragging={isDragging}
  style="z-index: var(--z-side-toolbar); {positionStyle}"
  onpointerdown={onDragStart}
  onpointermove={onDragMove}
  onpointerup={onDragEnd}
  oncontextmenu={onContextMenu}
  title="Drag to move. Right-click background to reset position."
>
  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      bind:this={manageTriggerEl}
      onclick={() => { manageMenuOpen = !manageMenuOpen; viewMenuOpen = false; filterMenuOpen = false; sortMenuOpen = false; }}
      title="Manage Columns"
      aria-label="Manage columns"
      aria-haspopup="menu"
      aria-expanded={manageMenuOpen}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <rect x="3" y="3" width="6" height="18" rx="1" />
        <rect x="11" y="3" width="6" height="12" rx="1" />
        <rect x="19" y="3" width="2" height="6" rx="1" />
      </svg>
    </button>

    {#if manageMenuOpen}
      <div
        class="toolbar-menu"
        role="menu"
        tabindex="-1"
        bind:this={manageMenuEl}
        onkeydown={(e) => menuKeydown(e, manageMenuEl, manageTriggerEl, () => { manageMenuOpen = false; })}
      >
        <button class="toolbar-menu-item" onclick={() => { manageMenuOpen = false; openReorder(); }}>Manage Columns</button>
        <button class="toolbar-menu-item" onclick={() => { manageMenuOpen = false; onCollapseAll(); }}>Collapse All</button>
        <button class="toolbar-menu-item" onclick={() => { manageMenuOpen = false; onExpandAll(); }}>Expand All</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      bind:this={viewTriggerEl}
      onclick={() => { viewMenuOpen = !viewMenuOpen; manageMenuOpen = false; filterMenuOpen = false; sortMenuOpen = false; }}
      title="View"
      aria-label="View"
      aria-haspopup="menu"
      aria-expanded={viewMenuOpen}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      </svg>
    </button>

    {#if viewMenuOpen}
      <div
        class="toolbar-menu"
        role="menu"
        tabindex="-1"
        bind:this={viewMenuEl}
        onkeydown={(e) => menuKeydown(e, viewMenuEl, viewTriggerEl, () => { viewMenuOpen = false; })}
      >
        <button class="toolbar-menu-item" onclick={() => { viewMenuOpen = false; onOpenTagsBrowser(); }}>Tags Browser</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={activeFilterCount > 0}
      bind:this={filterTriggerEl}
      onclick={() => { filterMenuOpen = !filterMenuOpen; manageMenuOpen = false; viewMenuOpen = false; sortMenuOpen = false; }}
      title={activeFilterCount > 0 ? `Filter (${activeFilterCount} active)` : 'Filter'}
      aria-label={activeFilterCount > 0 ? `Filter, ${activeFilterCount} active` : 'Filter'}
      aria-haspopup="menu"
      aria-expanded={filterMenuOpen}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
      {#if activeFilterCount > 0}
        <span class="toolbar-btn-badge" aria-hidden="true">{activeFilterCount}</span>
      {/if}
    </button>

    {#if filterMenuOpen}
      <div
        class="toolbar-menu wide"
        role="menu"
        tabindex="-1"
        bind:this={filterMenuEl}
        onkeydown={(e) => menuKeydown(e, filterMenuEl, filterTriggerEl, () => { filterMenuOpen = false; })}
      >
        {#if activeFilterCount > 0}
          <div class="toolbar-menu-active-chips" aria-label="Active filters">
            {#each activeFilterTags as tag (tag)}
              <span class="toolbar-active-chip">
                #{tag}
                <button
                  class="toolbar-active-chip-x"
                  aria-label={`Remove filter ${tag}`}
                  onclick={() => toggleTag(tag)}
                ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            {/each}
            {#if activeFilterProp}
              <span class="toolbar-active-chip">
                {activeFilterProp.key}{activeFilterProp.value ? `: ${activeFilterProp.value}` : ''}
                <button
                  class="toolbar-active-chip-x"
                  aria-label="Remove property filter"
                  onclick={() => onFilterPropChange(null)}
                ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            {/if}
            <button class="toolbar-clear-all" onclick={clearFilters}>Clear all</button>
          </div>
          <div class="toolbar-menu-divider"></div>
        {/if}
        <div class="toolbar-menu-section-title">Filter by Tag</div>
        {#if knownTags.length > 0}
          <input
            class="toolbar-tag-search"
            type="search"
            placeholder="Search tags…"
            aria-label="Search tags"
            bind:value={tagSearch}
          />
        {/if}
        <div class="toolbar-menu-tags">
          {#if knownTags.length === 0}
            <span class="toolbar-menu-empty">No tags in vault</span>
          {:else if filteredKnownTags.length === 0}
            <span class="toolbar-menu-empty">No tags match "{tagSearch}"</span>
          {:else}
            {#each filteredKnownTags as [tagName, count] (tagName)}
              {@const norm = tagName.replace(/^#/, '')}
              {@const checked = activeFilterTags.includes(norm)}
              <label class="toolbar-tag-option">
                <input
                  type="checkbox"
                  {checked}
                  onchange={() => toggleTag(norm)}
                />
                <span>#{norm} <span class="toolbar-tag-count">({count})</span></span>
              </label>
            {/each}
          {/if}
        </div>

        <div class="toolbar-menu-divider"></div>

        <div class="toolbar-menu-section-title">Filter by Property</div>
        <div class="toolbar-menu-prop">
          <input
            class="toolbar-prop-input"
            type="text"
            placeholder="key (e.g. status)"
            bind:value={propKey}
            oninput={scheduleApplyPropFilter}
          />
          <input
            class="toolbar-prop-input"
            type="text"
            placeholder="value"
            bind:value={propValue}
            oninput={scheduleApplyPropFilter}
          />
          <button class="toolbar-prop-apply" onclick={applyPropFilter} title="Apply now (or just keep typing — it applies automatically after 200ms)">Apply</button>
        </div>

        <div class="toolbar-menu-divider"></div>

        <button class="toolbar-menu-item" onclick={() => { clearFilters(); }}>Clear All Filters</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={activeSortBy !== 'manual'}
      bind:this={sortTriggerEl}
      onclick={() => { sortMenuOpen = !sortMenuOpen; manageMenuOpen = false; viewMenuOpen = false; filterMenuOpen = false; }}
      title={`Sort: ${sortLabels[activeSortBy]}`}
      aria-label={`Sort, current: ${sortLabels[activeSortBy]}`}
      aria-haspopup="menu"
      aria-expanded={sortMenuOpen}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="14" y2="12" />
        <line x1="4" y1="18" x2="9" y2="18" />
      </svg>
    </button>

    {#if sortMenuOpen}
      <div
        class="toolbar-menu"
        role="menu"
        tabindex="-1"
        bind:this={sortMenuEl}
        onkeydown={(e) => menuKeydown(e, sortMenuEl, sortTriggerEl, () => { sortMenuOpen = false; })}
      >
        <div class="toolbar-menu-section-title">Sort Tiles By</div>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'manual'} onclick={() => { sortMenuOpen = false; onSortChange('manual'); }}>Manual</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'title'} onclick={() => { sortMenuOpen = false; onSortChange('title'); }}>Title</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'created'} onclick={() => { sortMenuOpen = false; onSortChange('created'); }}>Date Created</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'dueDate'} onclick={() => { sortMenuOpen = false; onSortChange('dueDate'); }}>Due Date</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'priority'} onclick={() => { sortMenuOpen = false; onSortChange('priority'); }}>Priority</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={savedViews.length > 0}
      bind:this={viewsTriggerEl}
      onclick={() => { viewsMenuOpen = !viewsMenuOpen; closeAllMenusExcept('views'); }}
      title={savedViews.length > 0 ? `Saved Views (${savedViews.length})` : 'Saved Views'}
      aria-label="Saved views"
      aria-haspopup="menu"
      aria-expanded={viewsMenuOpen}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>

    {#if viewsMenuOpen}
      <div
        class="toolbar-menu wide"
        role="menu"
        tabindex="-1"
        bind:this={viewsMenuEl}
        onkeydown={(e) => menuKeydown(e, viewsMenuEl, viewsTriggerEl, () => { viewsMenuOpen = false; })}
      >
        <div class="toolbar-menu-section-title">Saved Views</div>
        {#if savedViews.length === 0}
          <p class="toolbar-menu-empty">No views saved yet. Save the current sort + filters as a named view to switch back to it later.</p>
        {:else}
          <ul class="views-list">
            {#each savedViews as view (view.id)}
              <li class="views-row">
                <button
                  class="views-apply"
                  onclick={() => { viewsMenuOpen = false; onApplyView(view); }}
                  title={`Sort: ${view.sortBy}; Tags: ${view.filterTags.join(', ') || '—'}; Prop: ${view.filterProp ? view.filterProp.key + (view.filterProp.value ? ':' + view.filterProp.value : '') : '—'}`}
                >
                  {view.name}
                </button>
                <button
                  class="views-delete"
                  onclick={() => onDeleteView(view.id)}
                  title={`Delete view "${view.name}"`}
                  aria-label={`Delete view ${view.name}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="toolbar-menu-divider"></div>
        <button class="toolbar-menu-item" onclick={openSavePrompt}>Save current as…</button>
      </div>
    {/if}
  </div>
</div>

{#if savePromptOpen}
  <div
    class="save-view-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Save current view"
    tabindex="-1"
    onclick={(e) => { if ((e.target as HTMLElement).classList.contains('save-view-backdrop')) cancelSaveView(); }}
    onkeydown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelSaveView(); }
      if (e.key === 'Enter') { e.preventDefault(); commitSaveView(); }
    }}
  >
    <div class="save-view-card">
      <div class="save-view-header">
        <h2 class="save-view-title">Save view</h2>
        <button class="save-view-close" onclick={cancelSaveView} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="save-view-body">
        <label class="save-view-label" for="save-view-input">View name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="save-view-input"
          class="save-view-input"
          type="text"
          placeholder="e.g. My Work"
          bind:value={saveDraftName}
          autofocus
        />
        <p class="save-view-hint">
          Captures current sort
          <strong>({activeSortBy})</strong>,
          {activeFilterTags.length} tag filter(s){activeFilterProp ? `, and 1 property filter` : ''}.
        </p>
      </div>
      <div class="save-view-actions">
        <button class="save-view-btn" onclick={cancelSaveView}>Cancel</button>
        <button class="save-view-btn primary" onclick={commitSaveView} disabled={!saveDraftName.trim()}>Save</button>
      </div>
    </div>
  </div>
{/if}

{#if reorderOpen}
  <div
    class="reorder-backdrop"
    bind:this={reorderBackdropEl}
    role="dialog"
    aria-modal="true"
    aria-label="Manage Kanban columns"
    onclick={(e) => { if ((e.target as HTMLElement).classList.contains('reorder-backdrop')) reorderOpen = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') reorderOpen = false; }}
    tabindex="-1"
  >
    <div class="reorder-card">
      <div class="reorder-header">
        <h2 class="reorder-title">Manage Columns</h2>
        <button class="reorder-close" onclick={() => reorderOpen = false} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="reorder-column-headings">
        <span class="reorder-heading-name">Column</span>
        <span class="reorder-heading-width">Width&nbsp;(px)</span>
        <span class="reorder-heading-order">Order</span>
      </div>
      <ul class="reorder-list">
        {#each reorderIds as id, idx (id)}
          {@const col = currentColumns.find((c) => c.id === id)}
          {@const hasOverride = (widthDrafts[id] ?? '').trim() !== ''}
          <li class="reorder-row">
            <span class="reorder-name">{col?.title ?? id}</span>
            <div class="reorder-width-cell">
              <input
                class="reorder-width-input"
                type="number"
                min={KANBAN_COLUMN_DEFAULTS.minWidth}
                max={KANBAN_COLUMN_DEFAULTS.maxWidth}
                step="10"
                placeholder={String(KANBAN_COLUMN_DEFAULTS.width)}
                bind:value={widthDrafts[id]}
                aria-label={`Width for column ${col?.title ?? id} in pixels`}
              />
              <span class="reorder-width-suffix">px</span>
              <button
                class="reorder-reset"
                onclick={() => { widthDrafts = { ...widthDrafts, [id]: '' }; }}
                disabled={!hasOverride}
                title={hasOverride ? 'Reset to default width' : 'Already at default'}
                aria-label={`Reset width for column ${col?.title ?? id}`}
              >Reset</button>
            </div>
            <div class="reorder-order-cell">
              <button class="reorder-btn" onclick={() => moveReorder(idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
              <button class="reorder-btn" onclick={() => moveReorder(idx, 1)} disabled={idx === reorderIds.length - 1} aria-label="Move down">↓</button>
            </div>
          </li>
        {/each}
      </ul>
      <p class="reorder-hint">
        Leave the width blank to inherit from board defaults.
      </p>
      <div class="reorder-actions">
        <button class="reorder-cancel" onclick={() => reorderOpen = false}>Cancel</button>
        <button class="reorder-save" onclick={commitReorder}>Apply</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .side-toolbar {
    position: fixed;
    top: calc(var(--global-toolbar-height, 44px) + 12px);
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: calc(4px * var(--ui-board-toolbar-scale, 1));
    padding: 6px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 10px;
    box-shadow: var(--ui-shadow);
    cursor: grab;
    touch-action: none;
  }

  .side-toolbar.dragging {
    cursor: grabbing;
    opacity: 0.9;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(36px * var(--ui-board-toolbar-scale, 1));
    height: calc(36px * var(--ui-board-toolbar-scale, 1));
    border-radius: 6px;
    color: var(--text-secondary);
    transition: background-color 0.15s ease, color 0.15s ease;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .toolbar-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .toolbar-btn.active {
    background: var(--ui-surface-hover);
    color: var(--accent-primary);
  }

  /* Count badge in the top-right of an "active" filter button. */
  .toolbar-btn {
    position: relative;
  }

  .toolbar-btn-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
    font-size: 10px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
    pointer-events: none;
  }

  .toolbar-menu-active-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    align-items: center;
  }

  .toolbar-active-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border-radius: 12px;
    background: var(--menu-hover);
    color: var(--text-primary);
    font-size: 11px;
  }

  .toolbar-active-chip-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: 0;
    padding: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .toolbar-active-chip-x:hover {
    background: var(--ui-surface-active);
    color: var(--text-primary);
  }

  .toolbar-clear-all {
    margin-left: auto;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--accent-primary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
  }

  .toolbar-clear-all:hover {
    background: var(--menu-hover);
    border-color: var(--ui-border-light);
  }

  .toolbar-group {
    position: relative;
  }

  .toolbar-menu {
    position: absolute;
    top: 0;
    right: 100%;
    margin-right: 8px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    z-index: 12;
    padding: 4px;
    min-width: 180px;
    animation: popIn 0.15s ease;
  }

  .toolbar-menu.wide {
    min-width: 260px;
    max-height: 60vh;
    overflow-y: auto;
  }

  .toolbar-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    border-radius: 4px;
    transition: background-color 0.1s ease;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .toolbar-menu-item:hover {
    background: var(--menu-hover);
  }

  .toolbar-menu-item.active {
    background: var(--menu-hover);
    font-weight: 600;
  }

  .toolbar-menu-section-title {
    padding: 6px 10px 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .toolbar-menu-divider {
    height: 1px;
    background: var(--ui-border-light);
    margin: 4px 0;
  }

  .toolbar-tag-search {
    margin: 4px 6px 6px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--ui-bg);
    color: var(--text-primary);
  }

  .toolbar-tag-search:focus {
    border-color: var(--ui-border-focus);
  }

  .toolbar-tag-search:focus:not(:focus-visible) {
    outline: none;
  }

  .toolbar-menu-tags {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 4px 4px;
    max-height: 240px;
    overflow-y: auto;
  }

  .toolbar-tag-option {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-primary);
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
  }

  .toolbar-tag-option:hover {
    background: var(--menu-hover);
  }

  .toolbar-tag-count {
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .toolbar-menu-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .toolbar-menu-prop {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 6px 6px;
  }

  .toolbar-prop-input {
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--ui-bg);
    color: var(--text-primary);
    width: 100%;
  }

  .toolbar-prop-input:focus {
    border-color: var(--ui-border-focus);
  }

  .toolbar-prop-input:focus:not(:focus-visible) {
    outline: none;
  }

  .toolbar-prop-apply {
    margin-top: 2px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 4px;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-surface);
    cursor: pointer;
  }

  .toolbar-prop-apply:hover {
    background: var(--ui-surface-hover);
  }

  /* Reorder modal */
  .reorder-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    background: var(--modal-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.12s ease;
  }

  .reorder-card {
    width: 460px;
    max-width: 92vw;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    overflow: hidden;
    animation: slideUp 0.15s ease;
  }

  .reorder-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .reorder-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .reorder-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .reorder-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .reorder-list {
    list-style: none;
    margin: 0;
    padding: 8px;
    max-height: 50vh;
    overflow-y: auto;
  }

  .reorder-column-headings {
    display: grid;
    grid-template-columns: 1fr 180px 70px;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .reorder-heading-order {
    text-align: right;
  }

  .reorder-row {
    display: grid;
    grid-template-columns: 1fr 180px 70px;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
  }

  .reorder-width-cell {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .reorder-width-input {
    width: 70px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-bg);
  }

  .reorder-width-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .reorder-width-input:focus:not(:focus-visible) {
    outline: none;
  }

  .reorder-width-input::placeholder {
    color: var(--text-tertiary);
    opacity: 0.7;
  }

  .reorder-width-suffix {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .reorder-reset {
    margin-left: auto;
    padding: 3px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .reorder-reset:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .reorder-reset:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .reorder-order-cell {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }

  .reorder-hint {
    margin: 0;
    padding: 0 16px 8px;
    font-size: 11px;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .reorder-row:hover {
    background: var(--ui-surface-hover);
  }

  .reorder-name {
    flex: 1;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .reorder-btn {
    width: 28px;
    height: 24px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
  }

  .reorder-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .reorder-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .reorder-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px 12px 12px;
    border-top: 1px solid var(--ui-border-light);
  }

  .reorder-cancel {
    padding: 6px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .reorder-cancel:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .reorder-save {
    padding: 6px 12px;
    border: 1px solid var(--accent-primary);
    border-radius: 4px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 12px;
    cursor: pointer;
    font-weight: 600;
  }

  .views-list {
    list-style: none;
    margin: 0;
    padding: 0 4px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .views-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-radius: 4px;
  }

  .views-row:hover {
    background: var(--menu-hover);
  }

  .views-apply {
    flex: 1;
    text-align: left;
    padding: 4px 6px;
    font-size: 12px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .views-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .views-delete:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .save-view-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    background: var(--modal-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.12s ease;
  }

  .save-view-card {
    width: 340px;
    max-width: 90vw;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    overflow: hidden;
    animation: slideUp 0.15s ease;
  }

  .save-view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .save-view-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .save-view-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .save-view-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .save-view-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .save-view-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .save-view-input {
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
  }

  .save-view-input:focus:not(:focus-visible) {
    outline: none;
  }

  .save-view-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .save-view-hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .save-view-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px 12px 12px;
    border-top: 1px solid var(--ui-border-light);
  }

  .save-view-btn {
    padding: 6px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .save-view-btn:hover {
    background: var(--ui-surface-hover);
  }

  .save-view-btn.primary {
    color: var(--text-inverse, #fff);
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    font-weight: 600;
  }

  .save-view-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

</style>
