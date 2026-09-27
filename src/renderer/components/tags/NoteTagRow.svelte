<script lang="ts">
  /**
   * NoteTagRow — the note's tags as a row at the top of the note.
   *
   * The note's frontmatter `tags:` is the only copy of its tags, so the row
   * reads them from the note and writes a frontmatter change through the
   * note writer (one board-undo step per edit). Type tags separated by
   * commas; Enter, a comma or leaving the field adds them, with suggestions
   * from the vault's tags. Backspace in the empty field removes the last one.
   * Clicking a tag opens its menu (files and tiles with that tag).
   */
  import { noteTags } from '../../stores/noteMeta';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { UpdatePropertiesCommand } from '../../commands/propertiesCommands';
  import { parseTagInput, withTagsAdded, tagSuggestions, completeLastEntry } from '../../lib/tags/tagRowInput';
  import { portal } from '../../lib/utils/portal';
  import { createId } from '../../lib/utils/ids';
  import TagBadge from './TagBadge.svelte';
  import TagsPopupMenu from './TagsPopupMenu.svelte';

  let {
    path,
    boardId,
    readOnly = false,
  }: {
    /** The note's vault path. */
    path: string;
    /** The board (or Document tab) whose undo stack records the edit. */
    boardId: string;
    /** The note can't be written (not UTF-8, missing, unreadable). */
    readOnly?: boolean;
  } = $props();

  const listId = `note-tag-suggestions-${createId(6)}`;
  let tags = $derived(noteTags(path));
  let text = $state('');
  let open = $state(false);
  let highlighted = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let tagMenu = $state<{ tagName: string; x: number; y: number } | null>(null);

  let suggestions = $derived(open ? tagSuggestions(text, fileTagsStore.allTagNames(), tags) : []);

  $effect(() => {
    if (highlighted >= suggestions.length) highlighted = Math.max(0, suggestions.length - 1);
  });

  /** Writes `next` as the note's tag list, as one undoable step. */
  function setTags(next: string[]): void {
    const before = [...tags];
    if (next.length === before.length && next.every((t, i) => t === before[i])) return;
    for (const name of next) if (!before.includes(name)) fileTagsStore.ensureTag(name);
    // An empty list removes the key rather than writing `tags: []`.
    historyStore.execute(
      new UpdatePropertiesCommand(
        { kind: 'frontmatter', relPath: path, fm: before.length > 0 ? { tags: before } : {} },
        { kind: 'frontmatter', relPath: path, fm: next.length > 0 ? { tags: next } : {} },
        boardId,
      ),
    );
  }

  function commitText(): void {
    if (!text.trim()) {
      text = '';
      return;
    }
    const parsed = parseTagInput(text, fileTagsStore.allTagNames());
    if (parsed.invalid.length > 0) {
      uiStore.toast(
        `${parsed.invalid.map((t) => `"${t}"`).join(', ')} ${parsed.invalid.length === 1 ? "isn't a valid tag name" : "aren't valid tag names"} — avoid commas, plain numbers, and leading symbols like @ * : &`,
        'warning',
        4000,
      );
    }
    setTags(withTagsAdded(tags, parsed.tags));
    // Keep what couldn't be added so the user can fix it.
    text = parsed.invalid.join(', ');
    open = false;
  }

  function removeTag(name: string): void {
    setTags(tags.filter((t) => t !== name));
  }

  function pick(name: string): void {
    text = completeLastEntry(text, name);
    commitText();
    inputEl?.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault();
      highlighted = (highlighted + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
      e.preventDefault();
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = suggestions[highlighted];
      if (choice) pick(choice);
      else commitText();
    } else if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault();
      text = completeLastEntry(text, suggestions[highlighted] ?? suggestions[0]!);
      open = false;
    } else if (e.key === ',') {
      // The comma separates entries; commit what's typed so far.
      e.preventDefault();
      commitText();
    } else if (e.key === 'Backspace' && text === '' && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]!);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      open = false;
    }
  }

  function onInput(): void {
    open = text.trim().length > 0;
    highlighted = 0;
  }

  function openTagMenu(name: string, e: MouseEvent): void {
    e.stopPropagation();
    tagMenu = tagMenu?.tagName === name ? null : { tagName: name, x: e.clientX, y: e.clientY };
  }
</script>

<div class="note-tag-row" role="group" aria-label="Tags">
  {#each tags as name (name)}
    <span class="note-tag">
      <TagBadge tagName={name} size="sm" onClick={(e) => openTagMenu(name, e)} />
      {#if !readOnly}
        <button
          type="button"
          class="note-tag-remove"
          aria-label="Remove tag {name}"
          title="Remove tag"
          onclick={() => removeTag(name)}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      {/if}
    </span>
  {/each}
  {#if !readOnly}
    <div class="note-tag-input-wrap">
      <input
        bind:this={inputEl}
        bind:value={text}
        class="note-tag-input"
        type="text"
        role="combobox"
        aria-label="Add tags, separated by commas"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={tags.length === 0 ? 'Add tags, separated by commas' : 'Add tag'}
        spellcheck="false"
        autocomplete="off"
        oninput={onInput}
        onkeydown={onKeydown}
        onblur={commitText}
      />
      {#if suggestions.length > 0}
        <ul class="note-tag-suggestions" id={listId} role="listbox">
          {#each suggestions as name, i (name)}
            <li role="option" aria-selected={i === highlighted}>
              <button
                type="button"
                class:highlighted={i === highlighted}
                tabindex="-1"
                onmousedown={(e) => { e.preventDefault(); pick(name); }}
              >#{name}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

{#if tagMenu}
  <div
    use:portal
    class="note-tag-menu-overlay"
    onclick={() => (tagMenu = null)}
    onkeydown={(e) => { if (e.key === 'Escape') tagMenu = null; }}
    role="presentation"
  ></div>
  <div
    use:portal
    class="note-tag-menu-anchor"
    style="position: fixed; left: {tagMenu.x}px; top: {tagMenu.y}px;"
  >
    <TagsPopupMenu tagName={tagMenu.tagName} onClose={() => (tagMenu = null)} />
  </div>
{/if}

<style>
  .note-tag-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tag-row-gap);
    min-height: 26px;
  }

  .note-tag {
    display: inline-flex;
    align-items: center;
  }

  .note-tag-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 1px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, background-color 0.12s ease;
  }

  .note-tag:hover .note-tag-remove,
  .note-tag-remove:focus-visible {
    opacity: 1;
  }

  .note-tag-remove:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .note-tag-input-wrap {
    position: relative;
    flex: 1;
    min-width: 140px;
  }

  .note-tag-input {
    width: 100%;
    padding: 2px 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
  }

  .note-tag-input::placeholder {
    color: var(--text-tertiary);
  }

  .note-tag-input:hover,
  .note-tag-input:focus {
    border-color: var(--ui-border);
  }

  .note-tag-suggestions {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    z-index: var(--z-tile-popup);
    min-width: 180px;
    max-height: 220px;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .note-tag-suggestions button {
    display: block;
    width: 100%;
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .note-tag-suggestions button.highlighted,
  .note-tag-suggestions button:hover {
    background: var(--ui-surface-hover);
  }

  .note-tag-menu-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-tile-popup-overlay);
  }

  .note-tag-menu-anchor {
    z-index: var(--z-tile-popup);
  }

  @media (prefers-reduced-motion: reduce) {
    .note-tag-remove {
      transition: none;
    }
  }
</style>
