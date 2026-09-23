import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';

describe('uiStore — toast aggregation helpers', () => {
  beforeEach(() => {
    for (const toast of [...uiStore.toasts]) {
      uiStore.dismissToast(toast.id, { silent: true });
    }
  });

  it('updateToastText replaces the text on the named toast and returns true', () => {
    const id = uiStore.pushToast({ text: 'original', type: 'error', duration: 0 });
    const ok = uiStore.updateToastText(id, 'updated');
    expect(ok).toBe(true);
    const t = uiStore.toasts.find((x) => x.id === id);
    expect(t?.text).toBe('updated');
  });

  it('updateToastText returns false when the toast id is unknown (e.g. already dismissed)', () => {
    const id = uiStore.pushToast({ text: 'a', type: 'error', duration: 0 });
    uiStore.dismissToast(id, { silent: true });
    const ok = uiStore.updateToastText(id, 'b');
    expect(ok).toBe(false);
  });

  it('updateToastText preserves other toasts in the stack', () => {
    const a = uiStore.pushToast({ text: 'A', type: 'info', duration: 0 });
    const b = uiStore.pushToast({ text: 'B', type: 'error', duration: 0 });
    const c = uiStore.pushToast({ text: 'C', type: 'success', duration: 0 });

    uiStore.updateToastText(b, 'B-updated');

    expect(uiStore.toasts.find((t) => t.id === a)?.text).toBe('A');
    expect(uiStore.toasts.find((t) => t.id === b)?.text).toBe('B-updated');
    expect(uiStore.toasts.find((t) => t.id === c)?.text).toBe('C');
  });
});

/**
 * 1.6 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — a genuinely-sticky error toast
 * (save failed, recovery-location hint) used to expire at the 15s cap even
 * though the failure persists. Error toasts with no explicit positive duration
 * are now sticky. The Audit5 R3 cap is preserved for every NON-error toast
 * (including the promise-backed external-edit decision warnings) so a re-firing
 * prompt can't blanket the screen and a write-blocking promise can't strand.
 */
describe('uiStore — sticky error toasts (1.6)', () => {
  beforeEach(() => {
    for (const toast of [...uiStore.toasts]) {
      uiStore.dismissToast(toast.id, { silent: true });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const toast of [...uiStore.toasts]) {
      uiStore.dismissToast(toast.id, { silent: true });
    }
  });

  it('an error toast with duration 0 stays past the 15s cap', () => {
    vi.useFakeTimers();
    const id = uiStore.pushToast({ text: 'save failed', type: 'error', duration: 0 });
    vi.advanceTimersByTime(20000);
    expect(uiStore.toasts.find((t) => t.id === id)).toBeTruthy();
  });

  it('a NON-error toast with duration 0 still auto-dismisses at the cap (Audit5 R3 preserved)', () => {
    vi.useFakeTimers();
    const id = uiStore.pushToast({ text: 'reload?', type: 'warning', duration: 0 });
    vi.advanceTimersByTime(16000);
    expect(uiStore.toasts.find((t) => t.id === id)).toBeFalsy();
  });

  it('an error toast with an explicit positive duration still auto-dismisses', () => {
    vi.useFakeTimers();
    const id = uiStore.pushToast({ text: 'delete failed', type: 'error', duration: 6000 });
    vi.advanceTimersByTime(7000);
    expect(uiStore.toasts.find((t) => t.id === id)).toBeFalsy();
  });
});
