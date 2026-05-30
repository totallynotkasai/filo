<script lang="ts">
  /**
   * LinkInsertPopup — anchored URL entry for the toolbar's Insert Link button.
   *
   * Replaces window.prompt(), which races with TipTap's focus model and is
   * disabled in some packaged Electron builds. The popup captures the
   * editor's selection range before mounting and applies the link to that
   * exact range on confirm so the link lands where the user expected.
   */
  import { onMount, untrack } from 'svelte';

  let {
    x,
    y,
    initialUrl = '',
    onApply,
    onRemove,
    onClose,
  }: {
    x: number;
    y: number;
    initialUrl?: string;
    onApply: (url: string) => void;
    onRemove: () => void;
    onClose: () => void;
  } = $props();

  let url = $state(untrack(() => initialUrl));
  let inputEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  function apply() {
    const trimmed = url.trim();
    if (trimmed) onApply(trimmed);
    onClose();
  }

  function remove() {
    onRemove();
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div
  class="link-popup-overlay"
  onclick={onClose}
  role="presentation"
  data-keeps-editor-focus="true"
></div>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="link-popup"
  style="left: {x}px; top: {y}px; z-index: var(--z-tile-popup);"
  onkeydown={handleKeydown}
  role="group"
  aria-label="Insert link"
  tabindex="-1"
  data-keeps-editor-focus="true"
>
  <input
    bind:this={inputEl}
    bind:value={url}
    type="text"
    class="link-input"
    placeholder="https://example.com or filo://board/<id>"
    aria-label="Link URL"
  />
  <div class="link-actions">
    <button class="link-btn secondary" onclick={remove} title="Remove existing link">Remove</button>
    <button class="link-btn primary" onclick={apply}>Apply</button>
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

  .link-input {
    width: 100%;
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
    color: #fff;
  }

  .link-btn.primary:hover {
    opacity: 0.9;
  }
</style>
