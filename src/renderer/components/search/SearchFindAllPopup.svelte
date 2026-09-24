<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { searchStore } from '../../stores/search.svelte';

  /**
   * SearchFindAllPopup — flat list of every match in the current result set.
   * Anchored to the page right-side as a sibling overlay to
   * `SearchPanel`. Click a row to jump to the match; pressing Enter on a
   * keyboard-focused row does the same.
   *
   * Caps at `searchStore.maxMatches` entries; a "+ N more — refine your
   * query" footer appears when truncated. ESC closes the popup; the panel
   * itself stays open.
   */

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let listEl = $state<HTMLDivElement | null>(null);
  let focusedIndex = $state(-1);

  function jumpTo(index: number): void {
    searchStore.jumpTo(index);
  }

  function onRowKeydown(e: KeyboardEvent, index: number): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(searchStore.matches.length - 1, index + 1);
      focusRow(focusedIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(0, index - 1);
      focusRow(focusedIndex);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      jumpTo(index);
    }
  }

  function focusRow(index: number): void {
    if (!listEl) return;
    const row = listEl.querySelector<HTMLButtonElement>(`[data-match-index="${index}"]`);
    row?.focus();
  }

  onMount(() => {
    // Focus the current match's row on open so keyboard users land somewhere
    // meaningful instead of at the top of an unread list.
    focusedIndex = searchStore.currentIndex;
    queueMicrotask(() => focusRow(focusedIndex));
  });

  onDestroy(() => {
    // Nothing to dispose — focus restoration is the caller's job.
  });
</script>

{#snippet typeIconInner(type: string | null)}
  {#if type === 'text'}
    <path d="M4 6h16M4 12h10M4 18h14"/>
  {:else if type === 'image'}
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>
  {:else if type === 'video'}
    <path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/>
  {:else if type === 'audio'}
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
  {:else if type === 'file'}
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
  {:else if type === 'link'}
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  {:else if type === 'iframe'}
    <path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16"/>
  {:else if type === 'timer'}
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2"/>
  {:else}
    <circle cx="12" cy="12" r="2"/>
  {/if}
{/snippet}

<div
  class="findall-popup"
  role="dialog"
  aria-label="All matches"
  bind:this={listEl}
>
  <header class="findall-header">
    <span>{searchStore.matches.length} matches</span>
    <button type="button" class="close" onclick={onclose} aria-label="Close all-matches popup" title="Close (Esc)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </header>

  <div class="findall-list" role="listbox" aria-label="Match list">
    {#each searchStore.matches as match, i (i)}
      <button
        type="button"
        role="option"
        class="findall-row"
        class:active={i === searchStore.currentIndex}
        aria-selected={i === searchStore.currentIndex}
        data-match-index={i}
        onclick={() => jumpTo(i)}
        onkeydown={(e) => onRowKeydown(e, i)}
      >
        <span class="row-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {@render typeIconInner(match.tileType)}
          </svg>
        </span>
        <span class="row-main">
          <span class="row-title">{match.tileTitle || '(untitled)'}</span>
          <span class="row-meta">
            <span class="row-board">{match.boardName}</span>
            {#if match.tags.length > 0}
              <span class="row-tags">{match.tags.map((t) => `#${t}`).join(' ')}</span>
            {/if}
          </span>
          <span class="row-snippet">{match.snippet}</span>
        </span>
      </button>
    {/each}
  </div>

  {#if searchStore.truncated}
    <footer class="findall-footer">
      Showing first {searchStore.maxMatches} matches — refine your query for more.
    </footer>
  {/if}
</div>

<style>
  .findall-popup {
    position: fixed;
    z-index: var(--z-floating, 800);
    top: 72px;
    right: 16px;
    width: 380px;
    max-height: 60vh;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    box-shadow: var(--ui-shadow-md, 0 4px 16px rgba(0, 0, 0, 0.18));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--text-primary);
    font-family: var(--font-system);
  }

  .findall-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--ui-border);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
  }

  .close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .findall-list {
    overflow-y: auto;
    flex: 1;
  }

  .findall-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    text-align: left;
    color: inherit;
    cursor: pointer;
    font-family: inherit;
    border-bottom: 1px solid var(--ui-border-soft, transparent);
  }

  .findall-row:hover,
  .findall-row:focus-visible {
    background: var(--ui-surface-hover);
    outline: none;
  }

  .findall-row.active {
    background: var(--ui-surface-hover);
  }

  .row-icon {
    display: inline-flex;
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--text-secondary);
  }

  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .row-title {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .row-board {
    color: var(--text-secondary);
  }

  .row-tags {
    color: var(--accent-primary);
  }

  .row-snippet {
    font-size: 11px;
    color: var(--text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .findall-footer {
    padding: 6px 12px;
    border-top: 1px solid var(--ui-border);
    font-size: 11px;
    color: var(--text-tertiary);
    text-align: center;
  }
</style>
