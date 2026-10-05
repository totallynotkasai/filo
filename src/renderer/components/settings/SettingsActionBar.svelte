<script lang="ts">
  /**
   * The Apply / Revert bar of a Settings tab that saves on Apply. It sits
   * above the tab's scrolling page, so the buttons stay in view however far
   * the page is scrolled. Revert drops the tab's unapplied edits and leaves
   * the dialog open.
   */
  interface Props {
    /** Whether the tab has unapplied edits. */
    dirty: boolean;
    /** Whether this dialog's own save is running. */
    busy: boolean;
    onApply: () => void;
    onRevert: () => void;
  }

  let { dirty, busy, onApply, onRevert }: Props = $props();
</script>

<div class="settings-action-bar" role="group" aria-label="Unapplied changes">
  <span class="settings-action-status" role="status">
    {dirty ? 'Unsaved changes: Apply saves them, Revert drops them.' : 'No changes. Changes here wait for Apply.'}
  </span>
  <div class="settings-action-buttons">
    <button class="action-btn revert" onclick={onRevert} disabled={!dirty || busy}>Revert</button>
    <button class="action-btn apply" onclick={onApply} disabled={!dirty || busy}>Apply</button>
  </div>
</div>

<style>
  .settings-action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-bg-secondary, var(--ui-surface));
    flex-shrink: 0;
  }

  .settings-action-status {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .settings-action-buttons {
    display: flex;
    gap: 8px;
  }

  .action-btn {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.1s ease, opacity 0.1s ease;
    font-family: var(--font-system);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  .action-btn.revert {
    background: var(--ui-surface);
    color: var(--text-primary);
    border-color: var(--ui-border);
  }

  .action-btn.revert:hover {
    background: var(--ui-surface-hover);
  }

  .action-btn.apply {
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
  }

  .action-btn.apply:hover {
    opacity: 0.88;
  }

  @media (prefers-reduced-motion: reduce) {
    .action-btn {
      transition: none;
    }
  }
</style>
