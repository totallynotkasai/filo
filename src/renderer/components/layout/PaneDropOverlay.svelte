<script lang="ts">
  /**
   * PaneDropOverlay — invisible drop targets on the four edges of the workspace
   * that let a user split by dragging a tab onto an edge. Only shows visual
   * highlighting when a tab drag is in progress.
   */
  import { tabStore } from '../../stores/tabs.svelte';
  import { workspaceStore } from '../../stores/workspace.svelte';

  const EDGE_PX = 60;

  let dragActive = $state(false);
  let hoveredEdge = $state<'left' | 'right' | 'top' | 'bottom' | null>(null);

  function handleWindowDragStart(e: DragEvent) {
    // Heuristic: only activate if the drag carries a tab id marker.
    const types = e.dataTransfer?.types;
    if (types && Array.from(types).includes('application/x-filo-tab-id')) {
      dragActive = true;
    }
  }

  function handleWindowDragEnd() {
    dragActive = false;
    hoveredEdge = null;
  }

  function onEdgeDragOver(e: DragEvent, edge: 'left' | 'right' | 'top' | 'bottom') {
    if (!dragActive) return;
    if (workspaceStore.leafCount >= 3) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    hoveredEdge = edge;
  }

  function onEdgeDragLeave() {
    hoveredEdge = null;
  }

  function onEdgeDrop(e: DragEvent, edge: 'left' | 'right' | 'top' | 'bottom') {
    if (!dragActive) return;
    e.preventDefault();
    const tabId = e.dataTransfer?.getData('application/x-filo-tab-id');
    if (!tabId) return;
    const tab = tabStore.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    workspaceStore.splitRoot(tab.id, edge);
    dragActive = false;
    hoveredEdge = null;
  }

  $effect(() => {
    window.addEventListener('dragstart', handleWindowDragStart, true);
    window.addEventListener('dragend', handleWindowDragEnd, true);
    return () => {
      window.removeEventListener('dragstart', handleWindowDragStart, true);
      window.removeEventListener('dragend', handleWindowDragEnd, true);
    };
  });
</script>

{#if dragActive}
  <div class="pane-drop-overlay" style="--edge: {EDGE_PX}px;">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="edge edge-left"
      class:hovered={hoveredEdge === 'left'}
      ondragover={(e) => onEdgeDragOver(e, 'left')}
      ondragleave={onEdgeDragLeave}
      ondrop={(e) => onEdgeDrop(e, 'left')}
    ></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="edge edge-right"
      class:hovered={hoveredEdge === 'right'}
      ondragover={(e) => onEdgeDragOver(e, 'right')}
      ondragleave={onEdgeDragLeave}
      ondrop={(e) => onEdgeDrop(e, 'right')}
    ></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="edge edge-top"
      class:hovered={hoveredEdge === 'top'}
      ondragover={(e) => onEdgeDragOver(e, 'top')}
      ondragleave={onEdgeDragLeave}
      ondrop={(e) => onEdgeDrop(e, 'top')}
    ></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="edge edge-bottom"
      class:hovered={hoveredEdge === 'bottom'}
      ondragover={(e) => onEdgeDragOver(e, 'bottom')}
      ondragleave={onEdgeDragLeave}
      ondrop={(e) => onEdgeDrop(e, 'bottom')}
    ></div>
  </div>
{/if}

<style>
  .pane-drop-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: var(--z-pane-drop-overlay);
  }

  .edge {
    position: absolute;
    pointer-events: auto;
    background: transparent;
    transition: background-color 0.12s ease, border-color 0.12s ease;
    border: 2px solid transparent;
  }

  .edge.hovered {
    background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
    border-color: var(--accent-primary);
  }

  .edge-left {
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--edge);
  }

  .edge-right {
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--edge);
  }

  .edge-top {
    top: 0;
    left: 0;
    right: 0;
    height: var(--edge);
  }

  .edge-bottom {
    bottom: 0;
    left: 0;
    right: 0;
    height: var(--edge);
  }
</style>
