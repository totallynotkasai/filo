<script lang="ts">
  /**
   * KanbanFindBar — narrow text input pinned to the top of the Kanban view.
   *
   * Filters cards in-place via the parent's per-column `tileMatchesFilters`
   * helper (matches title, body via the note store, and frontmatter tags).
   */
  let {
    query,
    onQueryChange,
    onClose,
  }: {
    query: string;
    onQueryChange: (q: string) => void;
    onClose: () => void;
  } = $props();

  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    inputEl?.focus();
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="kanban-find-bar" role="search">
  <svg class="find-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
  <input
    bind:this={inputEl}
    type="text"
    placeholder="Filter cards by title, content, or tags…"
    value={query}
    oninput={(e) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
    onkeydown={onKeydown}
    aria-label="Filter cards"
  />
  <button
    class="close-btn"
    onclick={onClose}
    title="Close (Esc)"
    aria-label="Close find bar"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>

<style>
  .kanban-find-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 24px 0;
    padding: 6px 10px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 8px;
    box-shadow: var(--ui-shadow);
  }

  .find-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .kanban-find-bar input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 13px;
    color: var(--text-primary);
    padding: 2px 0;
  }

  .kanban-find-bar input:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .kanban-find-bar input:focus:not(:focus-visible) {
    outline: none;
  }

  .kanban-find-bar input::placeholder {
    color: var(--text-tertiary);
  }

  .close-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .close-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }
</style>
