<script lang="ts">
  /**
   * TaskListSideToolbar — V7 toolbar for the Task List board.
   *
   * Buttons:
   *   - Add Task
   *   - Group By  (Status / Priority / Tag / Due Date / None)
   *   - Sort By   (Title / Created / Due Date / Priority / Manual)
   *   - Filter    (Tag multi / Status / Priority / Show Completed)
   *   - View      (Tags Browser)
   */
  import { vaultIndexStore } from '../../stores/vaultIndex.svelte';

  type GroupBy = 'status' | 'priority' | 'tag' | 'dueDate' | 'category' | 'none';
  type SortBy = 'title' | 'created' | 'dueDate' | 'priority' | 'manual';
  type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
  type SmartListId = 'all' | 'today' | 'upcoming' | 'overdue' | 'no-date' | 'completed';

  type SavedView = {
    id: string;
    name: string;
    groupBy: GroupBy;
    sortBy: SortBy;
    filterTags: string[];
    filterStatus: string | null;
    filterPriority: Priority | null;
    showCompleted: boolean;
    smartList: SmartListId;
  };

  let {
    onAddTask,
    activeGroupBy,
    onGroupByChange,
    activeSortBy,
    onSortByChange,
    knownStatuses,
    activeFilterTags,
    onFilterTagsChange,
    activeFilterStatus,
    onFilterStatusChange,
    activeFilterPriority,
    onFilterPriorityChange,
    showCompleted,
    onShowCompletedChange,
    onOpenTagsBrowser,
    onMarkAllIncomplete,
    onDeleteAllCompleted,
    savedViews = [],
    onApplyView,
    onSaveView,
    onDeleteView,
    groupByDisabled = false,
  }: {
    onAddTask: () => void;
    activeGroupBy: GroupBy;
    onGroupByChange: (g: GroupBy) => void;
    activeSortBy: SortBy;
    onSortByChange: (s: SortBy) => void;
    knownStatuses: string[];
    activeFilterTags: string[];
    onFilterTagsChange: (tags: string[]) => void;
    activeFilterStatus: string | null;
    onFilterStatusChange: (s: string | null) => void;
    activeFilterPriority: Priority | null;
    onFilterPriorityChange: (p: Priority | null) => void;
    showCompleted: boolean;
    onShowCompletedChange: (v: boolean) => void;
    onOpenTagsBrowser: () => void;
    onMarkAllIncomplete?: () => void;
    onDeleteAllCompleted?: () => void;
    savedViews?: SavedView[];
    onApplyView?: (view: SavedView) => void;
    onSaveView?: (name: string) => void;
    onDeleteView?: (id: string) => void;
    /**
     * True when the board has at least one user-defined section. Sections
     * take over as the top-level grouping, so the GroupBy menu is disabled
     * with a tooltip explaining why — disabling matches the user's
     * decision to keep the two hierarchies mutually exclusive.
     */
    groupByDisabled?: boolean;
  } = $props();

  let groupMenuOpen = $state(false);
  let sortMenuOpen = $state(false);
  let filterMenuOpen = $state(false);
  let viewMenuOpen = $state(false);
  let savedViewsMenuOpen = $state(false);
  let savePromptOpen = $state(false);
  let savePromptName = $state('');

  function closeAll() {
    groupMenuOpen = false;
    sortMenuOpen = false;
    filterMenuOpen = false;
    viewMenuOpen = false;
    savedViewsMenuOpen = false;
  }

  function openSavePrompt() {
    savedViewsMenuOpen = false;
    savePromptName = '';
    savePromptOpen = true;
  }

  function commitSaveView() {
    const name = savePromptName.trim();
    if (!name || !onSaveView) {
      savePromptOpen = false;
      return;
    }
    onSaveView(name);
    savePromptOpen = false;
    savePromptName = '';
  }

  function cancelSaveView() {
    savePromptOpen = false;
    savePromptName = '';
  }

  let knownTags = $derived<Array<[string, number]>>(Array.from(vaultIndexStore.allTags()));

  // Phase C item 16: dismiss the open menu (filter / group / sort / view /
  // saved views) when the user clicks anywhere outside the toolbar root.
  // Lives as a $effect rather than `use:` action so the listener mounts
  // exactly once and we don't pay the cost when every menu is closed.
  // pointerdown (capture) fires before any inner button's click — that
  // ordering lets us close menus *before* the new menu's toggle handler
  // runs, instead of fighting it.
  let toolbarRootEl: HTMLDivElement | null = $state(null);
  let anyMenuOpen = $derived(
    groupMenuOpen || sortMenuOpen || filterMenuOpen || viewMenuOpen || savedViewsMenuOpen,
  );

  $effect(() => {
    if (!anyMenuOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      const root = toolbarRootEl;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      closeAll();
    }
    function onDocKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeAll();
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeydown);
    };
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
    onFilterStatusChange(null);
    onFilterPriorityChange(null);
    onShowCompletedChange(true);
  }

  const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

  function groupLabel(g: GroupBy): string {
    return (
      ({
        status: 'Status',
        priority: 'Priority',
        tag: 'Tag',
        dueDate: 'Due Date',
        category: 'Category',
        none: 'None',
      } as const)[g] ?? g
    );
  }

  function sortLabel(s: SortBy): string {
    return (
      ({
        title: 'Title',
        created: 'Date Created',
        dueDate: 'Due Date',
        priority: 'Priority',
        manual: 'Manual',
      } as const)[s] ?? s
    );
  }

  let hasActiveFilter = $derived(
    activeFilterTags.length > 0
      || !!activeFilterStatus
      || !!activeFilterPriority
      || !showCompleted,
  );

  let activeFilterCount = $derived(
    activeFilterTags.length
      + (activeFilterStatus ? 1 : 0)
      + (activeFilterPriority ? 1 : 0)
      + (showCompleted ? 0 : 1),
  );
