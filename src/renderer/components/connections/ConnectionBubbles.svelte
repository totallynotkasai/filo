<script lang="ts">
  /**
   * ConnectionBubbles — Renders 8 connection bubbles around a tile
   * when connection mode is active. Clicking a bubble starts/ends drawing a connection.
   */
  import type { Tile } from '../../schema/index';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { getBubblePositions } from '../../lib/connections/bubblePositions';
  import { connectionsStore } from '../../stores/connections.svelte';
  import { vaultStore } from '../../stores/vault.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { createId } from '../../lib/utils/ids';

  let { tile }: { tile: Tile } = $props();

  let bubbles = $derived(
    getBubblePositions({
      x: tile.position.x,
      y: tile.position.y,
      width: tile.size.width,
      height: tile.size.height,
    }),
  );

  // Position-aware labels for the 8 perimeter connection points. Matches the
  // index layout in `lib/connections/bubblePositions.ts`. Keeps SR users from
  // hearing "circle, circle, circle" when connection mode is active.
  const BUBBLE_LABELS = [
    'top-left',
    'top-center',
    'top-right',
    'middle-right',
    'bottom-right',
    'bottom-center',
    'bottom-left',
    'middle-left',
  ] as const;

  let isDrawingFrom = $derived(
    connectionsStore.drawing?.fromTileId === tile.id,
  );

  function handleBubbleClick(e: MouseEvent, bubbleIndex: number) {
    e.stopPropagation();
    e.preventDefault();

    const drawing = connectionsStore.drawingOn(boardStore);

    if (!drawing) {
      // Start drawing from this bubble
      const bubble = bubbles[bubbleIndex];
      if (!bubble) return;
      connectionsStore.startDrawing(tile.id, bubbleIndex, bubble.x, bubble.y);
    } else if (drawing.fromTileId !== tile.id) {
      // Block duplicate connections between the same two bubble points
      if (boardStore.connectionExistsBetween(drawing.fromTileId, drawing.fromBubble, tile.id, bubbleIndex)) {
        connectionsStore.cancelDrawing();
        return;
      }
      // Complete connection to this tile
      const now = Date.now();
      // Read project-level mindmap defaults (fall back to hardcoded)
      const mmDefaults = vaultStore.project?.settings?.mindmap;
      const labelDefs = mmDefaults?.connectionLabel;
      // Per-board override (board.settings.defaults.connectionLabel) wins
      // over global for the `defaultText` creation seed. Cascade matches
      // the runtime style cascade for label colours / fontSize.
      const boardLabelDefs =
        boardStore.current?.type === 'mindmap'
          ? (boardStore.current.settings?.defaults?.connectionLabel as
              | { defaultText?: string }
              | undefined)
          : undefined;
      const seedDefaultText =
        boardLabelDefs?.defaultText && boardLabelDefs.defaultText !== ''
          ? boardLabelDefs.defaultText
          : (labelDefs?.defaultText ?? '');

      // Path-style fields (pathType / pathSize / pathStyle / arrowType /
      // arrowSize) are left unset at creation so the runtime cascade
      // resolves them from board / global defaults on every paint —
      // changing the global default propagates to existing connections.
      // Colour fields bake as empty strings (the cascade-unset sentinel
      // for strings).
      boardStore.addConnectionWithHistory({
        id: createId(),
        boardId: boardStore.current?.id ?? '',
        fromTileId: drawing.fromTileId,
        toTileId: tile.id,
        fromBubble: drawing.fromBubble,
        toBubble: bubbleIndex,
        pathColor: '',
        arrowColor: '',
        visibility: 'visible' as const,
        labelVisibility: 'visible' as const,
        label: {
          text: seedDefaultText,
          textColor: '',
          backgroundColor: '',
          position: 0.5,
          locked: false,
        },
        createdAt: now,
        updatedAt: now,
      });
      connectionsStore.finishDrawing();
    } else {
      // Clicked same tile — cancel
      connectionsStore.cancelDrawing();
    }
  }
</script>

{#each bubbles as bubble (bubble.index)}
  <circle
    class="connection-bubble"
    class:active-source={isDrawingFrom && connectionsStore.drawing?.fromBubble === bubble.index}
    cx={bubble.x}
    cy={bubble.y}
    r="6"
    style="z-index: var(--z-connection-bubbles)"
    role="button"
    tabindex="-1"
    aria-label="Connection point: {BUBBLE_LABELS[bubble.index]}"
    onmousedown={(e) => handleBubbleClick(e, bubble.index)}
  />
{/each}
