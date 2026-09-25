<script lang="ts">
  /**
   * KanbanNewTileModal — type picker shown when the user adds a new tile to
   * a Kanban column. Lists the tile types Filo supports inside a Kanban column
   * (Text / Audio / Link); File / Image arrive via drag-drop only, and
   * Video / Iframe / Timer are intentionally not allowed in Kanban.
   *
   * Focus-trap mirrors the shared Modal.svelte pattern. The component doesn't
   * route through uiStore (single-modal-at-a-time limit) so the trap is
   * wired here directly. `dialogEl.isConnected` guard around deactivate
   * avoids the Svelte 5 flush corruption Modal.svelte documents.
   */
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import { handleListKeyNav } from '../../lib/utils/listKeyNav';

  type AllowedKanbanType = 'text' | 'audio' | 'link' | 'template';

  let {
    open,
    onSelect,
    onClose,
  }: {
    open: boolean;
    onSelect: (type: AllowedKanbanType) => void;
    onClose: () => void;
  } = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);

  // The cleanup releases the trap on close and on unmount, so it never
  // lingers on focus-trap's global stack.
  $effect(() => {
    const el = dialogEl;
    if (!open || !el) return;
    const trap: FocusTrap = createFocusTrap(el, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      fallbackFocus: el,
      preventScroll: true,
    });
    try {
      trap.activate();
    } catch {
      el.focus();
    }
    return () => safeDeactivateTrap(trap, { name: 'KanbanNewTileModal' });
  });

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('kn-backdrop')) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    // E.11 — ArrowUp/ArrowDown traverse the four option buttons; Enter
    // activates the focused one (default button behaviour). Home/End jump
    // to first/last.
    if (bodyEl && handleListKeyNav(e, bodyEl, { selector: '.kn-option', orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  function pick(type: AllowedKanbanType) {
    onSelect(type);
  }
</script>

{#if open}
  <div
    class="kn-backdrop"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-label="Add tile to Kanban column"
    tabindex="-1"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="kn-card">
      <div class="kn-header">
        <h2 class="kn-title">New Tile</h2>
        <button class="kn-close" onclick={onClose} title="Close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="kn-body" bind:this={bodyEl}>
        <button class="kn-option" onclick={() => pick('text')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <div class="kn-option-text">
            <span class="kn-option-title">Text</span>
            <span class="kn-option-desc">Markdown note backed by a vault file</span>
          </div>
        </button>

        <button class="kn-option" onclick={() => pick('audio')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
          </svg>
          <div class="kn-option-text">
            <span class="kn-option-title">Audio</span>
            <span class="kn-option-desc">Recording stored in the vault</span>
          </div>
        </button>

        <button class="kn-option" onclick={() => pick('link')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <div class="kn-option-text">
            <span class="kn-option-title">Link</span>
            <span class="kn-option-desc">URL preview tile</span>
          </div>
        </button>

        <button class="kn-option" onclick={() => pick('template')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <div class="kn-option-text">
            <span class="kn-option-title">From Template…</span>
            <span class="kn-option-desc">Pick a Markdown template from the vault</span>
          </div>
        </button>
      </div>
      <div class="kn-footer">
        <span class="kn-hint">
          Drop a file onto a column to add an image, audio, or attachment tile.
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .kn-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    background: var(--modal-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.12s ease;
  }

  .kn-card {
    width: 360px;
    max-width: 90vw;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    overflow: hidden;
    animation: slideUp 0.15s ease;
  }

  .kn-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .kn-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .kn-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .kn-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .kn-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
  }

  .kn-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    color: var(--text-primary);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .kn-option:hover {
    background: var(--ui-surface-hover);
    border-color: var(--ui-border-light);
  }

  .kn-option-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .kn-option-title {
    font-size: var(--font-size-base);
    font-weight: 600;
  }

  .kn-option-desc {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .kn-footer {
    padding: 8px 16px 12px;
    border-top: 1px solid var(--ui-border-light);
  }

  .kn-hint {
    font-size: 11px;
    color: var(--text-tertiary);
  }

</style>
