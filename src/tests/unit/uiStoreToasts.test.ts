import { describe, it, expect, beforeEach } from 'vitest';
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
