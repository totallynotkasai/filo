<script lang="ts">
  /**
   * OrphanCatcher — finds and surfaces orphan tiles on the active Mind Map
   * board. An "orphan" is a text tile with empty content, or any tile that
   * has no connections, no tags, and is farther than `clusterDistance` from
   * its nearest neighbour.
   */
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  // This modal renders at the AppShell root (outside any pane's `BoardScope`
  // context), so it cannot read a pane scope via `getContext`. It doesn't need
  // to: the global `boardStore` is the facade Proxy that delegates to the
  // FOCUSED pane's scope (`getActiveScope()`). `orphansStore.rescan()` reads
  // through the SAME facade, so the scan and this modal's `getTile` /
  // `removeTilesWithHistory` always target the same (focused-pane) board.
  import { boardStore } from '../../stores/board.svelte';
  import { canvasStore } from '../../stores/canvas.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { selectionStore } from '../../stores/selection.svelte';
  import { orphansStore } from '../../stores/orphans.svelte';
  import type { OrphanInfo } from '../../lib/canvas/orphanCatcher';

  let results = $derived(orphansStore.results);
  let clusterDistance = $state(orphansStore.clusterDistance);

  // Bulk selection — set of tileIds the user has ticked for batch delete.
  const selectedIds = new SvelteSet<string>();

  onMount(() => {
    orphansStore.rescan();
    orphansStore.highlightAll();
    return () => orphansStore.clearHighlight();
  });

  function rescan() {
    orphansStore.setClusterDistance(clusterDistance);
    orphansStore.rescan();
    orphansStore.highlightAll();
    // Drop selections that no longer point to live orphans
    const liveIds = new SvelteSet(orphansStore.results.map((r) => r.tileId));
    for (const id of [...selectedIds]) {
      if (!liveIds.has(id)) selectedIds.delete(id);
    }
  }

  function navigateTo(info: OrphanInfo) {
    const tile = boardStore.getTile(info.tileId);
    if (!tile) return;
    orphansStore.highlight(info.tileId);
    selectionStore.select(info.tileId);
    const cx = tile.position.x + tile.size.width / 2;
    const cy = tile.position.y + tile.size.height / 2;
    const targetScale = Math.max(canvasStore.scale, 0.8);
    canvasStore.flyTo({
      x: canvasStore.viewportWidth / 2 - cx * targetScale,
      y: canvasStore.viewportHeight / 2 - cy * targetScale,
      scale: targetScale,
    }, 300);
  }

  function remove(info: OrphanInfo) {
    boardStore.removeTilesWithHistory([info.tileId]);
    // The per-row delete stays single-tap (see the bulk-delete note below);
    // surface a toast with the undo hint so the action isn't invisible, matching the feedback the bulk
    // paths get from their confirm dialog.
    uiStore.toast('Tile deleted — Ctrl+Z to undo', 'info', 2500);
    rescan();
  }

  // Bulk-delete entry points route through `uiStore.openConfirm`
  // so the destructive action picks up the in-app ConfirmDialog chrome
  // (focus management, reduced motion, unified Esc/Enter). The
  // per-row `remove` action stays single-tap because it operates on one
  // already-named tile and the user already chose it (it gives toast
  // feedback instead of a confirm — see `remove` above).
  function removeAll() {
    const ids = results.map((r) => r.tileId);
    if (ids.length === 0) return;
    uiStore.openConfirm({
      title: `Delete ${ids.length} orphan tile${ids.length === 1 ? '' : 's'}?`,
      body: 'This removes the tiles from boards. The files on disk are preserved. This can be undone.',
      confirmLabel: `Delete ${ids.length} tile${ids.length === 1 ? '' : 's'}`,
      danger: true,
      onConfirm: () => {
        boardStore.removeTilesWithHistory(ids);
        rescan();
      },
    });
  }

  function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    uiStore.openConfirm({
      title: `Delete ${ids.length} orphan tile${ids.length === 1 ? '' : 's'}?`,
      body: 'This removes the tiles from boards. The files on disk are preserved. This can be undone.',
      confirmLabel: `Delete ${ids.length} tile${ids.length === 1 ? '' : 's'}`,
      danger: true,
      onConfirm: () => {
        boardStore.removeTilesWithHistory(ids);
        selectedIds.clear();
        rescan();
      },
    });
  }

  function toggleSelected(tileId: string) {
    if (selectedIds.has(tileId)) selectedIds.delete(tileId);
    else selectedIds.add(tileId);
  }

  function selectAll() {
    selectedIds.clear();
    for (const r of results) selectedIds.add(r.tileId);
  }

  function clearSelection() {
    selectedIds.clear();
  }

  let allSelected = $derived(
    results.length > 0 && selectedIds.size === results.length,
  );

  function toggleAll() {
    if (allSelected) clearSelection();
    else selectAll();
  }

  function close() {
    orphansStore.clearHighlight();
    uiStore.closeModal();
  }

  function labelFor(info: OrphanInfo): string {
    const tile = boardStore.getTile(info.tileId);
    const title = tile?.title?.trim() || '(untitled)';
    const reason = info.reason === 'empty' ? 'Empty text tile' : 'Isolated';
    return `${title} — ${reason}`;
  }
