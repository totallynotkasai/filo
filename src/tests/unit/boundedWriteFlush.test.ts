import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import {
  isPathPending,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit5 R3 — the two independent defences against a stranded / wedged write
 * hanging the flush chain (#1):
 *
 *  Part 1 (toast eviction): a promise-backed toast (the external-edit drift
 *  prompt resolves its awaiting write ONLY via onDismiss/action) must never be
 *  SILENTLY evicted when the queue overflows — that strands the promise forever.
 *
 *  Part 2 (bounded write): `createScheduler({ writeTimeoutMs })` must stop
 *  awaiting a `performWrite` that never settles, mark its path failed (keeping
 *  the sentinel dirty), and attribute the failure so `flush`/`flushAll` resolve
 *  (and `save()` returns false) instead of hanging.
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

describe('Audit5 R3 part 1 — toast eviction never strands a promise-backed toast', () => {
  beforeEach(() => clearToasts());
  afterEach(() => clearToasts());

  it('evicts disposable toasts first, leaving a promise-backed drift toast intact', () => {
    let driftResolved: string | undefined;
    const driftId = uiStore.pushToast({
      text: 'drift prompt',
      type: 'warning',
      duration: 0,
      onDismiss: () => {
        driftResolved = 'defer';
      },
    });
    // Fill the queue past the cap with DISPOSABLE info toasts (no onDismiss).
    for (let i = 0; i < 8; i++) {
      uiStore.pushToast({ text: `info ${i}`, type: 'info' });
    }
    // The drift toast must still be present and its onDismiss must NOT have fired
    // — only disposable toasts were dropped to make room.
    expect(uiStore.toasts.some((t) => t.id === driftId)).toBe(true);
    expect(driftResolved).toBeUndefined();
  });

  it('fires onDismiss (→ resolves) when forced to evict a promise-backed toast', () => {
    let oldestResolved: string | undefined;
    // First toast is the one we track; fill the rest of the queue with
    // promise-backed (onDismiss-bearing) toasts so NO disposable victim exists.
    uiStore.pushToast({
      text: 'oldest drift',
      type: 'warning',
      duration: 0,
      onDismiss: () => {
        oldestResolved = 'defer';
      },
    });
    for (let i = 0; i < 7; i++) {
      uiStore.pushToast({ text: `drift ${i}`, type: 'warning', duration: 0, onDismiss: () => {} });
    }
    // Queue is now full (8) and every toast is promise-backed. One more push
    // forces an eviction; the victim is the oldest non-error → our tracked toast.
    uiStore.pushToast({ text: 'newest drift', type: 'warning', duration: 0, onDismiss: () => {} });

    // The evicted toast's onDismiss fired → its awaiting write resolves (defer)
    // instead of stranding forever.
    expect(oldestResolved).toBe('defer');
  });
});

describe('Audit5 R3 part 2 — bounded write flush (writeTimeoutMs)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('flushAll marks a never-settling write failed within the timeout (not hang)', async () => {
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-wedged',
      debounceMs: 5,
      writeTimeoutMs: 60,
      performWrite: () => new Promise<void>(() => {}), // never settles
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
      sentinelMode: 'pending-path',
    });

    scheduler.schedule('k1', () => ({ path: 'Wedged.md' }));
    const result = await scheduler.flushAll();

    // Resolved (didn't hang) and attributed the failure (failureId defaults to path).
    expect(result.failed).toContain('Wedged.md');
    expect(result.ok).toBe(0);
    // Sentinel stays dirty — the path is recorded failed, not silently cleaned.
    expect(isPathPending('Wedged.md')).toBe(true);
  }, 3000);

  it('flush(key) returns ok:false for a wedged write within the timeout', async () => {
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-wedged-2',
      debounceMs: 5,
      writeTimeoutMs: 60,
      performWrite: () => new Promise<void>(() => {}),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
      sentinelMode: 'pending-path',
    });
    scheduler.schedule('k1', () => ({ path: 'Wedged2.md' }));
    const { ok } = await scheduler.flush('k1');
    expect(ok).toBe(false);
  }, 3000);

  it('does NOT false-time-out a write that settles before the bound', async () => {
    let wrote = false;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-fast',
      debounceMs: 5,
      writeTimeoutMs: 1000,
      performWrite: async () => {
        wrote = true;
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
      sentinelMode: 'pending-path',
    });
    scheduler.schedule('k1', () => ({ path: 'Fast.md' }));
    const result = await scheduler.flushAll();
    expect(wrote).toBe(true);
    expect(result.failed).toEqual([]);
    expect(isPathPending('Fast.md')).toBe(false);
  }, 3000);
});
