<script lang="ts">
  /**
   * Header toolbar for the vault sidebar.
   *
   * Buttons (left → right): New Folder, Sort By, Group By,
   * Expand/Collapse (toggle), Pop-Out / Dock.
   *
   * Sort By and Group By each open an inline menu with two sections:
   *   1. Field      — Name / Date Modified / Type / Size  (+ None for Group By)
   *   2. Direction  — Ascending / Descending
   * The menus are mutually exclusive (opening one closes the other) and
   * dismiss on click-outside and Escape.
   *
   * `dragHandlers` is passed through from `FloatingVaultPanel`: the
   * surrounding header strip in `VaultSidebar.svelte` doubles as the
   * floating-panel drag handle, and the `.sidebar-actions` div in this
   * component stops `pointerdown` propagation so button clicks don't
   * also start a drag.
   */
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { sidebarTagFilter } from '../../stores/sidebarTagFilter.svelte';
  import { pathsEqual } from '../../lib/utils/path';
  import type {
    VaultSortField,
    VaultSortDirection,
    VaultGroupField,
  } from '../../../shared/types';

  /**
   * Moves the node to `document.body` on mount and restores on destroy.
   *
   * Required for the dropdown menus: their nearest positioned ancestor
   * (`.vault-sidebar`) has `transform: translateX(...)` for the slide-in
   * animation, which makes it the containing block for `position: fixed`
   * descendants — meaning viewport coordinates would otherwise be
   * interpreted relative to the sidebar, rendering the menu way off-screen.
   * Portaling to body restores normal viewport-relative positioning.
   */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.parentNode?.removeChild(node);
      },
    };
  }

  type MenuName = 'sort' | 'group' | null;

  let openMenu = $state<MenuName>(null);
  let sortBtnEl = $state<HTMLButtonElement | null>(null);
  let groupBtnEl = $state<HTMLButtonElement | null>(null);
  let sortMenuEl = $state<HTMLDivElement | null>(null);
  let groupMenuEl = $state<HTMLDivElement | null>(null);

  // Anchor coordinates for the currently-open menu in viewport space. The
  // menus render `position: fixed` so they escape the sidebar's
  // `overflow: hidden` (which otherwise clips the lower half of the menu
  // against the rounded panel bottom). Recomputed on open + on viewport
  // resize.
  let menuAnchor = $state<{ top: number; right: number } | null>(null);

  function computeAnchorFor(btn: HTMLButtonElement | null): { top: number; right: number } | null {
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return {
      // 4px gap below the button, matching the docked sidebar's old
      // `margin-top: 4px` from the absolute-position layout.
      top: r.bottom + 4,
      // Right-align with the trigger button so the menu opens leftwards
      // (consistent with the previous behaviour and avoids overflow on
      // narrow sidebars).
      right: window.innerWidth - r.right,
    };
  }

  // Sort By offers a "None" option in addition to the four fields. None
  // disables ordering and uses the persisted manual order — drag-and-drop
  // in the sidebar is only enabled while None is active.
  const SORT_FIELDS: { value: VaultSortField; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'name', label: 'Name' },
    { value: 'modified', label: 'Date Modified' },
    { value: 'type', label: 'Type' },
    { value: 'size', label: 'Size' },
  ];

  // Group By offers a "None" option in addition to the four fields. None
  // disables the secondary sort entirely.
  const GROUP_FIELDS: { value: VaultGroupField; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'name', label: 'Name' },
    { value: 'modified', label: 'Date Modified' },
    { value: 'type', label: 'Type' },
    { value: 'size', label: 'Size' },
  ];

  const DIRECTIONS: { value: VaultSortDirection; label: string }[] = [
    { value: 'asc', label: 'Ascending' },
    { value: 'desc', label: 'Descending' },
  ];

  function toggleMenu(menu: 'sort' | 'group') {
    if (openMenu === menu) {
      openMenu = null;
      menuAnchor = null;
      return;
    }
    openMenu = menu;
    menuAnchor = computeAnchorFor(menu === 'sort' ? sortBtnEl : groupBtnEl);
  }

  function closeMenus() {
    openMenu = null;
    menuAnchor = null;
  }

  // Click-outside + Escape dismiss + viewport-resize reposition for the
  // open menu. Patterned after `Dropdown.svelte` and the color-picker
  // panels in GlobalToolbar (which also use position: fixed to escape a
  // clipped parent).
  $effect(() => {
    if (openMenu === null) return;

    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      const triggers = [sortBtnEl, groupBtnEl];
      const menus = [sortMenuEl, groupMenuEl];
      for (const el of triggers) if (el && el.contains(t)) return;
      for (const el of menus) if (el && el.contains(t)) return;
      closeMenus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenus();
    }
    function onResize() {
      menuAnchor = computeAnchorFor(openMenu === 'sort' ? sortBtnEl : groupBtnEl);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  });

  // ── Expand / Collapse toggle ──
  //
  // Single button: shows "Collapse All" when any folder is expanded;
  // otherwise "Expand All". Disabled when the sidebar shows no folders.
  // While a tag filter is on, both act on the folders it shows.
  const anyExpanded = $derived(sidebarTagFilter.anyFolderExpanded);
  const hasFolders = $derived(sidebarTagFilter.hasFolders);

  function toggleExpandCollapse() {
    if (anyExpanded) sidebarTagFilter.collapseAll();
    else sidebarTagFilter.expandAll();
  }

  // ── New Folder (silent create) ──
  //
  // After a successful create we stash the new folder's
  // absolute path on `uiStore.pendingSidebarRenameId`. The matching
  // VaultFileItem reads that on mount and immediately enters rename
  // mode with the suggested name pre-selected, so the user can type a
  // real name without a second click.
  async function handleNewFolderClick() {
    if (!vaultStore.path) return;
    // An empty folder matches no tag, so under a tag filter its row (and the
    // rename it starts) would never show.
    sidebarTagFilter.clear();
    const name = await vaultStore.suggestFolderName(vaultStore.path, 'New Folder');
    const result = await vaultStore.createFolder(vaultStore.path, name);
    if (!result.success) {
      // Surface main-process create-folder failures (EACCES, EEXIST race
      // after suggest, ENOENT on a swapped vault, …) so the user sees
      // something fired rather than the sidebar silently gaining no row.
      uiStore.toast(
        `Couldn't create folder "${name}"${result.code ? ` (${result.code})` : ''}`,
        'error',
        4000,
      );
      return;
    }
    // The row matches on its exact tree path, and the tree keeps the
    // platform's separators (backslashes on Windows), so take the spelling
    // from the refreshed tree rather than joining one here.
    const newAbs = `${vaultStore.path.replace(/[\\/]+$/, '')}/${name}`;
    const node = vaultStore.tree.find((n) => n.isDirectory && pathsEqual(n.path, newAbs));
    uiStore.setPendingSidebarRenameId(node?.path ?? newAbs);
  }

  // ── Float / Dock ──
  function handlePopOut() {
    uiStore.setSidebarFloating(true);
  }
  function handleDock() {
    uiStore.setSidebarFloating(false);
  }

  // Sort/Group setters that also close the menu after applying. The store
  // setters short-circuit if the value hasn't changed, so clicking the
  // already-active item is a no-op except for closing the menu.
  function pickSortField(field: VaultSortField) {
    vaultStore.setSortField(field);
  }
  function pickSortDirection(dir: VaultSortDirection) {
    vaultStore.setSortDirection(dir);
  }
  function pickGroupField(field: VaultGroupField) {
    vaultStore.setGroupField(field);
  }
  function pickGroupDirection(dir: VaultSortDirection) {
    vaultStore.setGroupDirection(dir);
  }