</script>

<div class="orphan-body">
  <p class="orphan-intro">
    Tiles with no connections, no tags, and no nearby neighbours — plus any
    text tile whose content is completely empty.
  </p>

  <div class="orphan-controls">
    <label for="orphan-distance">Cluster distance</label>
    <input
      id="orphan-distance"
      type="number"
      min="0"
      step="50"
      bind:value={clusterDistance}
    />
    <span class="orphan-unit">px</span>
    <button type="button" class="orphan-btn" onclick={rescan}>Rescan</button>
  </div>

  {#if results.length === 0}
    <p class="orphan-empty">No orphans found on this board.</p>
  {:else}
    <div class="orphan-bulkbar">
      <label class="orphan-bulk-toggle">
        <input
          type="checkbox"
          checked={allSelected}
          indeterminate={selectedIds.size > 0 && !allSelected}
          onchange={toggleAll}
          aria-label="Select all orphans"
        />
        <span>{selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}</span>
      </label>
      {#if selectedIds.size > 0}
        <button type="button" class="orphan-btn" onclick={clearSelection}>Clear</button>
        <button type="button" class="orphan-btn danger" onclick={deleteSelected}>
          Delete selected ({selectedIds.size})
        </button>
      {/if}
    </div>

    <ul class="orphan-list" role="list">
      {#each results as info (info.tileId)}
        <li class="orphan-item" class:selected={selectedIds.has(info.tileId)}>
          <input
            type="checkbox"
            class="orphan-checkbox"
            checked={selectedIds.has(info.tileId)}
            onchange={() => toggleSelected(info.tileId)}
            aria-label="Select {labelFor(info)}"
          />
          <span class="orphan-label" title={labelFor(info)}>{labelFor(info)}</span>
          <div class="orphan-item-actions">
            <button
              type="button"
              class="orphan-btn"
              onclick={() => navigateTo(info)}
              aria-label="Navigate to orphan tile"
            >Navigate</button>
            <button
              type="button"
              class="orphan-btn danger"
              onclick={() => remove(info)}
              aria-label="Delete orphan tile"
            >Delete</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="orphan-footer">
    {#if results.length > 0}
      <button type="button" class="orphan-btn danger" onclick={removeAll}>
        Delete all ({results.length})
      </button>
    {/if}
    <button type="button" class="orphan-btn" onclick={close}>Close</button>
  </div>
</div>

<style>
  .orphan-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .orphan-intro {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  .orphan-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--ui-bg-secondary);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
  }

  .orphan-controls label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .orphan-controls input {
    width: 80px;
    padding: 3px 6px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
  }

  .orphan-unit {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .orphan-empty {
    padding: 16px;
    text-align: center;
    font-size: var(--font-size-base);
    color: var(--text-tertiary);
    margin: 0;
  }

  .orphan-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 340px;
    overflow-y: auto;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg-secondary);
  }

  .orphan-bulkbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--ui-bg-secondary);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
  }

  .orphan-bulk-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .orphan-checkbox {
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: var(--accent-primary);
    flex-shrink: 0;
  }

  .orphan-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .orphan-item.selected {
    background: var(--selection-bg, rgba(108, 99, 255, 0.08));
  }

  .orphan-item:last-child {
    border-bottom: none;
  }

  .orphan-label {
    flex: 1;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .orphan-item-actions {
    display: flex;
    gap: 4px;
  }

  .orphan-btn {
    padding: 4px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .orphan-btn:hover {
    background: var(--ui-surface-hover);
  }

  .orphan-btn.danger:hover {
    color: var(--accent-danger);
    border-color: var(--accent-danger);
  }

  .orphan-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
