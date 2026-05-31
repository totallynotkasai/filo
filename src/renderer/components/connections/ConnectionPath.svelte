<script lang="ts">
  /**
   * ConnectionPath — Renders a single SVG connection path between two tiles.
   * Supports curved, straight, elbow, and smart path types with stroke styling and arrows.
   */
  import type { Connection } from '../../schema/index';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { effectiveConnectionPathStyle } from '../../lib/styles/effectiveStyle';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  // Phase C / C.4 — connections are now selectable via click; the
  // SelectionScope's `selectedConnectionIds` was already present but
  // unused at the component level. Wired here + on the Delete shortcut.
  const selectionStore = scope.selection;
  import { getBubblePosition } from '../../lib/connections/bubblePositions';
  import { computePath, computeArrowHead, getPointOnPath, getAngleOnPath } from '../../lib/connections/pathRouter';

  let {
    connection,
    spatialIndex,
    pathD: pathDProp,
    oncontextmenu,
  }: {
    connection: Connection;
    spatialIndex?: import('../../lib/spatialIndex').SpatialIndex;
    /**
     * 3.3 — path precomputed by ConnectionLayer (computed once and shared
     * with this connection's label). When provided, ConnectionPath uses it
     * instead of recomputing — halving per-frame `computePath` calls. Falls
     * back to its own computation when rendered without it.
     */
    pathD?: string;
    oncontextmenu?: (e: MouseEvent, conn: Connection) => void;
  } = $props();

  let fromTile = $derived(boardStore.getTile(connection.fromTileId));
  let toTile = $derived(boardStore.getTile(connection.toTileId));

  // Cascade-resolved path styling — per-connection > board > global.
  let resolvedPath = $derived(
    effectiveConnectionPathStyle(connection, vaultStore.project?.settings, boardStore.current),
  );

  let pathD = $derived.by(() => {
    // 3.3 — prefer the path ConnectionLayer already computed (shared with
    // the label); only compute locally when rendered without the prop.
    if (pathDProp !== undefined) return pathDProp;
    if (!fromTile || !toTile) return '';

    const fromRect = { x: fromTile.position.x, y: fromTile.position.y, width: fromTile.size.width, height: fromTile.size.height };
    const toRect = { x: toTile.position.x, y: toTile.position.y, width: toTile.size.width, height: toTile.size.height };

    const from = getBubblePosition(fromRect, connection.fromBubble);
    const to = getBubblePosition(toRect, connection.toBubble);

    return computePath(from, to, connection.fromBubble, connection.toBubble, resolvedPath.pathType, spatialIndex);
  });

  let strokeDasharray = $derived(
    resolvedPath.pathStyle === 'dashed' ? '8 4' :
    resolvedPath.pathStyle === 'dotted' ? '2 4' :
    'none',
  );

  // Visibility
  let isHidden = $derived(
    connection.visibility === 'hidden' || connection.visibility === 'hidden-locked',
  );

  // Locked states pin the connection's visibility — the global Hide-All
  // toggle skips connections that have been explicitly locked by the user.
  let isLocked = $derived(
    connection.visibility === 'visible-locked' || connection.visibility === 'hidden-locked',
  );

  let inConnectionMode = $derived(connectionsStore.connectionMode);

  let opacity = $derived.by(() => {
    if (connectionsStore.hideAllPaths && !isLocked && !inConnectionMode) return 0;
    if (isHidden && !inConnectionMode) return 0;
    if (isHidden && inConnectionMode) return 0.3;
    return 1;
  });

  // When the path is fully hidden outside connection mode, disable pointer events so
  // the invisible hit-area doesn't intercept clicks meant for tiles or canvas behind it.
  let pointerEvents = $derived(opacity === 0 ? 'none' : 'auto');

  // Arrow references
  let pathElement = $state<SVGPathElement | null>(null);

  let startArrow = $derived(
    resolvedPath.arrowType === 'start' || resolvedPath.arrowType === 'both',
  );

  let endArrow = $derived(
    resolvedPath.arrowType === 'end' || resolvedPath.arrowType === 'both',
  );

  // Arrow geometry. `getPointOnPath` / `getAngleOnPath` read live DOM
  // geometry off the bound `<path>` element. The deriveds depend on
  // `pathD` so Svelte invalidates them whenever the routed path changes
  // — without that, switching to Smart routing (or moving an obstacle)
  // leaves the arrowheads stranded at the previous endpoints because
  // `pathElement` itself never changes reference after mount.
  let startArrowGeom = $derived.by(() => {
    if (!pathElement || !startArrow || !pathD) return null;
    return {
      point: getPointOnPath(pathElement, 0),
      angle: getAngleOnPath(pathElement, 0),
    };
  });

  let endArrowGeom = $derived.by(() => {
    if (!pathElement || !endArrow || !pathD) return null;
    return {
      point: getPointOnPath(pathElement, 1),
      angle: getAngleOnPath(pathElement, 1),
    };
  });

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    oncontextmenu?.(e, connection);
  }

  // Phase C / C.4 — click selects this connection. Shift-click adds to
  // the existing connection selection without clobbering it. We stop
  // propagation so the canvas-background click handler doesn't fire
  // (which would clear the selection we just set).
  function handleClick(e: MouseEvent) {
    if (inConnectionMode) return; // connection-mode reserves clicks for bubbles
    e.stopPropagation();
    selectionStore.selectConnection(connection.id, e.shiftKey);
  }

  // `.selected` styling driven off the per-pane selection set so two
  // panes can hold independent connection selections.
  let isSelected = $derived(selectionStore.selectedConnectionIds.has(connection.id));
