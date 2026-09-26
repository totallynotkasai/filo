<script lang="ts">
  // No board scope here: the Tags Browser opens this popup from the app shell,
  // outside every board pane. Going to a tile goes through the shared
  // navigateToTile, which opens the tile's board and acts on that pane.
  import { SvelteSet } from 'svelte/reactivity';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { isMarkdownExtension } from '../../lib/vault/extension';
  import { navigateToTile } from '../../lib/utils/navigation.svelte';

  import TagBadge from './TagBadge.svelte';

  let { tagName, onClose }: { tagName: string, onClose: () => void } = $props();

  let color = $derived(fileTagsStore.getDefinition(tagName).color);
  let tiles = $derived(fileTagsStore.getTilesWithTag(tagName));

  let placedPaths = $derived.by(() => {
    const out = new SvelteSet<string>();
    for (const t of tiles) if (t.path) out.add(t.path);
    return out;
  });
  let files = $derived(fileTagsStore.getFilesWithTag(tagName, placedPaths));

  function getBoardName(boardId: string): string {
    const board = vaultStore.project?.boards.find((b) => b.id === boardId);
    return board?.name || 'Unknown Board';
  }

  function goToTile(boardId: string, tileId: string) {
    navigateToTile(boardId, tileId);
    onClose();
  }

  function navigateToFile(path: string) {
    const dot = path.lastIndexOf('.');
    // Only a note opens as a document; a tagged media file has no document view.
    if (dot >= 0 && isMarkdownExtension(path.slice(dot))) openNoteInDocumentTab(path);
    onClose();
  }
</script>

<div
  class="tags-popup"
  role="dialog"
  aria-labelledby="tags-popup-menu-title"
  aria-modal="false"
>
  <div class="header">
    <div class="title">
      <span class="color-dot" style="background: {color}"></span>
      <span id="tags-popup-menu-title">{tagName}</span>
    </div>
    <div class="subtitle">{tiles.length + files.length} items</div>
  </div>

  <div class="tile-list">
    {#if tiles.length > 0}
      <div class="section-header">Tiles</div>
    {/if}
    {#each tiles as tile (`${tile.boardId}/${tile.id}`)}
      <button class="tile-item" onclick={() => goToTile(tile.boardId, tile.id)}>
        <span class="tile-icon" aria-hidden="true">
          {#if tile.type === 'text'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
          {:else if tile.type === 'image'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          {:else if tile.type === 'video'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          {/if}
        </span>
        <div class="tile-details">
          <div class="tile-title">{tile.title || 'Untitled'}</div>
          <div class="tile-board">{getBoardName(tile.boardId)}</div>
          <div class="tile-tags">
            {#each tile.tags as other (other)}
              {#if other !== tagName}
                <TagBadge tagName={other} size="sm" variant="outline" />
              {/if}
            {/each}
          </div>
        </div>
      </button>
    {/each}

    {#if files.length > 0}
      <div class="section-header">Files</div>
    {/if}
    {#each files as file (file.path)}
      <button class="tile-item" onclick={() => navigateToFile(file.path)}>
        <span class="tile-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </span>
        <div class="tile-details">
          <div class="tile-title">{file.title || file.path}</div>
          <div class="tile-board">{file.path}</div>
        </div>
      </button>
    {/each}

    {#if tiles.length === 0 && files.length === 0}
      <div class="empty">No tiles or files found with this tag</div>
    {/if}
  </div>
</div>

<style>
  .tags-popup {
    width: 260px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-elevated);
    display: flex;
    flex-direction: column;
    max-height: 300px;
    overflow: hidden;
  }
  .header {
    padding: 12px;
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-surface-hover);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }
  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .subtitle {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 4px;
    margin-left: 14px;
  }
  .tile-list {
    overflow-y: auto;
    padding: 6px 0;
  }
  .section-header {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 6px 12px 4px;
  }
  .tile-item {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 12px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }
  .tile-item:hover {
    background: var(--ui-surface-active);
  }
  .tile-icon {
    font-size: 16px;
    line-height: 1.2;
    opacity: 0.8;
  }
  .tile-details {
    flex: 1;
    min-width: 0;
  }
  .tile-title {
    font-size: 12px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile-board {
    font-size: 10px;
    color: var(--text-tertiary);
    margin-top: 1px;
  }
  .tile-tags {
    display: flex;
    gap: 4px;
    margin-top: 2px;
    overflow: hidden;
  }
  .empty {
    padding: 16px;
    text-align: center;
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
