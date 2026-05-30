<script lang="ts">
  import { dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import type { FileTreeNode } from '../../../shared/types';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import {
    basenameOf,
    describeMoveIntoFolderFailure,
  } from '../../lib/vault/moveIntoFolderFeedback';
  import VaultFileItem from './VaultFileItem.svelte';
  import VaultSidebarToolbar from './VaultSidebarToolbar.svelte';
  import TagEditor from '../tags/TagEditor.svelte';

  /**
   * svelte-dnd-action item wrapper. The library requires an `id` field on
   * every draggable; node.path is unique within a parent so it's our id.
   */
  type DndNode = { id: string; node: FileTreeNode };

  /**
   * Mirrors `vaultStore.tree` into a local mutable array so svelte-dnd-action
   * can swap items during a drag (the library expects to be the source of
   * truth for the items prop while a drag is active). A writable $derived
   * re-syncs from the store whenever `tree` changes externally (refreshTree,
   * sort change, external file edit) while still permitting the library to
   * reassign the array during a drag.
   */
  let rootDndItems: DndNode[] = $derived(
    vaultStore.tree.map((n) => ({ id: n.path, node: n })),
  );

  function onRootConsider(e: CustomEvent<DndEvent<DndNode>>) {
    rootDndItems = e.detail.items;
  }
  function onRootFinalize(e: CustomEvent<DndEvent<DndNode>>) {
    rootDndItems = e.detail.items;
    if (vaultStore.sortField === 'none' && vaultStore.path) {
      vaultStore.setManualOrder(vaultStore.path, e.detail.items.map((i) => i.id));
    }
  }

  interface DragHandlers {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: (e: PointerEvent) => void;
    onPointerCancel: (e: PointerEvent) => void;
  }

  interface Props {
    open?: boolean;
    /**
     * Kept as a passthrough prop so existing call sites that supply a
     * `role` value still type-check. The legacy `'popout'` branch
     * (second BrowserWindow) was removed when the sidebar moved to
     * an in-app floating panel; both values now behave identically.
     */
    role?: 'main' | 'popout';
    /**
     * When provided, the `.sidebar-header` strip becomes a drag handle.
     * Used by `FloatingVaultPanel` to let the user drag the floating
     * panel by its title bar. The action buttons' `onpointerdown`
     * propagation is stopped so clicking a button doesn't initiate a
     * drag.
     */
    dragHandlers?: DragHandlers;
  }

  let { open = true, role = 'main', dragHandlers }: Props = $props();

  let rootDropActive = $state(false);

  function handleRootDragOver(e: DragEvent) {
    const types = e.dataTransfer?.types;
    if (!types) return;
    if (!types.includes('application/x-vault-file') && !types.includes('application/x-vault-files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    rootDropActive = true;
  }

  function handleRootDragLeave(e: DragEvent) {
    if (e.relatedTarget && (e.currentTarget as HTMLElement)?.contains(e.relatedTarget as Node)) {
      return;
    }
    rootDropActive = false;
  }

  async function handleRootDrop(e: DragEvent) {
    // Folder drop handlers in VaultFileItem call stopPropagation, so this
    // fires only when the drop landed in empty space inside the tree — i.e.
    // the user wants the file at the vault root.
    if (!vaultStore.path) return;
    const root = vaultStore.path;
    const rootName = basenameOf(root) || 'vault root';
    e.preventDefault();
    rootDropActive = false;
    const rawMulti = e.dataTransfer?.getData('application/x-vault-files');
    if (rawMulti) {
      try {
        const payloads = JSON.parse(rawMulti) as { path: string }[];
        for (const p of payloads) {
          if (!p?.path) continue;
          const result = await vaultStore.moveIntoFolder(p.path, root);
          if (!result.ok) {
            uiStore.toast(
              describeMoveIntoFolderFailure(result, basenameOf(p.path), rootName),
              result.code === 'PERMISSION_DENIED' ? 'error' : 'warning',
            );
          }
        }
      } catch (err) {
        reportError(
          'VaultSidebar.root-multi-drop',
          err,
          'Failed to move one or more files to the vault root',
        );
      }
      vaultStore.clearSelection();
      return;
    }
    const raw = e.dataTransfer?.getData('application/x-vault-file');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as { path: string };
      if (!payload?.path) return;
      const result = await vaultStore.moveIntoFolder(payload.path, root);
      if (!result.ok) {
        uiStore.toast(
          describeMoveIntoFolderFailure(result, basenameOf(payload.path), rootName),
          result.code === 'PERMISSION_DENIED' ? 'error' : 'warning',
        );
      }
    } catch (err) {
      reportError(
        'VaultSidebar.root-drop',
        err,
        'Failed to move file to the vault root',
      );
    }
  }

  /**
   * Clears multi-selection when the user clicks empty space anywhere in
   * the sidebar — header padding, search-bar gap, below the last row.
   *
   * Negative-selector pattern: returns early if the click landed on any
   * interactive element. The previous `e.target === e.currentTarget`
   * check only matched bare clicks on the file-tree div and left the
   * selection stuck on every other empty-area click.
   */
  function handleSidebarClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(
      '.file-row, .file-actions, .sidebar-actions button, ' +
      'input, textarea, [role="menuitem"], [role="menuitemradio"], ' +
      '.sort-menu, .group-menu, .rename-input',
    )) return;
    vaultStore.clearSelection();
  }

  /**
   * Global Escape handler. Clears the sidebar's multi-selection when no
   * modal is open and no input/editor has focus. Bubble phase (not capture)
   * so CodeMirror / inputs swallow Escape first when focused.
   */
  $effect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (uiStore.activeModal) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (vaultStore.selectedPaths.size === 0) return;
      vaultStore.clearSelection();
    }
    document.addEventListener('keydown', onGlobalKey);
    return () => document.removeEventListener('keydown', onGlobalKey);
  });

  /**
   * Global pointerdown handler. Clears multi-selection when the user
   * clicks anywhere OUTSIDE the sidebar (docked or floating). Sidebar-
   * internal clicks are handled by `handleSidebarClick` so a drag that
   * starts on a file row keeps its selection set for `dragstart` to read.
   * Capture phase so we read the target before downstream handlers
   * consume the event.
   */
  $effect(() => {
    function onGlobalPointerDown(e: PointerEvent) {
      if (vaultStore.selectedPaths.size === 0) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // In-sidebar pointerdowns go through the sidebar-click handler.
      if (t.closest('.vault-sidebar, .floating-vault-panel')) return;
      // Don't fight context menus, dropdowns, or modals — they may have
      // been opened from a sidebar row whose selection is the action target.
      if (t.closest('.context-menu, .dropdown-panel, .modal, [role="dialog"]')) return;
      vaultStore.clearSelection();
    }
    document.addEventListener('pointerdown', onGlobalPointerDown, true);
    return () => document.removeEventListener('pointerdown', onGlobalPointerDown, true);
  });

  async function handleSelectVault() {
    // Sprint A / A4 — route through the canonical `openVault` so the swap
    // goes through `fireVaultSwap` (lifecycle reset, history clear, etc.).
    // The legacy `selectVault` shortcut bypassed every onVaultSwap subscriber
    // and was a footgun for any caller that wired into it later.
    const vaultPath = await window.filo.invoke('vault:select');
    if (!vaultPath) return;
    await vaultStore.openVault(vaultPath);
  }

  // ── Resize gutter (right-edge drag-to-resize) ──
  //
  // Mirrors SplitPaneContainer's pointer pattern: pointerdown captures
  // the pointer + records the starting width and clientX, pointermove
  // applies the delta clamped 180–600, pointerup releases capture.
  // Width persists per-machine via the debounced `sidebar:set-state` IPC
  // call inside `uiStore.setSidebarWidth`.
  let isResizing = $state(false);
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function onResizeStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = uiStore.sidebarWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: PointerEvent) {
    if (!isResizing) return;
    e.preventDefault();
    const next = resizeStartWidth + (e.clientX - resizeStartX);
    uiStore.setSidebarWidth(next);
  }

  function onResizeEnd(e: PointerEvent) {
    if (!isResizing) return;
    isResizing = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released — releasePointerCapture throws if so
    }
  }

  // Width applied inline. When the sidebar is rendered inside
  // `FloatingVaultPanel`, the panel's CSS overrides position/inset to
  // fill its body so this width is harmless (the gutter sibling is
  // hidden in that mode).
  let widthStyle = $derived(`${uiStore.sidebarWidth}px`);

  // ── Resize gutter height ──
  //
  // The gutter is a fixed-position sibling of `.vault-sidebar` (so it
  // escapes the parent's `pointer-events: none`). Its height needs to
  // track `.sidebar-inner`, which shrinks-to-content when the vault is
  // sparse — otherwise the gutter spans the whole chrome gap and looks
  // disconnected from the actual panel.
  let innerEl = $state<HTMLDivElement | null>(null);
  let innerHeight = $state(0);

  $effect(() => {
    if (!innerEl) return;
    const ro = new ResizeObserver(([entry]) => {
      innerHeight = entry.contentRect.height;
    });
    ro.observe(innerEl);
    return () => ro.disconnect();
  });

  // Start listening for file system changes when the component mounts
  $effect(() => {
    if (vaultStore.isOpen) {
      const unsub = vaultStore.listenForChanges();
      return unsub;
    }
  });

  let fileTreeEl = $state<HTMLDivElement | null>(null);

  // ── TagEditor host ──
  //
  // VaultFileItem dispatches `vault-file-tag-editor` (bubbles via the row
  // button or directly on `document` from the row's context menu). Single
  // host anchored at the requested position so we don't pay per-row mount
  // costs and so the editor lifecycle survives sidebar scroll.
  let fileTagEditor = $state<{ filePath: string; x: number; y: number } | null>(null);

  $effect(() => {
    function onOpenFileTagEditor(raw: Event) {
      const detail = (raw as CustomEvent<{ filePath: string; x: number; y: number }>).detail;
      if (!detail?.filePath) return;
      fileTagEditor = { filePath: detail.filePath, x: detail.x, y: detail.y };
    }
    document.addEventListener('vault-file-tag-editor', onOpenFileTagEditor);
    return () => document.removeEventListener('vault-file-tag-editor', onOpenFileTagEditor);
  });

  function closeFileTagEditor() {
    fileTagEditor = null;
  }

  /**
   * Tree-level keyboard navigation (WAI-ARIA tree pattern):
   *   ArrowDown / ArrowUp → move focus to next / previous visible treeitem
   *   ArrowRight          → expand collapsed folder, else step into children
   *   ArrowLeft           → collapse expanded folder, else step to parent
   *   Home / End          → first / last visible treeitem
   *
   * The selector `[role="treeitem"]` is set on each VaultFileItem's
   * `<button class="file-row">`; children render as DOM siblings of their
   * parent (the tree is flat in markup) so a single querySelectorAll across
   * the `.file-tree` root sees every visible row.
   */
  function findFolderPathFor(rowEl: HTMLElement): string | null {
    const folderTitle = rowEl.getAttribute('title');
    return folderTitle ?? null;
  }

  function handleTreeKeydown(e: KeyboardEvent) {
    if (!fileTreeEl) return;
    const items = Array.from(
      fileTreeEl.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    const step = (delta: number) => {
      if (items.length === 0) return;
      let next: number;
      if (idx === -1) next = delta > 0 ? 0 : items.length - 1;
      else next = (idx + delta + items.length) % items.length;
      e.preventDefault();
      items[next].focus();
    };
    switch (e.key) {
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(-1); break;
      case 'Home':
        e.preventDefault();
        items[0].focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      case 'ArrowRight': {
        if (idx === -1 || !active) return;
        const isExpanded = active.getAttribute('aria-expanded') === 'true';
        const isFolder = active.getAttribute('aria-expanded') !== null;
        if (isFolder && !isExpanded) {
          e.preventDefault();
          const path = findFolderPathFor(active);
          if (path) vaultStore.toggleFolder(path);
        } else if (isFolder && isExpanded) {
          // Already expanded → move focus to first child (the next DOM row).
          step(1);
        }
        break;
      }
      case 'ArrowLeft': {
        if (idx === -1 || !active) return;
        const isExpanded = active.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
          e.preventDefault();
          const path = findFolderPathFor(active);
          if (path) vaultStore.toggleFolder(path);
        }
        // Else: leaf or collapsed folder — stepping to parent without DOM
        // parent links is unreliable, so leave focus put (user can ArrowUp).
        break;
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<aside class="vault-sidebar" class:open class:embedded={dragHandlers !== undefined} style="z-index: var(--z-sidebar); width: {widthStyle};">
  <div class="sidebar-inner" bind:this={innerEl} onclick={handleSidebarClick}>
    <!--
      Header acts as a drag handle when `dragHandlers` is provided
      (i.e. when this sidebar is embedded inside `FloatingVaultPanel`).
      Otherwise the pointer listeners are no-ops (undefined props).
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-header"
      class:draggable={dragHandlers !== undefined}
      onpointerdown={dragHandlers?.onPointerDown}
      onpointermove={dragHandlers?.onPointerMove}
      onpointerup={dragHandlers?.onPointerUp}
      onpointercancel={dragHandlers?.onPointerCancel}
    >
      <h2 class="sidebar-title">Vault</h2>
      {#if vaultStore.isOpen}
        <VaultSidebarToolbar />
      {/if}
    </div>

    {#if vaultStore.isOpen}
      <div class="search-bar">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          class="search-input"
          type="text"
          placeholder="Search vault..."
          value={vaultStore.search}
          oninput={(e) => vaultStore.setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      <div
        bind:this={fileTreeEl}
        class="file-tree"
        class:root-drop-active={rootDropActive}
        class:sort-active={vaultStore.sortField !== 'none' || vaultStore.search !== ''}
        role="tree"
        aria-label="Vault files"
        tabindex={-1}
        onkeydown={handleTreeKeydown}
        ondragover={handleRootDragOver}
        ondragleave={handleRootDragLeave}
        ondrop={handleRootDrop}
      >
        {#if vaultStore.loading}
          <p class="tree-message">Loading...</p>
        {:else if vaultStore.tree.length === 0}
          <p class="tree-message">
            {vaultStore.search ? 'No matches found' : 'Empty vault'}
          </p>
        {:else}
          <!--
            svelte-dnd-action zone for the vault root. Active only when Sort
            By is set to "None" — any other sort overrides manual order, so
            dragging to reorder would be invisible. Each zone uses a unique
            `type` derived from its parent path so the library disallows
            cross-zone (cross-folder) moves; cross-folder moves remain a
            filesystem operation handled by the existing HTML5 drop on
            VaultFileItem.

            `dragHandleZone` (instead of `dndzone`) restricts the gesture
            that starts the in-vault reorder to the `.drag-handle` span on
            each row (see VaultFileItem.svelte). Without this, dnd-action's
            item-wide pointer listener consumed mousedown across the whole
            row and the native HTML5 dragstart never fired, so files
            dropped onto boards animated back to the sidebar instead of
            landing as tiles / cards / tasks.
          -->
          <div
            class="root-dnd-zone"
            use:dragHandleZone={{
              items: rootDndItems,
              type: `vault-order:${vaultStore.path}`,
              // Search filters items out of view; reordering with a partial
              // list would erase the hidden items' ranks. Re-enable once
              // the search input is empty.
              dragDisabled: vaultStore.sortField !== 'none' || vaultStore.search !== '',
              flipDurationMs: 150,
              dropTargetStyle: {},
            }}
            onconsider={onRootConsider}
            onfinalize={onRootFinalize}
          >
            {#each rootDndItems as item (item.id)}
              <VaultFileItem node={item.node} {role} />
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="vault-empty">
        <p class="empty-text">No vault selected</p>
        <button class="open-vault-btn" onclick={handleSelectVault}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          Open Vault
        </button>
      </div>
    {/if}
  </div>
</aside>

{#if open}
  <!--
    Rendered as a sibling of `.vault-sidebar` (not a child) so it escapes
    the parent's `pointer-events: none` — which is required there so the
    transparent area below the shrink-wrapped `.sidebar-inner` lets canvas
    clicks reach the workspace beneath. As an own fixed-position element
    with its own stacking context, hit-testing for the 6px gutter strip is
    reliable regardless of the workspace overlap. Hidden via CSS when this
    component is rendered inside `FloatingVaultPanel`.
  -->
  <div
    class="vault-resize-gutter"
    class:dragging={isResizing}
    style="left: calc({widthStyle} - 3px); height: {innerHeight}px; z-index: calc(var(--z-sidebar) + 1);"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    onpointerdown={onResizeStart}
    onpointermove={onResizeMove}
    onpointerup={onResizeEnd}
    onpointercancel={onResizeEnd}
  ></div>
{/if}

{#if fileTagEditor}
  <!--
    Single TagEditor host for the sidebar. Mounted as a top-level sibling
    so it escapes both the sidebar's overflow clip and any nested dndzones.
    Click-outside overlay closes the popup.
  -->
  <div
    class="file-tag-overlay"
    style="z-index: calc(var(--z-sidebar) + 49);"
    onclick={closeFileTagEditor}
    onkeydown={(e) => { if (e.key === 'Escape') closeFileTagEditor(); }}
    role="presentation"
  ></div>
  <div class="file-tag-anchor" style="position: fixed; left: {fileTagEditor.x}px; top: {fileTagEditor.y}px; z-index: calc(var(--z-sidebar) + 50);">
    <TagEditor filePath={fileTagEditor.filePath} onClose={closeFileTagEditor} />
  </div>
{/if}

<style>
  /* Outer sidebar slot — full-height between toolbar and tab bar. The
     panel background lives on `.sidebar-inner` so a vault with only a
     few files lets the workspace show through below the file list.

     `padding-bottom: 8px` lifts the inner panel off the tab bar so the
     rounded bottom corners are visible — without it the inner extends
     flush against the tab bar and reads as a continuation of the chrome
     rather than a self-contained panel. */
  .vault-sidebar {
    position: fixed;
    top: var(--global-toolbar-height, 44px);
    left: 0;
    bottom: var(--tabbar-height, 36px);
    padding-bottom: 8px;
    display: block;
    background: transparent;
    border-right: none;
    overflow: visible;
    user-select: none;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    pointer-events: none;
  }

  .vault-sidebar.open {
    transform: translateX(0);
  }

  /* Inner panel — carries background, border, and shadow; shrinks to
     content so a sparse vault doesn't paint a tall empty rectangle over
     the workspace. `max-height: 100%` keeps the chrome gap as a hard cap
     so a vault with many files still scrolls internally. The rounded
     bottom corners + bottom border give the panel a clear lower edge so
     it reads as a card sitting in the chrome rather than a flush
     vertical strip. */
  .sidebar-inner {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 100%;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--ui-border);
    border-bottom: 1px solid var(--ui-border);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
    overflow: hidden;
    pointer-events: auto;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--ui-border-light);
    flex-shrink: 0;
  }

  /* When embedded in the floating panel, the header doubles as a drag
     handle. Buttons inside `.sidebar-actions` stop pointerdown propagation
     so a click on a button doesn't initiate a drag. */
  .sidebar-header.draggable {
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .sidebar-header.draggable:active {
    cursor: grabbing;
  }

  .sidebar-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--ui-border);
    flex-shrink: 0;
  }

  .search-icon {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .search-input:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .search-input:focus:not(:focus-visible) {
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .file-tree {
    /* `flex: 0 1 auto` lets the tree shrink to its content height when
       the vault has few files, while still scrolling internally if it
       would otherwise overflow the panel. `min-height: 0` is required
       for an `overflow-y: auto` child of a flex column. */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
    transition: box-shadow 0.08s ease, background-color 0.08s ease;
  }

  /* E.12 — when reorder is disabled (sort != none or search active), each
     row no longer carries a 12 px drag-handle. Shift the whole list in by
     12 px so the text x-position matches the non-sorted state. */
  .file-tree.sort-active {
    padding-left: 12px;
  }

  /* In the docked state, leave an extra row of breathing room below the
     last file so the tree doesn't sit flush against the inner panel's
     bottom edge. The floating popout has its own bottom chrome, so the
     extra padding is unwanted there. */
  .vault-sidebar:not(.embedded) .file-tree {
    padding-bottom: 28px;
  }

  .file-tree.root-drop-active {
    box-shadow: inset 0 0 0 2px var(--accent-primary, #3a86ff);
    background: rgba(58, 134, 255, 0.06);
  }

  /* Wrapper around the dnd-action zone. Default block layout so the
     library can compute its bounding box for hit-testing; visual flow is
     unchanged (file rows still stack vertically). */
  .root-dnd-zone {
    display: block;
  }

  .tree-message {
    padding: 16px 12px;
    color: var(--text-tertiary);
    font-size: var(--font-size-base);
    text-align: center;
    margin: 0;
  }

  .vault-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
  }

  .empty-text {
    color: var(--text-tertiary);
    font-size: var(--font-size-base);
    margin: 0;
  }

  .open-vault-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .open-vault-btn:hover {
    background: var(--ui-surface-hover);
  }

  /* Drag handle along the sidebar's right edge. Rendered as a top-level
     fixed-position sibling (not a child of `.vault-sidebar`) so it doesn't
     inherit the sidebar's `pointer-events: none`. Mirrors
     SplitPaneContainer's gutter visually.

     Height is set inline from a ResizeObserver on `.sidebar-inner` so the
     gutter shrinks with the actual panel (which is shrink-to-content) and
     doesn't dangle into the empty chrome gap below a sparse vault. */
  .vault-resize-gutter {
    position: fixed;
    top: var(--global-toolbar-height, 44px);
    width: 6px;
    cursor: col-resize;
    background: transparent;
    pointer-events: auto;
    touch-action: none;
    transition: background-color 0.1s ease;
  }

  .vault-resize-gutter:hover,
  .vault-resize-gutter.dragging {
    background: var(--accent-primary);
  }

  /* Sidebar TagEditor host. Overlay catches click-outside; the anchor div
     positions the popup at the requested x/y. z-index is set inline so the
     sidebar z-index constant is the single source of truth. */
  .file-tag-overlay {
    position: fixed;
    inset: 0;
  }
</style>
