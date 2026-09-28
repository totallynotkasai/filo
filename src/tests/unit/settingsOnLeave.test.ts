/**
 * Settings the user hasn't applied (a Settings tab's fields, a theme being
 * edited) are in no writer, so the save before quitting or leaving the vault
 * never sees them. Quit and leave ask first, before the save runs: Apply
 * hands the edits to the writers, Discard drops them, Cancel stays.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const pending = vi.hoisted(() => ({
  global: false,
  board: false,
  calls: [] as string[],
}));

vi.mock('@renderer/stores/pendingSettings.svelte', () => ({
  pendingSettingsStore: {
    hasGlobalChanges: () => pending.global,
    hasBoardChanges: () => pending.board,
    hasUnsavedChanges: () => pending.global || pending.board,
    applyGlobal: () => { pending.calls.push('applyGlobal'); pending.global = false; return { ok: true, changed: true }; },
    applyBoard: () => { pending.calls.push('applyBoard'); pending.board = false; return { ok: true, changed: true }; },
    cancelGlobal: () => { pending.calls.push('cancelGlobal'); pending.global = false; },
    cancelBoard: () => { pending.calls.push('cancelBoard'); pending.board = false; },
    startGlobal: () => { pending.calls.push('startGlobal'); },
    startBoard: () => { pending.calls.push('startBoard'); },
  },
}));

import { handleFlushAndQuit, __resetQuitDrainingForTests } from '@renderer/lib/vault/handleFlushAndQuit';
import { hasOpenSettingsEdits, settleOpenSettings } from '@renderer/lib/settings/settleOpenSettings';
import { registerThemeEditor } from '@renderer/lib/themes/themeEditorGuard';
import { saveBeforeLeaving } from '@renderer/stores/vaultLeaveGuard';
import { uiStore } from '@renderer/stores/ui.svelte';

function dialog(): NonNullable<typeof uiStore.confirmDialog> {
  const d = uiStore.confirmDialog;
  if (!d) throw new Error('no confirm dialog open');
  return d;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function quit(save: () => Promise<boolean>, sent: string[]): Promise<void> {
  return handleFlushAndQuit({
    saveStateState: () => 'saved',
    save,
    send: (c) => { if (c !== 'app:drain-heartbeat') sent.push(c); },
    reportError: () => {},
    openSettingsEdits: () => hasOpenSettingsEdits(),
    settleOpenSettings: () => settleOpenSettings('quit'),
  });
}

beforeEach(() => {
  __resetQuitDrainingForTests();
  pending.global = false;
  pending.board = false;
  pending.calls = [];
});

afterEach(() => {
  uiStore.closeConfirm();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
});

describe('quitting with unapplied Settings edits', () => {
  it('asks before the save, after telling main a human is deciding', async () => {
    pending.global = true;
    const save = vi.fn(async () => true);
    const sent: string[] = [];

    const done = quit(save, sent);
    await tick();

    expect(dialog().title).toBe('Global Defaults has unapplied changes');
    expect(dialog().body).toContain('quit Filo');
    expect(sent).toEqual(['app:quit-awaiting-user']);
    expect(save).not.toHaveBeenCalled();

    dialog().onConfirm(false);
    uiStore.closeConfirm();
    await done;

    expect(pending.calls).toEqual(['applyGlobal', 'startGlobal']);
    expect(save).toHaveBeenCalled();
    expect(sent).toEqual(['app:quit-awaiting-user', 'app:ready-to-quit']);
  });

  it('Cancel stays open: nothing saved, main told to stop the quit', async () => {
    pending.board = true;
    const save = vi.fn(async () => true);
    const sent: string[] = [];

    const done = quit(save, sent);
    await tick();
    expect(dialog().title).toBe('Current Board has unapplied changes');
    dialog().onCancel?.();
    uiStore.closeConfirm();
    await done;

    expect(save).not.toHaveBeenCalled();
    expect(pending.calls).toEqual([]);
    expect(sent).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });

  it('Discard drops the edits and quits', async () => {
    pending.global = true;
    const sent: string[] = [];

    const done = quit(async () => true, sent);
    await tick();
    dialog().secondaryAction!.onClick();
    uiStore.closeConfirm();
    await done;

    expect(pending.calls[0]).toBe('cancelGlobal');
    expect(sent.at(-1)).toBe('app:ready-to-quit');
  });

  it('a theme being edited asks Save / Discard / Keep editing first', async () => {
    const unregister = registerThemeEditor({ name: () => 'Dusk', isDirty: () => true, save: async () => true });
    const sent: string[] = [];
    try {
      const done = quit(async () => true, sent);
      await tick();
      expect(dialog().title).toBe('Save changes to the theme?');
      dialog().onCancel?.();
      uiStore.closeConfirm();
      await done;
      expect(sent).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
    } finally {
      unregister();
    }
  });

  it('with nothing unapplied, asks nothing and quits as before', async () => {
    const sent: string[] = [];
    await quit(async () => true, sent);
    expect(uiStore.confirmDialog).toBeNull();
    expect(sent).toEqual(['app:ready-to-quit']);
  });
});

describe('closing the vault with unapplied Settings edits', () => {
  it('asks first; Cancel stays on the vault without saving', async () => {
    pending.global = true;
    const save = vi.fn(async () => true);

    const outcome = saveBeforeLeaving(save, 'close');
    await tick();
    expect(dialog().body).toContain('close the vault');
    dialog().onCancel?.();
    uiStore.closeConfirm();

    await expect(outcome).resolves.toBe('cancelled');
    expect(save).not.toHaveBeenCalled();
  });

  it('Apply hands the edits over before the save runs', async () => {
    pending.board = true;
    const order: string[] = [];
    const save = vi.fn(async () => { order.push('save'); return true; });

    const outcome = saveBeforeLeaving(save, 'open');
    await tick();
    expect(dialog().body).toContain('open another vault');
    dialog().onConfirm(false);
    uiStore.closeConfirm();

    await expect(outcome).resolves.toBe('saved');
    expect([...pending.calls, ...order]).toEqual(['applyBoard', 'startBoard', 'save']);
  });
});
