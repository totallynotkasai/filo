<script lang="ts">
  /**
   * Confirm dialog — generic destructive-action confirmation. Driven by
   * `uiStore.confirmDialog`; mounted once in AppShell so any caller can
   * trigger it via `uiStore.openConfirm({...})`.
   *
   * Stacks on top of the regular modal layer (z-index 3100 > 3001) so
   * it can confirm an action initiated from inside another modal — e.g.
   * the "Apply to all Boards" buttons in Project Settings.
   *
   * Focus the SAFER button on open (Cancel when
   * `danger: true`, Confirm otherwise) and run a strict focus trap
   * across the two buttons + optional `extraOption` checkbox so Tab
   * cycling stays inside the dialog. Mirrors Modal.svelte's trap so
   * users get the same keyboard model in both surfaces.
   */
  import { tick } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { uiStore } from '../../stores/ui.svelte';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let cancelBtn = $state<HTMLButtonElement | null>(null);
  let confirmBtn = $state<HTMLButtonElement | null>(null);
  let config = $derived(uiStore.confirmDialog);
  // Local toggle state for `extraOption`. Re-seeded each time a new config
  // arrives so the previous dialog's choice doesn't leak across opens.
  let extraChecked = $state(false);

  // One run per config: a confirm that displaces another re-seeds the
  // checkbox and focus. The cleanup releases the trap and closes the dialog
  // whether the config cleared or the dialog unmounted, so no trap is left
  // on focus-trap's global stack.
  $effect(() => {
    const c = config;
    const el = dialogEl;
    if (!c || !el) return;
    extraChecked = c.extraOption?.initial ?? false;
    if (!el.open) {
      try {
        el.showModal();
      } catch (err) {
        // Defence-in-depth: if showModal() throws (e.g. the dialog is
        // already in an open state because of a flush race), drop the
        // config so the caller's onCancel doesn't get wedged.
        console.warn('[ConfirmDialog] showModal() failed:', err);
        uiStore.closeConfirm();
        return;
      }
    }
    // Focus the safer button after the dialog is in the DOM. Cancel for
    // destructive actions, Confirm otherwise. `tick()` waits for Svelte's
    // bind:this to populate `cancelBtn` / `confirmBtn`.
    void tick().then(() => {
      if (!el.open) return;
      const target = c.danger ? cancelBtn : confirmBtn;
      target?.focus();
    });
    // Strict focus trap. Wrap activation so a failure can't freeze
    // Svelte's flush.
    let trap: FocusTrap | null = null;
    try {
      trap = createFocusTrap(el, {
        escapeDeactivates: false,
        clickOutsideDeactivates: false,
        allowOutsideClick: true,
        returnFocusOnDeactivate: true,
        fallbackFocus: el,
        preventScroll: true,
      });
      trap.activate();
    } catch (err) {
      console.warn('[ConfirmDialog] focus-trap activate failed:', err);
    }
    return () => {
      safeDeactivateTrap(trap, { name: 'ConfirmDialog' });
      if (el.open) el.close();
    };
  });

  function confirm() {
    const c = config;
    const checked = extraChecked;
    uiStore.closeConfirm();
    c?.onConfirm(checked);
  }

  function secondary() {
    const c = config;
    uiStore.closeConfirm();
    c?.secondaryAction?.onClick();
  }

  function cancel() {
    const c = config;
    uiStore.closeConfirm();
    c?.onCancel?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Stop Escape bubbling to the global `app:cancel` handler, which
      // would otherwise also dismiss the modal stacked beneath this dialog.
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && dialogEl?.contains(active)) {
      active.click();
      return;
    }
    if (config?.danger) {
      cancel();
    } else {
      confirm();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === dialogEl) cancel();
  }
</script>

{#if config}
  <dialog
    class="confirm-dialog"
    bind:this={dialogEl}
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="confirm-title"
  >
    <div class="confirm-content">
      <h2 class="confirm-title" id="confirm-title">{config.title}</h2>
      <p class="confirm-body">{config.body}</p>
      {#if config.extraOption}
        <label class="confirm-extra-option">
          <input type="checkbox" bind:checked={extraChecked} />
          <span class="confirm-extra-body">
            <span>{config.extraOption.label}</span>
            {#if config.extraOption.hint}
              <span class="confirm-extra-hint">{config.extraOption.hint}</span>
            {/if}
          </span>
        </label>
      {/if}
      <div class="confirm-actions">
        {#if !config.notice}
          <button class="confirm-btn cancel" bind:this={cancelBtn} onclick={cancel}>
            {config.cancelLabel ?? 'Cancel'}
          </button>
        {/if}
        {#if config.secondaryAction}
          <button class="confirm-btn secondary" onclick={secondary}>
            {config.secondaryAction.label}
          </button>
        {/if}
        <button
          class="confirm-btn"
          class:danger={config.danger}
          bind:this={confirmBtn}
          onclick={confirm}
        >
          {config.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </div>
  </dialog>
{/if}

<style>
  .confirm-dialog {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal-above);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    padding: 0;
    border: none;
    background: transparent;
    animation: fadeIn 0.12s ease;
  }

  .confirm-dialog::backdrop {
    background: var(--modal-backdrop);
    animation: fadeIn 0.12s ease;
  }

  .confirm-content {
    width: 90%;
    max-width: 420px;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    padding: 20px 22px;
    animation: slideUp 0.15s ease;
  }

  .confirm-title {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 10px;
    color: var(--text-primary);
  }

  .confirm-body {
    font-size: var(--font-size-base);
    line-height: 1.5;
    color: var(--text-secondary);
    margin: 0 0 18px;
    white-space: pre-line;
  }

  .confirm-extra-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    cursor: pointer;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    margin: 0 0 14px;
  }

  .confirm-extra-option input[type="checkbox"] {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    margin-top: 2px;
    cursor: pointer;
    accent-color: var(--accent-danger);
  }

  .confirm-extra-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .confirm-extra-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    line-height: 1.4;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-btn {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: var(--font-size-base);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    transition: background-color 0.1s ease, opacity 0.1s ease;
  }

  .confirm-btn:hover {
    background: var(--ui-surface-hover);
  }

  .confirm-btn.danger {
    background: var(--accent-danger);
    border-color: var(--accent-danger-hover);
    color: var(--text-on-danger);
  }

  .confirm-btn.danger:hover {
    background: var(--accent-danger-hover);
  }

  @media (prefers-reduced-motion: reduce) {
    .confirm-dialog,
    .confirm-content {
      animation: none;
    }
  }
</style>
