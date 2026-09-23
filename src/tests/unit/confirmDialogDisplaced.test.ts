import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Audit5 2.4 (#6) — `openConfirm` must not strand a displaced decision.
 *
 * Consumers (`tabStore.close` → confirmCloseAnyway, `handleFlushAndQuit`'s
 * save-failure confirm, `vaultExternalChanges.recreateDeletedFile`) await a
 * Promise that resolves ONLY through the dialog's onConfirm/onCancel. Pre-fix,
 * a second `openConfirm` reassigned `confirmDialog` outright, so the first
 * dialog's callbacks could never fire — its `await` hung forever (a wedged tab
 * close / quit). `openConfirm` now fires the outgoing config's onCancel before
 * installing the replacement, resolving the displaced awaiter to "cancel".
 */
describe('Audit5 2.4 — openConfirm does not strand a displaced confirm', () => {
  beforeEach(() => uiStore.closeConfirm());
  afterEach(() => uiStore.closeConfirm());

  it('fires the displaced dialog onCancel so its awaiter resolves (to cancel), then shows the new dialog', async () => {
    // First confirm, awaited the way real consumers await it.
    const first = new Promise<boolean>((resolve) => {
      uiStore.openConfirm({
        title: 'First',
        body: 'first body',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

    // A second confirm displaces it before the user answered the first.
    let secondAnswered: boolean | null = null;
    uiStore.openConfirm({
      title: 'Second',
      body: 'second body',
      onConfirm: () => {
        secondAnswered = true;
      },
      onCancel: () => {
        secondAnswered = false;
      },
    });

    // The displaced first promise resolved (to cancel) — no hang.
    await expect(first).resolves.toBe(false);

    // The live dialog is now the second one, intact and answerable.
    expect(uiStore.confirmDialog?.title).toBe('Second');
    expect(secondAnswered).toBeNull();
    uiStore.confirmDialog!.onConfirm(false);
    expect(secondAnswered).toBe(true);
  });

  it('resolves a chain of displacements — each prior dialog is cancelled, only the last survives', async () => {
    const first = new Promise<boolean>((resolve) => {
      uiStore.openConfirm({ title: '1', body: 'b1', onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
    const second = new Promise<boolean>((resolve) => {
      uiStore.openConfirm({ title: '2', body: 'b2', onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
    uiStore.openConfirm({ title: '3', body: 'b3', onConfirm: () => {}, onCancel: () => {} });

    // Both earlier awaiters resolved (to cancel); neither hung.
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(uiStore.confirmDialog?.title).toBe('3');
  });

  it('a displaced dialog with no onCancel still installs the replacement cleanly', () => {
    uiStore.openConfirm({ title: 'A', body: 'a', onConfirm: () => {} });
    expect(() =>
      uiStore.openConfirm({ title: 'B', body: 'b', onConfirm: () => {} }),
    ).not.toThrow();
    expect(uiStore.confirmDialog?.title).toBe('B');
  });
});
