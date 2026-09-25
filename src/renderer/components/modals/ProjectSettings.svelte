<script lang="ts">
  import { untrack } from 'svelte';
  import GeneralSettings from '../settings/GeneralSettings.svelte';
  import BoardDefaults from '../settings/BoardDefaults.svelte';
  import CurrentBoardSettings from '../settings/CurrentBoardSettings.svelte';
  import ThemeManager from '../settings/ThemeManager.svelte';
  import TrashSettings from '../settings/TrashSettings.svelte';
  import LivePreview from '../settings/LivePreview.svelte';
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { saveStateStore } from '../../stores/saveState.svelte';
  import { handleListKeyNav } from '../../lib/utils/listKeyNav';
  import { reportError } from '../../lib/utils/errorBus';

  type SettingsTab = 'general' | 'defaults' | 'current-board' | 'themes' | 'trash';
  let activeTab = $state<SettingsTab>('general');

  // Current Board tab is only meaningful when a board is active.
  let hasActiveBoard = $derived(boardStore.current !== null);

  // ── Per-tab Apply / Cancel handlers ──
  //
  // Pinned at the modal-level footer (NOT inside the scrollable panel)
  // so the buttons are always visible regardless of how far the user
  // has scrolled within the settings panel.
  //
  // After Apply / Cancel we re-`start()` the pending session so the user
  // can keep editing within the same modal without re-opening it. The
  // restart is wrapped in `untrack` so writing to the live settings
  // doesn't re-trigger the modal-mount effect via the tracked reads
  // inside `start()`. Without this guard, Apply both re-fired the mount
  // effect AND the queued microtask, causing two interleaved snapshots
  // to fight over `pending`/`pendingBoardSettings` and leaving stale
  // references that froze the UI on next board reopen.
  // Re-arm ONLY the scope we just committed/cancelled. Calling the bundled
  // `start()` here re-snapshots both layers, which silently overwrites
  // whatever is still uncommitted in the other tab — the bug behind
  // "changing one tab clobbers the other".
  // Apply handlers commit pending changes to the in-memory project, then
  // AWAIT vaultStore.save() so the success toast only fires after the disk
  // write resolves — otherwise the toast would fire during the 300ms debounce
  // window, before the write reached disk. The save-state indicator in the
  // GlobalToolbar provides visual feedback during the await; the button is
  // disabled to prevent double-clicks.
  let isSaving = $derived(saveStateStore.state === 'saving');

  async function applyGlobal() {
    pendingSettingsStore.applyGlobal();
    try {
      await vaultStore.save();
      uiStore.toast('Global defaults applied', 'success');
    } catch (err) {
      reportError('ProjectSettings.apply-global', err, 'Failed to save global defaults');
    }
    untrack(() => pendingSettingsStore.startGlobal());
  }
  function cancelGlobal() {
    pendingSettingsStore.cancelGlobal();
    untrack(() => pendingSettingsStore.startGlobal());
  }
  async function applyBoard() {
    pendingSettingsStore.applyBoard();
    try {
      await vaultStore.save();
      uiStore.toast('Board settings applied', 'success');
    } catch (err) {
      reportError('ProjectSettings.apply-board', err, 'Failed to save board settings');
    }
    untrack(() => pendingSettingsStore.startBoard());
  }
  function cancelBoard() {
    pendingSettingsStore.cancelBoard();
    untrack(() => pendingSettingsStore.startBoard());
  }
  function confirmApplyGlobalToAll() {
    uiStore.openConfirm({
      title: 'Apply Current Global Defaults to all Boards?',
      body:
        'This will overwrite every board\'s per-board settings with the current Global Defaults. Per-tile, per-frame, and per-connection style overrides are NOT affected. This action cannot be undone.',
      confirmLabel: 'Apply to all',
      danger: true,
      onConfirm: () => {
        if (pendingSettingsStore.pending) pendingSettingsStore.applyGlobal();
        boardStore.applyGlobalDefaultsToAllBoards();
        untrack(() => pendingSettingsStore.start());
      },
    });
  }
  function confirmApplyThemeToAll() {
    uiStore.openConfirm({
      title: 'Apply Theme Defaults to all Boards?',
      body:
        'This will overwrite every board\'s per-board settings with the active theme\'s defaults. Per-tile, per-frame, and per-connection style overrides are NOT affected. This action cannot be undone.',
      confirmLabel: 'Apply theme to all',
      danger: true,
      onConfirm: () => {
        boardStore.applyThemeDefaultsToAllBoards();
      },
    });
  }

  let tabListEl = $state<HTMLDivElement | null>(null);

  function handleSettingsTabKeydown(e: KeyboardEvent) {
    if (!tabListEl) return;
    // Vertical tablist — settings tabs are stacked in a left rail.
    if (handleListKeyNav(e, tabListEl, { selector: '[role="tab"]:not([disabled])', orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  // The `saveMode` chip flags each tab's commit semantics — auto-save vs
  // explicit Apply/Cancel — a user-visible cue, since the modal mixes save
  // behaviours and a small helper line isn't loud enough.
  const tabs: { id: SettingsTab; label: string; icon: string; saveMode: 'auto' | 'apply' }[] = [
    { id: 'general', label: 'General', saveMode: 'auto', icon: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
    { id: 'defaults', label: 'Global Defaults', saveMode: 'apply', icon: 'M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13' },
    { id: 'current-board', label: 'Current Board', saveMode: 'apply', icon: 'M3 3h18v18H3zM9 3v18M3 9h18' },
    { id: 'themes', label: 'Themes', saveMode: 'auto', icon: 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z' },
    { id: 'trash', label: 'Trash', saveMode: 'auto', icon: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' },
  ];

  // Begin a pending-edit session on mount; cancel anything still in
  // flight when the modal closes. Apply/Cancel are now per-tab inside
  // BoardDefaults / CurrentBoardSettings, so the modal-level lifecycle
  // only needs to bootstrap the session and discard any uncommitted
  // edits when the user dismisses the modal.
  //
  // CRITICAL: wrap in `untrack` so the tracked reads inside `start()`
  // (vaultStore.project.settings, boardStore.current.settings) don't
  // bind this mount-effect to those fields. Without this guard, Apply
  // mutates currentBoard.settings → effect re-runs → cancel() then
  // start() fire mid-Apply → snapshot races against the per-handler
  // restart and leaves stale references that freeze the canvas the
  // next time the board is closed and reopened.
  $effect(() => {
    untrack(() => pendingSettingsStore.start());
    return () => {
      if (untrack(() => pendingSettingsStore.active)) {
        untrack(() => pendingSettingsStore.cancel());
      }
    };
  });
</script>

<div class="settings-container">
  <div
    bind:this={tabListEl}
    class="settings-tabs"
    role="tablist"
    aria-label="Settings tabs"
    aria-orientation="vertical"
    tabindex={-1}
    onkeydown={handleSettingsTabKeydown}
  >
    {#each tabs as tab (tab.id)}
      {@const disabled = tab.id === 'current-board' && !hasActiveBoard}
      <button
        class="settings-tab"
        class:active={activeTab === tab.id}
        class:disabled
        {disabled}
        role="tab"
        tabindex={activeTab === tab.id ? 0 : -1}
        aria-selected={activeTab === tab.id}
        onclick={() => activeTab = tab.id}
        onfocus={() => { if (!disabled) activeTab = tab.id; }}
        title={disabled ? 'Open a board to edit its per-board settings' : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={tab.icon}/>
        </svg>
        <span class="settings-tab-label">{tab.label}</span>
        <span
          class="settings-tab-save-mode"
          class:apply={tab.saveMode === 'apply'}
          title={tab.saveMode === 'auto'
            ? 'Saves automatically as you change values.'
            : 'Use Apply / Cancel at the bottom to commit changes.'}
        >{tab.saveMode === 'auto' ? 'Auto' : 'Apply'}</span>
      </button>
    {/each}
  </div>

  <div class="settings-body">
    <div class="settings-panel" role="tabpanel">
      {#if activeTab === 'defaults' || activeTab === 'current-board'}
        <LivePreview
          settings={pendingSettingsStore.effective}
          board={boardStore.current}
          boardSettings={pendingSettingsStore.effectiveBoardSettings}
          activeTab={activeTab}
        />
      {/if}

      {#if activeTab === 'general'}
        <GeneralSettings />
      {:else if activeTab === 'defaults'}
        <BoardDefaults />
      {:else if activeTab === 'current-board'}
        <CurrentBoardSettings />
      {:else if activeTab === 'themes'}
        <ThemeManager />
      {:else if activeTab === 'trash'}
        <TrashSettings />
      {/if}
    </div>

    {#if activeTab === 'defaults'}
      <footer class="settings-footer">
        <div class="footer-row">
          <button class="footer-btn cancel" onclick={cancelGlobal} disabled={isSaving}>Cancel</button>
          <button class="footer-btn apply" onclick={applyGlobal} disabled={isSaving}>Apply</button>
        </div>
        <div class="footer-row danger-row">
          <button class="footer-btn danger" onclick={confirmApplyGlobalToAll}>
            Apply Current Global Defaults to all Boards
          </button>
          <button class="footer-btn danger" onclick={confirmApplyThemeToAll}>
            Apply Theme Defaults to all Boards
          </button>
        </div>
      </footer>
    {:else if activeTab === 'current-board'}
      <footer class="settings-footer">
        <div class="footer-row">
          <button class="footer-btn cancel" onclick={cancelBoard} disabled={isSaving}>Cancel</button>
          <button class="footer-btn apply" onclick={applyBoard} disabled={isSaving}>Apply</button>
        </div>
      </footer>
    {/if}
  </div>
</div>

<style>
  .settings-container {
    display: flex;
    gap: 0;
    min-height: 420px;
  }

  .settings-tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    border-right: 1px solid var(--ui-border);
    min-width: 140px;
    flex-shrink: 0;
  }

  .settings-tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
    text-align: left;
    white-space: nowrap;
  }

  .settings-tab:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .settings-tab.active {
    background: var(--ui-surface-active);
    color: var(--text-primary);
    font-weight: 500;
  }

  .settings-tab.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .settings-tab.disabled:hover {
    background: transparent;
    color: var(--text-secondary);
  }

  .settings-tab-label {
    flex: 1;
  }

  .settings-tab-save-mode {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 8px;
    background: var(--ui-surface-raised);
    color: var(--text-tertiary);
    line-height: 1;
    flex-shrink: 0;
  }

  .settings-tab-save-mode.apply {
    background: color-mix(in srgb, var(--accent-primary) 18%, transparent);
    color: var(--accent-primary);
  }

  .settings-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .settings-panel {
    flex: 1;
    padding: 4px 16px 16px;
    overflow-y: auto;
    min-width: 0;
  }

  .settings-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--ui-border);
    background: var(--ui-bg-secondary, var(--ui-surface));
    flex-shrink: 0;
  }

  .footer-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .danger-row {
    flex-wrap: wrap;
  }

  .footer-btn {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.1s ease, opacity 0.1s ease;
    font-family: var(--font-system);
  }

  .footer-btn.cancel {
    background: var(--ui-surface);
    color: var(--text-primary);
    border-color: var(--ui-border);
  }

  .footer-btn.cancel:hover {
    background: var(--ui-surface-hover);
  }

  .footer-btn.apply {
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
  }

  .footer-btn.apply:hover {
    opacity: 0.88;
  }

  .footer-btn.danger {
    background: transparent;
    color: #c0392b;
    border-color: #c0392b;
  }

  .footer-btn.danger:hover {
    background: rgba(192, 57, 43, 0.08);
  }
</style>
