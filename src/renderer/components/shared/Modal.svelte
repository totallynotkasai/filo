<script lang="ts">
  import type { Snippet } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { uiStore } from '../../stores/ui.svelte';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  interface Props {
    id: string;
    /**
     * The visible heading rendered in the header AND the accessible name
     * exposed via `aria-labelledby`. Required — leaving it empty would
     * leak the internal `id` string to assistive tech (e.g. screen readers
     * announcing "keyboard-shortcuts dialog") in lieu of a real label.
     */
    title: string;
    width?: string;
    /**
     * Whether to render the visible "Esc" pill next to the close icon. Use
     * for surfaces where keyboard hints aid first-day discoverability;
     * defaults to true. The `aria-keyshortcuts` attribute is always
     * present regardless of this flag.
     */
    showKeyHints?: boolean;
    /**
     * Optional guard invoked before any close path (Esc,
     * backdrop click, X button). Resolve `false` to keep the modal open
     * (e.g. when a discard-changes confirmation is pending); resolve
     * `true` to let the close proceed. Sync returns are accepted.
     * Defaults to "always allow" so existing modals are unaffected.
     */
    beforeClose?: () => boolean | Promise<boolean>;
    /**
     * Keeps app keyboard shortcuts with a modifier (Ctrl+Tab, Ctrl+W …) from
     * reaching the app behind the dialog. For a dialog whose state is tied to
     * the active board or tab, which such a shortcut would change underneath
     * it. Plain keys still reach the dialog's own controls.
     */
    isolateShortcuts?: boolean;
    children: Snippet;
  }

  let { id, title, width = '480px', showKeyHints = true, beforeClose, isolateShortcuts = false, children }: Props = $props();

  let dialogEl = $state<HTMLDialogElement | null>(null);

  const isOpen = $derived(uiStore.isModalOpen(id));

  // Native <dialog showModal()> intercepts Tab loosely; focus-trap enforces
  // a strict cycle through the modal's tabbable descendants and restores
  // focus to the previously-focused element when the modal closes.
  // The cleanup releases the trap on close AND when a parent `{#if}`
  // destroys the Modal: a trap left on focus-trap's global stack throws on
  // the next Tab or click anywhere in the app.
  $effect(() => {
    const el = dialogEl;
    if (!isOpen || !el) return;
    if (!el.open) el.showModal();
    const trap: FocusTrap = createFocusTrap(el, {
      // Esc/backdrop click are handled by our own listeners below; let
      // focus-trap stay agnostic and avoid double-deactivating.
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      // The dialog itself (tabindex=-1) takes focus when nothing inside is
      // tabbable, so the trap can never throw on Tab.
      fallbackFocus: el,
      // Body remains scrollable to support multi-pane layouts behind the modal.
      preventScroll: true,
    });
    try {
      trap.activate();
    } catch {
      el.focus();
    }
    return () => {
      safeDeactivateTrap(trap, { name: 'Modal' });
      if (el.open) el.close();
    };
  });

  // Re-entrancy guard for `tryClose`. Without it a held-down Esc key could
  // fire a second close attempt while the first is still awaiting the
  // beforeClose Promise (e.g. user holding Esc while a confirm dialog
  // appears) and would surface two confirms or close the modal under the
  // dialog.
  let closing = false;

  async function tryClose() {
    if (closing) return;
    if (beforeClose) {
      closing = true;
      try {
        const ok = await beforeClose();
        if (!ok) return;
      } finally {
        closing = false;
      }
    }
    uiStore.closeModal();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === dialogEl) {
      void tryClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Keep Escape from reaching the global `app:cancel`, which would
      // bypass `beforeClose` and force the modal shut behind its own guard.
      e.stopPropagation();
      void tryClose();
      return;
    }
    if (isolateShortcuts && (e.ctrlKey || e.metaKey || e.altKey)) {
      // The global shortcut listener is on window, so stopping the bubble
      // here keeps it from firing; default actions (copy, paste) still run.
      e.stopPropagation();
    }
  }
</script>

{#if isOpen}
  <dialog
    class="modal-dialog"
    bind:this={dialogEl}
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    tabindex="-1"
    aria-modal="true"
    aria-labelledby={`modal-title-${id}`}
  >
    <div class="modal-content" style="max-width: {width};">
      <div class="modal-header">
        <h2 class="modal-title" id={`modal-title-${id}`}>{title}</h2>
        <button
          class="modal-close"
          onclick={() => void tryClose()}
          title="Close (Esc)"
          aria-label="Close modal"
          aria-keyshortcuts="Escape"
        >
          {#if showKeyHints}
            <span class="modal-close-kbd" aria-hidden="true">Esc</span>
          {/if}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        {@render children()}
      </div>
    </div>
  </dialog>
{/if}

<style>
  .modal-dialog {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
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

  .modal-dialog::backdrop {
    background: var(--modal-backdrop);
    animation: fadeIn 0.12s ease;
  }

  .modal-content {
    width: 90%;
    max-height: 80vh;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.15s ease;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--ui-border);
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 28px;
    padding: 0 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .modal-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .modal-close-kbd {
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    padding: 2px 5px;
    border: 1px solid var(--ui-border);
    border-radius: 3px;
    color: var(--text-tertiary);
    background: var(--ui-surface);
    font-family: var(--font-system);
    letter-spacing: 0.02em;
  }

  .modal-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .modal-dialog,
    .modal-dialog::backdrop,
    .modal-content {
      animation: none;
    }
  }
</style>
