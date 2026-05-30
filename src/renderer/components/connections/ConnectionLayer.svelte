<script lang="ts">
  /**
   * ConnectionLayer — SVG overlay that renders all connection paths, labels,
   * bubbles (in connection mode), and the in-progress drawing line.
   */
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { uiStore } from '../../stores/ui.svelte';
  import { getBubblePosition } from '../../lib/connections/bubblePositions';
  import { computePath } from '../../lib/connections/pathRouter';
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

  /**
   * Compute path d string for a connection (used for hidden measurement paths).
   */
  function getPathD(conn: Connection): string {
    const fromTile = boardStore.getTile(conn.fromTileId);
    const toTile = boardStore.getTile(conn.toTileId);
    if (!fromTile || !toTile) return '';

    const fromRect = { x: fromTile.position.x, y: fromTile.position.y, width: fromTile.size.width, height: fromTile.size.height };
    const toRect = { x: toTile.position.x, y: toTile.position.y, width: toTile.size.width, height: toTile.size.height };
    const from = getBubblePosition(fromRect, conn.fromBubble);
    const to = getBubblePosition(toRect, conn.toBubble);

    return computePath(from, to, conn.fromBubble, conn.toBubble, conn.pathType ?? 'curved', spatialIndex);
  }

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
  {#each Object.values(connections).filter((c) => boardStore.getTile(c.fromTileId) && boardStore.getTile(c.toTileId)) as conn (conn.id)}
    <g style="pointer-events: stroke;">
      <ConnectionPath
        connection={conn}
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
  {#each Object.values(connections).filter((c) => boardStore.getTile(c.fromTileId) && boardStore.getTile(c.toTileId)) as conn (conn.id)}
    {@const pathD = getPathD(conn)}
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
