import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createErrorToastAggregator, type AggregatorToastApi } from '@renderer/lib/utils/errorToastAggregator';

interface FakeToast {
  id: string;
  text: string;
  onDismiss?: () => void;
}

function makeFakeApi(): { api: AggregatorToastApi; toasts: FakeToast[]; dismiss: (id: string) => void } {
  let nextId = 0;
  const toasts: FakeToast[] = [];
  const api: AggregatorToastApi = {
    pushToast(opts) {
      const id = `t${++nextId}`;
      toasts.push({ id, text: opts.text, onDismiss: opts.onDismiss });
      return id;
    },
    updateToastText(id, text) {
      const idx = toasts.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      toasts[idx] = { ...toasts[idx], text };
      return true;
    },
  };
  const dismiss = (id: string): void => {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [removed] = toasts.splice(idx, 1);
    removed.onDismiss?.();
  };
  return { api, toasts, dismiss };
}

describe('createErrorToastAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes a single toast for the first error of a context', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api);

    aggregate({ context: 'vault.recovery-snapshot', error: new Error('disk full') });

    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('vault.recovery-snapshot: disk full');
  });

  it('coalesces same-context errors within the window into one toast with a count', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api, { windowMs: 1000 });

    aggregate({ context: 'fileTags.write', error: new Error('A'), message: 'file 1' });
    aggregate({ context: 'fileTags.write', error: new Error('B'), message: 'file 2' });
    aggregate({ context: 'fileTags.write', error: new Error('C'), message: 'file 3' });

    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('fileTags.write (3×): file 3');
  });

  it('keeps the silence-window timer rolling — only fresh errors after windowMs open a new toast', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api, { windowMs: 1000 });

    aggregate({ context: 'x', error: new Error('first') });
    expect(toasts).toHaveLength(1);

    // Half-window later — still aggregates into the same toast.
    vi.advanceTimersByTime(500);
    aggregate({ context: 'x', error: new Error('second') });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('x (2×): second');

    // Cross the window after the LAST report — entry drops, next report opens fresh.
    vi.advanceTimersByTime(1001);
    aggregate({ context: 'x', error: new Error('third') });
    expect(toasts).toHaveLength(2);
    expect(toasts[1].text).toBe('x: third');
  });

  it('different contexts get their own toasts (no coalescing across contexts)', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api);

    aggregate({ context: 'a', error: new Error('1') });
    aggregate({ context: 'b', error: new Error('2') });
    aggregate({ context: 'a', error: new Error('3') });

    expect(toasts).toHaveLength(2);
    // a was updated in place
    expect(toasts.find((t) => t.text.startsWith('a'))?.text).toBe('a (2×): 3');
    expect(toasts.find((t) => t.text.startsWith('b'))?.text).toBe('b: 2');
  });

  it('when the user dismisses the in-window toast, the next error opens a fresh toast', () => {
    const { api, toasts, dismiss } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api);

    aggregate({ context: 'theme.list', error: new Error('first') });
    expect(toasts).toHaveLength(1);
    const firstId = toasts[0].id;
    dismiss(firstId);
    expect(toasts).toHaveLength(0);

    aggregate({ context: 'theme.list', error: new Error('second') });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('theme.list: second');
  });

  it('prefers the `message` field over `error.message` for the detail line', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api);

    aggregate({
      context: 'boardCache.persist',
      error: new Error('internal'),
      message: 'Friendly user-facing message',
    });

    expect(toasts[0].text).toBe('boardCache.persist: Friendly user-facing message');
  });

  it('handles non-Error throwables by stringifying them', () => {
    const { api, toasts } = makeFakeApi();
    const aggregate = createErrorToastAggregator(api);

    aggregate({ context: 'x', error: 'string thrown' });
    aggregate({ context: 'y', error: 42 });

    expect(toasts[0].text).toBe('x: string thrown');
    expect(toasts[1].text).toBe('y: 42');
  });
});
