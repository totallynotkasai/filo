<script lang="ts">
  import { tick } from 'svelte';
  import Modal from '../shared/Modal.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateTilePathCommand } from '../../commands/index';
  import { flattenTreePaths } from '../../lib/vault/vaultTreeSort';

  /**
   * Re-link picker. Surfaces a flat list of vault files
   * filtered to the extensions compatible with the broken tile's type.
   * Selecting a file rebinds the tile's path (`filePath` for text/file,
   * `src` for image/video/audio) through `UpdateTilePathCommand` so the
   * change is undoable.
   *
   * Sidebar-scoped, per the implementation plan: we list only files the
   * vault tree currently knows about — no full filesystem picker — so
   * the modal honours the local-first invariant (no leaking paths
   * outside the vault).
   */

  const MODAL_ID = 'relink-tile';

  // Stored on the uiStore as a side-channel so we don't need to thread the
  // tile object through the modal API (`uiStore.openModal` is keyed by
  // string alone).
  type RelinkContext = { tileId: string; expectedTypes: string[] };

  const isOpen = $derived(uiStore.isModalOpen(MODAL_ID));
  const ctx = $derived(uiStore.relinkContext);
  let filter = $state('');
  let filterInputEl = $state<HTMLInputElement | null>(null);

  // Reset filter on open so the previous session's text doesn't leak.
  // Also autofocus the filter input once the modal has mounted so keyboard
  // users can start typing immediately. `await tick()` waits for the
  // Modal's `showModal()` + focus-trap activation to settle before we
  // claim focus.
  $effect(() => {
    if (!isOpen) return;
    filter = '';
    void (async () => {
      await tick();
      filterInputEl?.focus();
    })();
  });

  const candidates = $derived.by(() => {
    if (!ctx || !vaultStore.path) return [] as string[];
    const all = Array.from(flattenTreePaths(vaultStore.rawTree, vaultStore.path));
    const expected = ctx.expectedTypes.map((e) => e.toLowerCase());
    return all
      .filter((rel) => {
        const ext = rel.split('.').pop()?.toLowerCase() ?? '';
        return expected.includes(ext);
      })
      .filter((rel) => filter === '' || rel.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  });

  function pick(newPath: string): void {
    if (!ctx) return;
    const tile = boardStore.getTile(ctx.tileId);
    if (!tile) {
      uiStore.toast('Tile no longer exists; re-link cancelled.', 'error', 4000);
      uiStore.closeModal();
      return;
    }
    const oldPath = inferTilePath(tile);
    if (oldPath === newPath) {
      uiStore.closeModal();
      return;
    }
    historyStore.execute(new UpdateTilePathCommand(ctx.tileId, oldPath, newPath));
    uiStore.toast(`Re-linked to "${newPath}"`, 'success', 2500);
    uiStore.closeModal();
  }

  /**
   * Reads the current path off the tile def, regardless of which field
   * the type uses. Mirrors the tile-type-keyed dispatch in
   * `UpdateTilePathCommand`. Returns '' when no path is set (legacy or
   * fresh tile).
   */
  function inferTilePath(tile: Record<string, unknown>): string {
    const type = tile.type as string;
    if (type === 'text' || type === 'file') return (tile.filePath as string) ?? '';
    if (type === 'image' || type === 'video' || type === 'audio') return (tile.src as string) ?? '';
    return '';
  }
</script>

<Modal id={MODAL_ID} title="Re-link tile" width="560px">
  <div class="relink-body">
    {#if !ctx}
      <p class="relink-empty">No tile selected.</p>
    {:else}
      <p class="relink-hint">
        Pick a {ctx.expectedTypes.join(' / ')} file to replace the broken reference. Undo restores the previous path.
      </p>
      <input
        type="text"
        class="relink-filter"
        bind:this={filterInputEl}
        bind:value={filter}
        placeholder="Filter by path..."
        aria-label="Filter files"
      />
      {#if candidates.length === 0}
        <p class="relink-empty">No matching files in the vault.</p>
      {:else}
        <ul class="relink-list" aria-label="Available files">
          {#each candidates as path (path)}
            <li>
              <button
                type="button"
                class="relink-item"
                onclick={() => pick(path)}
              >
                {path}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .relink-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
  }
  .relink-hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .relink-filter {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 0.9rem;
  }
  .relink-filter:focus {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }
  .relink-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
  }
  .relink-list li {
    margin: 0;
  }
  .relink-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--ui-border);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: inherit;
    cursor: pointer;
  }
  .relink-item:last-child {
    border-bottom: none;
  }
  .relink-item:hover,
  .relink-item:focus-visible {
    background: var(--ui-surface-hover);
  }
  .relink-empty {
    margin: 0;
    color: var(--text-secondary);
    font-style: italic;
    font-size: 0.875rem;
  }
</style>