</script>

{#if pathD && fromTile && toTile}
  <g
    class="connection-path-group"
    class:selected={isSelected}
    style="opacity: {opacity}; pointer-events: {pointerEvents}"
  >
    <!-- Invisible wider path for easier click target. SVG <path> is not
         keyboard-focusable; selecting a connection by keyboard would
         require a full Tab-order audit of the canvas layer (deferred).
         For now the path is mouse-only — same affordance the existing
         context-menu hit area already had. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <path
      class="connection-hit-area"
      d={pathD}
      fill="none"
      stroke="transparent"
      stroke-width="16"
      onclick={handleClick}
      oncontextmenu={handleContextMenu}
    />

    <!-- Visible path. `stroke-linecap: butt` (not round) — round caps
         overshoot the endpoint by half stroke-width, which on side bubbles
         (sitting on the tile's straight edge) visibly clips into the tile.
         Corner bubbles sit outside the tile's rounded corner, so they
         were already clean. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <path
      bind:this={pathElement}
      class="connection-path"
      d={pathD}
      fill="none"
      style="stroke: {isSelected ? 'var(--accent-primary)' : (resolvedPath.pathColor || 'var(--connection-path-color)')}"
      stroke-width={isSelected ? Math.max(resolvedPath.pathSize + 1, 3) : resolvedPath.pathSize}
      stroke-dasharray={strokeDasharray}
      stroke-linecap="butt"
      stroke-linejoin="round"
      onclick={handleClick}
      oncontextmenu={handleContextMenu}
    />

    <!-- Arrows — closed filled triangles (not stroked V's). A stroked
         linejoin at the tip extends past the geometric vertex in the
         bisector direction (into the target tile on side bubbles).
         Filled triangles give a sharp tip exactly at the bubble. -->
    {#if startArrowGeom}
      <path
        class="connection-arrow"
        d={computeArrowHead(startArrowGeom.point, startArrowGeom.angle + 180, resolvedPath.arrowSize)}
        style="fill: {resolvedPath.arrowColor || 'var(--connection-arrow-color)'}; stroke: {resolvedPath.arrowColor || 'var(--connection-arrow-color)'}"
        stroke-width="0.5"
        stroke-linejoin="miter"
      />
    {/if}

    {#if endArrowGeom}
      <path
        class="connection-arrow"
        d={computeArrowHead(endArrowGeom.point, endArrowGeom.angle, resolvedPath.arrowSize)}
        style="fill: {resolvedPath.arrowColor || 'var(--connection-arrow-color)'}; stroke: {resolvedPath.arrowColor || 'var(--connection-arrow-color)'}"
        stroke-width="0.5"
        stroke-linejoin="miter"
      />
    {/if}

  </g>
{/if}
