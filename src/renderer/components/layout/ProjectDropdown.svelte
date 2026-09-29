<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { pickAndOpenVault, rememberOpenVault } from '../../stores/vaultOpen';
  import { activeVaultColor } from '../../stores/vaultColor';
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
    if (!ok) return;
    await rememberOpenVault();
    uiStore.toast('Vault created', 'success');
  }

  async function handleOpenVault() {
    projectDropdownOpen = false;
    if (await pickAndOpenVault()) uiStore.toast('Vault opened', 'success');
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

  function openSettings() {
    uiStore.openModal('project-settings');
    projectDropdownOpen = false;
  }

  function startRename() {
    renameValue = vaultStore.projectName || '';
    showRenameInput = true;
  }

  function commitRename() {
    const next = renameValue.trim();
    if (next && next !== vaultStore.projectName) {
      vaultStore.setName(next);
      void rememberOpenVault();
    }
    showRenameInput = false;
  }

  function cancelRename() {
    showRenameInput = false;
  }
</script>

<Dropdown label={vaultStore.projectName || 'Vault'} swatch={activeVaultColor()} bind:open={projectDropdownOpen}>
  {#if showRenameInput}
    <div class="rename-project-row">
      <label class="rename-label" for="rename-project">Vault name:</label>
      <input
        id="rename-project"
        class="rename-input"
        type="text"
        bind:value={renameValue}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') cancelRename(); }}
        onblur={commitRename}
        placeholder="Untitled vault"
      />
    </div>
  {:else}
    <button class="dropdown-item" onclick={startRename}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      Rename Vault
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
  <button class="dropdown-item" onclick={openSettings}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    Settings
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
