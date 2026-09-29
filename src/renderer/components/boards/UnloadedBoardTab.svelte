<script lang="ts">
  /**
   * The body of a tab whose board file couldn't be loaded: what went wrong
   * and a Retry. The tab is kept (and saved in the workspace) so a board that
   * is repaired or finishes syncing comes back in place.
   */
  import type { TabData } from '../../stores/tabs.svelte';
  import { retryUnloadedBoard, unloadedTabMessage } from '../../lib/boards/unloadedBoardTab';

  interface Props {
    tab: TabData;
  }

  let { tab }: Props = $props();

  let retried = $state<string | null>(null);
  let message = $derived(retried ?? unloadedTabMessage(tab));
  let retrying = $state(false);

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      const result = await retryUnloadedBoard(tab);
      if (result.kind === 'failed') retried = result.message;
    } finally {
      retrying = false;
    }
  }
</script>

<div class="unloaded-board" role="status">
  <svg class="unloaded-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
  <p class="unloaded-title">Filo couldn't open "{tab.name}"</p>
  {#if message}
    <p class="unloaded-reason">{message}</p>
  {/if}
  <p class="unloaded-hint">
    Nothing in the file was changed. Fix it in a text editor, or wait for it to finish syncing, then retry.
  </p>
  <button class="unloaded-retry" onclick={() => { void retry(); }} disabled={retrying}>
    {retrying ? 'Retrying…' : 'Retry'}
  </button>
</div>

<style>
  .unloaded-board {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 100%;
    padding: 24px;
    box-sizing: border-box;
    background: var(--canvas-bg);
    color: var(--text-secondary);
    text-align: center;
  }

  .unloaded-icon {
    color: var(--text-tertiary);
  }

  .unloaded-title {
    margin: 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .unloaded-reason {
    margin: 0;
    max-width: 560px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .unloaded-hint {
    margin: 0;
    max-width: 560px;
    font-size: 13px;
  }

  .unloaded-retry {
    margin-top: 6px;
    padding: 6px 16px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font: inherit;
    cursor: pointer;
  }

  .unloaded-retry:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
