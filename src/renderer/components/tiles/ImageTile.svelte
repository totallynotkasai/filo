<script lang="ts">
  import type { ImageTile } from '../../schema/index';
  import { vaultStore } from '../../stores/vault.svelte';
  import { toMediaUrl } from '../../lib/utils/mediaUrl';
  import IconButton from '../shared/IconButton.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand, UpdateImageAltCommand } from '../../commands/index';
  import { boardRefIntegrityStore } from '../../stores/boardRefIntegrity.svelte';
  import { mediaErrorText } from '../../lib/utils/mediaErrorText';

  let { tile }: { tile: ImageTile } = $props();

  let inputUrl = $state('');
  let isEditingAlt = $state(false);
  let altDraft = $state('');
  // Surface a fallback when the image fails to load (broken/missing
  // vault path, dead URL) instead of leaving the OS broken-image glyph.
  let loadFailed = $state(false);
  let loadErrorText = $derived(mediaErrorText('image', { missing: boardRefIntegrityStore.isBrokenTile(tile.id) }));

  function handleImageLoad() {
    loadFailed = false;
  }

  function handleImageError() {
    loadFailed = true;
  }

  // Vault-relative paths route through the `filo://` protocol; http/data/blob
  // URLs are passed through unchanged. Absolute paths and `file://` URLs
  // (from legacy/stale tiles or buggy drop paths) are normalised against the
  // active vault root rather than leaking into the `<img src>` and tripping
  // Chromium's `file://` block.
  let displaySrc = $derived(toMediaUrl(tile.src, vaultStore.path));

  // Effective alt text: explicit alt > tile title. Never empty for accessibility.
  let effectiveAlt = $derived(
    (tile.alt && tile.alt.trim().length > 0) ? tile.alt : tile.title,
  );

  function handleUrlSubmit() {
    const next = inputUrl.trim();
    if (!next) return;
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'src', src: tile.src ?? '' },
        { kind: 'src', src: next },
        'Set image source',
      ),
    );
  }

  function handleRemove() {
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'src', src: tile.src ?? '' },
        { kind: 'src', src: '' },
        'Clear image',
      ),
    );
  }

  function startEditAlt() {
    altDraft = tile.alt ?? '';
    isEditingAlt = true;
  }

  function commitAlt() {
    const next = altDraft.trim();
    const after = next.length > 0 ? next : undefined;
    // Alt-text edits go through
    // UpdateImageAltCommand so Ctrl+Z reverses the change. Skip the push
    // when nothing changed so trivial open-close-without-edits doesn't
    // burn a history slot.
    if (after !== tile.alt) {
      historyStore.execute(
        new UpdateImageAltCommand(tile.id, tile.alt, after),
      );
    }
    isEditingAlt = false;
  }

  function cancelAlt() {
    isEditingAlt = false;
    altDraft = '';
  }
</script>

<div class="image-tile">
  {#if tile.src}
    <div class="image-container">
      <img
        src={displaySrc}
        alt={effectiveAlt}
        draggable="false"
        onload={handleImageLoad}
        onerror={handleImageError}
      />
      {#if loadFailed}
        <div class="load-error" role="alert">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
            <line x1="3" y1="3" x2="21" y2="21"/>
          </svg>
          <span>{loadErrorText}</span>
          {#if tile.src}<span class="load-error-path">{tile.src}</span>{/if}
        </div>
      {/if}
      <div class="actions">
        <IconButton title={tile.alt ? `Edit alt text — "${tile.alt}"` : 'Edit alt text'} onclick={startEditAlt}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <text x="3" y="17" font-size="13" font-family="sans-serif" font-weight="700" fill="currentColor" stroke="none">Aa</text>
          </svg>
        </IconButton>
        <IconButton title="Remove Image" danger onclick={handleRemove}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></IconButton>
      </div>
      {#if isEditingAlt}
        <!-- svelte-ignore a11y_autofocus -->
        <div class="alt-edit" role="dialog" aria-label="Edit image alt text">
          <label for="alt-input-{tile.id}" class="alt-edit-label">Alt text (for screen readers)</label>
          <input
            id="alt-input-{tile.id}"
            type="text"
            bind:value={altDraft}
            placeholder="Describe this image"
            autofocus
            onkeydown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitAlt(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelAlt(); }
            }}
          />
          <div class="alt-edit-buttons">
            <button class="alt-cancel" onclick={cancelAlt}>Cancel</button>
            <button class="alt-save" onclick={commitAlt}>Save</button>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="empty-state">
      <div class="icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>
      <div class="input-group">
        <input 
          type="text" 
          bind:value={inputUrl} 
          placeholder="Paste image URL here..." 
          onkeydown={(e) => e.key === 'Enter' && handleUrlSubmit()}
        />
        <button class="btn btn-primary" onclick={handleUrlSubmit}>Add</button>
      </div>
      <div class="hint">Or drag & drop an image onto the canvas</div>
    </div>
  {/if}
</div>

<style>
  .image-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .image-container {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Letterbox backing behind a `contain`-fitted image. TileContainer sets
       `--image-tile-bg: transparent` in frameless (media-only) mode so the
       image shows with no grey bars. */
    background: var(--image-tile-bg, rgba(0,0,0,0.05));
  }
  .image-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .load-error {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 13px;
    pointer-events: none;
  }
  .load-error-path {
    font-size: 11px;
    color: var(--text-tertiary);
    word-break: break-all;
    max-width: 100%;
  }
  .actions {
    position: absolute;
    top: 8px;
    right: 8px;
    opacity: 0;
    transition: opacity 0.2s;
    background: var(--ui-surface);
    border-radius: 6px;
    box-shadow: var(--ui-shadow);
  }
  .image-container:hover .actions {
    opacity: 1;
  }

  .alt-edit {
    position: absolute;
    bottom: 8px;
    left: 8px;
    right: 8px;
    padding: 10px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .alt-edit-label {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .alt-edit input {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
  }

  .alt-edit-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .alt-edit-buttons button {
    padding: 3px 10px;
    font-size: 11px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    cursor: pointer;
    background: var(--ui-surface);
    color: var(--text-primary);
  }

  .alt-edit-buttons .alt-save {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse);
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    gap: 12px;
    text-align: center;
  }
  .icon {
    opacity: 0.5;
    color: var(--text-tertiary);
  }
  .input-group {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 300px;
  }
  input {
    flex: 1;
    padding: 6px 10px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 13px;
  }
  .btn {
    padding: 6px 12px;
    border-radius: 4px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .btn:hover {
    background: var(--accent-primary-hover);
  }
  .hint {
    font-size: 11px;
    color: var(--text-tertiary);
  }
</style>
