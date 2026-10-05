<script lang="ts">
  import { untrack } from 'svelte';
  import GeneralSettings from '../settings/GeneralSettings.svelte';
  import BoardDefaults from '../settings/BoardDefaults.svelte';
  import CurrentBoardSettings from '../settings/CurrentBoardSettings.svelte';
  import ThemeManager from '../settings/ThemeManager.svelte';
  import TrashSettings from '../settings/TrashSettings.svelte';
  import RecoverySettings from '../settings/RecoverySettings.svelte';
  import LivePreview from '../settings/LivePreview.svelte';
  import SettingsActionBar from '../settings/SettingsActionBar.svelte';
  import { pendingSettingsStore, settingsBoard } from '../../stores/pendingSettings.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { settleUnappliedEdits } from '../../lib/settings/unappliedEditsPrompt';
  import { settleThemeEditor } from '../../lib/themes/themeEditorGuard';
  import { handleListKeyNav } from '../../lib/utils/listKeyNav';
  import { reportError } from '../../lib/utils/errorBus';
  import { APP_VERSION } from '../../constants/appVersion';
  import { settingsTabRequest, type SettingsTab } from '../../lib/settings/settingsTabRequest.svelte';

  // A notice may ask for a tab (Open Recovery): taken as the dialog opens, or
  // when the dialog is already open, as it arrives.
  let activeTab = $state<SettingsTab>(untrack(() => settingsTabRequest.take()) ?? 'general');
  $effect(() => {
    const asked = settingsTabRequest.requested;
    if (asked === null) return;
    untrack(() => {
      settingsTabRequest.take();
      void selectTab(asked);
    });
  });

  // Current Board tab is only meaningful when a board is active (not a note
  // in a Document tab, whose pane still holds the board it showed before).
  let targetBoard = $derived(settingsBoard());
  let hasActiveBoard = $derived(targetBoard !== null);
  // A note has no board file to keep per-board settings in: its page
  // follows Global Defaults → Document, and its line spacing is its own.
  let currentBoardOffHint = $derived(
    tabStore.activeTab?.notePath !== undefined
      ? 'A note has no board settings: its page follows Global Defaults → Document'
      : 'Open a board to edit its per-board settings',
  );

  // ── Layout ──
  //
  // A fixed tab rail on the left; on the right, the active tab's page is the
  // only thing that scrolls. Global Defaults and Current Board save on Apply:
  // their Revert / Apply bar is pinned above the page (outside the scroll),
  // and the "Apply … to all Boards" actions sit at the end of the Global
  // Defaults page, under "Danger zone". The other tabs save as they change.
  //
  // ── Per-tab Apply / Revert ──
  //
  // Each tab re-arms only its own copy after Apply / Revert: `start()` would
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
        "Every board's own style settings (colours, pattern, font sizes and style defaults) are cleared, so every board follows the Global Defaults. Other board settings, and per-tile, per-frame and per-connection style overrides, are NOT affected. This action cannot be undone.",
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
    const activeId = targetBoard?.id ?? null;
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

  // Leaving the Themes tab unmounts an open theme editor, so unsaved colours
  // there are asked about first. The tabs also switch on focus (arrow keys),
  // and the prompt hands focus back to the tab that asked: `settling` keeps
  // that from asking again.
  let settling = false;
  async function selectTab(id: SettingsTab): Promise<void> {
    if (id === activeTab || settling) return;
    if (activeTab === 'themes') {
      settling = true;
      let leave = false;
      try {
        leave = await settleThemeEditor();
      } finally {
        settling = false;
      }
      if (!leave) {
        tabListEl?.querySelector<HTMLElement>('#settings-tab-themes')?.focus();
        return;
      }
    }
    activeTab = id;
  }

  function handleSettingsTabKeydown(e: KeyboardEvent) {
    if (!tabListEl) return;
    // Vertical tablist — settings tabs are stacked in a left rail.
    if (handleListKeyNav(e, tabListEl, { selector: '[role="tab"]:not([disabled])', orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  // The `saveMode` chip flags each tab's commit semantics — auto-save vs
  // explicit Apply / Revert — a user-visible cue, since the modal mixes save
  // behaviours. Every tab also says its rule in words in the same place, the
  // bar above its page: the Apply / Revert bar, or this line.
  // Themes has no chip: a pick applies at once, but the theme editor saves
  // only on its Save button, so neither label is true of the whole tab.
  const SAVE_MODE_HINT = {
    auto: 'Changes here save as you make them.',
    apply: 'Changes here wait for Apply.',
    themes: 'Picking a theme applies it at once. The theme editor saves when you click Save.',
  } as const;
  const SAVE_RULE: Partial<Record<SettingsTab, string>> = {
    general: SAVE_MODE_HINT.auto,
    themes: SAVE_MODE_HINT.themes,
    trash: 'Restore and Empty trash act at once.',
    recovery: 'Open, Show in folder and Delete act at once.',
  };
  const tabs: { id: SettingsTab; label: string; icon: string; saveMode: 'auto' | 'apply' | 'themes' }[] = [
    { id: 'general', label: 'General', saveMode: 'auto', icon: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
    { id: 'defaults', label: 'Global Defaults', saveMode: 'apply', icon: 'M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13' },
    { id: 'current-board', label: 'Current Board', saveMode: 'apply', icon: 'M3 3h18v18H3zM9 3v18M3 9h18' },
    { id: 'themes', label: 'Themes', saveMode: 'themes', icon: 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z' },
    { id: 'trash', label: 'Trash', saveMode: 'auto', icon: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' },
    { id: 'recovery', label: 'Recovery', saveMode: 'auto', icon: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2' },
  ];

  // Begin a pending-edit session on mount; cancel anything still in
  // flight when the modal closes. Apply / Revert are per tab (the action
  // bar above), so the dialog-level lifecycle only starts the session and
  // discards any unapplied edits when the dialog is dismissed.
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
  <!-- The rail holds the tabs and, under them, which build is running (so
       builds can be told apart). The version sits outside the tablist, whose
       children must all be tabs. -->
  <div class="settings-rail">
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
          onclick={() => selectTab(tab.id)}
          onfocus={() => { if (!disabled) void selectTab(tab.id); }}
          title={disabled ? currentBoardOffHint : SAVE_MODE_HINT[tab.saveMode]}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={tab.icon}/>
          </svg>
          <span class="settings-tab-label">{tab.label}</span>
          <!-- Hidden from assistive tech so the tab is announced by its name
               alone; the tab's title carries what the chip means. -->
          {#if tab.saveMode !== 'themes'}
            <span
              class="settings-tab-save-mode"
              class:apply={tab.saveMode === 'apply'}
              aria-hidden="true"
            >{tab.saveMode === 'auto' ? 'Auto' : 'Apply'}</span>
          {/if}
        </button>
      {/each}
    </div>
    <p class="settings-version">Filo {APP_VERSION}</p>
  </div>

  <div
    id="settings-tabpanel"
    class="settings-body"
    role="tabpanel"
    aria-labelledby={`settings-tab-${activeTab}`}
  >
    {#if activeTab === 'defaults'}
      <SettingsActionBar dirty={globalDirty} busy={applying} onApply={applyGlobal} onRevert={cancelGlobal} />
    {:else if activeTab === 'current-board'}
      <SettingsActionBar dirty={boardDirty} busy={applying} onApply={applyBoard} onRevert={cancelBoard} />
    {:else if SAVE_RULE[activeTab]}
      <p class="settings-save-rule">{SAVE_RULE[activeTab]}</p>
    {/if}

    <!-- Keyed by tab, so each tab's page opens at its top rather than at
         the previous tab's scroll position. -->
    {#key activeTab}
      <div class="settings-scroll">
        {#if activeTab === 'defaults' || activeTab === 'current-board'}
          <LivePreview
            settings={pendingSettingsStore.effective}
            board={targetBoard}
            boardSettings={pendingSettingsStore.effectiveBoardSettings}
            activeTab={activeTab}
          />
        {/if}

        {#if activeTab === 'general'}
          <GeneralSettings />
        {:else if activeTab === 'defaults'}
          <BoardDefaults />
          <section class="danger-zone" aria-labelledby="settings-danger-zone">
            <h3 class="danger-zone-title" id="settings-danger-zone">Danger zone</h3>
            <p class="danger-zone-hint">These overwrite the style settings of every board and can't be undone.</p>
            <div class="danger-zone-buttons">
              <button class="danger-btn" onclick={confirmApplyGlobalToAll} disabled={applying}>
                Apply Current Global Defaults to all Boards
              </button>
              <button class="danger-btn" onclick={confirmApplyThemeToAll} disabled={applying}>
                Apply Theme Defaults to all Boards
              </button>
            </div>
          </section>
        {:else if activeTab === 'current-board'}
          <CurrentBoardSettings />
        {:else if activeTab === 'themes'}
          <ThemeManager />
        {:else if activeTab === 'trash'}
          <TrashSettings />
        {:else if activeTab === 'recovery'}
          <RecoverySettings />
        {/if}
      </div>
    {/key}
  </div>
</div>

<style>
  /* A set height, so switching tabs doesn't resize the dialog. The modal
     body is a shrinking flex column, so in a short window this shrinks to
     fit and the page scrolls instead. */
  .settings-container {
    display: flex;
    gap: 0;
    height: 680px;
    min-height: 0;
  }

  .settings-rail {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--ui-border);
    /* A set width: the active tab's heavier label must not nudge the page. */
    width: 210px;
    box-sizing: border-box;
    flex-shrink: 0;
    min-height: 0;
  }

  .settings-tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .settings-version {
    margin: 0;
    padding: 8px 18px 10px;
    font-size: 12px;
    color: var(--text-tertiary);
    user-select: text;
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
    min-height: 0;
  }

  /* Where an Apply tab has its Apply / Revert bar, the others say how they save. */
  .settings-save-rule {
    margin: 0;
    padding: 14px 16px;
    font-size: 12px;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-bg-secondary, var(--ui-surface));
    flex-shrink: 0;
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    padding: 4px 16px 16px;
    overflow-y: auto;
  }

  .danger-zone {
    margin-top: 24px;
    padding-top: 16px;
    /* The theme danger red marks the zone; text stays in the text colour, since
       red on the mid-tone dialogs of the darker themes reads at about 2:1. */
    border-top: 2px solid var(--accent-danger);
  }

  .danger-zone-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .danger-zone-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0 0 10px;
  }

  .danger-zone-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .danger-btn {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--accent-danger);
    transition: background-color 0.1s ease, opacity 0.1s ease;
    font-family: var(--font-system);
  }

  .danger-btn:hover {
    background: var(--menu-danger-bg);
  }

  .danger-btn:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .settings-tab,
    .danger-btn {
      transition: none;
    }
  }
</style>
