<script lang="ts">
  /**
   * Floating Table of Contents for the Task List Board.
   *
   * Modelled on FloatingVaultPanel: a position-fixed wrapper with a drag
   * handle (header strip) and a bottom-right resize handle. Geometry lives
   * on the board's settings.tocPanelBounds, so each Task List remembers its
   * own panel placement.
   *
   * Always rendered — when the board has no sections the body shows an
   * empty-state CTA that materialises a new section. Internally, when
   * sections exist, it embeds the existing TaskListToc body for jump-link
   * behaviour.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import TaskListToc from './TaskListToc.svelte';
  import { TOC_DEFAULTS, tocDefaultBounds } from '../../lib/tasklist/tocPlacement';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateBoardSettingsCommand } from '../../commands/index';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let {
    sections,
    scrollContainerEl,
    onAddSection,
  }: {
    sections: Array<{ id: string; title: string }>;
    scrollContainerEl: HTMLElement | undefined;
    onAddSection: () => void;
  } = $props();

  // Defaults sit just below the top-right corner, beside the list column
  // when it leaves room (`tocDefaultBounds`).

  function defaultBounds() {
    const list = scrollContainerEl?.querySelector('.tasklist-content');
    return tocDefaultBounds(window.innerWidth, list ? list.getBoundingClientRect().right : null);
  }

  // Read persisted bounds from the active board's settings. Computed
  // (not just snapshotted) so a board switch reseeds the geometry from the
  // new board's own settings, while a settings update on the current board
  // does NOT thrash local state mid-drag (the $effect below only reseeds
  // when the board identity itself changes).
  const persisted = $derived.by(() => {
    const s = boardStore.current?.settings as
      | { tocPanelBounds?: { x: number; y: number; width: number; height: number } }
      | undefined;
    return s?.tocPanelBounds;
  });

  const boardId = $derived(boardStore.current?.id ?? null);
  let activeBoardId: string | null = null;

  // Geometry state. Seeded with neutral defaults; the $effect below
  // hydrates from persisted bounds (or computed defaults) once the board
  // identity is known and reseeds on every board switch.
  let bx = $state<number>(TOC_DEFAULTS.rightMargin);
  let by = $state<number>(TOC_DEFAULTS.top);
  let bw = $state<number>(TOC_DEFAULTS.width);
  let bh = $state<number>(TOC_DEFAULTS.height);

  // Reseed when the active board changes. Only when the *identity* flips so
  // an in-place settings write (from our own persist call) doesn't echo back
  // and jump the panel mid-drag.
  $effect(() => {
    if (boardId === activeBoardId) return;
    // The default place is read off the list column, so wait for it.
    if (!persisted && !scrollContainerEl) return;
    activeBoardId = boardId;
    const next = persisted ?? defaultBounds();
    bx = next.x;
    by = next.y;
    bw = next.width;
    bh = next.height;
  });

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
    const clampedW = Math.max(180, Math.min(w, vw - 16));
    const clampedH = Math.max(160, Math.min(h, vh - top - bottom - 16));
    // Keep at least 80px of the header strip on-screen.
    const clampedX = Math.max(8 - clampedW + 80, Math.min(x, vw - 80));
    const clampedY = Math.max(top + 4, Math.min(y, vh - bottom - 32));
    return { x: clampedX, y: clampedY, w: clampedW, h: clampedH };
  }

  function persistBounds() {
    // allow-direct-mutation: gesture-survival write; a single undoable UpdateBoardSettingsCommand is pushed on dragend/resize-end (see captureGestureStart below).
    boardStore.updateSettings({
      tocPanelBounds: { x: bx, y: by, width: bw, height: bh },
    });
  }

  /**
   * Capture the pre-gesture bounds so the dragend / resize-end
   * commit can push a single UpdateBoardSettingsCommand for the whole gesture.
   * During the gesture itself, `persistBounds()` keeps writing through the
   * bare `updateSettings` path so the panel position survives reloads even
   * if the user kills the app mid-drag — only the *history* entry collapses
   * into one undoable step.
   */
  type Bounds = { x: number; y: number; width: number; height: number };
  let gestureStartBounds: Bounds | null = null;

  function captureGestureStart(): void {
    const prev = boardStore.current?.settings as { tocPanelBounds?: Bounds } | undefined;
    gestureStartBounds = prev?.tocPanelBounds ? { ...prev.tocPanelBounds } : { x: bx, y: by, width: bw, height: bh };
  }

  function commitGestureToHistory(description: string): void {
    if (!gestureStartBounds) return;
    const next: Bounds = { x: bx, y: by, width: bw, height: bh };
    const prev = gestureStartBounds;
    gestureStartBounds = null;
    const sameBounds =
      prev.x === next.x && prev.y === next.y
      && prev.width === next.width && prev.height === next.height;
    if (sameBounds) return;
    historyStore.pushWithoutExecute(
      new UpdateBoardSettingsCommand(
        { tocPanelBounds: next },
        { tocPanelBounds: prev },
        [],
        description,
      ),
    );
  }

  // ── Drag (header strip) ──
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartBx = 0;
  let dragStartBy = 0;

  function onDragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    // Ignore drags that start on interactive children (jump buttons, CTA).
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('button, a, input')) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartBx = bx;
    dragStartBy = by;
    captureGestureStart();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    e.preventDefault();
    const nx = dragStartBx + (e.clientX - dragStartX);
    const ny = dragStartBy + (e.clientY - dragStartY);
    const c = clamp(nx, ny, bw, bh);
    bx = c.x;
    by = c.y;
    persistBounds();
  }

  function onDragEnd(e: PointerEvent) {
    if (!isDragging) return;
    isDragging = false;
    commitGestureToHistory('Move ToC panel');
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
    captureGestureStart();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: PointerEvent) {
    if (!isResizing) return;
    e.preventDefault();
    const nw = resizeStartW + (e.clientX - resizeStartX);
    const nh = resizeStartH + (e.clientY - resizeStartY);
    const c = clamp(bx, by, nw, nh);
    bw = c.w;
    bh = c.h;
    persistBounds();
  }

  function onResizeEnd(e: PointerEvent) {
    if (!isResizing) return;
    isResizing = false;
    commitGestureToHistory('Resize ToC panel');
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  // Re-clamp on viewport shrink so the panel stays reachable.
  $effect(() => {
    function onResize() {
      const c = clamp(bx, by, bw, bh);
      const changed = c.x !== bx || c.y !== by || c.w !== bw || c.h !== bh;
      if (changed) {
        bx = c.x; by = c.y; bw = c.w; bh = c.h;
        persistBounds();
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="floating-toc-panel"
  style="left: {bx}px; top: {by}px; width: {bw}px; height: {bh}px; z-index: calc(var(--z-sidebar) + 2);"
  role="region"
  aria-label="Table of Contents"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="floating-toc-header"
    onpointerdown={onDragStart}
    onpointermove={onDragMove}
    onpointerup={onDragEnd}
    onpointercancel={onDragEnd}
    title="Drag to move"
  >
    <span class="floating-toc-title">Table of Contents</span>
  </div>

  <div class="floating-toc-body">
    {#if sections.length === 0}
      <div class="toc-empty">
        <p class="toc-empty-hint">No sections yet</p>
        <button class="toc-add-section-btn" onclick={onAddSection}>+ Add section</button>
      </div>
    {:else}
      <TaskListToc {sections} {scrollContainerEl} />
    {/if}
  </div>

  <div
    class="floating-resize-handle"
    class:resizing={isResizing}
    onpointerdown={onResizeStart}
    onpointermove={onResizeMove}
    onpointerup={onResizeEnd}
    onpointercancel={onResizeEnd}
    aria-label="Resize Table of Contents panel"
    role="separator"
  ></div>
</div>

<style>
  .floating-toc-panel {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--sidebar-bg, var(--ui-surface));
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.2));
    overflow: hidden;
  }

  .floating-toc-header {
    flex: 0 0 auto;
    padding: 8px 12px;
    background: var(--ui-surface-hover, transparent);
    border-bottom: 1px solid var(--ui-border);
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .floating-toc-header:active {
    cursor: grabbing;
  }
  .floating-toc-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .floating-toc-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0;
  }

  /* Inside the floating wrapper TaskListToc must not be sticky-positioned.
     Strip the embedded heading too — the wrapper header already labels the
     panel. */
  .floating-toc-body :global(.tasklist-toc) {
    position: static;
    flex: 1;
    padding: 4px 0;
  }
  .floating-toc-body :global(.tasklist-toc .toc-heading) {
    display: none;
  }

  .toc-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 12px;
    color: var(--text-tertiary);
    text-align: center;
  }
  .toc-empty-hint {
    margin: 0;
    font-size: 12px;
  }
  .toc-add-section-btn {
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .toc-add-section-btn:hover {
    background: var(--ui-surface-hover);
    border-color: var(--accent-primary, #4f7cff);
    color: var(--accent-primary, #4f7cff);
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
