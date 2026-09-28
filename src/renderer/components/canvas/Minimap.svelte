<script lang="ts">
  /**
   * Minimap — scaled-down overview of the canvas with viewport indicator,
   * radar pips for active media, and waypoint navigation.
   *
   * Layout: waypoints list on the LEFT, map graphic on the RIGHT.
   * Dimensions scale with window size (20% of viewport, clamped min/max).
   * The map shows a local window around the viewport (`computeMinimapWindow`),
   * so it scales with zoom and a far-away tile can't shrink it to dots.
   * Its fill is a shade of the board background, and the viewport box's
   * stroke is light or dark to match.
   * Tile pips use headerColor with fallback. Active media uses mm-pulse-anim ripple.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { effectiveTileHeaderColor } from '../../lib/styles/effectiveStyle';
  import { computeTilesAABB, computeMinimapWindow, isFiniteTile } from '../../lib/canvas/minimapBounds';
  import { contrastShade, getDynamicContrastText, resolveBackgroundColor } from '../../lib/utils/color';
  import { themeStore } from '../../stores/theme.svelte';
  import { recordingTiles } from '../../stores/tiles.svelte';

  interface Props {
    /** The board's resolved background colour; empty means the theme's `--canvas-bg`. */
    bgColor?: string;
  }

  let { bgColor = '' }: Props = $props();

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasStore = scope.canvas;

  const MIN_MAP_W = 180;
  const MAX_MAP_W = 400;
  const MIN_MAP_H = 120;
  const MAX_MAP_H = 260;
  const MAP_FRACTION = 0.2; // 20% of viewport

  // Per-project minimap scale (Project Settings → General → Minimap).
  // Multiplies both the clamp bounds and the viewport fraction so the
  // entire size envelope scales — not just one limit.
  let minimapScale = $derived(vaultStore.project?.settings?.general?.minimapScale ?? 1);

  // Responsive map dimensions derived from viewport size, scaled.
  let mapW = $derived(
    Math.min(MAX_MAP_W * minimapScale, Math.max(MIN_MAP_W * minimapScale, canvasStore.viewportWidth * MAP_FRACTION * minimapScale))
  );
  let mapH = $derived(
    Math.min(MAX_MAP_H * minimapScale, Math.max(MIN_MAP_H * minimapScale, canvasStore.viewportHeight * MAP_FRACTION * minimapScale))
  );

  let waypoints = $derived(
    boardStore.current?.type === 'mindmap' ? boardStore.current.waypoints : [],
  );
  let showWaypointPanel = $derived(canvasStore.waypointsVisible);
  let effectiveMapW = $derived(mapW);

  let allTiles = $derived(boardStore.tiles);

  // Radar toggle (Settings > General > Minimap Radar). Defaults on.
  let radarEnabled = $derived(vaultStore.project?.settings.general.radarEnabled ?? true);

  // Active media tiles for radar pips — empty when the radar is disabled so
  // the pulse animation (and surrounding ring) never renders.
  let activeMediaIds = $derived.by(() => {
    if (!radarEnabled) return new Set<string>();
    return new Set(
      Object.values(allTiles)
        .filter((t) =>
          (t.type === 'video' && t.isPlaying) ||
          (t.type === 'audio' && (t.isPlaying || recordingTiles.has(t.id))) ||
          (t.type === 'timer' && t.isRunning)
        )
        .map((t) => t.id)
    );
  });

  /**
   * The all-tiles AABB is cached here, keyed on the tile set only
   * (it does NOT read `viewportRect`), so a pure pan/zoom doesn't re-walk every
   * tile. Recomputes only when a tile is added/removed/moved/resized.
   */
  let tilesAABB = $derived(computeTilesAABB(Object.values(allTiles)));

  /**
   * The canvas region drawn: a local window around the viewport, kept inside
   * the board. Reads `viewportRect` (so it re-runs on pan), but only does a
   * few min/max ops over the cached AABB.
   */
  let bounds = $derived(
    computeMinimapWindow(tilesAABB, canvasStore.viewportRect, effectiveMapW, mapH),
  );

  // Pips for finite tiles that overlap the window. The rest would be clipped
  // anyway, and skipping them keeps a big board's minimap cheap.
  let visibleTiles = $derived(
    Object.values(allTiles).filter(
      (t) =>
        isFiniteTile(t) &&
        t.position.x < bounds.maxX &&
        t.position.x + t.size.width > bounds.minX &&
        t.position.y < bounds.maxY &&
        t.position.y + t.size.height > bounds.minY,
    ),
  );

  // Colours follow the board background, including unsaved Settings edits.
  // Reading the theme ids re-resolves `--canvas-bg` after a theme switch: the
  // theme store applies the CSS variables before it updates them.
  let resolvedBg = $derived.by(() => {
    void themeStore.active;
    void themeStore.activeFileId;
    return resolveBackgroundColor(bgColor, '--canvas-bg');
  });
  let mapFill = $derived(contrastShade(resolvedBg));
  let viewportStroke = $derived(getDynamicContrastText(mapFill));

  // Scale to fit bounds uniformly inside the map area
  let mapScale = $derived(
    Math.min(effectiveMapW / bounds.w, mapH / bounds.h),
  );

  // Centering offset so content is centered in the map area
  let offsetX = $derived((effectiveMapW - bounds.w * mapScale) / 2);
  let offsetY = $derived((mapH - bounds.h * mapScale) / 2);

  // Convert canvas coord → minimap pixel
  function toMX(canvasX: number): number {
    return offsetX + (canvasX - bounds.minX) * mapScale;
  }
  function toMY(canvasY: number): number {
    return offsetY + (canvasY - bounds.minY) * mapScale;
  }

  // Viewport indicator rectangle
  let vpRect = $derived(canvasStore.viewportRect);
  let vRect = $derived({
    x: toMX(vpRect.left),
    y: toMY(vpRect.top),
    w: vpRect.width * mapScale,
    h: vpRect.height * mapScale,
  });

  /**
   * Click on minimap to navigate — reverse the offset + scale math
   * to find the canvas world coordinate, then center the camera.
   */
  function handleMapClick(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const canvasX = bounds.minX + (mx - offsetX) / mapScale;
    const canvasY = bounds.minY + (my - offsetY) / mapScale;

    // Center on clicked point, subtracting half viewport to place it in the middle
    canvasStore.centerOn(canvasX, canvasY);
  }

  let renamingWpId = $state<string | null>(null);
  let renameValue = $state('');

  /**
   * Navigate to a waypoint — animates camera (0.3s ease-out) to the waypoint's
   * stored position and zoom. Respects `prefers-reduced-motion`.
   */
  function gotoWaypoint(wp: { x: number; y: number; zoom?: number }) {
    const targetScale = wp.zoom ?? 1.0;
    canvasStore.flyTo({
      x: canvasStore.viewportWidth / 2 - wp.x * targetScale,
      y: canvasStore.viewportHeight / 2 - wp.y * targetScale,
      scale: targetScale,
    });
  }

  let renameOriginalName = '';
  function startRenameWaypoint(wp: { id: string; name: string }) {
    renamingWpId = wp.id;
    renameValue = wp.name;
    renameOriginalName = wp.name;
  }

  function commitRenameWaypoint() {
    if (renamingWpId && renameValue && renameValue !== renameOriginalName) {
      boardStore.renameWaypointWithHistory(renamingWpId, renameOriginalName, renameValue);
    }
    renamingWpId = null;
  }

  // ── Minimap waypoint drag ──
  let draggingWpId = $state<string | null>(null);
  let wpDragStartClient = { x: 0, y: 0 };
  let wpDragStartCanvas = { x: 0, y: 0 };
  let wpIsDragging = $state(false);

  function onWaypointPointerDown(e: PointerEvent, wp: { id: string; x: number; y: number; locked?: boolean }) {
    if (e.button !== 0 || wp.locked) return;
    e.stopPropagation();
    e.preventDefault();
    draggingWpId = wp.id;
    wpDragStartClient = { x: e.clientX, y: e.clientY };
    wpDragStartCanvas = { x: wp.x, y: wp.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onWaypointPointerMove(e: PointerEvent) {
    if (!draggingWpId || e.buttons !== 1) return;
    const dx = e.clientX - wpDragStartClient.x;
    const dy = e.clientY - wpDragStartClient.y;
    if (!wpIsDragging && Math.hypot(dx, dy) > 3) wpIsDragging = true;
    if (!wpIsDragging) return;
    e.stopPropagation();
    boardStore.moveWaypoint(
      draggingWpId,
      wpDragStartCanvas.x + dx / mapScale,
      wpDragStartCanvas.y + dy / mapScale,
    );
  }

  function onWaypointPointerUp() {
    // On drag end, commit the move through history so Ctrl+Z restores the
    // pre-drag position. The intermediate `moveWaypoint` calls in
    // onWaypointPointerMove are not history-tracked (they would otherwise
    // produce dozens of entries per drag).
    if (draggingWpId && wpIsDragging) {
      const wp = waypoints.find((w) => w.id === draggingWpId);
      if (wp) {
        boardStore.moveWaypointWithHistory(
          draggingWpId,
          { x: wpDragStartCanvas.x, y: wpDragStartCanvas.y },
          { x: wp.x, y: wp.y },
        );
      }
    }
    draggingWpId = null;
    wpIsDragging = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="minimap-container" style="z-index: var(--z-minimap)">

  <!-- Waypoint list (LEFT side) -->
  {#if showWaypointPanel}
    <div class="waypoint-panel">
      <div class="waypoint-header">Waypoints</div>
      {#if waypoints.length > 0}
        <div class="waypoint-list">
          {#each waypoints as wp (wp.id)}
            <div class="waypoint-item-row">
              {#if renamingWpId === wp.id}
                <input
                  class="waypoint-rename"
                  type="text"
                  size="1"
                  bind:value={renameValue}
                  onblur={commitRenameWaypoint}
                  onkeydown={(e) => { if (e.key === 'Enter') commitRenameWaypoint(); else if (e.key === 'Escape') { renamingWpId = null; } }}
                />
              {:else}
                <button
                  class="waypoint-item"
                  onclick={() => gotoWaypoint(wp)}
                  ondblclick={() => startRenameWaypoint(wp)}
                  title="Navigate to {wp.name} (double-click to rename)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                    <circle cx="12" cy="9" r="2.5"/>
                  </svg>
                  <span class="waypoint-name">{wp.name}</span>
                </button>
              {/if}
              <button
                class="waypoint-lock"
                class:locked={wp.locked}
                onclick={() => boardStore.toggleWaypointLockWithHistory(wp.id)}
                title={wp.locked ? 'Unlock waypoint' : 'Lock waypoint position'}
                aria-label={wp.locked ? 'Unlock ' + wp.name : 'Lock ' + wp.name}
              >
                {#if wp.locked}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                    <path d="M18 10h-1V7a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-7H9V7a3 3 0 0 1 6 0v3z"/>
                  </svg>
                {:else}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                  </svg>
                {/if}
              </button>
              <button
                class="waypoint-delete"
                onclick={() => boardStore.removeWaypointWithHistory(wp)}
                title="Delete waypoint"
                aria-label="Delete {wp.name}"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="waypoint-empty">No waypoints yet</div>
      {/if}
    </div>
  {/if}

  <!-- Map graphic (RIGHT side) -->
  <div
    class="minimap"
    onclick={handleMapClick}
    style="width: {effectiveMapW}px; height: {mapH}px; background: {mapFill}; --mm-viewport-stroke: {viewportStroke};"
  >
    <!-- Tile pips. Re-resolve each tile via `getTile()` so a stale entry that
         the proxy hasn't yet finished evicting cannot leave a ghost pip.
         Route headerColor through the full cascade so board/global defaults
         show up in the minimap pips, not just per-tile overrides. -->
    {#each visibleTiles.filter((t) => boardStore.getTile(t.id)) as tile (tile.id)}
      {@const isActive = activeMediaIds.has(tile.id)}
      {@const headerColor = effectiveTileHeaderColor(tile, vaultStore.project?.settings, boardStore.current)}
      <div
        class="minimap-pip"
        class:mm-active-media={isActive}
        style="
          left: {toMX(tile.position.x)}px;
          top: {toMY(tile.position.y)}px;
          width: {Math.max(4, tile.size.width * mapScale)}px;
          height: {Math.max(3, tile.size.height * mapScale)}px;
          background: {headerColor || 'var(--tile-header-bg)'};
        "
      >
        {#if isActive}
          <div class="mm-pulse-ring"></div>
        {/if}
      </div>
    {/each}

    <!-- Waypoint pips. Gated by the same toggle as the canvas markers and
         the side panel so "Hide Waypoints" hides waypoints everywhere. -->
    {#if canvasStore.waypointsVisible}
      {#each waypoints.filter((w) => Number.isFinite(w.x) && Number.isFinite(w.y)) as wp (wp.id)}
        <div
          class="minimap-waypoint-pip"
          class:wp-dragging={wpIsDragging && draggingWpId === wp.id}
          class:wp-locked={wp.locked}
          style="left: {toMX(wp.x) - 6}px; top: {toMY(wp.y) - 6}px;"
          title={wp.locked ? wp.name + ' (locked)' : wp.name + ' (drag to reposition)'}
          onpointerdown={(e) => onWaypointPointerDown(e, wp)}
          onpointermove={onWaypointPointerMove}
          onpointerup={onWaypointPointerUp}
          onpointercancel={onWaypointPointerUp}
        >
          <span class="minimap-waypoint-icon" aria-hidden="true">
            {#if wp.icon}
              {wp.icon}
            {:else}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/>
              </svg>
            {/if}
          </span>
        </div>
      {/each}
    {/if}

    <!-- Viewport indicator -->
    <div
      class="minimap-viewport"
      style="
        left: {vRect.x}px;
        top: {vRect.y}px;
        width: {Math.max(10, vRect.w)}px;
        height: {Math.max(8, vRect.h)}px;
      "
    ></div>
  </div>
</div>

<style>
  .minimap-container {
    position: fixed;
    bottom: 52px;
    right: 64px; /* clear SideToolbar (~48px wide + gap) */
    display: flex;
    flex-direction: row;
    gap: 8px;
    pointer-events: auto;
  }

  .minimap {
    position: relative;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    box-shadow: var(--ui-shadow);
    opacity: 0.92;
    transition: opacity 0.15s ease;
  }

  .minimap:hover {
    opacity: 1;
  }

  /* ── Tile pips ── */
  .minimap-pip {
    position: absolute;
    border-radius: 1px;
    opacity: 0.75;
    pointer-events: none;
  }

  .minimap-pip.mm-active-media {
    opacity: 1;
    z-index: 1;
  }

  /* Expanding ripple ring on active media pips */
  .mm-pulse-ring {
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid var(--accent-primary);
    animation: mm-pulse-anim 1.5s infinite ease-out;
    pointer-events: none;
  }

  /* ── Waypoint pips ── */
  .minimap-waypoint-pip {
    position: absolute;
    width: 12px;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    cursor: grab;
    z-index: 2;
  }

  .minimap-waypoint-pip.wp-dragging {
    cursor: grabbing;
  }

  .minimap-waypoint-pip.wp-locked {
    cursor: default;
  }

  .minimap-waypoint-icon {
    font-size: 10px;
    line-height: 1;
    color: var(--accent-primary, #d04444);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.5));
  }

  .minimap-waypoint-icon svg {
    display: block;
  }

  /* ── Viewport indicator ── */
  .minimap-viewport {
    position: absolute;
    border: 2px solid var(--mm-viewport-stroke);
    background: color-mix(in srgb, var(--mm-viewport-stroke) 12%, transparent);
    border-radius: 2px;
    pointer-events: none;
  }

  /* ── Waypoint panel (left side) ── */
  .waypoint-panel {
    width: 170px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: var(--ui-shadow);
    overflow: hidden;
  }

  .waypoint-header {
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-system);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .waypoint-list {
    padding: 4px;
    max-height: 220px;
    overflow-y: auto;
    flex: 1;
    /* min-height: 0 lets the flex item honour max-height (without it,
       min-height: auto pins the list to its content height and the panel
       grows past 220px).

       scrollbar-gutter: stable is the authoritative space-reserver — it
       reserves the gutter at all times so the lock/delete buttons sit to
       the LEFT of it whether the scrollbar is currently visible or not,
       which prevents the overlay-scrollbar overlap on modern Chromium
       (where ::-webkit-scrollbar alone may not reserve width). The webkit
       rule below is now purely cosmetic (thin thumb styling). */
    min-height: 0;
    scrollbar-gutter: stable;
  }

  .waypoint-list::-webkit-scrollbar {
    width: 6px;
  }
  .waypoint-list::-webkit-scrollbar-thumb {
    background: var(--ui-border);
    border-radius: 3px;
  }
  .waypoint-list::-webkit-scrollbar-thumb:hover {
    background: var(--text-tertiary);
  }
  .waypoint-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .waypoint-item-row {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }

  .waypoint-item {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    padding: 4px 8px;
    border: none;
    background: transparent;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-system);
    color: var(--text-secondary);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }

  .waypoint-item:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .waypoint-rename {
    flex: 1;
    /* min-width: 0 + box-sizing: border-box let the input shrink inside
       the row instead of forcing horizontal overflow (inputs default to
       min-width: auto, sized by the `size` attribute). */
    min-width: 0;
    box-sizing: border-box;
    padding: 2px 6px;
    border: 1px solid var(--ui-border-focus);
    border-radius: 3px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 11px;
    font-family: var(--font-system);
  }

  .waypoint-rename:focus:not(:focus-visible) {
    outline: none;
  }

  .waypoint-lock {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
  }

  .waypoint-item-row:hover .waypoint-lock {
    opacity: 1;
  }

  .waypoint-lock.locked {
    opacity: 1;
    color: var(--accent-primary);
  }

  .waypoint-lock:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .waypoint-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease;
  }

  .waypoint-item-row:hover .waypoint-delete {
    opacity: 1;
  }

  .waypoint-delete:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .waypoint-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 110px;
  }

  .waypoint-empty {
    padding: 12px 10px;
    font-size: 11px;
    font-family: var(--font-system);
    color: var(--text-tertiary);
    text-align: center;
    flex: 1;
  }

</style>
