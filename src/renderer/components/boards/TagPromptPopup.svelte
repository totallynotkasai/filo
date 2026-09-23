<script lang="ts">
  /**
   * TagPromptPopup — Audit-18 M7. A small centered text-input dialog for the
   * Kanban bulk "Add tag" action. Replaces `window.prompt`, which is
   * unimplemented in Electron's renderer (it throws). Mirrors the
   * `LinkInsertPopup` pattern: capture a string, resolve on Add / Enter, or
   * cancel on Escape / click-outside / Cancel.
   *
   * The parent (`KanbanBoard`) opens it by resolving a promise its
   * `tagSelectedTiles` controller awaits; `onResolve(value)` hands the entered
   * tag back (or `null` on cancel) and the parent unmounts the popup.
   */
  import { onMount } from 'svelte';

  let { onResolve }: { onResolve: (value: string | null) => void } = $props();

  let value = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      onResolve(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onResolve(null);
    }
  }
</script>

<div
  class="tag-prompt-overlay"
  role="presentation"
  onclick={() => onResolve(null)}
></div>
<div
  class="tag-prompt"
  role="dialog"
  aria-modal="true"
  aria-label="Add tag to selected cards"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  <label class="tag-prompt-label" for="kanban-bulk-tag-input">Add tag to selected cards</label>
  <input
    id="kanban-bulk-tag-input"
    class="tag-prompt-input"
    type="text"
    placeholder="tag name (without #)"
    bind:this={inputEl}
    bind:value
  />
  <div class="tag-prompt-actions">
    <button class="tag-prompt-btn secondary" onclick={() => onResolve(null)}>Cancel</button>
    <button class="tag-prompt-btn primary" onclick={() => onResolve(value)}>Add tag</button>
  </div>
</div>

<style>
  .tag-prompt-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-tile-popup-overlay);
    background: rgba(0, 0, 0, 0.18);
  }
  .tag-prompt {
    position: fixed;
    left: 50%;
    top: 38%;
    transform: translate(-50%, -50%);
    z-index: var(--z-tile-popup);
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 320px;
    padding: 14px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
  }
  .tag-prompt-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .tag-prompt-input {
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
  .tag-prompt-input:focus {
    border-color: var(--accent-primary);
  }
  .tag-prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .tag-prompt-btn {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .tag-prompt-btn.secondary {
    background: var(--ui-surface);
    color: var(--text-secondary);
    border-color: var(--ui-border);
  }
  .tag-prompt-btn.secondary:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }
  .tag-prompt-btn.primary {
    background: var(--accent-primary);
    color: #fff;
  }
  .tag-prompt-btn.primary:hover {
    opacity: 0.9;
  }
</style>
