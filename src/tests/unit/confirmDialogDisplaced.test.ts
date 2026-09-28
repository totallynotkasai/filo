import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';

/**
 * A second confirm waits for the first instead of answering it.
 *
 * Consumers (`tabStore.close` → confirmCloseAnyway, `handleFlushAndQuit`'s
 * save-failure confirm, the open-time recovery prompts) await a Promise that
 * resolves ONLY through the dialog's onConfirm/onCancel. Overwriting a dialog
 * would wedge its awaiter; cancelling it answers for the user, and for the
 * "Incomplete rename detected" prompt Cancel is Discard. So a confirm asked
 * for while another shows is queued and shows once that one is answered.
 */
function clearConfirms(): void {
  for (let i = 0; i < 20 && uiStore.confirmDialog; i++) uiStore.closeConfirm();
}

function asked(title: string): { answer: Promise<boolean | 'unanswered'>; answered: () => boolean } {
  let done = false;
  const answer = new Promise<boolean>((resolve) => {
    uiStore.openConfirm({
      title,
      body: `${title} body`,
      onConfirm: () => { done = true; resolve(true); },
      onCancel: () => { done = true; resolve(false); },
    });
  });
  return { answer, answered: () => done };
}

describe('openConfirm queues a confirm asked for while another shows', () => {
  beforeEach(clearConfirms);
  afterEach(clearConfirms);

  it('leaves the first dialog unanswered and shows the second only once the first is answered', async () => {
    const first = asked('First');
    const second = asked('Second');

    expect(first.answered()).toBe(false);
    expect(uiStore.confirmDialog?.title).toBe('First');

    // The dialog's Cancel button: close, then the callback.
    const cfg = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    cfg.onCancel?.();
    await expect(first.answer).resolves.toBe(false);

    expect(uiStore.confirmDialog?.title).toBe('Second');
    expect(second.answered()).toBe(false);
    const next = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    next.onConfirm(false);
    await expect(second.answer).resolves.toBe(true);
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('shows a chain of queued confirms in the order they were asked for', () => {
    asked('1');
    asked('2');
    asked('3');
    const seen: string[] = [];
    while (uiStore.confirmDialog) {
      seen.push(uiStore.confirmDialog.title);
      uiStore.closeConfirm();
    }
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('Esc (cancelTopLayer) cancels only the confirm on screen, and the next one shows', async () => {
    const first = asked('A');
    const second = asked('B');
    expect(uiStore.cancelTopLayer()).toBe('confirm');
    await expect(first.answer).resolves.toBe(false);
    expect(second.answered()).toBe(false);
    expect(uiStore.confirmDialog?.title).toBe('B');
  });

  it('a vault swap cancels the confirm on screen and every queued one, so no awaiter hangs', async () => {
    const first = asked('X');
    const second = asked('Y');
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/a', nextVault: '/b', saveOutgoing: true });
    await expect(first.answer).resolves.toBe(false);
    await expect(second.answer).resolves.toBe(false);
    expect(uiStore.confirmDialog).toBeNull();
  });
});
