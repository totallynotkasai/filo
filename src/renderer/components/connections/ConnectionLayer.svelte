<script lang="ts">
  /**
   * ConnectionLayer — SVG overlay that renders all connection paths, labels,
   * bubbles (in connection mode), and the in-progress drawing line.
   */
  import { getContext, untrack } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasScope = scope.canvas;
  const spatialScope = scope.spatial;
  import { uiStore } from '../../stores/ui.svelte';
  import { getBubblePosition } from '../../lib/connections/bubblePositions';
  import { computePath } from '../../lib/connections/pathRouter';
  import {
    createConnectionPathMemo,
    connectionPathSignature,
  } from '../../lib/connections/connectionPathMemo';
  import { effectiveConnectionPathStyle } from '../../lib/styles/effectiveStyle';
  import { connectionIntersectsViewport } from '../../lib/connections/connectionCulling';
  import { vaultStore } from '../../stores/vault.svelte';
  import type { Connection } from '../../schema/index';
  import type { SpatialIndex } from '../../lib/spatialIndex';

  import ConnectionPath from './ConnectionPath.svelte';
  import ConnectionLabel from './ConnectionLabel.svelte';
  import ConnectionBubbles from './ConnectionBubbles.svelte';

  let {
    spatialIndex,
    onstyleopen,
  }: {
    spatialIndex?: SpatialIndex;
    /**
     * Bubbled up so the parent can mount the style popup OUTSIDE the
     * canvas-transform — `position: fixed` is relative to a transformed
     * ancestor when there is one, which would mis-place the popup if it
     * lived inside this component.
     */
    onstyleopen?: (connection: Connection, x: number, y: number) => void;
  } = $props();

  let connections = $derived(boardStore.connections);
  let inConnectionMode = $derived(connectionsStore.connectionMode);
  let drawing = $derived(connectionsStore.drawing);

  // Hidden measurement path elements for label positioning
  let measurePaths = $state<Record<string, SVGPathElement>>({});

  // Label editing state (triggered from context menu "Edit Label")
  let editingLabelId = $state<string | null>(null);

  // Drawing line from source bubble to current mouse position
  let drawingPathD = $derived.by(() => {
    if (!drawing) return '';
    const fromTile = boardStore.getTile(drawing.fromTileId);
    if (!fromTile) return '';

    const fromRect = {
      x: fromTile.position.x,
      y: fromTile.position.y,
      width: fromTile.size.width,
      height: fromTile.size.height,
    };
    const from = getBubblePosition(fromRect, drawing.fromBubble);
    return `M ${from.x} ${from.y} L ${drawing.currentX} ${drawing.currentY}`;
  });

  // Matches the tile-culling buffer (VisibleTilesViewModel) so the
  // connection and tile sets stay consistent at the viewport edge.
  const VIEWPORT_CULL_BUFFER = 200;

  // Per-connection path cache. The derived re-runs on every pan/zoom
  // frame (it reads `viewportRect` to cull), but a pure pan doesn't move any
  // tile, so each path's signature is unchanged and the cached `d` is reused —
  // no `computePath`/A* runs on pan. See connectionPathMemo for the rationale.
  const pathMemo = createConnectionPathMemo();

  /**
   * Single source of truth for what the path + label layers render.
   * Culls to the buffered viewport (off-screen connections aren't rendered
   * and their paths aren't computed at all, which matters on large boards)
   * and computes each visible path ONCE here, shared by ConnectionPath and
   * the label's measurement path. Uses the cascade-resolved pathType, so the
   * label rides the same route the path actually draws. Export mode renders
   * everything (no cull).
   *
   * Each visible path routes through `pathMemo`, so a pan (which re-runs
   * this derived via `viewportRect`) reuses the cached `d` instead of
   * recomputing. `smartRevision` is read UNTRACKED so a tile move bumping the
   * spatial revision doesn't force this derived to re-run every drag frame
   * (which would A*-storm all smart paths); when the derived does re-run
   * (pan/zoom/endpoint move) it folds the latest revision into smart-path
   * signatures so an obstacle that moved still re-routes.
   */
  let renderableConnections = $derived.by((): Array<{ conn: Connection; pathD: string }> => {
    const vp = canvasScope.viewportRect;
    const exportMode = canvasScope.exportMode;
    const smartRevision = untrack(() => spatialScope.revision);
    const out: Array<{ conn: Connection; pathD: string }> = [];
    for (const conn of Object.values(connections)) {
      const fromTile = boardStore.getTile(conn.fromTileId);
      const toTile = boardStore.getTile(conn.toTileId);
      if (!fromTile || !toTile) continue; // drop stale connections
      const fromRect = { x: fromTile.position.x, y: fromTile.position.y, width: fromTile.size.width, height: fromTile.size.height };
      const toRect = { x: toTile.position.x, y: toTile.position.y, width: toTile.size.width, height: toTile.size.height };
      if (!exportMode && !connectionIntersectsViewport(fromRect, toRect, vp, VIEWPORT_CULL_BUFFER)) {
        continue;
      }
      const resolved = effectiveConnectionPathStyle(conn, vaultStore.project?.settings, boardStore.current);
      const sig = connectionPathSignature(fromRect, toRect, conn.fromBubble, conn.toBubble, resolved.pathType, smartRevision);
      const pathD = pathMemo.resolve(conn.id, sig, () => {
        const from = getBubblePosition(fromRect, conn.fromBubble);
        const to = getBubblePosition(toRect, conn.toBubble);
        return computePath(from, to, conn.fromBubble, conn.toBubble, resolved.pathType, spatialIndex);
      });
      out.push({ conn, pathD });
    }
    pathMemo.pruneExcept(connections);
    return out;
  });

  function handleConnectionContextMenu(e: MouseEvent, conn: Connection) {
    uiStore.showContextMenu(e.clientX, e.clientY, [
      {
        id: 'style',
        label: 'Style',
        action: () => {
          onstyleopen?.(conn, e.clientX, e.clientY);
        },
      },
      {
        id: 'edit-label',
        label: 'Edit Label',
        action: () => {
          editingLabelId = conn.id;
        },
      },
      { id: 'div1', label: '', divider: true },
      {
        id: 'delete',
        label: 'Delete Connection',
        danger: true,
        action: () => {
          boardStore.removeConnectionWithHistory(conn.id);
        },
      },
    ], conn.id);
  }

  function handleStyleClick(e: MouseEvent, conn: Connection) {
    onstyleopen?.(conn, e.clientX, e.clientY);
  }

  /**
   * Svelte action to capture a measurement path element ref.
   */
  function measurePathAction(el: SVGPathElement, connId: string) {
    measurePaths = { ...measurePaths, [connId]: el };
    return {
      destroy() {
        const next = { ...measurePaths };
        delete next[connId];
        measurePaths = next;
      },
    };
  }
