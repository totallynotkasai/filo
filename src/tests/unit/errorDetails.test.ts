/**
 * An error toast's Copy details: the text a user pastes into a bug report.
 * It must carry what the toast leaves out: the error's own message, its stack,
 * its code and cause, the file, and which build it came from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeThrown, errorDetailsText, copyErrorDetails } from '@renderer/lib/utils/errorDetails';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { uiStore } from '@renderer/stores/ui.svelte';

const BUILD = { version: '0.2.10', commit: 'abc1234' };
const AT = Date.UTC(2026, 9, 13, 21, 41, 5);

describe('describeThrown', () => {
  it("keeps an Error's stack, which opens with its name and message", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'x')");
    const text = describeThrown(err);
    expect(text.startsWith("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(true);
    expect(text).toContain('\n    at ');
  });

  it('puts the name and message first when the stack leaves them out', () => {
    const err = new Error('disk full');
    err.stack = '    at write (noteWriter.ts:10:5)';
    expect(describeThrown(err)).toBe('Error: disk full\n    at write (noteWriter.ts:10:5)');
    err.stack = undefined;
    expect(describeThrown(err)).toBe('Error: disk full');
  });

  it('adds the code and follows the cause', () => {
    const cause = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    cause.stack = undefined;
    const err = new Error('Save failed', { cause });
    err.stack = undefined;
    expect(describeThrown(err)).toBe('Error: Save failed\nCaused by: Error: EPERM: operation not permitted\nCode: EPERM');
  });

  it('writes a string as it is, and anything else as JSON', () => {
    expect(describeThrown('ResizeObserver loop')).toBe('ResizeObserver loop');
    expect(describeThrown({ code: 'STALE', path: 'a.md' })).toBe('{\n  "code": "STALE",\n  "path": "a.md"\n}');
    expect(describeThrown(undefined)).toBe('(no error value)');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeThrown(circular)).toBe('[object Object]');
  });
});

describe('errorDetailsText', () => {
  it('names the build, then each report: when, where, the message, the file and the error', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at x (a.ts:1:1)';
    const text = errorDetailsText([{ report: { context: 'window.onerror', error: err, message: 'An unexpected error occurred.', path: 'Notes/A.md' }, at: AT }], BUILD);
    expect(text).toBe(
      [
        'Filo 0.2.10 (abc1234)',
        '',
        'Time: 2026-10-13T21:41:05.000Z',
        'Where: window.onerror',
        'Message: An unexpected error occurred.',
        'File: Notes/A.md',
        'Error: boom',
        '    at x (a.ts:1:1)',
      ].join('\n'),
    );
  });

  it('numbers the reports when a toast stands for several', () => {
    const text = errorDetailsText(
      [
        { report: { context: 'tagSweep', error: 'first' }, at: AT },
        { report: { context: 'tagSweep', error: 'second' }, at: AT + 1000 },
      ],
      BUILD,
    );
    expect(text).toContain('Error 1 of 2\nTime: 2026-10-13T21:41:05.000Z\nWhere: tagSweep\nfirst');
    expect(text).toContain('Error 2 of 2\nTime: 2026-10-13T21:41:06.000Z\nWhere: tagSweep\nsecond');
  });
});

describe('copyErrorDetails', () => {
  let copied: unknown[] = [];

  beforeEach(() => {
    copied = [];
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  afterEach(() => {
    restoreFiloDefault();
  });

  it('puts the text on the clipboard through main and says so', async () => {
    installFiloMock({ 'shell:copy-text': (text: unknown) => { copied.push(text); return true; } });
    await copyErrorDetails([{ report: { context: 'window.onerror', error: 'x' }, at: AT }]);
    expect(copied).toHaveLength(1);
    expect(String(copied[0])).toContain('Where: window.onerror');
    expect(uiStore.toasts.at(-1)?.text).toBe('Error details copied. Paste them into a note or a bug report.');
  });

  it("says when the clipboard couldn't take it", async () => {
    installFiloMock({ 'shell:copy-text': () => false });
    await copyErrorDetails([{ report: { context: 'window.onerror', error: 'x' }, at: AT }]);
    expect(uiStore.toasts.at(-1)?.text).toBe("Couldn't copy the error details.");
    expect(uiStore.toasts.at(-1)?.type).toBe('error');
  });
});
