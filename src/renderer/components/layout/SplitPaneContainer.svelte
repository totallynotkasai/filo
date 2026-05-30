<script lang="ts">
  /**
   * SplitPaneContainer — recursively renders the workspace pane tree.
   *
   * Splits are CSS-grid layouts with draggable gutters. Leaves render via
   * {@link PaneView}, which hosts a fully-live BoardRouter rooted in its
   * own per-pane `BoardScope`. The currently-active pane's scope is the
   * one the global facades (`boardStore` etc.) delegate to.
   */
  import { workspaceStore, type PaneNode } from '../../stores/workspace.svelte';
  import PaneView from './PaneView.svelte';
  import SplitPaneContainer from './SplitPaneContainer.svelte';

  interface Props {
    node: PaneNode;
  }

  let { node }: Props = $props();

  // ── Gutter drag state ──
  let draggingGutter = $state(false);
  let dragStart = { x: 0, y: 0, sizes: [] as number[] };
  let dragGutterIndex = $state(-1);

  function beginGutterDrag(e: PointerEvent, index: number) {
    if (node.type !== 'split') return;
    e.preventDefault();
    e.stopPropagation();
    dragStart = { x: e.clientX, y: e.clientY, sizes: [...node.sizes] };
    dragGutterIndex = index;
    draggingGutter = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGutterMove(e: PointerEvent, totalPx: number) {
    if (!draggingGutter || node.type !== 'split') return;
    const delta = node.orientation === 'horizontal' ? e.clientX - dragStart.x : e.clientY - dragStart.y;
    if (totalPx <= 0) return;
    const fractionDelta = delta / totalPx;

    const sizes = [...dragStart.sizes];
    // Resize between child[index] and child[index+1]
    const before = sizes[dragGutterIndex];
    const after = sizes[dragGutterIndex + 1];
    const combined = before + after;
    const newBefore = Math.max(0.1, Math.min(combined - 0.1, before + fractionDelta));
    sizes[dragGutterIndex] = newBefore;
    sizes[dragGutterIndex + 1] = combined - newBefore;
    workspaceStore.resizeSplit(node.id, sizes);
  }

  function endGutterDrag() {
    draggingGutter = false;
    dragGutterIndex = -1;
  }

  let containerEl: HTMLElement | null = $state(null);
  let totalPx = $derived.by(() => {
    if (!containerEl || node.type !== 'split') return 0;
    const rect = containerEl.getBoundingClientRect();
    return node.orientation === 'horizontal' ? rect.width : rect.height;
  });
</script>

{#if node.type === 'leaf'}
  <PaneView paneId={node.id} tabId={node.tabId} />
{:else}
  <div
    bind:this={containerEl}
    class="split-container"
    class:horizontal={node.orientation === 'horizontal'}
    class:vertical={node.orientation === 'vertical'}
    style:grid-template-columns={node.orientation === 'horizontal' ? node.sizes.map(s => `${s}fr`).join(' var(--gutter) ') : ''}
    style:grid-template-rows={node.orientation === 'vertical' ? node.sizes.map(s => `${s}fr`).join(' var(--gutter) ') : ''}
  >
    {#each node.children as child, i (child.id)}
      <div class="split-cell">
        <SplitPaneContainer node={child} />
      </div>
      {#if i < node.children.length - 1}
        <div
          class="split-gutter"
          class:horizontal={node.orientation === 'horizontal'}
          class:vertical={node.orientation === 'vertical'}
          class:dragging={draggingGutter && dragGutterIndex === i}
          role="separator"
          aria-orientation={node.orientation === 'horizontal' ? 'vertical' : 'horizontal'}
          onpointerdown={(e) => beginGutterDrag(e, i)}
          onpointermove={(e) => onGutterMove(e, totalPx)}
          onpointerup={endGutterDrag}
          onpointercancel={endGutterDrag}
        ></div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .split-container {
    --gutter: 6px;
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .split-cell {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  .split-gutter {
    background: var(--ui-border);
    transition: background-color 0.1s ease;
    touch-action: none;
  }

  .split-gutter.horizontal {
    cursor: col-resize;
  }

  .split-gutter.vertical {
    cursor: row-resize;
  }

  .split-gutter:hover,
  .split-gutter.dragging {
    background: var(--accent-primary);
  }
</style>