</script>

<!-- SVG overlay for all connections -->
<svg
  class="connection-layer"
  style="z-index: var(--z-connection-path); position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible;"
 aria-hidden="true">
  <!-- Connection paths. Drop connections whose endpoints no longer exist —
       prevents a stale connection from mounting a ConnectionPath whose
       <g> element lingers in the DOM after the referenced tile is deleted. -->
  {#each renderableConnections as { conn, pathD } (conn.id)}
    <g style="pointer-events: stroke;">
      <ConnectionPath
        connection={conn}
        {pathD}
        {spatialIndex}
        oncontextmenu={handleConnectionContextMenu}
      />
    </g>
  {/each}

  <!-- Drawing line -->
  {#if drawing && drawingPathD}
    <path
      class="drawing-line"
      d={drawingPathD}
      fill="none"
      stroke="var(--connection-drawing-stroke, var(--accent-primary))"
      stroke-width="2"
      stroke-dasharray="6 3"
      opacity="0.7"
    />
  {/if}
</svg>

<!-- Separate SVG for connection bubbles — rendered ABOVE tiles.
     Reads boardStore.tiles directly (not via the $derived alias above) and
     re-resolves each tile via getTile() per render so a deleted tile cannot
     leave phantom bubbles at its old position. -->
{#if inConnectionMode}
  <svg
    class="connection-bubbles-layer"
    style="z-index: var(--z-connection-bubbles); position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible;"
   aria-hidden="true">
    {#each Object.values(boardStore.tiles) as tile (tile.id)}
      {@const live = boardStore.getTile(tile.id)}
      {#if live}
        <g style="pointer-events: all;">
          <ConnectionBubbles tile={live} />
        </g>
      {/if}
    {/each}
  </svg>
{/if}

<!-- Separate SVG for labels: uses hidden measurement paths for positioning -->
<svg
  class="connection-label-layer"
  style="z-index: var(--z-connection-label); position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible;"
 aria-hidden="true">
  {#each renderableConnections as { conn, pathD } (conn.id)}
    {#if pathD}
      <!-- Hidden measurement path for label positioning -->
      <path
        use:measurePathAction={conn.id}
        d={pathD}
        fill="none"
        stroke="none"
        style="visibility: hidden; pointer-events: none;"
      />
      <ConnectionLabel
        connection={conn}
        pathElement={measurePaths[conn.id] ?? null}
        {pathD}
        editing={editingLabelId === conn.id}
        oncontextmenu={handleConnectionContextMenu}
        onstyleclick={handleStyleClick}
        oneditdone={() => editingLabelId = null}
      />
    {/if}
  {/each}
</svg>

<!--
  Style popup is mounted by the parent (MindMapBoard) at the top level
  so it sits outside the canvas-transform; otherwise `position: fixed`
  would be relative to the transformed ancestor and mis-place the popup.
-->
