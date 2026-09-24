<script lang="ts">
  import { uiStore } from '../../stores/ui.svelte';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import Modal from '../shared/Modal.svelte';
  import IconButton from '../shared/IconButton.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import TagsPopupMenu from './TagsPopupMenu.svelte';
  import { isSafeNewTagName } from '../../lib/vault/tagsStorage';

  let activeColorPicker = $state<string | null>(null);
  let editingTagName = $state<string | null>(null);
  let editName = $state('');
  let activeTagMenu = $state<{ tagName: string; x: number; y: number } | null>(null);
  let scope = $state<'all' | 'files' | 'tiles'>('all');

  const knownTagNames = $derived(
    [...fileTagsStore.allTagNames()].sort((a, b) => a.localeCompare(b)),
  );

  function fileCount(name: string): number {
    return fileTagsStore.filesForTag(name).length;
  }

  function tileCount(name: string): number {
    return fileTagsStore.getTilesWithTag(name).length;
  }

  function colorFor(name: string): string {
    return fileTagsStore.getDefinition(name).color;
  }

  /**
   * Tag depth is derived from `/` segments in the name (`urgent/blocker` →
   * depth 1, `team/dev/lead` → depth 2). Storage stays flat — this is purely
   * a display affordance. Each row indents by `depth × 16px` so children
   * visually nest under their prefix. Alphabetical sort already groups them
   * because `/` (0x2F) sorts after `urgent` and before `urgentX`.
   */
  function depthOf(name: string): number {
    const slashes = name.match(/\//g);
    return slashes ? slashes.length : 0;
  }

  /**
   * The visible leaf segment — what we show as the row's "name" when the
   * tag is a child (`urgent/blocker` → `blocker`). The full name still goes
   * in the row's title/aria-label so screen readers and tooltips don't lose
   * the hierarchy context.
   */
  function leafOf(name: string): string {
    const idx = name.lastIndexOf('/');
    return idx === -1 ? name : name.slice(idx + 1);
  }

  const visibleTags = $derived.by(() => {
    return knownTagNames
      .map((name) => ({
        name,
        files: fileCount(name),
        tiles: tileCount(name),
        depth: depthOf(name),
        leaf: leafOf(name),
      }))
      .filter((t) => {
        if (scope === 'files') return t.files > 0;
        if (scope === 'tiles') return t.tiles > 0;
        return true;
      });
  });

  function openTagMenu(tagName: string, e: MouseEvent | KeyboardEvent) {
    fileTagsStore.ensureTag(tagName, colorFor(tagName));
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    activeColorPicker = null;
    activeTagMenu = { tagName, x: rect.left, y: rect.bottom + 4 };
  }

  function dismissTagMenu() {
    activeTagMenu = null;
  }

  function onMenuNavigated() {
    activeTagMenu = null;
    uiStore.closeModal();
  }

  function startEditByName(name: string) {
    editingTagName = name;
    editName = name;
    activeColorPicker = null;
  }

  function saveEdit() {
    const trimmed = editName.trim().replace(/^#/, '');
    if (editingTagName && trimmed && trimmed !== editingTagName) {
      // Validate the new name at the rename input boundary. The rewriter
      // quotes on disk, but @home / 123 / null make confusing tags; existing
      // tags are never re-validated. Keep the field open so the user can fix it.
      if (!isSafeNewTagName(trimmed)) {
        uiStore.toast(
          `"${trimmed}" isn't a valid tag name — avoid spaces, plain numbers, and leading symbols like @ * : &`,
          'warning',
          4000,
        );
        return;
      }
      // Detect orphaned children — a rename of `project` does NOT cascade
      // to `project/active` etc., so warn the user before they discover
      // the gap. Falls through silently when no children exist.
      const prefix = `${editingTagName}/`;
      const children = fileTagsStore
        .allTagNames()
        .filter((n) => n.startsWith(prefix));
      if (children.length > 0) {
        const childList = children.slice(0, 5).map((n) => ` • ${n}`).join('\n');
        const extra = children.length > 5 ? `\n …and ${children.length - 5} more` : '';
        const ok = confirm(
          `Rename "${editingTagName}" to "${trimmed}"?\n\n` +
          `${children.length} child tag${children.length === 1 ? '' : 's'} won't be renamed ` +
          `(nested tags don't cascade):\n${childList}${extra}\n\n` +
          `They'll stay under "${editingTagName}/…" until you rename them individually.`,
        );
        if (!ok) {
          editingTagName = null;
          return;
        }
      }
      void fileTagsStore.renameTagEverywhere(editingTagName, trimmed);
    }
    editingTagName = null;
  }

  function deleteTagByName(name: string) {
    if (confirm('Are you sure you want to delete this tag from all tiles and files?')) {
      void fileTagsStore.removeTagEverywhere(name);
      if (editingTagName === name) editingTagName = null;
      if (activeColorPicker === name) activeColorPicker = null;
    }
  }

  function toggleColorPicker(name: string) {
    if (activeColorPicker === name) {
      activeColorPicker = null;
    } else {
      activeColorPicker = name;
      editingTagName = null;
    }
  }

  function handleColorChange(name: string, color: string) {
    fileTagsStore.setTagColor(name, color);
    activeColorPicker = null;
  }
</script>

<Modal id="tags-browser" title="Tags Browser" width="540px">
  <div class="tags-browser">
    <div class="filter-chips" role="tablist" aria-label="Tag scope">
      <button
        type="button"
        role="tab"
        aria-selected={scope === 'all'}
        class="chip"
        class:active={scope === 'all'}
        onclick={() => (scope = 'all')}
      >All</button>
      <button
        type="button"
        role="tab"
        aria-selected={scope === 'files'}
        class="chip"
        class:active={scope === 'files'}
        onclick={() => (scope = 'files')}
      >Files only</button>
      <button
        type="button"
        role="tab"
        aria-selected={scope === 'tiles'}
        class="chip"
        class:active={scope === 'tiles'}
        onclick={() => (scope = 'tiles')}
      >Tiles only</button>
    </div>

    <div class="header-row">
      <div class="col-name">Tag</div>
      <div class="col-count">Files · Tiles</div>
      <div class="col-actions">Actions</div>
    </div>

    <div class="tags-list">
      {#each visibleTags as t (t.name)}
        <div class="tag-row" class:is-child={t.depth > 0} style:--tag-depth={t.depth}>
          <div class="color-wrapper">
            <button
              class="color-dot-btn"
              style="background: {colorFor(t.name)}"
              onclick={() => toggleColorPicker(t.name)}
              title="Change color"
              aria-label="Change color for {t.name}"
            ></button>

            {#if activeColorPicker === t.name}
              <div class="color-picker-popover">
                <ColorPicker value={colorFor(t.name)} onchange={(c: string) => handleColorChange(t.name, c)} />
              </div>
            {/if}
          </div>

          <div class="col-name">
            {#if editingTagName === t.name}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                bind:value={editName}
                onkeydown={(e) => { if (e.key === 'Enter') saveEdit(); else if (e.key === 'Escape') editingTagName = null; }}
                onblur={saveEdit}
                autofocus
              />
            {:else}
              <button
                type="button"
                class="tag-name"
                title="Show files and tiles tagged with {t.name}"
                aria-label={t.depth > 0 ? `${t.name} (child of ${t.name.slice(0, t.name.lastIndexOf('/'))})` : t.name}
                onclick={(e) => openTagMenu(t.name, e)}
                ondblclick={() => startEditByName(t.name)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTagMenu(t.name, e);
                  }
                }}
              >{#if t.depth > 0}<span class="tag-name-prefix">{t.name.slice(0, t.name.lastIndexOf('/') + 1)}</span>{/if}{t.leaf}</button>
            {/if}
          </div>

          <div class="col-count">
            <span class="count-pair">
              <span class="count-files" class:zero={t.files === 0}>Files: {t.files}</span>
              <span class="count-dot">·</span>
              <span class="count-tiles" class:zero={t.tiles === 0}>Tiles: {t.tiles}</span>
            </span>
          </div>

          <div class="col-actions">
            {#if editingTagName !== t.name}
              <IconButton title="Rename" onclick={() => startEditByName(t.name)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></IconButton>
            {/if}
            <IconButton title="Delete tag" danger onclick={() => deleteTagByName(t.name)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></IconButton>
          </div>
        </div>
      {/each}

      {#if visibleTags.length === 0}
        <div class="empty-state">
          {#if scope === 'all'}
            <p>No tags exist in this vault yet.</p>
            <p class="empty-hint">
              Add a tag from any tile's menu, type <code>#tag</code> in note
              text, or list one under <code>tags:</code> in a file's
              frontmatter.
            </p>
          {:else if scope === 'files'}
            No tags are assigned to files.
          {:else}
            No tags are assigned to tiles.
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if activeTagMenu}
    <div class="tag-menu-overlay" onclick={dismissTagMenu} role="presentation"></div>
    <div
      class="tag-menu-anchor"
      style="position: fixed; left: {activeTagMenu.x}px; top: {activeTagMenu.y}px; z-index: var(--z-modal-popup);"
    >
      <TagsPopupMenu tagName={activeTagMenu.tagName} onClose={onMenuNavigated} />
    </div>
  {/if}
</Modal>

<style>
  .tags-browser {
    display: flex;
    flex-direction: column;
    height: 400px;
  }
  .header-row {
    display: flex;
    align-items: center;
    padding: 8px 16px;
    background: var(--ui-surface-hover);
    border-bottom: 1px solid var(--ui-border);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .tags-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .tag-row {
    --tag-depth: 0;
    display: flex;
    align-items: center;
    padding: 8px 16px;
    padding-left: calc(16px + var(--tag-depth) * 16px);
    border-bottom: 1px solid var(--ui-border-subtle, transparent);
  }
  .tag-row:hover {
    background: var(--ui-surface-hover);
  }
  /* Faded prefix on child rows so the leaf segment reads as the row's
     identity while the parent path remains visible for orientation. */
  .tag-name-prefix {
    color: var(--text-tertiary);
    font-weight: normal;
  }

  .col-name { flex: 1; display: flex; align-items: center; gap: 12px; }
  .col-count { width: 160px; text-align: right; margin-right: 16px; }
  .col-actions { display: flex; gap: 4px; width: 64px; justify-content: flex-end; }

  .filter-chips {
    display: flex;
    gap: 8px;
    padding: 12px 16px 4px;
  }
  .chip {
    border: 1px solid var(--ui-border);
    background: transparent;
    color: var(--text-secondary);
    padding: 4px 12px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font: inherit;
    font-size: 12px;
  }
  .chip:hover { background: var(--ui-surface-hover); }
  .chip.active {
    background: var(--accent-primary);
    color: white;
    border-color: var(--accent-primary);
  }
  .count-pair { font-size: 12px; color: var(--text-tertiary); }
  .count-files, .count-tiles { font-variant-numeric: tabular-nums; }
  .count-pair .zero { opacity: 0.45; }
  .count-dot { margin: 0 6px; opacity: 0.5; }

  .color-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }
  .color-dot-btn {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid rgba(0,0,0,0.1);
    cursor: pointer;
    padding: 0;
    margin-right: 12px;
  }
  .color-dot-btn:hover {
    transform: scale(1.1);
  }
  .color-picker-popover {
    position: absolute;
    top: 24px;
    left: 0;
    z-index: var(--z-dropdown-panel);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    padding: 8px;
    box-shadow: var(--ui-shadow-elevated);
  }

  .tag-name {
    font-size: 14px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
  }
  .tag-name:hover {
    text-decoration: underline;
  }
  .tag-name:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .tag-menu-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal-popup-overlay);
  }
  .tag-menu-anchor {
    animation: popIn 0.15s ease;
  }
  input {
    flex: 1;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--accent-primary);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 14px;
    margin-right: 16px;
  }
  .empty-state {
    padding: 40px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 14px;
  }
  .empty-state p {
    margin: 0 0 8px;
  }
  .empty-state p:last-child {
    margin-bottom: 0;
  }
  .empty-hint {
    font-size: 12px;
    line-height: 1.5;
    max-width: 360px;
    margin-inline: auto !important;
  }
  .empty-hint code {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--ui-surface);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-secondary);
  }
</style>
