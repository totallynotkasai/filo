<script lang="ts">
  /**
   * SideToolbar — Mind Map board-specific tools.
   * Floats on the right side of the board.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';
  import { uiStore } from '../../stores/ui.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasStore = scope.canvas;
  const selectionStore = scope.selection;
  import { createId } from '../../lib/utils/ids';
  import type { Tile } from '../../schema/index';
  import { TILE_DEFAULTS, FRAME_DEFAULTS, defaultTileStyleSnapshot, defaultFrameStyleSnapshot } from '../../constants/defaults';
  import { alignTiles, layoutTree, layoutRadial, type AlignMode } from '../../lib/canvas/layout';
  import { historyStore } from '../../stores/history.svelte';
  import { ToggleFadeCommand } from '../../commands/index';

  let showNewTileMenu = $state(false);
  let showManageMenu = $state(false);
  let showViewMenu = $state(false);
  let anyMenuOpen = $derived(showNewTileMenu || showManageMenu || showViewMenu);

  // Root element + the button that opened the active menu. Used for
  // click-outside dismissal and focus restoration on Escape, matching the
  // ContextMenu accessibility pattern.
  let toolbarEl = $state<HTMLElement | null>(null);
  let lastTrigger: HTMLElement | null = null;

  // ── Drag state for movable toolbar ──
  let isDragging = $state(false);
  let dragPosition = $state<{ x: number; y: number } | null>(null);
  let dragOffset = $state({ x: 0, y: 0 });

  function onDragStart(e: PointerEvent) {
    // Only drag on left-click directly on the toolbar background, not on buttons/dropdowns
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.side-btn, .side-dropdown, .toolbar-group')) return;

    isDragging = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    // Clamp to viewport bounds
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
  }

  let positionStyle = $derived(
    dragPosition
      ? `left: ${dragPosition.x}px; top: ${dragPosition.y}px; right: auto; transform: none;`
      : ''
  );

  let inConnectionMode = $derived(connectionsStore.connectionMode);

  const tileTypes = [
    { type: 'text', label: 'Text', icon: 'M4 6h16M4 12h10M4 18h14' },
    { type: 'audio', label: 'Audio', icon: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8' },
    { type: 'link', label: 'Link', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
    { type: 'iframe', label: 'Embed', icon: 'M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16' },
    { type: 'timer', label: 'Timer', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2' },
  ] as const;

  function createTile(tileType: string) {
    showNewTileMenu = false;

    const vp = canvasStore.viewportRect;
    const jitterX = (Math.random() - 0.5) * 100;
    const jitterY = (Math.random() - 0.5) * 100;
    const centerX = vp.left + vp.width / 2 - TILE_DEFAULTS.width / 2 + jitterX;
    const centerY = vp.top + vp.height / 2 - TILE_DEFAULTS.height / 2 + jitterY;
    const now = Date.now();
    const tileDefs = vaultStore.project?.settings?.mindmap?.tile;

    const baseTile = {
      id: createId(),
      title: boardStore.getNextTileName(),
      position: { x: centerX, y: centerY },
      size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
      style: {
        ...defaultTileStyleSnapshot(),
        ...(tileDefs?.headerColor != null && { headerColor: tileDefs.headerColor }),
        ...(tileDefs?.bodyColor != null && { bodyColor: tileDefs.bodyColor }),
        ...(tileDefs?.borderColor != null && { borderColor: tileDefs.borderColor }),
        ...(tileDefs?.shape != null && { shape: tileDefs.shape }),
        ...(tileDefs?.borderStyle != null && { borderStyle: tileDefs.borderStyle }),
        ...(tileDefs?.borderWidth != null && { borderWidth: tileDefs.borderWidth }),
        ...(tileDefs?.shadowIntensity != null && { shadowIntensity: tileDefs.shadowIntensity }),
      },
      locked: false,
      faded: false,
      tags: [],
      boardId: boardStore.current?.id ?? '',
      createdAt: now,
      updatedAt: now,
    };

    let tile: Tile;

    switch (tileType) {
      case 'text':
        tile = { ...baseTile, type: 'text', contentId: createId(), content: '' } as Tile;
        break;
      case 'image':
        tile = { ...baseTile, type: 'image', src: '' } as Tile;
        break;
      case 'video':
        tile = { ...baseTile, type: 'video', src: '', isPlaying: false } as Tile;
        break;
      case 'file':
        tile = { ...baseTile, type: 'file', filePath: '', fileName: '', fileExtension: '' } as Tile;
        break;
      case 'audio':
        tile = { ...baseTile, type: 'audio', src: '', isRecording: false, isPlaying: false } as Tile;
        break;
      case 'link':
        tile = { ...baseTile, type: 'link', url: '' } as Tile;
        break;
      case 'iframe':
        tile = { ...baseTile, type: 'iframe', url: '' } as Tile;
        break;
      case 'timer':
        tile = { ...baseTile, type: 'timer', duration: 0, remaining: 0, mode: 'hms', isRunning: false } as Tile;
        break;
      default:
        tile = { ...baseTile, type: 'text', contentId: createId(), content: '' } as Tile;
    }

    boardStore.addTileWithHistory(tile);
  }

  function createFrame() {
    closeAllMenus();
    const vp = canvasStore.viewportRect;
    const jitterX = (Math.random() - 0.5) * 100;
    const jitterY = (Math.random() - 0.5) * 100;
    const centerX = vp.left + vp.width / 2 - FRAME_DEFAULTS.width / 2 + jitterX;
    const centerY = vp.top + vp.height / 2 - FRAME_DEFAULTS.height / 2 + jitterY;
    const now = Date.now();

    boardStore.addFrameWithHistory({
      id: createId(),
      boardId: boardStore.current?.id ?? '',
      title: 'Frame',
      position: { x: centerX, y: centerY },
      size: { width: FRAME_DEFAULTS.width, height: FRAME_DEFAULTS.height },
      style: {
        ...defaultFrameStyleSnapshot(),
        ...(vaultStore.project?.settings?.mindmap?.frame?.headerColor != null && {
          headerColor: vaultStore.project.settings.mindmap.frame.headerColor,
        }),
        ...(vaultStore.project?.settings?.mindmap?.frame?.borderColor != null && {
          borderColor: vaultStore.project.settings.mindmap.frame.borderColor,
        }),
        ...(vaultStore.project?.settings?.mindmap?.frame?.borderStyle != null && {
          borderStyle: vaultStore.project.settings.mindmap.frame.borderStyle,
        }),
        ...(vaultStore.project?.settings?.mindmap?.frame?.borderWidth != null && {
          borderWidth: vaultStore.project.settings.mindmap.frame.borderWidth,
        }),
        ...(vaultStore.project?.settings?.general?.defaultBoardFontSize?.frameTitle !== undefined && {
          fontSizeTitle: vaultStore.project.settings.general.defaultBoardFontSize.frameTitle,
        }),
      },
      collapsed: false,
      tileIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function closeAllMenus() {
    showNewTileMenu = false;
    showManageMenu = false;
    showViewMenu = false;
    lastTrigger = null;
  }

  function toggleMenu(menu: 'new' | 'manage' | 'view', trigger?: HTMLElement) {
    const wasOpen = menu === 'new' ? showNewTileMenu : menu === 'manage' ? showManageMenu : showViewMenu;
    closeAllMenus();
    if (!wasOpen) {
      if (menu === 'new') showNewTileMenu = true;
      else if (menu === 'manage') showManageMenu = true;
      else showViewMenu = true;
      lastTrigger = trigger ?? null;
      // WAI-ARIA menu-button pattern: move focus to the first item on open so
      // arrow-key navigation has a starting point.
      requestAnimationFrame(() => {
        toolbarEl?.querySelector<HTMLButtonElement>('.side-dropdown .dropdown-item')?.focus();
      });
    }
  }

  // Escape closes the active menu and returns focus to the button that opened
  // it. Click/pointer outside the toolbar dismisses without moving focus.
  function handleWindowKeydown(e: KeyboardEvent) {
    if (!anyMenuOpen || e.key !== 'Escape') return;
    e.preventDefault();
    const trigger = lastTrigger;
    closeAllMenus();
    trigger?.focus();
  }

  function handleWindowPointerDown(e: PointerEvent) {
    if (!anyMenuOpen) return;
    const target = e.target as Node | null;
    if (toolbarEl && target && !toolbarEl.contains(target)) closeAllMenus();
  }

  // Arrow/Home/End navigation within the currently-open dropdown. Scoped to the
  // dropdown via its onkeydown so it only fires while focus is inside the menu.
  function handleMenuKeydown(e: KeyboardEvent) {
    const menuEl = e.currentTarget as HTMLElement;
    const items = Array.from(menuEl.querySelectorAll<HTMLButtonElement>('.dropdown-item'));
    if (items.length === 0) return;
    const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        items[currentIdx < 0 ? 0 : (currentIdx + 1) % items.length]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        items[currentIdx < 0 ? items.length - 1 : (currentIdx - 1 + items.length) % items.length]?.focus();
        break;
      }
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
    }
  }

  // Align helpers
  function alignSelected(mode: AlignMode) {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length < 2) return;
    const positionMap = alignTiles(boardStore.tiles, ids, mode);
    if (positionMap.size === 0) {
      if ((mode === 'distribute-h' || mode === 'distribute-v') && ids.length < 3) {
        uiStore.toast('Select 3+ tiles to distribute', 'info', 1500);
      }
      return;
    }
    boardStore.alignTilesWithHistory(positionMap);
  }

  // ── Group / Ungroup selected tiles ──
  function toggleGroupSelected() {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length < 2) { uiStore.toast('Select 2+ tiles to group', 'info', 1500); return; }
    // If all selected are in the same group, ungroup; otherwise group
    const group = boardStore.getGroupForTile(ids[0]);
    const allInSameGroup = group && ids.every(id => boardStore.getGroupForTile(id)?.id === group.id);
    const groupsBefore = [...boardStore.groups];
    if (allInSameGroup) {
      boardStore.ungroupTilesWithHistory(ids, groupsBefore);
      uiStore.toast('Tiles ungrouped', 'info', 1500);
    } else {
      boardStore.groupTilesWithHistory(ids, groupsBefore);
      uiStore.toast('Tiles grouped', 'info', 1500);
    }
  }

  // ── Fade / Unfade selected tiles ──
  function toggleFadeSelected() {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length === 0) { uiStore.toast('Select tiles first', 'info', 1500); return; }
    const tiles = ids.map(id => boardStore.getTile(id)).filter(Boolean) as Tile[];
    // If any are not faded, fade all; otherwise unfade all. Phase 7 / 7.7 —
    // route through ToggleFadeCommand so Ctrl+Z reverses the mixed change.
    const anyNotFaded = tiles.some(t => !t.faded);
    historyStore.execute(
      new ToggleFadeCommand(
        tiles.map((t) => t.id),
        anyNotFaded,
        `${anyNotFaded ? 'Fade' : 'Unfade'} ${tiles.length} tile(s)`,
      ),
    );
  }

  // ── Align Tree (Horizontal — top-to-bottom) ──
  function alignTreeH() {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length < 2) { uiStore.toast('Select 2+ tiles', 'info', 1500); return; }
    const positionMap = layoutTree(boardStore.tiles, boardStore.connections, ids, 'horizontal');
    if (positionMap.size === 0) return;
    boardStore.layoutTilesWithHistory(positionMap, 'Tree layout (horizontal)');
  }

  // ── Align Tree (Vertical — left-to-right) ──
  function alignTreeV() {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length < 2) { uiStore.toast('Select 2+ tiles', 'info', 1500); return; }
    const positionMap = layoutTree(boardStore.tiles, boardStore.connections, ids, 'vertical');
    if (positionMap.size === 0) return;
    boardStore.layoutTilesWithHistory(positionMap, 'Tree layout (vertical)');
  }

  // ── Align Radial ──
  function alignRadial() {
    closeAllMenus();
    const ids = [...selectionStore.selectedIds];
    if (ids.length < 2) { uiStore.toast('Select 2+ tiles', 'info', 1500); return; }
    const positionMap = layoutRadial(boardStore.tiles, ids);
    if (positionMap.size === 0) return;
    boardStore.layoutTilesWithHistory(positionMap, 'Radial layout');
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} onpointerdown={handleWindowPointerDown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="side-toolbar"
  class:dragging={isDragging}
  style="z-index: var(--z-side-toolbar); {positionStyle}"
  bind:this={toolbarEl}
  onpointerdown={onDragStart}
  onpointermove={onDragMove}
  onpointerup={onDragEnd}
  onclick={(e) => e.stopPropagation()}
>

  <!-- New Tile -->
  <div class="toolbar-group">
    <button
      class="side-btn"
      title="New Tile (Ctrl+N)"
      aria-haspopup="true"
      aria-expanded={showNewTileMenu}
      onclick={(e) => toggleMenu('new', e.currentTarget)}
      class:active={showNewTileMenu}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>

    {#if showNewTileMenu}
      <div class="side-dropdown" role="menu" tabindex="-1" onkeydown={handleMenuKeydown}>
        {#each tileTypes as tt (tt.type)}
          <button class="dropdown-item" role="menuitem" onclick={() => createTile(tt.type)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={tt.icon}/>
            </svg>
            <span>{tt.label}</span>
          </button>
        {/each}
        <div class="dropdown-divider" role="separator"></div>
        <button class="dropdown-item" role="menuitem" onclick={createFrame}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="2" width="20" height="20" rx="2"/>
            <line x1="2" y1="8" x2="22" y2="8"/>
          </svg>
          <span>Frame</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Connections Mode -->
  <button
    class="side-btn"
    title="Connections Mode"
    class:active={inConnectionMode}
    onclick={() => { closeAllMenus(); connectionsStore.toggleConnectionMode(); }}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8.59 13.51l6.83-3.02"/>
    </svg>
  </button>

  <!-- Manage Tiles -->
  <div class="toolbar-group">
    <button
      class="side-btn"
      title="Manage Tiles"
      aria-haspopup="true"
      aria-expanded={showManageMenu}
      onclick={(e) => toggleMenu('manage', e.currentTarget)}
      class:active={showManageMenu}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
      </svg>
    </button>

    {#if showManageMenu}
      <div class="side-dropdown" role="menu" tabindex="-1" onkeydown={handleMenuKeydown}>
        <button
          class="dropdown-item"
          role="menuitemcheckbox"
          class:toggle-active={canvasStore.snapEnabled}
          aria-checked={canvasStore.snapEnabled}
          onclick={() => { canvasStore.toggleSnap(); closeAllMenus(); }}
        >
          <span>Snap Tiles</span>
        </button>
        <button class="dropdown-item" role="menuitem" onclick={toggleGroupSelected}>
          <span>Group / Ungroup</span>
        </button>
        <button class="dropdown-item" role="menuitem" onclick={toggleFadeSelected}>
          <span>Fade / Unfade</span>
        </button>
        <div class="dropdown-divider" role="separator"></div>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('left')}><span>Align Left</span></button>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('right')}><span>Align Right</span></button>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('top')}><span>Align Top</span></button>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('bottom')}><span>Align Bottom</span></button>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('distribute-h')}><span>Distribute Horizontally</span></button>
        <button class="dropdown-item" role="menuitem" onclick={() => alignSelected('distribute-v')}><span>Distribute Vertically</span></button>
        <div class="dropdown-divider" role="separator"></div>
        <button class="dropdown-item" role="menuitem" onclick={alignTreeH}><span>Align Tree (H)</span></button>
        <button class="dropdown-item" role="menuitem" onclick={alignTreeV}><span>Align Tree (V)</span></button>
        <button class="dropdown-item" role="menuitem" onclick={alignRadial}><span>Align Radial</span></button>
      </div>
    {/if}
  </div>

  <!-- View -->
  <div class="toolbar-group">
    <button
      class="side-btn"
      title="View"
      aria-haspopup="true"
      aria-expanded={showViewMenu}
      onclick={(e) => toggleMenu('view', e.currentTarget)}
      class:active={showViewMenu}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>

    {#if showViewMenu}
      <div class="side-dropdown" role="menu" tabindex="-1" onkeydown={handleMenuKeydown}>
        <button class="dropdown-item" role="menuitem" onclick={() => { uiStore.openModal('tags-browser'); closeAllMenus(); }}>
          <span>Tags Browser</span>
        </button>
        <button class="dropdown-item" role="menuitem" onclick={() => { uiStore.openModal('orphan-catcher'); closeAllMenus(); }}>
          <span>Orphan Catcher</span>
        </button>
        <div class="dropdown-divider" role="separator"></div>
        <button
          class="dropdown-item"
          role="menuitemcheckbox"
          class:toggle-active={connectionsStore.hideAllPaths}
          aria-checked={connectionsStore.hideAllPaths}
          onclick={() => { connectionsStore.toggleHidePaths(); }}
        >
          <span class="check-slot" aria-hidden="true">
            {#if connectionsStore.hideAllPaths}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </span>
          <span>Hide Connection Paths</span>
        </button>
        <button
          class="dropdown-item"
          role="menuitemcheckbox"
          class:toggle-active={connectionsStore.hideAllLabels}
          aria-checked={connectionsStore.hideAllLabels}
          onclick={() => { connectionsStore.toggleHideLabels(); }}
        >
          <span class="check-slot" aria-hidden="true">
            {#if connectionsStore.hideAllLabels}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </span>
          <span>Hide Connection Labels</span>
        </button>
        <button
          class="dropdown-item"
          role="menuitemcheckbox"
          class:toggle-active={!canvasStore.waypointsVisible}
          aria-checked={!canvasStore.waypointsVisible}
          onclick={() => { canvasStore.toggleWaypointsVisible(); }}
        >
          <span class="check-slot" aria-hidden="true">
            {#if !canvasStore.waypointsVisible}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </span>
          <span>Hide Waypoints</span>
        </button>
        <button
          class="dropdown-item"
          role="menuitemcheckbox"
          class:toggle-active={canvasStore.semanticZoomEnabled}
          aria-checked={canvasStore.semanticZoomEnabled}
          onclick={() => { boardStore.toggleSemanticZoom(); }}
        >
          <span class="check-slot" aria-hidden="true">
            {#if canvasStore.semanticZoomEnabled}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </span>
          <span>Semantic Zoom (LOD)</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Toggle Minimap -->
  <button
    class="side-btn"
    title="Toggle Minimap"
    class:active={canvasStore.minimapVisible}
    onclick={() => canvasStore.toggleMinimap()}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  </button>

  <!-- Help -->
  <button
    class="side-btn"
    title="Help"
    onclick={() => uiStore.openModal('keyboard-shortcuts')}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  </button>
</div>

<style>
  .side-toolbar {
    position: fixed;
    right: 12px;
    top: calc(var(--global-toolbar-height, 44px) + 12px);
    display: flex;
    flex-direction: column;
    gap: calc(4px * var(--ui-board-toolbar-scale, 1));
    padding: 8px 6px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow);
    cursor: grab;
    touch-action: none;
  }

  .side-toolbar.dragging {
    cursor: grabbing;
    opacity: 0.9;
  }

  .toolbar-group {
    position: relative;
  }

  .side-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(36px * var(--ui-board-toolbar-scale, 1));
    height: calc(36px * var(--ui-board-toolbar-scale, 1));
    border-radius: 8px;
    color: var(--text-secondary);
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .side-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .side-btn.active {
    background: var(--ui-surface-active);
    color: var(--accent-primary);
  }

  .side-dropdown {
    position: absolute;
    right: 100%;
    top: 0;
    margin-right: 8px;
    min-width: 180px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    padding: 4px 0;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.15s ease;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    transition: background-color 0.1s ease;
  }

  .dropdown-item:hover {
    background: var(--ui-surface-hover);
  }

  .dropdown-item.toggle-active {
    color: var(--accent-primary);
  }

  .dropdown-item .check-slot {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent-primary);
  }

  .dropdown-divider {
    height: 1px;
    margin: 4px 0;
    background: var(--ui-border-light);
  }
</style>
