import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createErrorToastAggregator,
  MAX_DETAILED_REPORTS,
  type AggregatorToastApi,
  type ToastButton,
} from '@renderer/lib/utils/errorToastAggregator';
import type { TimedReport } from '@renderer/lib/utils/errorDetails';

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

describe('createErrorToastAggregator — several files in one toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function apiWithActions() {
    const { api, toasts } = makeFakeApi();
    const actions = new Map<string, string[]>();
    const push = api.pushToast.bind(api);
    api.pushToast = (opts) => {
      const id = push(opts);
      actions.set(id, (opts.actions ?? []).map((a) => a.label));
      return id;
    };
    api.updateToastActions = (id, next) => {
      actions.set(id, next.map((a) => a.label));
      return true;
    };
    return { api, toasts, actions };
  }

  const openA = { label: 'Open A', handler: () => undefined };
  const retry = { label: 'Retry', handler: () => undefined };

  it('names every file, not only the newest, and drops the first file’s own buttons for Details', () => {
    const { api, toasts, actions } = apiWithActions();
    const details = vi.fn();
    const aggregate = createErrorToastAggregator(api, { details });

    aggregate({ context: 'File save failed', error: new Error('x'), message: "Filo couldn't save (A.md).", path: 'A.md', actions: [openA], sharedActions: [retry] });
    expect(actions.get(toasts[0].id)).toEqual(['Open A', 'Retry']);

    aggregate({ context: 'File save failed', error: new Error('x'), message: "Filo couldn't save (B.md).", path: 'B.md', actions: [], sharedActions: [retry] });
    aggregate({ context: 'File save failed', error: new Error('x'), message: "Filo couldn't save (C.md).", path: 'C.md', sharedActions: [retry] });
    aggregate({ context: 'File save failed', error: new Error('x'), message: "Filo couldn't save (D.md).", path: 'D.md', sharedActions: [retry] });

    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe("File save failed: 4 files couldn't be saved: A.md, B.md, C.md…");
    expect(actions.get(toasts[0].id)).toEqual(['Retry', 'Details']);
  });

  it('the same file failing again keeps its buttons and the count badge', () => {
    const { api, toasts, actions } = apiWithActions();
    const aggregate = createErrorToastAggregator(api, { details: () => undefined });
    aggregate({ context: 'Board save failed', error: new Error('x'), message: 'first', path: 'Plan.board.json', actions: [openA] });
    aggregate({ context: 'Board save failed', error: new Error('x'), message: 'again', path: 'Plan.board.json', actions: [openA] });
    expect(toasts[0].text).toBe('Board save failed (2×): again');
    expect(actions.get(toasts[0].id)).toEqual(['Open A']);
  });
});

describe('Copy details', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function apiWithButtons() {
    const { api, toasts } = makeFakeApi();
    const buttons = new Map<string, ToastButton[]>();
    const push = api.pushToast.bind(api);
    api.pushToast = (opts) => {
      const id = push(opts);
      buttons.set(id, opts.actions ?? []);
      return id;
    };
    api.updateToastActions = (id, next) => {
      buttons.set(id, next);
      return true;
    };
    const press = async (id: string, label: string): Promise<void> => {
      const button = buttons.get(id)?.find((b) => b.label === label);
      if (!button) throw new Error(`no ${label} button`);
      await button.handler();
    };
    return { api, toasts, buttons, press };
  }

  it('every toast gets one, last, and it keeps the toast open', () => {
    const { api, toasts, buttons } = apiWithButtons();
    const aggregate = createErrorToastAggregator(api, { readable: true, copyDetails: vi.fn() });
    aggregate({ context: 'window.onerror', error: new Error('boom'), message: 'An unexpected error occurred.', sharedActions: [{ label: 'Retry', handler: () => undefined }] });
    const own = buttons.get(toasts[0].id) ?? [];
    expect(own.map((b) => b.label)).toEqual(['Retry', 'Copy details']);
    expect(own[1].keepOpen).toBe(true);
  });

  it('is left out without a copier', () => {
    const { api, toasts, buttons } = apiWithButtons();
    createErrorToastAggregator(api, { readable: true })({ context: 'x', error: new Error('boom') });
    expect(buttons.get(toasts[0].id)).toEqual([]);
  });

  it("hands over every report the toast stands for, with the error's own text, even after its window closed", async () => {
    const { api, toasts, press } = apiWithButtons();
    const copyDetails = vi.fn();
    const aggregate = createErrorToastAggregator(api, { readable: true, windowMs: 1000, copyDetails });
    const first = new TypeError('x is undefined');
    aggregate({ context: 'window.onerror', error: first, message: 'An unexpected error occurred.' });
    vi.advanceTimersByTime(200);
    aggregate({ context: 'window.onerror', error: 'second', message: 'An unexpected error occurred.' });
    vi.advanceTimersByTime(5000);

    await press(toasts[0].id, 'Copy details');
    expect(copyDetails).toHaveBeenCalledTimes(1);
    const reports = copyDetails.mock.calls[0][0] as TimedReport[];
    expect(reports.map((r) => r.report.error)).toEqual([first, 'second']);
    expect(reports[0].report).toEqual({ context: 'window.onerror', error: first, message: 'An unexpected error occurred.' });
    expect(reports[1].at - reports[0].at).toBe(200);
  });

  it(`keeps the newest ${MAX_DETAILED_REPORTS} of a storm`, async () => {
    const { api, toasts, press } = apiWithButtons();
    const copyDetails = vi.fn();
    const aggregate = createErrorToastAggregator(api, { readable: true, copyDetails });
    for (let i = 1; i <= MAX_DETAILED_REPORTS + 5; i++) aggregate({ context: 'tagSweep', error: `failure ${i}` });
    await press(toasts[0].id, 'Copy details');
    const reports = copyDetails.mock.calls[0][0] as TimedReport[];
    expect(reports).toHaveLength(MAX_DETAILED_REPORTS);
    expect(reports[0].report.error).toBe('failure 6');
    expect(reports.at(-1)?.report.error).toBe(`failure ${MAX_DETAILED_REPORTS + 5}`);
  });

  it('stays when a second file swaps the first file’s buttons for Details', async () => {
    const { api, toasts, buttons, press } = apiWithButtons();
    const copyDetails = vi.fn();
    const aggregate = createErrorToastAggregator(api, { details: () => undefined, copyDetails });
    aggregate({ context: 'File save failed', error: new Error('a'), path: 'A.md', actions: [{ label: 'Open A', handler: () => undefined }] });
    aggregate({ context: 'File save failed', error: new Error('b'), path: 'B.md' });
    expect(buttons.get(toasts[0].id)?.map((b) => b.label)).toEqual(['Details', 'Copy details']);
    await press(toasts[0].id, 'Copy details');
    expect((copyDetails.mock.calls[0][0] as TimedReport[]).map((r) => r.report.path)).toEqual(['A.md', 'B.md']);
  });
});
