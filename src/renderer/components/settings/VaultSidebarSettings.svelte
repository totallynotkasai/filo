<script lang="ts">
  /**
   * The Vault Sidebar section of General settings: the vault's name and
   * colour, and how the sidebar lists files. Sort and Group change the same
   * setting as the sidebar's own buttons. Everything saves at once to
   * `.filo/app.json`; a new name or colour also refreshes the vault's Home entry.
   */
  import { vaultStore } from '../../stores/vault.svelte';
  import { rememberOpenVault } from '../../stores/vaultOpen';
  import { activeVaultColor } from '../../stores/vaultColor';
  import { safeVaultColor } from '../../../shared/vaultColor';
  import { SORT_FIELDS, GROUP_FIELDS, DIRECTIONS } from '../../constants/vaultSidebarOptions';
  import type { VaultGroupField, VaultSortDirection, VaultSortField } from '../../../shared/types';
  import ColorPicker from '../shared/ColorPicker.svelte';

  let nameDraft = $state(vaultStore.projectName || '');
  let editingName = $state(false);

  // Follows a rename made elsewhere (the vault name menu) while the field isn't being typed in.
  $effect(() => {
    const current = vaultStore.projectName || '';
    if (!editingName) nameDraft = current;
  });

  function commitName(): void {
    editingName = false;
    const next = nameDraft.trim();
    if (!next || next === vaultStore.projectName) {
      nameDraft = vaultStore.projectName || '';
      return;
    }
    vaultStore.setName(next);
    void rememberOpenVault();
  }

  function onNameKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      // Keep the Settings dialog open: Escape only drops the typed name.
      e.stopPropagation();
      nameDraft = vaultStore.projectName || '';
      editingName = false;
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  function setColor(color: string): void {
    const general = vaultStore.project?.settings.general;
    if (!general) return;
    const next = safeVaultColor(color);
    if (next === safeVaultColor(general.vaultColor)) return;
    general.vaultColor = next;
    vaultStore.markMetaDirty();
    void rememberOpenVault();
  }

  function setShowExtensions(show: boolean): void {
    const general = vaultStore.project?.settings.general;
    if (!general) return;
    general.showFileExtensions = show;
    vaultStore.markMetaDirty();
  }

  function clearRootDirectory(): void {
    const general = vaultStore.project?.settings.general;
    if (!general || !general.activeRootFolder) return;
    general.activeRootFolder = '';
    vaultStore.markMetaDirty();
  }

  let showExtensions = $derived(vaultStore.project?.settings.general?.showFileExtensions ?? false);
  let rootDirectory = $derived(vaultStore.activeRootFolder);
</script>

<div class="vault-sidebar-settings">
  <div class="section-label">Vault Sidebar</div>

  <div class="setting-row">
    <label class="setting-label" for="vault-name">Vault name</label>
    <input
      id="vault-name"
      class="setting-input name-input"
      type="text"
      placeholder="Untitled vault"
      bind:value={nameDraft}
      onfocus={() => { editingName = true; }}
      onblur={commitName}
      onkeydown={onNameKeydown}
    />
  </div>

  <div class="setting-row">
    <div class="setting-label-stack">
      <span class="setting-label">Vault colour</span>
      <span class="setting-hint">Shown beside the vault name in the toolbar, the sidebar and the Home screen.</span>
    </div>
    <ColorPicker value={activeVaultColor()} onchange={setColor} />
  </div>

  <div class="setting-row">
    <label class="setting-label" for="vault-sort-field">Sort by</label>
    <div class="select-pair">
      <select
        id="vault-sort-field"
        class="setting-select"
        value={vaultStore.sortField}
        onchange={(e) => vaultStore.setSortField((e.currentTarget as HTMLSelectElement).value as VaultSortField)}
      >
        {#each SORT_FIELDS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
      <select
        class="setting-select"
        aria-label="Sort direction"
        value={vaultStore.sortDirection}
        disabled={vaultStore.sortField === 'none'}
        onchange={(e) => vaultStore.setSortDirection((e.currentTarget as HTMLSelectElement).value as VaultSortDirection)}
      >
        {#each DIRECTIONS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="setting-row">
    <label class="setting-label" for="vault-group-field">Group by</label>
    <div class="select-pair">
      <select
        id="vault-group-field"
        class="setting-select"
        value={vaultStore.groupField}
        onchange={(e) => vaultStore.setGroupField((e.currentTarget as HTMLSelectElement).value as VaultGroupField)}
      >
        {#each GROUP_FIELDS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
      <select
        class="setting-select"
        aria-label="Group direction"
        value={vaultStore.groupDirection}
        disabled={vaultStore.groupField === 'none'}
        onchange={(e) => vaultStore.setGroupDirection((e.currentTarget as HTMLSelectElement).value as VaultSortDirection)}
      >
        {#each DIRECTIONS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="setting-row">
    <label class="setting-label" for="file-ext-toggle">Show file extensions</label>
    <button
      id="file-ext-toggle"
      class="toggle-btn"
      class:active={showExtensions}
      onclick={() => setShowExtensions(!showExtensions)}
      role="switch"
      aria-checked={showExtensions}
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">{showExtensions ? 'On' : 'Off'}</span>
    </button>
  </div>

  <div class="setting-row">
    <div class="setting-label-stack">
      <span class="setting-label">Root Directory</span>
      <span class="setting-hint">New files go here. Set it with a folder's "Use as root directory" button in the sidebar.</span>
    </div>
    <div class="root-directory">
      <span class="root-path" class:unset={!rootDirectory} title={rootDirectory || undefined}>
        {rootDirectory || 'Vault root'}
      </span>
      <button
        class="btn-secondary"
        type="button"
        onclick={clearRootDirectory}
        disabled={!rootDirectory}
        aria-label="Clear Root Directory"
      >Clear</button>
    </div>
  </div>
</div>

<style>
  .vault-sidebar-settings {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-label {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 36px;
    padding-left: 12px;
  }

  .setting-label {
    font-size: 12px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .setting-label-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .setting-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .setting-input,
  .setting-select {
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .setting-select {
    cursor: pointer;
    min-width: 120px;
  }

  .setting-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .setting-input:focus,
  .setting-select:focus {
    border-color: var(--ui-border-focus);
  }
  .setting-input:focus:not(:focus-visible),
  .setting-select:focus:not(:focus-visible) {
    outline: none;
  }

  .name-input {
    width: 220px;
  }

  .select-pair {
    display: flex;
    gap: 6px;
  }

  .root-directory {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .root-path {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-primary);
  }

  .root-path.unset {
    color: var(--text-tertiary);
    font-style: italic;
    /* Room for the italic overhang, which overflow: hidden would cut. */
    padding-right: 2px;
  }

  .btn-secondary {
    padding: 6px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 12px;
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    color: var(--text-secondary);
    font-family: var(--font-system);
    font-size: var(--font-size-base);
  }

  .toggle-track {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--ui-border);
    transition: background-color 0.15s ease;
  }

  .toggle-btn.active .toggle-track {
    background: var(--accent-primary);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    transition: transform 0.15s ease;
  }

  .toggle-btn.active .toggle-thumb {
    transform: translateX(16px);
  }

  .toggle-label {
    font-size: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-track,
    .toggle-thumb,
    .btn-secondary {
      transition: none;
    }
  }
</style>
