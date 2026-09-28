/**
 * Before an action that would make a Settings tab's unapplied edits stale,
 * the user picks what happens to them: Apply them (the action waits for the
 * apply, and a refused apply stops it), Discard them, or Cancel. A tab with
 * no edits asks nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const pending = vi.hoisted(() => ({
  global: false,
  board: false,
  applyResult: { ok: true, message: '' } as { ok: boolean; message: string },
  calls: [] as string[],
}));

vi.mock('@renderer/stores/pendingSettings.svelte', () => ({
  pendingSettingsStore: {
    hasGlobalChanges: () => pending.global,
    hasBoardChanges: () => pending.board,
    applyGlobal: () => { pending.calls.push('applyGlobal'); return pending.applyResult; },
    applyBoard: () => { pending.calls.push('applyBoard'); return pending.applyResult; },
    cancelGlobal: () => { pending.calls.push('cancelGlobal'); },
    cancelBoard: () => { pending.calls.push('cancelBoard'); },
  },
}));

import { settleUnappliedEdits } from '@renderer/lib/settings/unappliedEditsPrompt';
import { uiStore } from '@renderer/stores/ui.svelte';

function dialog(): NonNullable<typeof uiStore.confirmDialog> {
  const d = uiStore.confirmDialog;
  if (!d) throw new Error('no confirm dialog open');
  return d;
}

beforeEach(() => {
  pending.global = false;
  pending.board = false;
  pending.applyResult = { ok: true, message: '' };
  pending.calls = [];
});

afterEach(() => {
  uiStore.closeConfirm();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
});

describe('settleUnappliedEdits', () => {
  it('goes ahead without asking when the tab has no edits', async () => {
    await expect(settleUnappliedEdits('global', 'pick a theme')).resolves.toBe(true);
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('asks about the right tab, naming the action', () => {
    pending.board = true;
    void settleUnappliedEdits('board', 'apply this to all boards');
    expect(dialog().title).toBe('Current Board has unapplied changes');
    expect(dialog().body).toBe('Apply or discard your Current Board changes before you apply this to all boards.');
  });

  it('Apply them: applies that tab, then goes ahead', async () => {
    pending.global = true;
    const settled = settleUnappliedEdits('global', 'pick a theme');
    dialog().onConfirm(false);
    await expect(settled).resolves.toBe(true);
    expect(pending.calls).toEqual(['applyGlobal']);
  });

  it('a refused apply stops the action and says why', async () => {
    pending.board = true;
    pending.applyResult = { ok: false, message: 'Board settings are invalid.' };
    const settled = settleUnappliedEdits('board', 'apply this to all boards');
    dialog().onConfirm(false);
    await expect(settled).resolves.toBe(false);
    expect(pending.calls).toEqual(['applyBoard']);
    expect(uiStore.toasts.some((t) => t.text === 'Board settings are invalid.' && t.type === 'error')).toBe(true);
  });

  it('Discard them: drops that tab\'s edits, then goes ahead', async () => {
    pending.board = true;
    const settled = settleUnappliedEdits('board', 'apply this to all boards');
    dialog().secondaryAction!.onClick();
    await expect(settled).resolves.toBe(true);
    expect(pending.calls).toEqual(['cancelBoard']);
  });

  it('Cancel: keeps the edits and stops the action', async () => {
    pending.global = true;
    const settled = settleUnappliedEdits('global', 'pick a theme');
    dialog().onCancel!();
    await expect(settled).resolves.toBe(false);
    expect(pending.calls).toEqual([]);
  });
});
