<script lang="ts">
  /**
   * LinkInsertPopup — anchored Text + URL entry for the toolbar's Insert Link
   * button and Ctrl+K.
   *
   * Replaces window.prompt(), which races with TipTap's focus model and is
   * disabled in some packaged Electron builds. The toolbar captures the
   * editor's target range before this mounts and applies the link to that
   * exact range, so the link lands where the user expected.
   *
   * Portalled to <body>: inside the toolbar it would sit in the toolbar's
   * stacking context, where tile popups and canvas layers can cover it.
   */
  import { onMount, untrack } from 'svelte';
  import { portal } from '../../lib/utils/portal';

  let {
    x,
    y,
    initialText = '',
    initialUrl = '',
    onApply,
    onRemove,
    onClose,
  }: {
    x: number;
    y: number;
    initialText?: string;
    initialUrl?: string;
    /** Returns an error to show, keeping the popup open, or null once applied. */
    onApply: (text: string, url: string) => string | null;
    onRemove: () => void;
    onClose: () => void;
  } = $props();

  const VIEWPORT_MARGIN = 8;

  let text = $state(untrack(() => initialText));
  let url = $state(untrack(() => initialUrl));
  let error = $state<string | null>(null);
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let popupEl = $state<HTMLDivElement | null>(null);
  let left = $state(untrack(() => x));
  let top = $state(untrack(() => y));
  const editing = untrack(() => initialUrl !== '');

  onMount(() => {
    if (popupEl) {
      // Clamp into the viewport: Ctrl+K anchors at the caret, which can sit
      // near the right or bottom edge.
      const rect = popupEl.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
      left = Math.max(VIEWPORT_MARGIN, Math.min(x, maxLeft));
      top = Math.max(VIEWPORT_MARGIN, Math.min(y, maxTop));
    }
    urlInputEl?.focus();
    urlInputEl?.select();
  });

  function apply() {
    if (!url.trim()) {
      error = 'Enter a URL.';
      urlInputEl?.focus();
      return;
    }
    error = onApply(text, url.trim());
    if (error === null) onClose();
    else urlInputEl?.focus();
  }

  function remove() {
    onRemove();
    onClose();
  }

  // Enter and Escape stop here. Applying closes the popup before the key
  // reaches window listeners, so a board's own Enter (rename the selected
  // tile) or Escape (cancel a connection) would see no input focused and act
  // on it, taking focus away from the editor.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<div use:portal class="link-popup-layer">
  <div
    class="link-popup-overlay"
    onclick={onClose}
    role="presentation"
    data-keeps-editor-focus="true"
  ></div>

  <div
    bind:this={popupEl}
    class="link-popup"
    style="left: {left}px; top: {top}px;"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label={editing ? 'Edit link' : 'Insert link'}
    tabindex="-1"
    data-keeps-editor-focus="true"
  >
    <label class="link-field">
      <span class="link-label">Text</span>
      <input
        bind:value={text}
        type="text"
        class="link-input"
        placeholder="Text to show (optional)"
      />
    </label>
    <label class="link-field">
      <span class="link-label">URL</span>
      <input
        bind:this={urlInputEl}
        bind:value={url}
        oninput={() => (error = null)}
        type="text"
        class="link-input"
        placeholder="example.com or filo://board/<id>"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'link-popup-error' : undefined}
      />
    </label>
    {#if error}
      <p id="link-popup-error" class="link-error" role="alert">{error}</p>
    {/if}
    <div class="link-actions">
      {#if editing}
        <button class="link-btn secondary" onclick={remove} title="Remove the link, keep its text">Remove</button>
      {/if}
      <button class="link-btn primary" onclick={apply}>Apply</button>
    </div>
  </div>
</div>

<style>
  .link-popup-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-tile-popup-overlay);
  }

  .link-popup {
    position: fixed;
    z-index: var(--z-tile-popup);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    width: 320px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.1s ease;
  }

  .link-field {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .link-label {
    width: 32px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .link-input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    box-sizing: border-box;
  }

  .link-input:focus {
    border-color: var(--accent-primary);
  }

  .link-input:focus:not(:focus-visible) {
    outline: none;
  }

  .link-input[aria-invalid='true'] {
    border-color: var(--accent-danger);
  }

  .link-error {
    margin: 0;
    font-size: 12px;
    color: var(--accent-danger);
  }

  .link-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .link-btn {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.1s ease;
  }

  .link-btn.secondary {
    background: var(--ui-surface);
    color: var(--text-secondary);
    border-color: var(--ui-border);
  }

  .link-btn.secondary:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .link-btn.primary {
    background: var(--accent-primary);
    color: var(--text-inverse);
  }

  .link-btn.primary:hover {
    opacity: 0.9;
  }

  @media (prefers-reduced-motion: reduce) {
    .link-popup {
      animation: none;
    }
  }
</style>
