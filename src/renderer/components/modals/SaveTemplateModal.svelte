<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../shared/Modal.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { selectionStore } from '../../stores/selection.svelte';
  import { templatesStore } from '../../stores/templates.svelte';
  import { captureLayoutTemplate } from '../../lib/templates/layoutCapture';
  import { reportError } from '../../lib/utils/errorBus';

  /**
   * Save-as-Template prompt. Captures the current selection of mind-map
   * tiles, asks the user to name the template, validates uniqueness, and
   * persists via `templatesStore.save`.
   */

  let name = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let includeConnections = $state(true);
  // E.14 — capture the focused element at open time so we can restore
  // focus on close. Modal.svelte's focus-trap already calls
  // `returnFocusOnDeactivate`, but SaveTemplateModal is typically opened
  // from a context menu whose host element is already unmounted by the
  // time the modal closes — focus-trap then drops focus on body. This
  // fallback re-aims at the canvas root so keyboard users keep working.
  let prevActiveBeforeOpen: HTMLElement | null = null;

  const isOpen = $derived(uiStore.isModalOpen('save-template'));
  const selectedCount = $derived(selectionStore.selectedIds.size);
  // Connections need ≥ 2 tiles to exist between them. With one tile selected
  // the checkbox is greyed out and forced false during capture so the UI
  // doesn't claim to save something it can't.
  const canIncludeConnections = $derived(selectedCount >= 2);

  $effect(() => {
    if (!isOpen) {
      // On transition to closed, restore focus to whatever was focused
      // before we opened. If that element has unmounted (common when the
      // trigger was a context menu item), focus the canvas root.
      const target = prevActiveBeforeOpen;
      prevActiveBeforeOpen = null;
      if (target && target.isConnected) {
        try { target.focus(); } catch { /* no longer focusable */ }
      } else {
        const canvas = document.querySelector<HTMLElement>(
          '.canvas-container, .pane-view, [role="application"]',
        );
        canvas?.focus();
      }
      return;
    }
    untrack(() => {
      prevActiveBeforeOpen = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      void templatesStore.load();
      const n = templatesStore.records.length + 1;
      name = `Template ${n}`;
      error = null;
      saving = false;
      includeConnections = true;
    });
  });

  async function handleSave(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      error = 'Please enter a name.';
      return;
    }
    if (templatesStore.hasName(trimmed)) {
      error = `A template named "${trimmed}" already exists.`;
      return;
    }
    const selectedTiles = Object.values(boardStore.tiles).filter((t) =>
      selectionStore.isSelected(t.id),
    );
    if (selectedTiles.length === 0) {
      error = 'No tiles selected.';
      return;
    }
    saving = true;
    try {
      const includeFlag = canIncludeConnections && includeConnections;
      const allConnections = includeFlag
        ? Object.values(boardStore.connections)
        : [];
      const template = captureLayoutTemplate(
        selectedTiles,
        allConnections,
        trimmed,
        { includeConnections: includeFlag },
      );
      await templatesStore.save(template);
      uiStore.closeModal();
      uiStore.toast(`Saved template "${trimmed}"`, 'success', 1800);
    } catch (err) {
      // C14 — route through the error bus so the failure also surfaces as a
      // toast. The inline `error` text below is the in-modal user surface;
      // the toast catches the user who's already dismissed or moved away.
      reportError('SaveTemplateModal', err, 'Failed to save template');
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function handleCancel(): void {
    uiStore.closeModal();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !saving) {
      e.preventDefault();
      void handleSave();
    }
  }
</script>

<Modal id="save-template" title="Save as Template" width="420px">
  <div class="save-template">
    <p class="hint">
      {selectedCount === 1 ? '1 tile' : `${selectedCount} tiles`} selected. The
      template captures type, size, position, style{canIncludeConnections && includeConnections ? ', and connections' : ''} — but not titles,
      content, tags, or file references.
    </p>
    <label class="label" for="save-template-name">Name</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="save-template-name"
      class="name-input"
      type="text"
      bind:value={name}
      onkeydown={onKeydown}
      onfocus={(e) => (e.target as HTMLInputElement).select()}
      autofocus
      disabled={saving}
    />
    <label class="connections-toggle">
      <input
        type="checkbox"
        bind:checked={includeConnections}
        disabled={saving || !canIncludeConnections}
      />
      <span>Save this template with current Connection Paths and Labels?</span>
    </label>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="actions">
      <button class="btn-secondary" onclick={handleCancel} disabled={saving}>Cancel</button>
      <button class="btn-primary" onclick={handleSave} disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</Modal>

<style>
  .save-template {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .hint {
    margin: 0 0 4px 0;
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .name-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    transition: border-color 0.1s ease;
  }

  .name-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .name-input:focus:not(:focus-visible) {
    outline: none;
  }

  .name-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .connections-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }

  .connections-toggle input[type='checkbox'] {
    margin: 0;
    cursor: pointer;
  }

  .connections-toggle input[type='checkbox']:disabled {
    cursor: not-allowed;
  }

  .connections-toggle input[type='checkbox']:disabled + span {
    opacity: 0.5;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--ui-danger, #d83b3b);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 8px 16px;
    font-size: var(--font-size-base);
    font-weight: 500;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, opacity 0.1s ease;
  }

  .btn-primary {
    background: var(--accent-primary);
    color: var(--accent-on-primary, white);
    border-color: var(--accent-primary);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.05);
  }

  .btn-secondary {
    background: transparent;
    color: var(--text-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
