<script lang="ts">
  import { tick } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { historyStore } from '../../stores/history.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { saveStateStore } from '../../stores/saveState.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import IconButton from '../shared/IconButton.svelte';
  import FiloLogo from '../shared/FiloLogo.svelte';
  import ProjectDropdown from './ProjectDropdown.svelte';
  import TextFormattingToolbar from './TextFormattingToolbar.svelte';

  interface Props {
    onGoHome?: () => void;
  }

  let { onGoHome }: Props = $props();

  // Toolbar color from `--toolbar-bg`, written to :root by App.svelte
  // whenever `general.toolbarColor` changes. Height derives from
  // `--ui-toolbar-scale` (also App.svelte).

  function handleGoHome() {
    onGoHome?.();
  }

  let saveLabel = $derived.by(() => {
    switch (saveStateStore.state) {
      case 'saving': return 'Saving…';
      case 'saved': return 'Saved';
      case 'error': return 'Save failed';
      default: return 'All changes saved';
    }
  });

  // `inError` is read in many spots in the template;
  // a $derived avoids the otherwise-invalid `{@const inError = …}`
  // placement inside a `.toolbar-section` div.
  let inError = $derived(saveStateStore.state === 'error');

  // Clickable error popover anchored to the indicator.
  // Open state is local to the toolbar; the popover dismisses on click-
  // outside / Escape / a successful drain that clears `failedPaths`.
  let errorPopoverOpen = $state(false);
  let saveIndicatorEl = $state<HTMLElement | null>(null);
  let retrying = $state(false);
  // Focus + trap state for the role=dialog popover so keyboard
  // users land on Retry instead of nowhere, and Tab cycles inside the
  // popover instead of leaking into the toolbar behind it.
  let popoverEl = $state<HTMLDivElement | null>(null);
  let retryBtn = $state<HTMLButtonElement | null>(null);
  let popoverTrap: FocusTrap | null = null;

  function toggleErrorPopover() {
    if (saveStateStore.state !== 'error') return;
    errorPopoverOpen = !errorPopoverOpen;
  }

  async function retrySave() {
    if (retrying) return;
    retrying = true;
    try {
      const ok = await vaultStore.save();
      if (ok) {
        errorPopoverOpen = false;
        // setStatus(0, 0) on the next listener tick will drain
        // failedPaths; nothing more to do here.
      } else {
        uiStore.toast('Save still failing — check the error toasts.', 'error');
      }
    } finally {
      retrying = false;
    }
  }

  // Close the popover on click-outside / Escape while it's open.
  $effect(() => {
    if (!errorPopoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (saveIndicatorEl && saveIndicatorEl.contains(t)) return;
      const popover = document.querySelector('.save-error-popover');
      if (popover && popover.contains(t)) return;
      errorPopoverOpen = false;
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') errorPopoverOpen = false; }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  });

  // Auto-close once the failure list drains (e.g. retry succeeded).
  $effect(() => {
    if (errorPopoverOpen && saveStateStore.failedPaths.length === 0 && saveStateStore.state !== 'error') {
      errorPopoverOpen = false;
    }
  });

  // When the popover opens, move focus to Retry (the primary
  // action) and trap Tab inside the popover until it closes. On close,
  // deactivate the trap and return focus to the indicator so the keyboard
  // user lands somewhere meaningful. Mirrors ConfirmDialog's pattern.
  $effect(() => {
    if (!errorPopoverOpen) return;
    // A close before the tick lands must not leave a trap created after
    // its own cleanup ran.
    let disposed = false;
    void tick().then(() => {
      if (disposed || !errorPopoverOpen || !popoverEl) return;
      // Focus Retry by default; fall back to the popover root if Retry is
      // disabled (e.g. mid-retry) so focus still lands inside the trap.
      if (retryBtn && !retryBtn.disabled) {
        retryBtn.focus();
      } else {
        popoverEl.focus();
      }
      try {
        popoverTrap = createFocusTrap(popoverEl, {
          escapeDeactivates: false,
          clickOutsideDeactivates: false,
          allowOutsideClick: true,
          returnFocusOnDeactivate: true,
          // Tolerate the brief window where retry-disabled toggles strip
          // the last tabbable from the popover — the popover root is
          // fallback-focusable via `tabindex=-1`.
          fallbackFocus: () => popoverEl ?? document.body,
          preventScroll: true,
        });
        popoverTrap.activate();
      } catch (err) {
        console.warn('[GlobalToolbar] save-error popover focus-trap activate failed:', err);
        popoverTrap = null;
      }
    });
    return () => {
      disposed = true;
      safeDeactivateTrap(popoverTrap, { name: 'GlobalToolbar/save-error-popover' });
      popoverTrap = null;
    };
  });

  function handleIndicatorKeydown(e: KeyboardEvent) {
    if (saveStateStore.state !== 'error') return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleErrorPopover();
    }
  }
</script>

<header class="global-toolbar" style="height: calc(44px * var(--ui-toolbar-scale, 1));">
  <!-- Left section: Home + Project -->
  <div class="toolbar-section">
    <IconButton title="Home" ariaLabel="Home screen" onclick={handleGoHome}>
      <FiloLogo size={20} />
    </IconButton>

    <div class="toolbar-divider"></div>

    <ProjectDropdown />

    <!--
      Ambient save indicator. Lives in the toolbar (rather than inside the
      ProjectDropdown menu) so the state is visible without opening the
      dropdown. aria-live announces transitions; aria-label gives screen
      readers the full state text on demand.

      When state === 'error' the surface becomes a
      role=button, accepts pointer + keyboard activation, and opens a
      popover listing failed paths + a Retry button. In all other
      states it remains a status surface with pointer-events disabled.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="save-indicator save-{saveStateStore.state}"
      class:clickable={inError}
      bind:this={saveIndicatorEl}
      role={inError ? 'button' : undefined}
      tabindex={inError ? 0 : undefined}
      aria-live={inError ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-label={inError ? `${saveLabel} — click for details` : `Save status: ${saveLabel}`}
      aria-haspopup={inError ? 'dialog' : undefined}
      aria-expanded={inError ? errorPopoverOpen : undefined}
      title={saveLabel}
      onclick={inError ? toggleErrorPopover : undefined}
      onkeydown={handleIndicatorKeydown}
    >
      {#if saveStateStore.state === 'saving'}
        <svg class="save-icon spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      {:else if saveStateStore.state === 'saved'}
        <svg class="save-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      {:else if saveStateStore.state === 'error'}
        <svg class="save-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      {:else}
        <svg class="save-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      {/if}
    </div>

    {#if inError && errorPopoverOpen}
      <!-- role=dialog needs an accessible name (aria-labelledby
           on the title) + focus trap. `tabindex=-1` lets `popoverEl.focus()`
           land here as a fallback when Retry is disabled. -->
      <div
        bind:this={popoverEl}
        class="save-error-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-error-popover-title"
        tabindex="-1"
      >
        <div class="popover-title" id="save-error-popover-title">Save failed</div>
        {#if saveStateStore.failedPaths.length === 0}
          <p class="popover-empty">The error has cleared. You can close this.</p>
        {:else}
          <ul class="popover-list">
            {#each saveStateStore.failedPaths.slice(0, 10) as path (path)}
              <li title={path}>{path}</li>
            {/each}
            {#if saveStateStore.failedPaths.length > 10}
              <li class="popover-more">…and {saveStateStore.failedPaths.length - 10} more</li>
            {/if}
          </ul>
        {/if}
        <div class="popover-actions">
          <button class="popover-btn" onclick={() => { errorPopoverOpen = false; }}>Close</button>
          <button
            bind:this={retryBtn}
            class="popover-btn primary"
            disabled={retrying}
            onclick={() => { void retrySave(); }}
          >
            {retrying ? 'Retrying…' : 'Retry save'}
          </button>
        </div>
      </div>
    {/if}

    <div class="toolbar-divider"></div>

    <IconButton
      title="Undo (Ctrl+Z)"
      ariaLabel="Undo"
      disabled={!historyStore.canUndo}
      onclick={() => historyStore.undo()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="1 4 1 10 7 10"/>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
      </svg>
    </IconButton>

    <IconButton
      title="Redo (Ctrl+Y)"
      ariaLabel="Redo"
      disabled={!historyStore.canRedo}
      onclick={() => historyStore.redo()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
    </IconButton>
  </div>

  <!-- Center section: Text formatting -->
  <TextFormattingToolbar />

  <!-- Right section: Sidebar + Board Toolbar Toggles -->
  <div class="toolbar-section">
    <IconButton
      title="Toggle Sidebar"
      ariaLabel="Toggle sidebar"
      active={uiStore.sidebarOpen}
      onclick={() => uiStore.toggleSidebar()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </IconButton>

    <IconButton
      title="Toggle Board Toolbar"
      ariaLabel="Toggle board toolbar"
      active={uiStore.boardToolbarVisible}
      onclick={() => uiStore.toggleBoardToolbar()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="15" y1="3" x2="15" y2="21"/>
      </svg>
    </IconButton>
  </div>
</header>

<style>
  .global-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background: var(--toolbar-bg);
    border-bottom: 1px solid var(--toolbar-border, var(--ui-border));
    box-shadow: var(--toolbar-shadow, none);
    flex-shrink: 0;
    gap: 4px;
    user-select: none;
    position: relative;
    z-index: var(--z-toolbar);
  }

  .toolbar-section {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-divider {
    width: 1px;
    height: 24px;
    background: var(--toolbar-divider, var(--ui-border));
    margin: 0 6px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .save-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    pointer-events: none;
    user-select: none;
    flex-shrink: 0;
    transition: color 0.15s ease, background-color 0.15s ease;
    border: 0;
    background: transparent;
  }

  /* In the error state the indicator becomes an
     interactive button. Re-enable pointer-events + add a hover affordance
     so the user sees it's clickable. */
  .save-indicator.clickable {
    pointer-events: auto;
    cursor: pointer;
  }
  .save-indicator.clickable:hover {
    background: var(--ui-surface-hover);
  }
  .save-indicator.clickable:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 1px;
  }

  .save-indicator.save-saving { color: var(--text-secondary); }
  .save-indicator.save-saved { color: var(--accent-primary); }
  .save-indicator.save-error { color: var(--accent-danger, #d32f2f); }

  /* Popover anchored below the indicator. position: absolute
     keeps it inside the global toolbar (which already sets z-index: --z-toolbar),
     so it stacks over board content without escaping the toolbar's chrome. */
  .save-error-popover {
    position: absolute;
    top: calc(44px * var(--ui-toolbar-scale, 1));
    left: 12px;
    z-index: 1;
    min-width: 280px;
    max-width: 360px;
    padding: 10px 12px;
    background: var(--modal-bg, var(--ui-surface));
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    color: var(--text-primary);
  }

  .popover-title {
    font-weight: 600;
    font-size: var(--font-size-base);
    margin-bottom: 6px;
    color: var(--accent-danger, #d32f2f);
  }

  .popover-empty {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .popover-list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    max-height: 200px;
    overflow-y: auto;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .popover-list li {
    padding: 3px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .popover-more {
    color: var(--text-tertiary);
    font-style: italic;
  }

  .popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .popover-btn {
    padding: 5px 12px;
    border-radius: 5px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .popover-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .popover-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .popover-btn.primary {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse, #fff);
  }

  .popover-btn.primary:hover:not(:disabled) {
    opacity: 0.92;
  }

  .save-icon {
    flex-shrink: 0;
  }

  .save-icon.spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .save-icon.spin { animation: none; }
  }
</style>
