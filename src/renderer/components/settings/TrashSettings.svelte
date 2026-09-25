<script lang="ts">
  import { onMount } from 'svelte';
  import { trashStore } from '../../stores/trash.svelte';
  import type { TrashEntryInfo } from '@shared/ipcContracts';

  onMount(() => {
    void trashStore.refresh();
  });

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function deletedLabel(entry: TrashEntryInfo): string {
    const when = new Date(entry.deletedAt);
    return Number.isNaN(when.getTime()) ? 'Deleted' : `Deleted ${dateFormat.format(when)}`;
  }

  function nameOf(path: string): string {
    return path.split('/').pop() ?? path;
  }

  function folderOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : '';
  }
</script>

<div class="trash-settings">
  <h3 class="section-title">Trash</h3>
  <p class="hint">
    Deleted files, folders and boards wait here. Restore puts an item back where it was
    (or beside it, if that name is taken). Items older than 30 days go to the Recycle Bin
    when the vault opens on the computer that deleted them.
  </p>

  {#if !trashStore.loaded}
    <p class="empty-text">Loading…</p>
  {:else if trashStore.entries.length === 0}
    <p class="empty-text">Filo's trash is empty.</p>
  {:else}
    <ul class="trash-list" aria-label="Items in Filo's trash">
      {#each trashStore.entries as entry (entry.trashId)}
        <li class="trash-item">
          <svg class="item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            {#if entry.kind === 'folder'}
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            {:else}
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            {/if}
          </svg>
          <div class="item-text">
            <span class="item-name" title={entry.originalPath}>{nameOf(entry.originalPath)}</span>
            <span class="item-meta">
              {#if folderOf(entry.originalPath)}{folderOf(entry.originalPath)} · {/if}{deletedLabel(entry)}{#if trashStore.thisMachine && entry.machineId !== trashStore.thisMachine} · on another computer{/if}{#if !entry.present} · missing{/if}
            </span>
          </div>
          <button
            class="restore-btn"
            onclick={() => void trashStore.restore(entry)}
            disabled={trashStore.busy || !entry.present}
            aria-label={`Restore ${entry.originalPath}`}
          >Restore</button>
        </li>
      {/each}
    </ul>
    <div class="actions">
      <button class="empty-btn" onclick={() => void trashStore.empty()} disabled={trashStore.busy}>
        Empty trash
      </button>
    </div>
  {/if}
</div>

<style>
  .trash-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-tertiary);
  }

  .empty-text {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--text-secondary);
  }

  .trash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 360px;
    overflow-y: auto;
  }

  .trash-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
  }

  .item-icon {
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .item-name {
    font-size: var(--font-size-base);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-meta {
    font-size: 11px;
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .restore-btn,
  .empty-btn {
    flex-shrink: 0;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .restore-btn:hover:not(:disabled),
  .empty-btn:hover:not(:disabled) {
    border-color: var(--ui-border-focus);
  }

  .restore-btn:disabled,
  .empty-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .empty-btn {
    color: var(--accent-danger);
  }
</style>
