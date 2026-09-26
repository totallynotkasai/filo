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
  import { settleUnappliedEdits } from '../../lib/settings/unappliedEditsPrompt';
  import { handleListKeyNav } from '../../lib/utils/listKeyNav';
  import { reportError } from '../../lib/utils/errorBus';

  type SettingsTab = 'general' | 'defaults' | 'current-board' | 'themes' | 'trash';
  let activeTab = $state<SettingsTab>('general');

  // Current Board tab is only meaningful when a board is active.
  let hasActiveBoard = $derived(boardStore.current !== null);

  // ── Per-tab Apply / Cancel ──
  //
  // Each tab re-arms only its own copy after Apply / Cancel: `start()` would
  // re-copy both and drop the other tab's unapplied edits. The re-arm runs in
  // `untrack` so its reads of the live settings don't subscribe the caller.
  //
  // Apply awaits `vaultStore.save()` so "applied" is only said once the
  // write is on disk. `applying` disables the buttons during that save; it
  // is this dialog's own save only (the global save state flickers with any
  // unrelated write).
  let applying = $state(false);
  let globalDirty = $derived(pendingSettingsStore.hasGlobalChanges());
  let boardDirty = $derived(pendingSettingsStore.hasBoardChanges());

  async function saveAfterApply(label: string, context: string): Promise<void> {
    applying = true;
    try {
      await vaultStore.save();
      uiStore.toast(label, 'success');
    } catch (err) {
      reportError(context, err, 'Failed to save settings');
    } finally {
      applying = false;
    }
  }

  async function applyGlobal() {
    const result = pendingSettingsStore.applyGlobal();
    if (!result.ok) {
      uiStore.toast(result.message, 'error');
      return;
    }
    untrack(() => pendingSettingsStore.startGlobal());
    if (result.changed) await saveAfterApply('Global defaults applied', 'ProjectSettings.apply-global');
  }
  function cancelGlobal() {
    pendingSettingsStore.cancelGlobal();
    untrack(() => pendingSettingsStore.startGlobal());
  }
  async function applyBoard() {
    const result = pendingSettingsStore.applyBoard();
    if (!result.ok) {
      uiStore.toast(result.message, 'error');
      return;
    }
    untrack(() => pendingSettingsStore.startBoard());
    if (result.changed) await saveAfterApply('Board settings applied', 'ProjectSettings.apply-board');
  }
  function cancelBoard() {
    pendingSettingsStore.cancelBoard();
    untrack(() => pendingSettingsStore.startBoard());
  }

  /**
   * Runs a bulk "Apply … to all Boards". It rewrites the current board, so
   * the Current Board copy is settled first (Apply / Discard / Cancel) and
   * re-armed afterwards; otherwise a later Apply there would write the old
   * settings back.
   */
  async function runBulkApply(
    what: string,
    run: () => Promise<{ updated: number; skipped: string[] }>,
  ): Promise<void> {
    applying = true;
    try {
      const { updated, skipped } = await run();
      await vaultStore.save();
      if (skipped.length > 0) {
        uiStore.toast(
          `${what} applied to ${updated} board${updated === 1 ? '' : 's'}. Not updated (couldn't load): ${skipped.join(', ')}.`,
          'warning',
        );
      } else {
        uiStore.toast(`${what} applied to ${updated} board${updated === 1 ? '' : 's'}`, 'success');
      }
    } catch (err) {
      reportError('ProjectSettings.bulk-apply', err, `Failed to apply ${what} to all boards`);
    } finally {
      applying = false;
      untrack(() => pendingSettingsStore.startBoard());
    }
  }

  async function confirmApplyGlobalToAll() {
    if (!(await settleUnappliedEdits('board', 'apply the Global Defaults to every board'))) return;
    uiStore.openConfirm({
      title: 'Apply Current Global Defaults to all Boards?',
      body:
        "This will overwrite every board's style settings (colours, pattern, font sizes and style defaults) with the current Global Defaults. Other board settings, and per-tile, per-frame and per-connection style overrides, are NOT affected. This action cannot be undone.",
      confirmLabel: 'Apply to all',
      danger: true,
      onConfirm: () => {
        // The bulk action uses the live defaults, so unapplied Global
        // Defaults edits are applied first (the button is on that tab).
        const result = pendingSettingsStore.applyGlobal();
        if (!result.ok) {
          uiStore.toast(result.message, 'error');
          return;
        }
        untrack(() => pendingSettingsStore.startGlobal());
        void runBulkApply('Global Defaults', () => boardStore.applyGlobalDefaultsToAllBoards());
      },
    });
  }
  async function confirmApplyThemeToAll() {
    if (!(await settleUnappliedEdits('board', 'apply the theme defaults to every board'))) return;
    uiStore.openConfirm({
      title: 'Apply Theme Defaults to all Boards?',
      body:
        "This will overwrite every board's style settings (colours, pattern, font sizes and style defaults) with the active theme's defaults. Other board settings, and per-tile, per-frame and per-connection style overrides, are NOT affected. This action cannot be undone.",
      confirmLabel: 'Apply theme to all',
      danger: true,
      onConfirm: () => {
        void runBulkApply('Theme defaults', () => boardStore.applyThemeDefaultsToAllBoards());
      },
    });
  }

  // The dialog is modal and shortcuts are kept out of it (`isolateShortcuts`
  // on its Modal), so the active board can't be switched from here. It can
  // still go away underneath (its file deleted by another program closes the
  // tab). The Current Board copy then belongs to a board the tab no longer
  // shows, so the session ends: a copy with no edits follows the new board,
  // and unapplied edits are dropped with a notice rather than applied to a
  // board the user isn't looking at.
  $effect(() => {
    const activeId = boardStore.current?.id ?? null;
    untrack(() => {
      const pinned = pendingSettingsStore.pendingBoardId;
      if (pinned === null || pinned === activeId) return;
      if (pendingSettingsStore.hasBoardChanges()) {
        uiStore.toast('The board changed, so your unapplied Current Board changes were discarded.', 'warning');
      }
      pendingSettingsStore.startBoard();
    });
  });

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
  const SAVE_MODE_HINT = {
    auto: 'Saves automatically as you change values.',
    apply: 'Changes here take effect when you click Apply.',
  } as const;
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
        id={`settings-tab-${tab.id}`}
        class="settings-tab"
        class:active={activeTab === tab.id}
        class:disabled
        {disabled}
        role="tab"
        tabindex={activeTab === tab.id ? 0 : -1}
        aria-selected={activeTab === tab.id}
        aria-controls="settings-tabpanel"
        onclick={() => activeTab = tab.id}
        onfocus={() => { if (!disabled) activeTab = tab.id; }}
        title={disabled ? 'Open a board to edit its per-board settings' : SAVE_MODE_HINT[tab.saveMode]}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={tab.icon}/>
        </svg>
        <span class="settings-tab-label">{tab.label}</span>
        <!-- Hidden from assistive tech so the tab is announced by its name
             alone; the tab's title carries what the chip means. -->
        <span
          class="settings-tab-save-mode"
          class:apply={tab.saveMode === 'apply'}
          aria-hidden="true"
        >{tab.saveMode === 'auto' ? 'Auto' : 'Apply'}</span>
      </button>
    {/each}
  </div>

  <div class="settings-body">
    <div
      id="settings-tabpanel"
      class="settings-panel"
      role="tabpanel"
      aria-labelledby={`settings-tab-${activeTab}`}
    >
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
          <button class="footer-btn cancel" onclick={cancelGlobal} disabled={!globalDirty || applying}>Cancel</button>
          <button class="footer-btn apply" onclick={applyGlobal} disabled={!globalDirty || applying}>Apply</button>
        </div>
        <div class="footer-row danger-row">
          <button class="footer-btn danger" onclick={confirmApplyGlobalToAll} disabled={applying}>
            Apply Current Global Defaults to all Boards
          </button>
          <button class="footer-btn danger" onclick={confirmApplyThemeToAll} disabled={applying}>
            Apply Theme Defaults to all Boards
          </button>
        </div>
      </footer>
    {:else if activeTab === 'current-board'}
      <footer class="settings-footer">
        <div class="footer-row">
          <button class="footer-btn cancel" onclick={cancelBoard} disabled={!boardDirty || applying}>Cancel</button>
          <button class="footer-btn apply" onclick={applyBoard} disabled={!boardDirty || applying}>Apply</button>
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

  .footer-btn:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
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
