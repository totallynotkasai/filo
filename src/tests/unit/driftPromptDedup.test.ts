import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  promptBoardExternalEdit,
  __inFlightDriftPromptsForTests,
} from '@renderer/stores/vaultExternalChanges';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Concurrent board drift prompts for the same file dedupe.
 *
 * Every board save that meets an external edit asks the same question; without
 * the per-path in-flight `Map<path, Promise<choice>>` a save storm would stack
 * duplicate Reload / Keep-local toasts and await independent decisions.
 */

function findOpenDriftToast(pathSubstr?: string) {
  return uiStore.toasts.find((t) => {
    if (typeof t.text !== 'string') return false;
    if (!t.text.includes('modified externally')) return false;
    if (pathSubstr && !t.text.includes(pathSubstr)) return false;
    return true;
  });
}

function actionIndex(toast: { actions?: Array<{ label: string }> }, label: string): number {
  return toast.actions?.findIndex((a) => a.label === label) ?? -1;
}

async function clickKeepLocal(pathSubstr?: string): Promise<void> {
  const toast = findOpenDriftToast(pathSubstr);
  if (!toast) throw new Error(`drift toast not found${pathSubstr ? ` for ${pathSubstr}` : ''}`);
  const idx = actionIndex(toast, 'Keep local');
  if (idx < 0) throw new Error('Keep-local action missing');
  // Use invokeToastAction so the toast is auto-dismissed after the handler
  // runs (mirrors the real Toast component dispatcher). Direct
  // `toast.actions[idx].handler()` would resolve the promise but leave a
  // stale entry in the queue, confusing the next `findOpenDriftToast`.
  uiStore.invokeToastAction(toast.id, idx);
  // Let microtasks drain so the resolve in the handler propagates.
  await Promise.resolve();
}

describe('promptBoardExternalEdit — per-path dedup', () => {
  beforeEach(() => {
    restoreFiloDefault();
    // Clear any toasts lingering from prior tests.
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  afterEach(() => {
    restoreFiloDefault();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('two concurrent prompts for the same path share one toast and one promise', async () => {
    const path = 'shared.board.json';
    const p1 = promptBoardExternalEdit({ path });
    const p2 = promptBoardExternalEdit({ path });

    // Both callers got the SAME promise instance.
    expect(p1).toBe(p2);
    expect(__inFlightDriftPromptsForTests().size).toBe(1);
    expect(__inFlightDriftPromptsForTests().has(path)).toBe(true);

    // Only ONE drift toast was pushed.
    const driftToasts = uiStore.toasts.filter(
      (t) => typeof t.text === 'string' && t.text.includes('modified externally'),
    );
    expect(driftToasts).toHaveLength(1);

    // Trigger Keep-local — both awaiters resolve to the same value.
    await clickKeepLocal();

    await expect(p1).resolves.toBe('keep-local');
    await expect(p2).resolves.toBe('keep-local');

    // Map is drained once the prompt settles, so a future external-edit
    // race opens a fresh prompt instead of latching the old one forever.
    expect(__inFlightDriftPromptsForTests().size).toBe(0);
  });

  it('different paths get independent prompts (no cross-talk)', async () => {
    const a = promptBoardExternalEdit({ path: 'a.board.json' });
    const b = promptBoardExternalEdit({ path: 'b.board.json' });

    expect(a).not.toBe(b);
    expect(__inFlightDriftPromptsForTests().size).toBe(2);

    const driftToasts = uiStore.toasts.filter(
      (t) => typeof t.text === 'string' && t.text.includes('modified externally'),
    );
    expect(driftToasts).toHaveLength(2);

    // Resolve one — the OTHER stays in the map.
    await clickKeepLocal('a.board.json');
    await expect(a).resolves.toBe('keep-local');

    expect(__inFlightDriftPromptsForTests().has('b.board.json')).toBe(true);
    expect(__inFlightDriftPromptsForTests().has('a.board.json')).toBe(false);

    // Drain b too so the test doesn't leave a dangling toast.
    await clickKeepLocal('b.board.json');
    await b;
  });

  // An unattended dismiss must not overwrite the external edit: it resolves
  // 'defer' (abort the write, leave both sides intact) and the next write
  // re-prompts so the user must choose Reload or Keep-local explicitly.
  it('toast auto-dismiss resolves to defer, not keep-local', async () => {
    const path = 'autoDismiss.board.json';
    const p = promptBoardExternalEdit({ path });

    const toast = findOpenDriftToast(path);
    expect(toast).toBeDefined();

    // Simulate auto-dismiss (no action invoked). The toast component
    // calls dismissToast on lifetime expiry, which fires onDismiss.
    uiStore.dismissToast(toast!.id);
    await Promise.resolve();

    await expect(p).resolves.toBe('defer');
    expect(__inFlightDriftPromptsForTests().size).toBe(0);
  });

  it('a fresh call AFTER the prior prompt resolved opens a new toast', async () => {
    const path = 'sequential.board.json';

    const first = promptBoardExternalEdit({ path });
    await clickKeepLocal();
    await first;
    expect(__inFlightDriftPromptsForTests().size).toBe(0);

    // Now a second external-edit race fires — the dedup must NOT latch the
    // old decision; the user gets a fresh prompt.
    const second = promptBoardExternalEdit({ path });
    expect(__inFlightDriftPromptsForTests().size).toBe(1);
    expect(findOpenDriftToast()).toBeDefined();

    await clickKeepLocal();
    await second;
    expect(__inFlightDriftPromptsForTests().size).toBe(0);
  });
});
