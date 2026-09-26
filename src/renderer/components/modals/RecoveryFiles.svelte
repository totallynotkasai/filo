<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { foreignSentinelsStore, machineLabel } from '../../stores/foreignSentinels.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { checkRecovery } from '../../lib/vault/dirtyFlagRecovery';
  import { recoveryLocationsSince, type RecoveryLocation } from '../../lib/vault/recoveryLocations';

  let paths = $derived(vaultStore.recoveryPendingPaths);
  // Other machines' unclean-shutdown markers / quit-failure
  // breadcrumbs in the synced `.filo/`: listed read-only (their data is on
  // that machine; Filo never prompts for, resumes or clears them).
  let foreign = $derived(
    foreignSentinelsStore.list.filter((s) => s.kind === 'dirty' || s.kind === 'quit-failure'),
  );
  function since(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Rescue copies and moved-aside partial files from the unfinished session
  // on: where the user's last changes may be if they aren't in the files.
  let locations = $state<RecoveryLocation[]>([]);
  $effect(() => {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    let live = true;
    void (async () => {
      try {
        const status = await checkRecovery(vaultRoot);
        const listing = await window.filo.invoke('recovery:list', vaultRoot);
        if (live && vaultStore.path === vaultRoot) locations = recoveryLocationsSince(listing, status.dirtyAt);
      } catch {
        // No listing: the modal still names the files.
      }
    })();
    return () => {
      live = false;
    };
  });

  function isNote(path: string): boolean {
    return path.toLowerCase().endsWith('.md');
  }

  function showInFolder(relPath: string) {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    void window.filo.invoke('shell:show-item-in-folder', `${vaultRoot.replace(/[\\/]+$/, '')}/${relPath}`);
  }

  function locationText(l: RecoveryLocation): string {
    const what = l.kind === 'unsaved'
      ? `Copies of unsaved work (${l.files} file${l.files === 1 ? '' : 's'})`
      : `Partly written files moved aside (${l.files})`;
    return `${what}, ${since(l.at)}`;
  }

  // Acknowledgement — drops the pending-paths list, clears the on-disk
  // `.filo/.dirty` sentinel (if the write tracker is idle), and un-parks the
  // recovery sequencer so the remaining sentinel prompts (tag-rewrite,
  // rename-cascade, snapshot listing) can surface. Esc / backdrop / X only
  // un-park (the Modal's `beforeClose` in AppShell); this explicit Dismiss is
  // the one path that acknowledges.
  async function dismiss() {
    await vaultStore.acknowledgeRecovery();
    uiStore.closeModal();
  }
</script>

<div class="recovery-body">
  <p class="recovery-intro">
    Filo didn't finish saving these files last time. Your last changes may not be in them.
  </p>

  <ul class="recovery-list">
    {#each paths as path (path)}
      <li class="recovery-item" title={path}>
        <span class="recovery-path">{path}</span>
        {#if isNote(path)}
          <button type="button" class="recovery-row-btn" onclick={() => openNoteInDocumentTab(path)}>Open</button>
        {:else}
          <button type="button" class="recovery-row-btn" onclick={() => showInFolder(path)}>Show in folder</button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if locations.length > 0}
    <p class="recovery-intro">If something is missing, Filo kept these:</p>
    <ul class="recovery-list">
      {#each locations as l (l.firstFile)}
        <li class="recovery-item">
          <span class="recovery-path">{locationText(l)}</span>
          <button type="button" class="recovery-row-btn" onclick={() => showInFolder(l.firstFile)}>Show in folder</button>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="recovery-hint">
    Open each file and check it. Dismiss once you're done; until then Filo asks again next time.
  </p>

  {#if foreign.length > 0}
    <p class="recovery-intro">Other machines that sync this vault:</p>
    <ul class="recovery-list">
      {#each foreign as f (f.relPath)}
        <li class="recovery-item">
          {machineLabel(f)}: {f.kind === 'dirty' ? 'unclean-shutdown marker' : 'unsaved bytes preserved after a failed save'}
          since {since(f.mtimeMs)}. Open the vault on that machine to recover.
        </li>
      {/each}
    </ul>
  {/if}

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
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    color: var(--text-secondary);
  }

  .recovery-path {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .recovery-row-btn {
    flex-shrink: 0;
    padding: 2px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .recovery-row-btn:hover {
    background: var(--ui-surface-hover);
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
