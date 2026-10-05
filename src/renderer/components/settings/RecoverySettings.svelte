<script lang="ts">
  import { onMount } from 'svelte';
  import { recoveryCopiesStore } from '../../stores/recoveryCopies.svelte';
  import {
    RECOVERY_KINDS,
    copyDisplayName,
    parseRecoveryTimestamp,
    sizeLabel,
    type RecoveryCopy,
  } from '../../lib/vault/recoveryCopies';

  onMount(() => {
    void recoveryCopiesStore.refresh();
  });

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // The copies the system can open: text Filo wrote.
  const OPENABLE = /\.(md|markdown|txt|json)$/i;

  const sections = $derived(
    RECOVERY_KINDS
      .map((k) => ({ ...k, copies: recoveryCopiesStore.copies.filter((c) => c.kind === k.kind) }))
      .filter((s) => s.copies.length > 0),
  );

  function keptLabel(copy: RecoveryCopy): string {
    const at = parseRecoveryTimestamp(copy.timestamp);
    return at === null ? copy.timestamp : `Kept ${dateFormat.format(new Date(at))}`;
  }
</script>

<div class="recovery-settings">
  <h3 class="section-title">Recovery</h3>
  <p class="hint">
    Copies Filo kept in .filo/recovery so nothing you wrote is lost. Filo doesn't need them:
    open one to take what you want from it, and delete the rest. Kept versions and rescue
    copies stay until you delete them.
  </p>

  {#if !recoveryCopiesStore.loaded}
    <p class="empty-text">Loading…</p>
  {:else if sections.length === 0}
    <p class="empty-text">Filo has kept no copies in this vault.</p>
  {:else}
    {#each sections as section (section.kind)}
      <section class="kind" aria-labelledby={`recovery-kind-${section.kind}`}>
        <div class="kind-head">
          <h4 class="kind-title" id={`recovery-kind-${section.kind}`}>{section.title} ({section.copies.length})</h4>
          <button
            class="row-btn danger"
            onclick={() => void recoveryCopiesStore.remove(section.copies, { confirm: true })}
            disabled={recoveryCopiesStore.busy}
            aria-label={`Delete all ${section.title.toLowerCase()}`}
          >Delete all</button>
        </div>
        <p class="hint">{section.about}</p>
        <ul class="copy-list" aria-label={section.title}>
          {#each section.copies as copy (copy.relPath)}
            <li class="copy-item">
              <svg class="item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <div class="item-text">
                <span class="item-name" title={copy.relPath}>{copyDisplayName(copy.basename)}</span>
                <span class="item-meta">{keptLabel(copy)} · {sizeLabel(copy.size)}</span>
              </div>
              {#if OPENABLE.test(copy.basename)}
                <button
                  class="row-btn"
                  onclick={() => void recoveryCopiesStore.open(copy)}
                  aria-label={`Open ${copyDisplayName(copy.basename)}`}
                >Open</button>
              {/if}
              <button
                class="row-btn"
                onclick={() => recoveryCopiesStore.showInFolder(copy)}
                aria-label={`Show ${copyDisplayName(copy.basename)} in its folder`}
              >Show in folder</button>
              <button
                class="row-btn danger"
                onclick={() => void recoveryCopiesStore.remove([copy])}
                disabled={recoveryCopiesStore.busy}
                aria-label={`Delete ${copyDisplayName(copy.basename)}`}
              >Delete</button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .recovery-settings {
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

  .kind {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .kind-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .kind-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .copy-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .copy-item {
    display: flex;
    align-items: center;
    gap: 8px;
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

  .row-btn {
    flex-shrink: 0;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .row-btn:hover:not(:disabled) {
    border-color: var(--ui-border-focus);
  }

  .row-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .row-btn.danger {
    color: var(--accent-danger);
  }
</style>
