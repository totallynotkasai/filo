import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetDirtyTrackingForTests, markPathFailed, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import { createErrorToastAggregator, readableContext, type AggregatorToastApi } from '@renderer/lib/utils/errorToastAggregator';
import { onError, reportError, __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';

/**
 * - Every failed write stays listed: the failed set used to be trimmed at 256
 *   paths, and a trimmed path counted as saved.
 * - The error bus's toasts: a report about a second file used to replace the
 *   first file's name in the same toast, and the toast led with the raw
 *   context id (`frontmatter.unparseable: …`).
 */

describe('failed writes are never trimmed', () => {
  beforeEach(() => __resetDirtyTrackingForTests());
  afterEach(() => __resetDirtyTrackingForTests());

  it('300 failed paths are all still unsaved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 300; i++) markPathFailed(undefined, `Notes/N${i}.md`);
    expect(unsavedWork().failed).toHaveLength(300);
    warn.mockRestore();
  });
});

function fakeApi(): { api: AggregatorToastApi; toasts: Array<{ id: string; text: string }> } {
  let next = 0;
  const toasts: Array<{ id: string; text: string }> = [];
  return {
    toasts,
    api: {
      pushToast(opts) {
        const id = `t${++next}`;
        toasts.push({ id, text: opts.text });
        return id;
      },
      updateToastText(id, text) {
        const t = toasts.find((x) => x.id === id);
        if (!t) return false;
        t.text = text;
        return true;
      },
    },
  };
}

describe('error bus toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    __resetErrorBusForTests();
  });

  it("a second file's report opens its own toast; the same file again counts", () => {
    const { api, toasts } = fakeApi();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onError(createErrorToastAggregator(api, { readable: true }));
    reportError('frontmatter.unparseable', null, 'Couldn\'t update metadata for "A.md".', 'A.md');
    reportError('frontmatter.unparseable', null, 'Couldn\'t update metadata for "B.md".', 'B.md');
    reportError('frontmatter.unparseable', null, 'Couldn\'t update metadata for "A.md".', 'A.md');
    expect(toasts.map((t) => t.text)).toEqual([
      'Couldn\'t update metadata for "A.md". (2×)',
      'Couldn\'t update metadata for "B.md".',
    ]);
    errSpy.mockRestore();
  });

  it('shows the message, or a readable label, never the raw context id', () => {
    const { api, toasts } = fakeApi();
    const aggregate = createErrorToastAggregator(api, { readable: true });
    aggregate({ context: 'vault.recovery-snapshot', error: null, message: 'Filo couldn\'t copy the board.' });
    aggregate({ context: 'boardCache.persist', error: new Error('disk full') });
    expect(toasts.map((t) => t.text)).toEqual(["Filo couldn't copy the board.", 'Board cache: disk full']);
  });

  it('readableContext', () => {
    expect(readableContext('boardCache.create-text-md')).toBe('Board cache');
    expect(readableContext('theme.list')).toBe('Theme');
    expect(readableContext('miscWriteScheduler')).toBe('Misc write scheduler');
    expect(readableContext('hotkeys.load-overrides')).toBe('Hotkeys');
  });
});
