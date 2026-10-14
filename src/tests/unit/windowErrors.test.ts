/**
 * The renderer's backstops for errors nothing else caught. Chromium's
 * ResizeObserver notice arrives as a window `error` event too, but nothing
 * failed, so it must not show as "An unexpected error occurred.".
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { installErrorBackstops, isResizeObserverNotice, windowErrorValue } from '@renderer/lib/utils/windowErrors';

const report = vi.fn();

beforeAll(() => {
  installErrorBackstops(window, report);
});

beforeEach(() => {
  report.mockClear();
});

const NOTICE = 'ResizeObserver loop completed with undelivered notifications.';

describe('isResizeObserverNotice', () => {
  it("is Chromium's notice, in its current and its older words", () => {
    expect(isResizeObserverNotice({ error: null, message: NOTICE })).toBe(true);
    expect(isResizeObserverNotice({ error: undefined, message: 'ResizeObserver loop limit exceeded' })).toBe(true);
  });

  it('is never a thrown error, nor another message', () => {
    expect(isResizeObserverNotice({ error: new Error(NOTICE), message: NOTICE })).toBe(false);
    expect(isResizeObserverNotice({ error: null, message: 'Script error.' })).toBe(false);
    expect(isResizeObserverNotice({ error: null, message: `Uncaught ${NOTICE}` })).toBe(false);
  });
});

describe('windowErrorValue', () => {
  it('is the thrown value when there is one', () => {
    const err = new TypeError('x is undefined');
    expect(windowErrorValue({ error: err, message: 'Uncaught TypeError: x is undefined', filename: 'a.js', lineno: 1, colno: 2 })).toBe(err);
  });

  it('is the message and where it was raised when nothing was thrown', () => {
    expect(windowErrorValue({ error: null, message: 'Script error.', filename: 'file:///app/index.js', lineno: 12, colno: 4 })).toBe(
      'Script error. (at file:///app/index.js:12:4)',
    );
    expect(windowErrorValue({ error: null, message: 'Script error.', filename: '', lineno: 0, colno: 0 })).toBe('Script error.');
  });
});

describe('installErrorBackstops', () => {
  it('passes over the ResizeObserver notice', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: NOTICE, error: null }));
    expect(report).not.toHaveBeenCalled();
  });

  it('reports any other window error with what was thrown', () => {
    const err = new RangeError('bad index');
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught RangeError: bad index', error: err }));
    expect(report).toHaveBeenCalledWith('window.onerror', err, 'An unexpected error occurred.');
  });

  it('reports a rejection nothing handled', () => {
    const reason = new Error('lost');
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
    expect(report).toHaveBeenCalledWith('unhandledrejection', reason, 'An unexpected background task failed.');
  });
});
