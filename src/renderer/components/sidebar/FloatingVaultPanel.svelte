<script lang="ts">
  /**
   * In-app floating wrapper for the vault sidebar. Replaces the legacy
   * "pop out into a second BrowserWindow" feature with a draggable,
   * resizable panel rendered inside the main window — so the vault
   * persists across tab/board switches without involving Electron.
   *
   * Geometry (x/y/width/height) is held in `uiStore.floatingBounds` and
   * persisted per-machine via `sidebar:set-state`. There is no separate
   * panel header: the embedded `VaultSidebar`'s own `.sidebar-header`
   * doubles as the drag handle (via `dragHandlers`), and its
   * `.sidebar-actions` row carries the "Dock back" button — which flips
   * `uiStore.sidebarFloating` to false and brings AppShell back to the
   * docked `<VaultSidebar />` column.
   */
  import VaultSidebar from './VaultSidebar.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { onMount } from 'svelte';

  // Local copies of bounds — updated live during drag/resize, written
  // back to `uiStore.setFloatingBounds` on each pointermove so the
  // debounced disk-write fires at the end of the gesture.
  let bx = $state(uiStore.floatingBounds.x);
  let by = $state(uiStore.floatingBounds.y);
  let bw = $state(uiStore.floatingBounds.width);
  let bh = $state(uiStore.floatingBounds.height);

  // Reseed local state if the store changes from elsewhere (e.g. another
  // panel snapping it back into view on startup).
  $effect(() => {
    bx = uiStore.floatingBounds.x;
    by = uiStore.floatingBounds.y;
    bw = uiStore.floatingBounds.width;
    bh = uiStore.floatingBounds.height;
  });

  // Clamp panel so the header strip stays on-screen and the panel never
  // grows past the viewport. The toolbar/tabbar CSS variables read at
  // call time so the clamp adapts to scale-factor changes.
  function readChromeHeights(): { top: number; bottom: number } {
    const cs = getComputedStyle(document.documentElement);
    const top = parseInt(cs.getPropertyValue('--global-toolbar-height')) || 44;
    const bottom = parseInt(cs.getPropertyValue('--tabbar-height')) || 36;
    return { top, bottom };
  }

  function clamp(x: number, y: number, w: number, h: number) {
    const { top, bottom } = readChromeHeights();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampedW = Math.max(220, Math.min(w, vw - 16));
    const clampedH = Math.max(240, Math.min(h, vh - top - bottom - 16));
    // Keep at least 80px of the header strip on-screen and never let
    // the top slip above the toolbar.
    const clampedX = Math.max(8 - clampedW + 80, Math.min(x, vw - 80));
    const clampedY = Math.max(top + 4, Math.min(y, vh - bottom - 32));
    return { x: clampedX, y: clampedY, w: clampedW, h: clampedH };
  }

  // ── Drag (header strip) ──
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartBx = 0;
  let dragStartBy = 0;

  function onDragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartBx = bx;
    dragStartBy = by;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    e.preventDefault();
    const nx = dragStartBx + (e.clientX - dragStartX);
    const ny = dragStartBy + (e.clientY - dragStartY);
    const c = clamp(nx, ny, bw, bh);
    bx = c.x; by = c.y;
    uiStore.setFloatingBounds({ x: bx, y: by, width: bw, height: bh });
  }

  function onDragEnd(e: PointerEvent) {
    if (!isDragging) return;
    isDragging = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  // ── Resize (bottom-right corner) ──
  let isResizing = $state(false);
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;

  function onResizeStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = bw;
    resizeStartH = bh;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: PointerEvent) {
    if (!isResizing) return;
    e.preventDefault();
    const nw = resizeStartW + (e.clientX - resizeStartX);
    const nh = resizeStartH + (e.clientY - resizeStartY);
    const c = clamp(bx, by, nw, nh);
    bw = c.w; bh = c.h;
    uiStore.setFloatingBounds({ x: bx, y: by, width: bw, height: bh });
  }

  function onResizeEnd(e: PointerEvent) {
    if (!isResizing) return;
    isResizing = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  // Audit-14 5.8 — keyboard resize for the corner handle (was pointer-only).
  // Arrow keys nudge width/height; Shift takes a larger step. Clamped exactly
  // like the pointer path so it can't escape the viewport.
  function onResizeKeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    let nw = bw;
    let nh = bh;
    if (e.key === 'ArrowRight') nw += step;
    else if (e.key === 'ArrowLeft') nw -= step;
    else if (e.key === 'ArrowDown') nh += step;
    else if (e.key === 'ArrowUp') nh -= step;
    else return;
    e.preventDefault();
    const c = clamp(bx, by, nw, nh);
    bw = c.w;
    bh = c.h;
    uiStore.setFloatingBounds({ x: bx, y: by, width: bw, height: bh });
  }

  // Drag handlers passed down to the embedded `VaultSidebar` so its
  // `.sidebar-header` strip acts as the drag handle. Action buttons inside
  // that header stop pointerdown propagation to keep clicks working.
  const headerDragHandlers = {
    onPointerDown: onDragStart,
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: onDragEnd,
  };

  // Sprint B / B19 — clamp persisted bounds against the current viewport
  // on mount. Without this, a saved x=2400 from a multi-monitor desktop
  // session would mount the panel off-screen on a laptop with width
  // 1366. `clamp` already runs during every pointermove, but only after
  // the user starts a drag — the panel is invisible until then.
  onMount(() => {
    const c = clamp(bx, by, bw, bh);
    if (c.x !== bx || c.y !== by || c.w !== bw || c.h !== bh) {
      bx = c.x;
      by = c.y;
      bw = c.w;
      bh = c.h;
      uiStore.setFloatingBounds({ x: bx, y: by, width: bw, height: bh });
    }
  });