</script>

<!--
  Stop pointerdown propagation so clicking a toolbar button inside a
  draggable floating-panel header doesn't initiate a drag. Click events
  still fire (pointerdown→pointerup→click on the same element is unaffected).
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sidebar-actions" onpointerdown={(e) => e.stopPropagation()}>
  <!-- New Folder -->
  <button
    class="sidebar-btn"
    onclick={handleNewFolderClick}
    title="New Folder"
    aria-label="New Folder"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  </button>

  <!-- Sort By -->
  <div class="menu-wrapper">
    <button
      bind:this={sortBtnEl}
      class="sidebar-btn"
      class:active={openMenu === 'sort'}
      onclick={() => toggleMenu('sort')}
      title="Sort By"
      aria-label="Sort by"
      aria-haspopup="menu"
      aria-expanded={openMenu === 'sort'}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6"/>
        <line x1="4" y1="12" x2="16" y2="12"/>
        <line x1="4" y1="18" x2="12" y2="18"/>
      </svg>
    </button>
    {#if openMenu === 'sort' && menuAnchor}
      <div
        bind:this={sortMenuEl}
        use:portal
        class="sort-menu"
        role="menu"
        aria-label="Sort options"
        style="top: {menuAnchor.top}px; right: {menuAnchor.right}px;"
      >
        <div class="menu-section-label">Sort by</div>
        {#each SORT_FIELDS as opt (opt.value)}
          <button
            class="menu-option"
            class:active={vaultStore.sortField === opt.value}
            role="menuitemradio"
            aria-checked={vaultStore.sortField === opt.value}
            onclick={() => pickSortField(opt.value)}
          >
            <span class="check" aria-hidden="true">
              {#if vaultStore.sortField === opt.value}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </span>
            <span class="label">{opt.label}</span>
          </button>
        {/each}
        <div class="menu-divider"></div>
        <div class="menu-section-label">Direction</div>
        {#each DIRECTIONS as opt (opt.value)}
          <button
            class="menu-option"
            class:active={vaultStore.sortDirection === opt.value}
            class:disabled={vaultStore.sortField === 'none'}
            disabled={vaultStore.sortField === 'none'}
            role="menuitemradio"
            aria-checked={vaultStore.sortDirection === opt.value}
            onclick={() => pickSortDirection(opt.value)}
          >
            <span class="check" aria-hidden="true">
              {#if vaultStore.sortDirection === opt.value}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </span>
            <span class="label">{opt.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Group By -->
  <div class="menu-wrapper">
    <button
      bind:this={groupBtnEl}
      class="sidebar-btn"
      class:active={openMenu === 'group'}
      onclick={() => toggleMenu('group')}
      title="Group By"
      aria-label="Group by"
      aria-haspopup="menu"
      aria-expanded={openMenu === 'group'}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="6" rx="1"/>
        <rect x="3" y="13" width="18" height="6" rx="1"/>
        <line x1="7" y1="6" x2="17" y2="6"/>
        <line x1="7" y1="16" x2="17" y2="16"/>
      </svg>
    </button>
    {#if openMenu === 'group' && menuAnchor}
      <div
        bind:this={groupMenuEl}
        use:portal
        class="sort-menu group-menu"
        role="menu"
        aria-label="Group options"
        style="top: {menuAnchor.top}px; right: {menuAnchor.right}px;"
      >
        <div class="menu-section-label">Group by</div>
        {#each GROUP_FIELDS as opt (opt.value)}
          <button
            class="menu-option"
            class:active={vaultStore.groupField === opt.value}
            role="menuitemradio"
            aria-checked={vaultStore.groupField === opt.value}
            onclick={() => pickGroupField(opt.value)}
          >
            <span class="check" aria-hidden="true">
              {#if vaultStore.groupField === opt.value}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </span>
            <span class="label">{opt.label}</span>
          </button>
        {/each}
        <div class="menu-divider"></div>
        <div class="menu-section-label">Direction</div>
        {#each DIRECTIONS as opt (opt.value)}
          <button
            class="menu-option"
            class:active={vaultStore.groupDirection === opt.value}
            class:disabled={vaultStore.groupField === 'none'}
            disabled={vaultStore.groupField === 'none'}
            role="menuitemradio"
            aria-checked={vaultStore.groupDirection === opt.value}
            onclick={() => pickGroupDirection(opt.value)}
          >
            <span class="check" aria-hidden="true">
              {#if vaultStore.groupDirection === opt.value}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </span>
            <span class="label">{opt.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Expand / Collapse toggle -->
  <button
    class="sidebar-btn"
    onclick={toggleExpandCollapse}
    disabled={!hasFolders}
    title={anyExpanded ? 'Collapse All' : 'Expand All'}
    aria-label={anyExpanded ? 'Collapse all folders' : 'Expand all folders'}
  >
    {#if anyExpanded}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="18 15 12 9 6 15"/>
      </svg>
    {:else}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    {/if}
  </button>

  <!-- Pop-Out / Dock -->
  {#if !uiStore.sidebarFloating}
    <button class="sidebar-btn" onclick={handlePopOut} title="Float as panel" aria-label="Float vault as panel">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M15 3h6v6"/>
        <path d="M10 14L21 3"/>
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>
      </svg>
    </button>
  {:else}
    <button class="sidebar-btn" onclick={handleDock} title="Dock back" aria-label="Dock vault back into main window">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M9 5l-7 7 7 7"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
      </svg>
    </button>
  {/if}

  <!-- Hide Vault: hides the sidebar (docked or floating); the global
       toolbar's sidebar toggle brings it back. Closing the vault lives in
       the vault name dropdown and on Ctrl+Shift+W. The door's arrow points
       the way the sidebar will go. -->
  <button
    class="sidebar-btn"
    onclick={() => uiStore.setSidebarOpen(!uiStore.sidebarOpen)}
    title={uiStore.sidebarOpen ? 'Hide Vault' : 'Show Vault'}
    aria-label={uiStore.sidebarOpen ? 'Hide vault sidebar' : 'Show vault sidebar'}
    data-testid="hide-vault"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      {#if uiStore.sidebarOpen}
        <polyline points="15 17 10 12 15 7"/>
        <line x1="10" y1="12" x2="21" y2="12"/>
      {:else}
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      {/if}
    </svg>
  </button>
</div>

<style>
  .sidebar-actions {
    display: flex;
    gap: 2px;
  }

  .sidebar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .sidebar-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .sidebar-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .sidebar-btn.active {
    background: var(--ui-surface-active);
    color: var(--accent-primary);
  }

  .menu-wrapper {
    position: relative;
  }

  /* `position: fixed` so the menu escapes `.sidebar-inner`'s
     `overflow: hidden` (which otherwise clips the lower half against the
     rounded panel bottom). Coordinates come from inline `top` / `right`
     applied from `menuAnchor` (computed from the trigger button's
     bounding rect). */
  .sort-menu {
    position: fixed;
    z-index: var(--z-dropdown-panel);
    min-width: 180px;
    padding: 4px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    animation: slideDown 0.1s ease;
  }

  .menu-section-label {
    padding: 6px 12px 4px;
    font-size: 10px;
    font-weight: 700;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .menu-divider {
    height: 1px;
    margin: 4px 0;
    background: var(--ui-border-light, var(--ui-border));
  }

  .menu-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .menu-option:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .menu-option.active {
    color: var(--accent-primary);
  }

  .menu-option:disabled,
  .menu-option.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .menu-option .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--accent-primary);
  }

  .menu-option .label {
    flex: 1;
    min-width: 0;
  }
</style>
