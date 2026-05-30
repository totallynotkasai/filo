<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';

  let paths = $derived(vaultStore.recoveryPendingPaths);

  // Explicit acknowledgement — drops the pending-paths list AND clears the
  // on-disk `.filo/.dirty` sentinel. Only this button calls it; closing the
  // modal via Esc / backdrop / X leaves the sentinel intact so the modal
  // re-appears on the next vault open (the user must explicitly read and
  // dismiss the list to clear it).
  async function dismiss() {
    await vaultStore.acknowledgeRecovery();
    uiStore.closeModal();
  }
</script>

<div class="recovery-body">
  <p class="recovery-intro">
    Filo closed with unflushed changes. Recovered — but the following files were
    mid-write when the session ended and may need review:
  </p>

  <ul class="recovery-list">
    {#each paths as path (path)}
      <li class="recovery-item" title={path}>{path}</li>
    {/each}
  </ul>

  <p class="recovery-hint">
    Open each file, verify the content matches your intent, and save again if needed.
  </p>

  <div class="recovery-actions">
    <button type="button" class="recovery-dismiss" onclick={dismiss}>Dismiss</button>
  </div>
</div>

<style>
  .recovery-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .recovery-intro {
    font-size: 14px;
    color: var(--text-primary);
    margin: 0;
    line-height: 1.5;
  }

  .recovery-list {
    list-style: none;
    margin: 0;
    padding: 8px 12px;
    background: var(--ui-bg-secondary);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    max-height: 260px;
    overflow-y: auto;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-base);
  }

  .recovery-item {
    padding: 4px 0;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .recovery-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0;
    line-height: 1.5;
  }

  .recovery-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }

  .recovery-dismiss {
    padding: 6px 14px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .recovery-dismiss:hover {
    background: var(--ui-surface-hover);
  }
</style>
