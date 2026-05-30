/**
 * H1 — Escape on a stacked ConfirmDialog must not close the modal beneath it.
 *
 * Two layers under test:
 *
 *  1. `uiStore.cancelTopLayer()` — the layering-aware close used by the global
 *     `app:cancel` (Escape) command. Closes exactly one layer in priority
 *     order: confirm dialog → modal → context menu.
 *  2. The real window-level keydown listener (`hotkeys.ts`) wired to an
 *     `app:cancel` shortcut whose action calls `cancelTopLayer()`, exercising
 *     the same path AppShell registers.
 *
 * The primary fix lives in ConfirmDialog.svelte (it calls `stopPropagation`
 * so a bubbling Escape never reaches `app:cancel`); `cancelTopLayer` is the
 * defense-in-depth for the edge case where the dialog's own handler doesn't
 * run (e.g. focus-trap activation failed and focus is outside the dialog).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uiStore, type ConfirmDialogConfig } from '@renderer/stores/ui.svelte';
import { registerShortcut, initKeyboardShortcuts, _resetForTests } from '@renderer/core/hotkeys';

function baseConfirm(overrides: Partial<ConfirmDialogConfig> = {}): ConfirmDialogConfig {
  return { title: 'Title', body: 'Body', onConfirm: () => {}, ...overrides };
}

function clearLayers(): void {
  uiStore.closeConfirm();
  uiStore.closeModal();
  uiStore.hideContextMenu();
}

describe('uiStore.cancelTopLayer — layering priority', () => {
  beforeEach(clearLayers);
  afterEach(clearLayers);

  it('closes only the confirm dialog when a confirm is stacked over a modal', () => {
    const onCancel = vi.fn();
    uiStore.openModal('project-settings');
    uiStore.openConfirm(baseConfirm({ onCancel }));

    expect(uiStore.cancelTopLayer()).toBe('confirm');

    expect(uiStore.confirmDialog).toBeNull();
    // The modal underneath must survive.
    expect(uiStore.activeModal).toBe('project-settings');
    // Cancelling the confirm fires its onCancel, same as clicking Cancel.
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('closes a lone modal', () => {
    uiStore.openModal('board-browser');
    expect(uiStore.cancelTopLayer()).toBe('modal');
    expect(uiStore.activeModal).toBeNull();
  });

  it('closes the context menu when only it is open', () => {
    uiStore.showContextMenu(10, 10, [{ id: 'a', label: 'A' }]);
    expect(uiStore.cancelTopLayer()).toBe('context-menu');
    expect(uiStore.contextMenu.visible).toBe(false);
  });

  it('prefers the modal over the context menu', () => {
    uiStore.openModal('board-browser');
    uiStore.showContextMenu(10, 10, [{ id: 'a', label: 'A' }]);

    expect(uiStore.cancelTopLayer()).toBe('modal');
    expect(uiStore.activeModal).toBeNull();
    // Context menu survives this Escape — it closes on the next one.
    expect(uiStore.contextMenu.visible).toBe(true);
  });

  it('is a no-op when nothing is open', () => {
    expect(uiStore.cancelTopLayer()).toBeNull();
  });
});

describe('app:cancel Escape integration via the global hotkey listener', () => {
  beforeEach(() => {
    _resetForTests();
    initKeyboardShortcuts();
    // Mirror AppShell's registration so the real window-level keydown path
    // and the real cancelTopLayer action are exercised end-to-end.
    registerShortcut({
      commandId: 'app:cancel',
      key: 'Escape',
      description: 'Cancel / Close',
      action: () => { uiStore.cancelTopLayer(); },
    });
    clearLayers();
  });
  afterEach(() => {
    _resetForTests();
    clearLayers();
  });

  function dispatchEscape(target: EventTarget): void {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  }

  it('when the dialog stops propagation, app:cancel never runs and both layers are untouched', () => {
    uiStore.openModal('project-settings');
    uiStore.openConfirm(baseConfirm());

    // Stands in for ConfirmDialog.handleKeydown, which calls stopPropagation
    // on Escape — the bubbling event must never reach the window listener.
    const dialog = document.createElement('div');
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(dialog);
    try {
      dispatchEscape(dialog);
      // app:cancel did not fire, so it touched neither layer. The dialog's own
      // cancel() (not modelled here) is what closes the confirm in the app.
      expect(uiStore.confirmDialog).not.toBeNull();
      expect(uiStore.activeModal).toBe('project-settings');
    } finally {
      dialog.remove();
    }
  });

  it('if Escape reaches app:cancel with a confirm stacked over a modal, only the confirm closes', () => {
    const onCancel = vi.fn();
    uiStore.openModal('project-settings');
    uiStore.openConfirm(baseConfirm({ onCancel }));

    // Models the edge case where focus is outside the dialog (trap failed) so
    // Escape bubbles straight to the window-level app:cancel.
    const node = document.createElement('div');
    document.body.appendChild(node);
    try {
      dispatchEscape(node);
      expect(uiStore.confirmDialog).toBeNull();
      expect(uiStore.activeModal).toBe('project-settings');
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      node.remove();
    }
  });

  it('a lone modal still closes on Escape', () => {
    uiStore.openModal('board-browser');
    const node = document.createElement('div');
    document.body.appendChild(node);
    try {
      dispatchEscape(node);
      expect(uiStore.activeModal).toBeNull();
    } finally {
      node.remove();
    }
  });
});
