<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { isSafeNewTagName } from '../../lib/vault/tagsStorage';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  // BoardScope is only required for tile-mode (single / multi). In file-path
  // mode the editor reads + writes via vault-relative paths, so no scope is
  // needed and `getContext` may return undefined (sidebar, document board).
  const scope = getContext<BoardScope | undefined>(BOARD_SCOPE_KEY);
  const boardStore = scope?.board;

  /**
   * Three modes, mutually exclusive:
   *   - Single tile: pass `tileId`. Reads/writes via `addTagToTile` /
   *     `removeTagFromTile` (three-sink write through the tile).
   *   - Multi-tile: pass `tileIds` (length > 1). Shows union; add/remove
   *     applies to every tile in the set.
   *   - File path: pass `filePath`. Reads/writes via `addTagToPath` /
   *     `removeTagFromPath` (three-sink write driven by the path). Used by
   *     the sidebar file editor and the Document board.
   */
  let { tileId, tileIds, filePath, onClose }: {
    tileId?: string;
    tileIds?: string[];
    filePath?: string;
    onClose: () => void;
  } = $props();

  let effectiveIds = $derived<string[]>(
    tileIds && tileIds.length > 0 ? tileIds : tileId ? [tileId] : [],
  );
  let isMulti = $derived(effectiveIds.length > 1);
  let isFileMode = $derived(!!filePath && effectiveIds.length === 0);

  // Kanban / Task board types leave `boardStore.tiles` empty (the
  // `getFullTilesForBoard` mindmap guard, see fileTags.svelte.ts:639-644), so
  // `getTile()` returns undefined for their cards. Fall back to `allTileDefs`
  // so single-tile mode resolves on every board type.
  let tile = $derived.by(() => {
    if (!tileId || !boardStore) return undefined;
    return boardStore.getTile(tileId) ?? boardStore.allTileDefs[tileId];
  });
  let inputValue = $state('');

  // Autocomplete dropdown state.
  let showSuggestions = $state(false);
  let highlightedIndex = $state(0);

  // Union of tags across the selection (and a count of how many tiles carry each tag).
  let aggregatedTags = $derived.by(() => {
    if (isFileMode) {
      return fileTagsStore
        .tagsForFile(filePath!)
        .map((t): [string, number] => [t, 1])
        .sort((a, b) => a[0].localeCompare(b[0]));
    }
    if (!boardStore) return [] as Array<[string, number]>;
    const counts = new SvelteMap<string, number>();
    for (const id of effectiveIds) {
      const t = boardStore.getTile(id);
      if (!t) continue;
      for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });

  // Suggestions = all known tags minus those already applied, filtered by
  // the typed prefix (case-insensitive substring match). Cap to keep the
  // dropdown short.
  let suggestions = $derived.by(() => {
    const query = inputValue.trim().replace(/^#/, '').toLowerCase();
    if (!query) return [] as string[];
    const applied = new Set(aggregatedTags.map(([t]) => t.toLowerCase()));
    const all = fileTagsStore.allTagNames();
    const out: string[] = [];
    for (const name of all) {
      const lower = name.toLowerCase();
      if (applied.has(lower)) continue;
      if (!lower.includes(query)) continue;
      out.push(name);
      if (out.length >= 8) break;
    }
    return out;
  });

  // Clamp the highlighted index whenever the suggestion list shrinks so the
  // arrow-key cursor never points past the end. Re-runs on every list change.
  $effect(() => {
    if (highlightedIndex >= suggestions.length) {
      highlightedIndex = Math.max(0, suggestions.length - 1);
    }
  });

  function commitTag(rawName: string): void {
    const trimmed = rawName.trim().replace(/^#/, '');
    if (!trimmed) return;
    // Sprint B / B6 + 1.5a — reject names that round-trip badly through YAML
    // frontmatter (internal whitespace splits into two tags), produce an empty
    // registry key, or that YAML reads as a non-string / indicator-led scalar
    // (123, null, @home). The rewriter quotes on disk, but these make
    // confusing tags; reject at the input boundary and toast so the user knows.
    if (!isSafeNewTagName(trimmed)) {
      uiStore.toast(
        `Tag "${trimmed}" isn't a valid name — avoid spaces, plain numbers, and leading symbols like @ * : &`,
        'warning',
        3500,
      );
      return;
    }
    if (isFileMode) {
      fileTagsStore.addTagToPath(filePath!, trimmed);
      return;
    }
    if (!boardStore) return;
    for (const id of effectiveIds) {
      fileTagsStore.addTagToTile(id, trimmed);
    }
  }

  function handleAddTag() {
    // Prefer the highlighted suggestion when the dropdown is open and has
    // entries; otherwise commit the literal text (supports comma-separated).
    if (showSuggestions && suggestions.length > 0) {
      commitTag(suggestions[highlightedIndex] ?? suggestions[0]);
      inputValue = '';
      showSuggestions = false;
      return;
    }
    const val = inputValue.trim();
    if (!val) return;
    const tagNames = val.split(',').map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
    for (const name of tagNames) commitTag(name);
    inputValue = '';
    showSuggestions = false;
  }

  function handleRemove(tagName: string) {
    if (isFileMode) {
      fileTagsStore.removeTagFromPath(filePath!, tagName);
      return;
    }
    if (!boardStore) return;
    for (const id of effectiveIds) {
      fileTagsStore.removeTagFromTile(id, tagName);
    }
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      showSuggestions = true;
      highlightedIndex = (highlightedIndex + 1) % suggestions.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      showSuggestions = true;
      highlightedIndex = (highlightedIndex - 1 + suggestions.length) % suggestions.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
      return;
    }
    if (e.key === 'Escape') {
      // Escape dismisses the dropdown without closing the popup; a second
      // Escape (with no dropdown) falls through to the Modal's close
      // handler / app:cancel command.
      if (showSuggestions) {
        e.preventDefault();
        e.stopPropagation();
        showSuggestions = false;
      }
      return;
    }
    if (e.key === 'Tab' && showSuggestions && suggestions.length > 0) {
      e.preventDefault();
      inputValue = suggestions[highlightedIndex] ?? suggestions[0];
      showSuggestions = false;
    }
  }

  function handleInput() {
    showSuggestions = inputValue.trim().length > 0;
    highlightedIndex = 0;
  }

  function pickSuggestion(name: string) {
    commitTag(name);
    inputValue = '';
    showSuggestions = false;
  }

  // Focus restoration: keyboard users return to the trigger on close.
  $effect(() => {
    const triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });

  // Focus trap — keeps Tab cycling within the popup so keyboard users can't
  // wander into the canvas / board behind it. Escape still closes via the
  // existing input keydown handler at handleInputKeydown. We mount the trap
  // after the DOM lands (next microtask) so the trigger element's focus has
  // already moved into the dialog.
  let popupRoot: HTMLDivElement | null = $state(null);
  $effect(() => {
    if (!popupRoot) return;
    let trap: FocusTrap | null = null;
    try {
      trap = createFocusTrap(popupRoot, {
        escapeDeactivates: false,
        clickOutsideDeactivates: true,
        allowOutsideClick: true,
        returnFocusOnDeactivate: false,
        initialFocus: false,
      });
      trap.activate();
    } catch (err) {
      console.warn('[TagEditor] focus trap failed to activate:', err);
    }
    return () => { safeDeactivateTrap(trap); };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="tag-editor-popup"
  role="dialog"
  aria-labelledby="tag-editor-popup-title"
  tabindex="-1"
  bind:this={popupRoot}
  onclick={(e) => e.stopPropagation()}
>
  <div class="header">
    <h3 id="tag-editor-popup-title">
      {#if isMulti}
        Edit Tags ({effectiveIds.length} tiles)
      {:else}
        Edit Tags
      {/if}
    </h3>
    <button class="close-btn" onclick={onClose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <div class="tag-input-row">
    <div class="input-wrapper">
      <input
        type="text"
        role="combobox"
        bind:value={inputValue}
        placeholder="Add tags (comma separated)"
        oninput={handleInput}
        onfocus={() => { if (inputValue.trim()) showSuggestions = true; }}
        onkeydown={handleInputKeydown}
        aria-autocomplete="list"
        aria-controls="tag-editor-suggestions"
        aria-expanded={showSuggestions && suggestions.length > 0}
      />
      {#if showSuggestions && suggestions.length > 0}
        <ul class="suggestions" id="tag-editor-suggestions" role="listbox">
          {#each suggestions as name, i (name)}
            {@const color = fileTagsStore.getDefinition(name).color}
            <li
              class="suggestion"
              class:highlighted={i === highlightedIndex}
              role="option"
              aria-selected={i === highlightedIndex}
            >
              <button
                type="button"
                class="suggestion-btn"
                onmousedown={(e) => { e.preventDefault(); pickSuggestion(name); }}
                onmouseenter={() => { highlightedIndex = i; }}
              >
                <span class="color-dot" style="background: {color}"></span>
                <span class="suggestion-name">{name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <button class="add-btn" onclick={handleAddTag}>
      {#if isMulti}Add to all{:else}Add{/if}
    </button>
  </div>

  <div class="current-tags">
    {#if isMulti}
      {#if aggregatedTags.length === 0}
        <div class="empty">No tags on any selected tile</div>
      {:else}
        {#each aggregatedTags as [tagName, count] (tagName)}
          {@const color = fileTagsStore.getDefinition(tagName).color}
          {@const partial = count < effectiveIds.length}
          <div class="tag-chip" class:partial title={partial ? `On ${count} of ${effectiveIds.length} selected tiles` : `On all selected tiles`}>
            <span class="color-dot" style="background: {color}"></span>
            <span class="name">{tagName}{partial ? ` (${count}/${effectiveIds.length})` : ''}</span>
            <button class="remove-btn" onclick={() => handleRemove(tagName)} aria-label={`Remove ${tagName} from selected tiles`}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </div>
        {/each}
      {/if}
    {:else if isFileMode}
      {#if aggregatedTags.length === 0}
        <div class="empty">No tags on this file</div>
      {:else}
        {#each aggregatedTags as [tagName] (tagName)}
          {@const color = fileTagsStore.getDefinition(tagName).color}
          <div class="tag-chip">
            <span class="color-dot" style="background: {color}"></span>
            <span class="name">{tagName}</span>
            <button class="remove-btn" onclick={() => handleRemove(tagName)} aria-label={`Remove ${tagName} tag`}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </div>
        {/each}
      {/if}
    {:else if tile?.tags.length === 0}
      <div class="empty">No tags assigned</div>
    {:else}
      {#each tile?.tags || [] as tagName (tagName)}
        {@const color = fileTagsStore.getDefinition(tagName).color}
        <div class="tag-chip">
          <span class="color-dot" style="background: {color}"></span>
          <span class="name">{tagName}</span>
          <button class="remove-btn" onclick={() => handleRemove(tagName)} aria-label={`Remove ${tagName} tag`}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tag-editor-popup {
    width: 280px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-elevated);
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 12px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header h3 {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--text-primary);
  }
  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
  }
  .close-btn:hover {
    color: var(--text-primary);
  }
  .tag-input-row {
    display: flex;
    gap: 6px;
  }
  .input-wrapper {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  input {
    width: 100%;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    font-size: 12px;
  }
  .suggestions {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 10;
    list-style: none;
    margin: 0;
    padding: 4px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    box-shadow: var(--ui-shadow-elevated);
    max-height: 140px;
    overflow-y: auto;
  }
  .suggestion-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-primary);
  }
  .suggestion.highlighted .suggestion-btn,
  .suggestion-btn:hover {
    background: var(--ui-surface-hover);
  }
  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-btn {
    padding: 6px 10px;
    border-radius: 4px;
    border: none;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .add-btn:hover {
    background: var(--accent-primary-hover);
  }
  .current-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 150px;
    overflow-y: auto;
  }
  .tag-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    padding: 2px 6px;
    border-radius: 12px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .tag-chip.partial {
    opacity: 0.7;
    border-style: dashed;
  }
  .color-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .remove-btn {
    background: transparent;
    border: none;
    padding: 0 2px;
    margin-left: 2px;
    cursor: pointer;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .remove-btn:hover {
    color: var(--status-error, red);
  }
  .empty {
    font-size: 11px;
    color: var(--text-tertiary);
    width: 100%;
    text-align: center;
    padding: 8px 0;
  }
</style>
