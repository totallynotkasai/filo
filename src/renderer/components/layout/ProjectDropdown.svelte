<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import Dropdown from './Dropdown.svelte';

  let projectDropdownOpen = $state(false);
  let showRenameInput = $state(false);
  let renameValue = $state('');

  $effect(() => {
    if (!projectDropdownOpen) showRenameInput = false;
  });

  async function handleNewVault() {
    projectDropdownOpen = false;
    const vaultPath = await window.filo.invoke('vault:select');
    if (!vaultPath) return;
    const name = vaultPath.split(/[\\/]/).pop() || 'Vault';
    const ok = await vaultStore.newVault(vaultPath, name);
    if (ok) uiStore.toast('Vault created', 'success');
  }

  async function handleOpenVault() {
    projectDropdownOpen = false;
    const vaultPath = await window.filo.invoke('vault:select');
    if (!vaultPath) return;
    const ok = await vaultStore.openVault(vaultPath);
    if (ok) uiStore.toast('Vault opened', 'success');
  }

  async function handleSave() {
    const ok = await vaultStore.save();
    if (ok) {
      uiStore.toast('Saved', 'success');
    } else {
      // Per-file toasts from trackComponentWrite already enumerate which
      // writes failed; this one ties them together as "the save didn't
      // actually succeed".
      uiStore.toast('Save failed — check the error toasts above', 'error');
    }
    projectDropdownOpen = false;
  }

  async function handleSyncAllTiles() {
    projectDropdownOpen = false;
    const board = boardStore.current;
    if (!board) {
      uiStore.toast('No active board to sync', 'info');
      return;
    }
    uiStore.toast('Syncing tiles...', 'info', 1500);
    const result = await boardCacheStore.syncAllOnBoard(board.id);
    if (result.failed > 0) {
      uiStore.toast(`Synced ${result.ok} tiles, ${result.failed} failed`, 'error');
    } else if (result.skipped > 0) {
      uiStore.toast(`Synced ${result.ok} tile${result.ok === 1 ? '' : 's'}, skipped ${result.skipped} empty`, 'warning');
    } else {
      uiStore.toast(`Synced ${result.ok} tile${result.ok === 1 ? '' : 's'}`, 'success');
    }
  }

  async function handleExport(format: 'png' | 'svg' | 'pdf' | 'md' | 'html') {
    projectDropdownOpen = false;

    const boardEl = document.querySelector('.board-viewport') as HTMLElement | null;
    const project = vaultStore.getData();
    const name = vaultStore.projectName || 'export';

    const progressToastId = uiStore.pushToast({
      text: `Exporting as ${format.toUpperCase()}…`,
      type: 'info',
      duration: 0,
    });

    try {
      // Lazy-load the export subsystem (html-to-image + jspdf, ~hundreds of
      // kB) only when the user actually exports, keeping it out of the
      // first-paint renderer chunk. (7.6)
      const { doExport } = await import('../../lib/export/exportService');
      const result = await doExport(format, boardEl, project, name);
      uiStore.dismissToast(progressToastId, { silent: true });
      if (result.success) {
        uiStore.toast(`Exported as ${format.toUpperCase()}`, 'success');
      } else if (result.canceled) {
        // Audit-18 4.4 — the user dismissed the save dialog; treat it as a
        // no-op. The old code surfaced the same `{ success: false }` path as a
        // real write failure, so cancelling spuriously toasted "Export failed".
      } else {
        uiStore.toast(result.error || 'Export failed', 'error');
      }
    } catch (err) {
      uiStore.dismissToast(progressToastId, { silent: true });
      const message = err instanceof Error ? err.message : 'Export failed';
      uiStore.toast(message, 'error');
    }
  }

  function openSettings() {
    uiStore.openModal('project-settings');
    projectDropdownOpen = false;
  }

  function startRename() {
    renameValue = vaultStore.projectName || '';
    showRenameInput = true;
  }

  function commitRename() {
    if (renameValue.trim()) {
      vaultStore.setName(renameValue.trim());
    }
    showRenameInput = false;
  }

  function cancelRename() {
    showRenameInput = false;
  }
</script>

<Dropdown label={vaultStore.projectName || 'Project'} bind:open={projectDropdownOpen}>
  {#if showRenameInput}
    <div class="rename-project-row">
      <label class="rename-label" for="rename-project">Project Name:</label>
      <input
        id="rename-project"
        class="rename-input"
        type="text"
        bind:value={renameValue}
        onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') cancelRename(); }}
        onblur={commitRename}
        placeholder="Untitled Project"
      />
    </div>
  {:else}
    <button class="dropdown-item" onclick={startRename}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      Name Project
    </button>
  {/if}
  <div class="dropdown-divider"></div>
  <button class="dropdown-item" onclick={handleNewVault}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
    New Vault
  </button>
  <button class="dropdown-item" onclick={handleOpenVault}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    Open Vault
  </button>
  <button class="dropdown-item" onclick={handleSave}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    Save
  </button>
  <div class="dropdown-divider"></div>
  <div class="dropdown-submenu-wrapper">
    <button class="dropdown-item dropdown-item-submenu">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Export
      <svg class="submenu-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
    <div class="dropdown-submenu">
      <button class="dropdown-item" onclick={() => handleExport('png')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        PNG
      </button>
      <button class="dropdown-item" onclick={() => handleExport('svg')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>
        SVG
      </button>
      <button class="dropdown-item" onclick={() => handleExport('pdf')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        PDF
      </button>
      <button class="dropdown-item" onclick={() => handleExport('md')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M7 15V9l3 3 3-3v6"/><path d="M17 9v6l-2-2"/></svg>
        Markdown
      </button>
      <button class="dropdown-item" onclick={() => handleExport('html')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        HTML
      </button>
    </div>
  </div>
  <div class="dropdown-divider"></div>
  <button class="dropdown-item" onclick={handleSyncAllTiles}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10"/>
      <polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
    Sync All Tiles on this Board
  </button>

  <div class="dropdown-divider"></div>
  <button class="dropdown-item" onclick={openSettings}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    Project Settings
  </button>
</Dropdown>

<style>
  :global(.dropdown-item) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 16px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.08s ease;
  }

  :global(.dropdown-item:hover) {
    background: var(--ui-surface-hover);
  }

  :global(.dropdown-item:active) {
    background: var(--ui-surface-active);
  }

  :global(.dropdown-divider) {
    height: 1px;
    margin: 4px 8px;
    background: var(--ui-border-light);
  }

  .dropdown-submenu-wrapper {
    position: relative;
  }

  :global(.dropdown-item-submenu) {
    justify-content: flex-start;
  }

  :global(.dropdown-item-muted) {
    opacity: 0.55;
  }

  .submenu-arrow {
    margin-left: auto;
    opacity: 0.5;
  }

  .dropdown-submenu {
    display: none;
    position: absolute;
    left: 100%;
    top: 0;
    min-width: 140px;
    padding: 4px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    z-index: calc(var(--z-dropdown-panel) + 1);
  }

  .dropdown-submenu-wrapper:hover .dropdown-submenu {
    display: block;
    animation: popIn 0.1s ease;
  }

  .rename-project-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px;
  }

  .rename-label {
    font-size: 11px;
    color: var(--text-tertiary);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .rename-input {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--ui-border-focus);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    box-sizing: border-box;
  }

  .rename-input:focus {
    border-color: var(--accent-primary);
  }

  .rename-input:focus:not(:focus-visible) {
    outline: none;
  }

</style>
