import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  promptExternalEditOnSync,
  __inFlightDriftPromptsForTests,
} from '@renderer/stores/vaultExternalChanges';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit2 5.2 — concurrent drift prompts for the same file dedupe.
 *
 * Before the fix, every keystroke that armed a body write while an external
 * edit was already detected pushed a fresh Reload / Keep-local toast onto
 * the queue (toast storm) and awaited an independent decision (redundant
 * writes). The fix keys an in-flight `Map<path, Promise<choice>>` so all
 * concurrent callers for the same path share one toast and one decision.
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

describe('promptExternalEditOnSync — per-path dedup (5.2)', () => {
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
    const path = 'shared.md';
    const p1 = promptExternalEditOnSync({ path });
    const p2 = promptExternalEditOnSync({ path });

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
    const a = promptExternalEditOnSync({ path: 'a.md' });
    const b = promptExternalEditOnSync({ path: 'b.md' });

    expect(a).not.toBe(b);
    expect(__inFlightDriftPromptsForTests().size).toBe(2);

    const driftToasts = uiStore.toasts.filter(
      (t) => typeof t.text === 'string' && t.text.includes('modified externally'),
    );
    expect(driftToasts).toHaveLength(2);

    // Dismiss one — the OTHER stays in the map.
    await clickKeepLocal('a.md');
    await expect(a).resolves.toBe('keep-local');

    // b.md still in flight.
    expect(__inFlightDriftPromptsForTests().has('b.md')).toBe(true);
    expect(__inFlightDriftPromptsForTests().has('a.md')).toBe(false);

    // Drain b.md too so the test doesn't leave a dangling toast.
    await clickKeepLocal('b.md');
    await b;
  });

  // 6.4.M4 — the toast's `onDismiss` historically resolved to 'keep-local',
  // so an unattended auto-dismiss silently overwrote the external edit on
  // disk. The fix: dismiss resolves to 'defer' (abort the write, leave
  // both sides intact); the next write attempt re-prompts so the user
  // must explicitly choose Reload or Keep-local.
  it('toast auto-dismiss resolves to defer, not keep-local (M4)', async () => {
    const path = 'autoDismiss.md';
    const p = promptExternalEditOnSync({ path });

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
    const path = 'sequential.md';

    const first = promptExternalEditOnSync({ path });
    await clickKeepLocal();
    await first;
    expect(__inFlightDriftPromptsForTests().size).toBe(0);

    // Now a second external-edit race fires — the dedup must NOT latch the
    // old decision; the user gets a fresh prompt.
    const second = promptExternalEditOnSync({ path });
    expect(__inFlightDriftPromptsForTests().size).toBe(1);
    expect(findOpenDriftToast()).toBeDefined();

    await clickKeepLocal();
    await second;
    expect(__inFlightDriftPromptsForTests().size).toBe(0);
  });
});
