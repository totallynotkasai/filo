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

/**
 * Audit-19 UX-6 — non-promise decision toasts may be `sticky` (no lifetime
 * timer) and carry a `dedupeKey` (a newer toast for the same subject replaces
 * the older one). A promise-backed toast (onDismiss set) refuses `sticky` and
 * keeps the Audit5-R3 15s cap so its write can never strand.
 */
describe('uiStore — sticky + deduped decision toasts (Audit-19 UX-6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const toast of [...uiStore.toasts]) uiStore.dismissToast(toast.id, { silent: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const toast of [...uiStore.toasts]) uiStore.dismissToast(toast.id, { silent: true });
  });

  it('a sticky toast survives 60 s of fake time', () => {
    const id = uiStore.pushToast({
      text: 'decide', type: 'warning', duration: 0, sticky: true,
      actions: [{ label: 'Reload', handler: () => {} }],
    });
    vi.advanceTimersByTime(60_000);
    expect(uiStore.toasts.some((t) => t.id === id)).toBe(true);
  });

  it('sticky + onDismiss is refused: still auto-dismisses at 15 s and resolves via onDismiss', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onDismiss = vi.fn();
    const id = uiStore.pushToast({ text: 'drift', type: 'warning', duration: 0, sticky: true, onDismiss });
    vi.advanceTimersByTime(15_000);
    expect(uiStore.toasts.some((t) => t.id === id)).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the same dedupeKey replaces the older toast', () => {
    const a = uiStore.pushToast({ text: 'first', type: 'warning', sticky: true, dedupeKey: 'ext-mod:A.md' });
    const b = uiStore.pushToast({ text: 'second', type: 'warning', sticky: true, dedupeKey: 'ext-mod:A.md' });
    const other = uiStore.pushToast({ text: 'other', type: 'warning', sticky: true, dedupeKey: 'ext-mod:B.md' });
    const ids = uiStore.toasts.map((t) => t.id);
    expect(ids).not.toContain(a);
    expect(ids).toContain(b);
    expect(ids).toContain(other);
    uiStore.dismissToastsByKey('ext-mod:B.md', { silent: true });
    expect(uiStore.toasts.map((t) => t.id)).not.toContain(other);
  });

  it('the 8-toast cap evicts disposable toasts before sticky ones', () => {
    const sticky = uiStore.pushToast({ text: 'sticky', type: 'warning', sticky: true });
    for (let i = 0; i < 7; i++) uiStore.pushToast({ text: `plain ${i}`, type: 'info' });
    uiStore.pushToast({ text: 'overflow', type: 'info' });
    expect(uiStore.toasts).toHaveLength(8);
    expect(uiStore.toasts.some((t) => t.id === sticky)).toBe(true);
    expect(uiStore.toasts.some((t) => t.text === 'plain 0')).toBe(false);
  });
});