</script>

<!-- Audit-14 5.8 — `region` (labelled landmark), not `dialog`: this is a
     persistent, non-modal floating panel, not a modal dialog with a focus
     trap / Escape-to-close contract. -->
<div
  class="floating-vault-panel"
  style="left: {bx}px; top: {by}px; width: {bw}px; height: {bh}px; z-index: calc(var(--z-sidebar) + 2);"
  role="region"
  aria-label="Vault"
>
  <div class="floating-body">
    <!--
      Reuse the same sidebar markup that the docked column renders.
      The sidebar's own `.sidebar-header` doubles as the drag handle via
      `dragHandlers`, and its `.sidebar-actions` row carries the "Dock
      back" button (only when floating). That avoids a duplicate "Vault"
      title and keeps all vault controls in one place.
    -->
    <VaultSidebar open={true} role="main" dragHandlers={headerDragHandlers} />
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="floating-resize-handle"
    class:resizing={isResizing}
    onpointerdown={onResizeStart}
    onpointermove={onResizeMove}
    onpointerup={onResizeEnd}
    onpointercancel={onResizeEnd}
    onkeydown={onResizeKeydown}
    aria-label="Resize vault panel (arrow keys)"
    aria-orientation="vertical"
    role="separator"
    tabindex="0"
  ></div>
</div>

<style>
  .floating-vault-panel {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--sidebar-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.2));
    overflow: hidden;
  }

  /* Body hosts the VaultSidebar. Since VaultSidebar is itself `position:
     fixed`, we override that by neutralising the wrapper's positioning
     and re-targeting the slide-in transform — the floating panel is
     already always visible. `width: 100% !important` overrides the
     inline `width: {sidebarWidth}px` the docked mode applies, so the
     inner sidebar fills the floating panel's width and filenames stop
     truncating when the user resizes the panel wider. */
  .floating-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .floating-body :global(.vault-sidebar) {
    position: absolute;
    inset: 0;
    width: 100% !important;
    /* The docked-mode inline `z-index: var(--z-sidebar)` would otherwise
       layer the embedded sidebar on top of `.floating-resize-handle` in
       the same stacking context, swallowing pointer events on the
       bottom-right corner. Neutralise it here. */
    z-index: auto !important;
    transform: none !important;
    pointer-events: auto;
  }
  .floating-body :global(.vault-sidebar .sidebar-inner) {
    height: 100%;
    max-height: 100%;
    border-right: none;
    background: transparent;
    /* The docked-mode bottom border + rounded corners would stack with
       the floating panel's own border + radius, producing a visible
       doubled line. Neutralise them inside the floating panel. */
    border-bottom: none;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Hide the docked-mode external resize gutter inside the floating panel. */
  .floating-body :global(.vault-resize-gutter) {
    display: none;
  }

  .floating-resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background:
      linear-gradient(135deg, transparent 50%, var(--text-tertiary) 50%, var(--text-tertiary) 60%, transparent 60%, transparent 70%, var(--text-tertiary) 70%, var(--text-tertiary) 80%, transparent 80%);
    opacity: 0.4;
    transition: opacity 0.1s ease;
    touch-action: none;
  }
  .floating-resize-handle:hover,
  .floating-resize-handle.resizing { opacity: 1; }
</style>
