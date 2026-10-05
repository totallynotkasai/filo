<script lang="ts">
  /**
   * TileContainer — universal tile wrapper.
   * Renders the positioned tile with header, body slot, resize handle,
   * selection state, and semantic zoom behaviour.
   */
  import type { Tile } from '../../schema/index';
  import type { ResolvedTileStyle } from '../../lib/styles/effectiveStyle';
  import TileHeader from './TileHeader.svelte';
  import TagBadge from '../tags/TagBadge.svelte';
  import TagsPopupMenu from '../tags/TagsPopupMenu.svelte';
  import { getContext, setContext } from 'svelte';
  import { RESOLVED_TILE_STYLE_KEY } from '../../lib/styles/resolvedTileStyleContext';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { orphansStore } from '../../stores/orphans.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { tileDragAction, isSelectionHandled } from '../../lib/canvas/tileDrag';
  import { tileResizeAction } from '../../lib/canvas/tileResize';
  import { effectiveTileStyle } from '../../lib/styles/effectiveStyle';
  import { getContextMenuKeyPosition } from '../../lib/utils/contextMenuKey';
  import { portal } from '../../lib/utils/portal';
  import { navigationState } from '../../lib/utils/navigation.svelte';
  import { isContentEditableAware } from '../../lib/utils/editableTarget';
  import type { Snippet } from 'svelte';

  // Per-pane scope; aliases preserve the existing call sites. See
  // PaneView.svelte / boardScope.svelte.ts.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasStore = scope.canvas;
  const selectionStore = scope.selection;
  const spatialStore = scope.spatial;

  let {
    tile,
    children,
    flowLayout = false,
    resolved: resolvedOverride,
  }: {
    tile: Tile;
    children: Snippet;
    /**
     * When true, the container renders in flow layout (no absolute
     * positioning, no canvas drag/resize, LOD pinned to 'full'). Used by
     * non-mind-map boards (Kanban) that mount TileContainer inside their own
     * column-and-card layout. Defaults to false (canvas mode).
     */
    flowLayout?: boolean;
    /**
     * Optional pre-resolved style. When provided (e.g. by <KanbanCard>),
     * the container skips its internal `effectiveTileStyle` call and uses
     * this value — letting the parent layer in per-placement overrides
     * from a sibling cascade (Kanban card cascade's fontSizeTitle / Body)
     * without each child component re-implementing the merge.
     */
    resolved?: ResolvedTileStyle;
  } = $props();

  let selected = $derived(selectionStore.isSelected(tile.id));
  let lodLevel = $derived(flowLayout ? 'full' : canvasStore.lodLevel);
  let isOrphanHighlighted = $derived(orphansStore.isHighlighted(tile.id));
  // Short-lived highlight pulse after navigateToTile (e.g.
  // jumping from search). Cleared via the 2s timer in navigation.svelte.ts.
  let isNavHighlighted = $derived(navigationState.highlightedTileId === tile.id);

  // When General settings → Toggle Hover Buttons → Tiles is Off, the header
  // action buttons (defined inside TileHeader) stay permanently visible.
  let forceShowButtons = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.tiles === false,
  );

  // Media-only ("frameless") display — hides the header bar, border, shadow,
  // and body background so only the media is visible; the header re-reveals
  // as an overlay on hover. Scoped to canvas (`!flowLayout`) media tiles so
  // Kanban / Task List cards and non-media tiles are unaffected.
  let frameless = $derived(
    !flowLayout
    && tile.frameless === true
    && (tile.type === 'image' || tile.type === 'video'
        || tile.type === 'audio' || tile.type === 'file'),
  );

  // Resolved style after walking the per-element > board > global cascade,
  // including Dynamic Contrast Text colour selection. When the parent
  // passes `resolvedOverride` (Kanban card layer), use it verbatim.
  let resolved = $derived(
    resolvedOverride
      ?? effectiveTileStyle(tile, vaultStore.project?.settings, boardStore.current),
  );

  // Expose the resolved style to body children (TextTile etc.) via context so
  // they don't have to re-walk the cascade for fields like fontSizeBody.
  setContext(RESOLVED_TILE_STYLE_KEY, { get value() { return resolved; } });

  let borderRadius = $derived(resolved.shape === 'rounded' ? '8px' : '2px');

  let boxShadow = $derived(
    resolved.shadowIntensity > 0
      ? `0 2px ${8 * resolved.shadowIntensity}px rgba(0,0,0,${resolved.shadowIntensity})`
      : 'none'
  );

  // Canvas tiles position via `transform: translate()` rather than `left/top`.
  // Translate is composited (no layout pass) so per-tile position updates
  // during a multi-tile drag don't thrash layout. `left/top` are pinned to 0
  // so the transform origin is the canvas root.
  //
  // Positioning lives on the outer `.tile-shell` rather than the inner
  // `.tile-container` so the group-number badge — which sits *outside* the
  // tile's clipped bounds — can be a sibling of the container, escaping
  // the container's `overflow: hidden`.
  let shellStyle = $derived([
    flowLayout ? 'position: relative' : 'position: absolute; left: 0; top: 0',
    flowLayout ? '' : `transform: translate(${tile.position.x}px, ${tile.position.y}px)`,
    flowLayout ? 'width: 100%' : `width: ${tile.size.width}px`,
    flowLayout ? '' : `height: ${tile.size.height}px`,
    `z-index: var(${selected ? '--z-tile-selected' : '--z-tile'})`,
    tile.faded ? 'opacity: 0.3' : '',
  ].filter(Boolean).join('; '));

  let containerStyle = $derived([
    `border-radius: ${borderRadius}`,
    frameless
      ? 'border: none'
      : `border: ${resolved.borderWidth}px ${resolved.borderStyle} ${resolved.borderColor || 'var(--tile-border)'}`,
    `box-shadow: ${frameless ? 'none' : boxShadow}`,
  ].filter(Boolean).join('; '));

  // Group badge — displays the group's `displayIndex` above the tile when
  // the tile belongs to a group. Returns null on non-Mind Map boards (only
  // mindmap boards have a groups slice) and when the tile is ungrouped.
  let groupNumber = $derived.by(() => {
    if (flowLayout) return null;
    const group = boardStore.getGroupForTile(tile.id);
    return group?.displayIndex ?? null;
  });

  // Body inline style (background + optional Dynamic Contrast Text colour
  // exposed as a CSS custom property for descendants to opt into).
  let bodyStyle = $derived(
    [
      `background: ${frameless ? 'transparent' : (resolved.bodyColor || 'var(--tile-body-bg)')}`,
      // Frameless: blank the image-letterbox backing so the image shows with
      // no grey bars (ImageTile reads `--image-tile-bg`).
      frameless ? '--image-tile-bg: transparent' : '',
      resolved.bodyTextColor ? `--body-text-color: ${resolved.bodyTextColor}` : '',
      resolved.bodyTextColor ? `color: ${resolved.bodyTextColor}` : '',
    ].filter(Boolean).join('; ')
  );

  // ResizeObserver: keep spatial index accurate when the container's rendered size changes
  // (e.g. min-height constraints, content overflow). Only fires when delta > 2px.
  // Skipped in flowLayout mode — those tiles aren't on the canvas spatial index.
  // Routed through updateOrDefer so a reflow mid-drag (image load, auto-height)
  // doesn't perturb the index the smart guides read — it flushes on drag end.
  let containerElement = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!containerElement || flowLayout) return;
    let lastW = tile.size.width;
    let lastH = tile.size.height;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (Math.abs(width - lastW) > 2 || Math.abs(height - lastH) > 2) {
          lastW = width;
          lastH = height;
          spatialStore.updateOrDefer(tile.id, () => ({
            x: tile.position.x,
            y: tile.position.y,
            width,
            height,
          }));
        }
      }
    });
    observer.observe(containerElement);
    return () => observer.disconnect();
  });

  function handlePointerDown(e: PointerEvent) {
    // In canvas mode, swallow the pointerdown so it doesn't reach the
    // board's marquee/deselect handler. In flow mode (Kanban / Task List
    // / Document), the pointerdown MUST bubble — the parent's dndzone
    // wrapper (`.tile-drop-zone`) reads it to arm the card drag for the
    // next gesture. Without this guard, dragging a card from its header
    // (title bar) silently no-ops because dndzone never sees pointerdown.
    if (!flowLayout) e.stopPropagation();
    // Additive selection (Ctrl/Meta/Shift) must not leave focus inside a TipTap
    // editor — otherwise the global Delete shortcut is swallowed by ProseMirror
    // and the multi-tile delete confirmation never opens.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && isContentEditableAware(ae)) ae.blur();
    }
    // Flow-layout boards (Kanban / Task List / Document) own selection at
    // the parent wrapper's click handler (e.g. KanbanMultiSelect). Running
    // selection here too produced a double-toggle on Ctrl+Click:
    // pointerdown added the tile, then click toggled it back off — the
    // "selects for a split second then deselects" bug.
    if (flowLayout) return;
    if (isSelectionHandled(e)) return;
    if (e.ctrlKey || e.metaKey) {
      selectionStore.toggle(tile.id);
    } else if (!selectionStore.isSelected(tile.id)) {
      selectionStore.select(tile.id);
    }
  }

  // Tag display & popup
  let tagNames = $derived(tile.tags);
  let tagPopup = $state<{ tagName: string; x: number; y: number } | null>(null);

  function handleTagClick(tagName: string, e: MouseEvent) {
    e.stopPropagation();
    if (tagPopup?.tagName === tagName) {
      tagPopup = null;
    } else {
      tagPopup = { tagName, x: e.clientX, y: e.clientY };
    }
  }

  function closeTagPopup() {
    tagPopup = null;
  }

  /**
   * Keyboard a11y for canvas tiles:
   *   Tab        — focus reaches the tile via the wrapper div (tabindex=0)
   *   Enter      — adds the tile to the active selection
   *   Shift+F10  — opens the same context menu the right-click handler uses,
   *                positioned at the tile's centre
   *
   * Flow-layout tiles (Kanban) keep tabindex=-1 because their context menu
   * is column-scoped, and their body content is already in normal Tab order.
   */
  function handleContainerKeydown(e: KeyboardEvent) {
    if (flowLayout) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target !== containerElement) return;
      e.preventDefault();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        selectionStore.toggle(tile.id);
      } else {
        selectionStore.select(tile.id);
      }
      return;
    }
    const pos = getContextMenuKeyPosition(e, containerElement);
    if (!pos || !containerElement) return;
    e.preventDefault();
    e.stopPropagation();
    // Ensure the tile is the selected one so the existing canvas-level
    // contextmenu hit-test snaps to us (it reads selectionStore).
    if (!selectionStore.isSelected(tile.id)) selectionStore.select(tile.id);
    // Synthesize a contextmenu event that bubbles up to the canvas's
    // oncontextmenu handler (MindMapBoard.handleContextMenu). Cleaner than
    // duplicating the menu items here.
    const ev = new MouseEvent('contextmenu', {
      clientX: pos.x,
      clientY: pos.y,
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    containerElement.dispatchEvent(ev);
  }
</script>

<!--
  Each tile is an independently meaningful content unit (text, image, etc.)
  so `role="article"` is semantically correct. Marking it Tab-reachable
  and wiring a keydown handler makes it interactive at the
  widget level; Svelte's lint flags non-button interactive content with
  warnings that don't apply here, so silence them.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="tile-shell" style={shellStyle} data-canvas-tile-id={tile.id}>
  {#if groupNumber !== null}
    <div class="tile-group-badge" aria-label="Group {groupNumber}">{groupNumber}</div>
  {/if}
  <div
    bind:this={containerElement}
    class="tile-container"
    class:selected
    class:lod-simplified={lodLevel === 'simplified'}
    class:lod-block={lodLevel === 'block'}
    class:locked={tile.locked}
    class:orphan-highlight={isOrphanHighlighted}
    class:nav-highlight={isNavHighlighted}
    class:force-show-buttons={forceShowButtons}
    class:frameless
    role="article"
    aria-label={tile.title || 'Untitled tile'}
    tabindex={flowLayout ? -1 : 0}
    style={containerStyle}
    onpointerdown={handlePointerDown}
    onkeydown={handleContainerKeydown}
  >
  {#if lodLevel === 'block'}
    <!-- LOD block: bare coloured rectangle. No header, no body, no resize handle. -->
    <div
      class="tile-lod-block"
      style="background: {resolved.headerColor || 'var(--tile-header-bg)'}"
    ></div>
  {:else}
    <!-- Header — drag action only in canvas mode. -->
    {#if flowLayout}
      <div class="tile-header-drag tile-header-drag-static">
        <TileHeader {tile} {resolved} />
      </div>
    {:else}
      <div
        class="tile-header-drag"
        class:frameless-header={frameless}
        use:tileDragAction={{ tileId: tile.id, locked: tile.locked, snapToGrid: canvasStore.snapEnabled, scope }}
      >
        <TileHeader {tile} {resolved} />
      </div>
    {/if}

    {#if lodLevel === 'full'}
      {#if frameless}
        <!-- Frameless: the body itself is the drag handle so the bare media can
             be moved directly. tileDragAction's interactive guard still lets
             buttons / inputs inside the body (e.g. ImageTile's remove/alt
             actions) handle their own clicks instead of starting a drag. -->
        <div
          class="tile-body"
          style={bodyStyle}
          use:tileDragAction={{ tileId: tile.id, locked: tile.locked, snapToGrid: canvasStore.snapEnabled, scope }}
        >
          {@render children()}
        </div>
      {:else}
        <div class="tile-body" style={bodyStyle}>
          {@render children()}
        </div>
      {/if}

      <!-- In flowLayout (Kanban), the host KanbanCard renders its own footer
           that co-locates tag chips with the priority/due/cover/tag-edit
           buttons — rendering the generic tag-footer here too would duplicate
           the chips. -->
      {#if tagNames.length > 0 && !flowLayout && !frameless}
        <div class="tile-tags-footer" style={bodyStyle}>
          {#each tagNames as name (name)}
            <TagBadge tagName={name} onClick={(e) => handleTagClick(name, e)} />
          {/each}
        </div>
      {/if}

      {#if tagPopup}
        <div
          use:portal
          class="tag-popup-overlay"
          onclick={closeTagPopup}
          onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeTagPopup(); } }}
          role="presentation"
        ></div>
        <div use:portal class="tag-popup-anchor" style="position: fixed; left: {tagPopup.x}px; top: {tagPopup.y}px; z-index: var(--z-tile-popup);">
          <TagsPopupMenu tagName={tagPopup.tagName} onClose={closeTagPopup} />
        </div>
      {/if}
    {:else}
      <!-- LOD simplified: header is rendered above; body is a flat block of the header colour. -->
      <div
        class="tile-lod-simplified-body"
        style="background: {resolved.headerColor || 'var(--tile-header-bg)'}"
      ></div>
    {/if}

    {#if !tile.locked && lodLevel === 'full' && !flowLayout}
      <div
        class="tile-resize-handle"
        use:tileResizeAction={{ tileId: tile.id, locked: tile.locked }}
      ></div>
    {/if}
  {/if}

    <!-- Broken-ref indicator now lives inline in TileHeader, next to the title. -->
  </div>
</div>

<style>
  /* Outer positioning shell — owns canvas placement (transform/width/height/
     z-index) so the group-number badge can sit *above* the tile, outside
     the inner container's `overflow: hidden`. */
  .tile-shell {
    /* position is set inline (absolute on canvas, relative in flow layout) */
    overflow: visible;
  }

  /* Group-number badge. Hugs the top edge of the tile, centred. Always
     rendered when the tile belongs to a group (visible at every LOD
     level). pointer-events: none so it never steals clicks. */
  .tile-group-badge {
    position: absolute;
    top: -20px;
    left: 50%;
    transform: translateX(-50%);
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    color: var(--text-inverse);
    background: var(--accent-primary);
    border-radius: 9px;
    text-align: center;
    user-select: none;
    pointer-events: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    z-index: 1;
  }

  .tile-container {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    cursor: default;
    transition: box-shadow 0.2s ease;
  }

  .tile-container:hover {
    box-shadow: var(--ui-shadow-elevated) !important;
  }

  .tile-container.selected {
    outline: 2px solid var(--accent-primary);
    outline-offset: 1px;
  }

  /* Keyboard focus indicator — canvas tiles are Tab-reachable. */
  .tile-container:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }

  /* Nav-jump highlight pulse. Applied by `navigateToTile`
     (e.g. from search) for `HIGHLIGHT_DURATION_MS` so the user can spot the
     tile after the viewport snaps to it. Animation uses transform+box-shadow
     only (GPU-accelerated). Respects prefers-reduced-motion: still shows the
     ring colour, just without the animated pulse. */
  .tile-container.nav-highlight {
    outline: 3px solid var(--accent-primary);
    outline-offset: 3px;
    animation: tile-nav-pulse 0.8s ease-in-out 2;
  }

  @keyframes tile-nav-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-primary) 45%, transparent); }
    50%      { box-shadow: 0 0 0 12px color-mix(in srgb, var(--accent-primary) 0%, transparent); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tile-container.nav-highlight {
      animation: none;
    }
  }

  .tile-container.locked {
    opacity: 0.92;
  }

  /* Header drag zone */
  .tile-header-drag {
    cursor: grab;
    flex-shrink: 0;
  }

  .tile-header-drag:active {
    cursor: grabbing;
  }

  .tile-container.locked .tile-header-drag {
    cursor: default;
  }

  /* In flow-layout (Kanban) mode, drag is column-level — header has no
     individual grab cursor. */
  .tile-header-drag-static {
    cursor: default;
  }

  /* ── Frameless (media-only) mode ──
     The header collapses to a hover-revealed overlay so the media shows
     unobstructed. position:absolute keeps the body at full height (no reflow
     when the header fades in). The header keeps `use:tileDragAction`, so the
     tile stays draggable once hovered. */
  .tile-header-drag.frameless-header {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 6;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }

  /* Hover-only reveal. The keyboard path is scoped to `.frameless-header:focus-within`
     (a header *control* is focused) rather than the container — clicking a
     frameless tile focuses the tabindex=0 container, and we do NOT want that
     (or mere selection) to keep the header up. So a selected / click-focused
     frameless tile stays clean until actually hovered, while Tabbing to a
     header button still reveals it for keyboard users. */
  .tile-container:hover .tile-header-drag.frameless-header,
  .tile-header-drag.frameless-header:focus-within {
    opacity: 1;
    pointer-events: auto;
  }

  /* Suppress the hover elevation on frameless tiles. The inline containerStyle
     already sets box-shadow:none, but the :hover rule below uses !important
     and would otherwise re-add it. */
  .tile-container.frameless:hover {
    box-shadow: none !important;
  }

  /* In frameless mode the body IS the drag handle (the header is hover-only
     chrome), so hint draggability with a grab cursor. The global grabbing
     cursor during an active drag is set by tileDragAction. */
  .tile-container.frameless .tile-body {
    cursor: grab;
  }

  .tile-container.frameless .tile-body:active {
    cursor: grabbing;
  }

  @media (prefers-reduced-motion: reduce) {
    .tile-header-drag.frameless-header {
      transition: none;
    }
  }

  /* Body */
  .tile-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  /* Tags footer — background is supplied inline via `bodyStyle` so the
     tile body colour extends through the tag row rather than leaving a
     transparent strip. */
  .tile-tags-footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tag-row-gap);
    padding: 3px 8px 5px;
  }

  .tag-popup-overlay {
    position: fixed;
    inset: 0;
    /* Sits below the popup (var(--z-tile-popup) = 2400) so clicks inside
       the popup hit the popup, not the click-outside overlay. */
    z-index: var(--z-tile-popup-overlay);
  }

  .tag-popup-anchor {
    animation: popIn 0.15s ease;
  }

  /* Resize handle */
  .tile-resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 14px;
    height: 14px;
    cursor: se-resize;
    z-index: 5;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .tile-resize-handle::after {
    content: '';
    position: absolute;
    bottom: 3px;
    right: 3px;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--text-tertiary);
    border-bottom: 2px solid var(--text-tertiary);
    border-radius: 0 0 2px 0;
  }

  .tile-container:hover .tile-resize-handle {
    opacity: 1;
  }

  /* ── Semantic zoom (LOD) ── */

  /* Simplified: header (with bold title) sits above a flat block of the header colour. */
  .tile-container.lod-simplified {
    min-height: 32px;
  }

  .tile-container.lod-simplified .tile-header-drag {
    flex-shrink: 0;
  }

  .tile-lod-simplified-body {
    flex: 1;
    min-height: 0;
  }

  /* Bolder title at simplified zoom for legibility at low scale. */
  .tile-container.lod-simplified :global(.tile-title) {
    font-weight: 700;
  }

  /* Block: the entire tile is a single coloured rectangle (birds-eye view). */
  .tile-lod-block {
    width: 100%;
    height: 100%;
  }
</style>