</script>

<div class="side-toolbar" bind:this={toolbarRootEl} style:z-index="var(--z-side-toolbar)">
  <button class="toolbar-btn" onclick={onAddTask} title="Add Task" aria-label="Add task">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  </button>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={activeGroupBy !== 'none'}
      disabled={groupByDisabled}
      onclick={() => { const o = !groupMenuOpen; closeAll(); groupMenuOpen = o; }}
      title={groupByDisabled ? 'Group By is disabled while the board uses sections' : `Group By: ${groupLabel(activeGroupBy)}`}
      aria-label="Group by"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M6 12h12" />
        <path d="M9 18h6" />
      </svg>
    </button>
    {#if groupMenuOpen}
      <div class="toolbar-menu" role="menu">
        <div class="toolbar-menu-section-title">Group Tasks By</div>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'status'} onclick={() => { groupMenuOpen = false; onGroupByChange('status'); }}>Status</button>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'priority'} onclick={() => { groupMenuOpen = false; onGroupByChange('priority'); }}>Priority</button>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'tag'} onclick={() => { groupMenuOpen = false; onGroupByChange('tag'); }}>Tag</button>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'dueDate'} onclick={() => { groupMenuOpen = false; onGroupByChange('dueDate'); }}>Due Date</button>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'category'} onclick={() => { groupMenuOpen = false; onGroupByChange('category'); }}>Category</button>
        <button class="toolbar-menu-item" class:active={activeGroupBy === 'none'} onclick={() => { groupMenuOpen = false; onGroupByChange('none'); }}>None</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={activeSortBy !== 'manual'}
      onclick={() => { const o = !sortMenuOpen; closeAll(); sortMenuOpen = o; }}
      title="Sort By: {sortLabel(activeSortBy)}"
      aria-label="Sort by"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="14" y2="12" />
        <line x1="4" y1="18" x2="9" y2="18" />
      </svg>
    </button>
    {#if sortMenuOpen}
      <div class="toolbar-menu" role="menu">
        <div class="toolbar-menu-section-title">Sort Tasks By</div>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'title'} onclick={() => { sortMenuOpen = false; onSortByChange('title'); }}>Title</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'created'} onclick={() => { sortMenuOpen = false; onSortByChange('created'); }}>Date Created</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'dueDate'} onclick={() => { sortMenuOpen = false; onSortByChange('dueDate'); }}>Due Date</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'priority'} onclick={() => { sortMenuOpen = false; onSortByChange('priority'); }}>Priority</button>
        <button class="toolbar-menu-item" class:active={activeSortBy === 'manual'} onclick={() => { sortMenuOpen = false; onSortByChange('manual'); }}>Manual</button>
      </div>
    {/if}
  </div>

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      class:active={hasActiveFilter}
      onclick={() => { const o = !filterMenuOpen; closeAll(); filterMenuOpen = o; }}
      title={activeFilterCount > 0 ? `Filter (${activeFilterCount} active)` : 'Filter'}
      aria-label={activeFilterCount > 0 ? `Filter, ${activeFilterCount} active` : 'Filter'}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
      {#if activeFilterCount > 0}
        <span class="toolbar-btn-badge" aria-hidden="true">{activeFilterCount}</span>
      {/if}
    </button>
    {#if filterMenuOpen}
      <div class="toolbar-menu wide" role="menu">
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
            {#if activeFilterStatus}
              <span class="toolbar-active-chip">
                status: {activeFilterStatus}
                <button
                  class="toolbar-active-chip-x"
                  aria-label="Remove status filter"
                  onclick={() => onFilterStatusChange(null)}
                ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            {/if}
            {#if activeFilterPriority}
              <span class="toolbar-active-chip">
                priority: {activeFilterPriority}
                <button
                  class="toolbar-active-chip-x"
                  aria-label="Remove priority filter"
                  onclick={() => onFilterPriorityChange(null)}
                ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            {/if}
            {#if !showCompleted}
              <span class="toolbar-active-chip">
                hide completed
                <button
                  class="toolbar-active-chip-x"
                  aria-label="Show completed"
                  onclick={() => onShowCompletedChange(true)}
                ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            {/if}
            <button class="toolbar-clear-all" onclick={clearFilters}>Clear all</button>
          </div>
          <div class="toolbar-menu-divider"></div>
        {/if}
        <div class="toolbar-menu-section-title">Filter by Tag</div>
        <div class="toolbar-menu-tags">
          {#if knownTags.length === 0}
            <span class="toolbar-menu-empty">No tags in vault</span>
          {:else}
            {#each knownTags as [tagName, count] (tagName)}
              {@const norm = tagName.replace(/^#/, '')}
              {@const checked = activeFilterTags.includes(norm)}
              <label class="toolbar-tag-option">
                <input type="checkbox" {checked} onchange={() => toggleTag(norm)} />
                <span>#{norm} <span class="toolbar-tag-count">({count})</span></span>
              </label>
            {/each}
          {/if}
        </div>

        <div class="toolbar-menu-divider"></div>

        <div class="toolbar-menu-section-title">Filter by Status</div>
        <div class="toolbar-menu-row">
          <button
            class="filter-chip"
            class:active={activeFilterStatus === null}
            onclick={() => onFilterStatusChange(null)}
          >Any</button>
          {#each knownStatuses as st (st)}
            <button
              class="filter-chip"
              class:active={activeFilterStatus === st}
              onclick={() => onFilterStatusChange(activeFilterStatus === st ? null : st)}
            >{st}</button>
          {/each}
        </div>

        <div class="toolbar-menu-divider"></div>

        <div class="toolbar-menu-section-title">Filter by Priority</div>
        <div class="toolbar-menu-row">
          <button
            class="filter-chip"
            class:active={activeFilterPriority === null}
            onclick={() => onFilterPriorityChange(null)}
          >Any</button>
          {#each PRIORITIES as p (p)}
            <button
              class="filter-chip"
              class:active={activeFilterPriority === p}
              onclick={() => onFilterPriorityChange(activeFilterPriority === p ? null : p)}
            >{p}</button>
          {/each}
        </div>

        <div class="toolbar-menu-divider"></div>

        <label class="toolbar-toggle-row">
          <input
            type="checkbox"
            checked={showCompleted}
            onchange={(e) => onShowCompletedChange((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Show Completed</span>
        </label>

        <div class="toolbar-menu-divider"></div>

        <button class="toolbar-menu-item" onclick={() => clearFilters()}>Clear All Filters</button>
      </div>
    {/if}
  </div>

  {#if onSaveView || onApplyView || onDeleteView}
    <div class="toolbar-group">
      <button
        class="toolbar-btn"
        class:active={savedViews.length > 0}
        onclick={() => { const o = !savedViewsMenuOpen; closeAll(); savedViewsMenuOpen = o; }}
        title={savedViews.length > 0 ? `Saved views (${savedViews.length})` : 'Saved views'}
        aria-label="Saved views"
        aria-haspopup="menu"
        aria-expanded={savedViewsMenuOpen}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      {#if savedViewsMenuOpen}
        <div class="toolbar-menu wide" role="menu">
          <div class="toolbar-menu-section-title">Saved Views</div>
          {#if savedViews.length === 0}
            <p class="toolbar-menu-empty">No views saved yet. Save the current sort + filters as a named view to flip back to it later.</p>
          {:else}
            <ul class="views-list">
              {#each savedViews as view (view.id)}
                <li class="views-row">
                  <button
                    class="views-apply"
                    onclick={() => { savedViewsMenuOpen = false; onApplyView?.(view); }}
                    title={`Smart list: ${view.smartList}; Sort: ${view.sortBy}; Group: ${view.groupBy}; Tags: ${view.filterTags.join(', ') || '—'}`}
                  >
                    {view.name}
                  </button>
                  {#if onDeleteView}
                    <button
                      class="views-delete"
                      onclick={() => onDeleteView?.(view.id)}
                      title={`Delete view "${view.name}"`}
                      aria-label={`Delete view ${view.name}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if onSaveView}
            <div class="toolbar-menu-divider"></div>
            <button class="toolbar-menu-item" onclick={openSavePrompt}>Save current as…</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="toolbar-group">
    <button
      class="toolbar-btn"
      onclick={() => { const o = !viewMenuOpen; closeAll(); viewMenuOpen = o; }}
      title="View"
      aria-label="View"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      </svg>
    </button>
    {#if viewMenuOpen}
      <div class="toolbar-menu" role="menu">
        <button class="toolbar-menu-item" onclick={() => { viewMenuOpen = false; onOpenTagsBrowser(); }}>Tags Browser</button>
        {#if onMarkAllIncomplete || onDeleteAllCompleted}
          <div class="toolbar-menu-divider"></div>
          <div class="toolbar-menu-section-title">Bulk Actions</div>
          {#if onMarkAllIncomplete}
            <button class="toolbar-menu-item" onclick={() => { viewMenuOpen = false; onMarkAllIncomplete?.(); }}>Mark all incomplete</button>
          {/if}
          {#if onDeleteAllCompleted}
            <button class="toolbar-menu-item" onclick={() => { viewMenuOpen = false; onDeleteAllCompleted?.(); }}>Delete completed</button>
          {/if}
        {/if}
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
      <h3 class="save-view-title">Save current view</h3>
      <p class="save-view-hint">Name this combination of smart list, group, sort, and filters so you can flip back to it later.</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="save-view-input"
        bind:value={savePromptName}
        placeholder="e.g. Today's focus"
        autofocus
      />
      <div class="save-view-actions">
        <button class="save-view-btn cancel" onclick={cancelSaveView}>Cancel</button>
        <button
          class="save-view-btn primary"
          onclick={commitSaveView}
          disabled={!savePromptName.trim()}
        >
          Save
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .side-toolbar {
    position: absolute;
    top: 12px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: calc(4px * var(--ui-board-toolbar-scale, 1));
    padding: 6px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 10px;
    box-shadow: var(--ui-shadow);
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

  .toolbar-divider {
    height: 1px;
    background: var(--ui-border-light);
    margin: 2px 4px;
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

  .toolbar-menu-tags {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 4px 4px;
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

  .toolbar-menu-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 6px 6px;
  }

  .filter-chip {
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    padding: 2px 8px;
    font-size: 11px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    text-transform: capitalize;
  }

  .filter-chip:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .filter-chip.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse);
  }

  .toolbar-toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-primary);
    padding: 6px 10px;
    cursor: pointer;
  }

  .toolbar-toggle-row input {
    accent-color: var(--accent-primary);
  }

  .views-list {
    list-style: none;
    margin: 0;
    padding: 2px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .views-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .views-apply {
    flex: 1;
    text-align: left;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .views-apply:hover {
    background: var(--menu-hover);
  }

  .views-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease;
  }

  .views-delete:hover {
    color: var(--accent-danger);
    background: var(--menu-danger-bg, rgba(255, 107, 107, 0.1));
  }

  .save-view-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    z-index: var(--z-modal-backdrop);
  }

  .save-view-card {
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 10px;
    box-shadow: var(--ui-shadow-lg);
    padding: 20px;
    width: min(360px, 90vw);
  }

  .save-view-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 6px;
    color: var(--text-primary);
  }

  .save-view-hint {
    font-size: 12px;
    color: var(--text-secondary);
    margin: 0 0 12px;
  }

  .save-view-input {
    width: 100%;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 14px;
  }

  .save-view-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .save-view-input:focus:not(:focus-visible) {
    outline: none;
  }

  .save-view-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .save-view-btn {
    padding: 6px 14px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    background: var(--ui-surface);
    color: var(--text-primary);
    cursor: pointer;
  }

  .save-view-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .save-view-btn.primary {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse);
  }

  .save-view-btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
