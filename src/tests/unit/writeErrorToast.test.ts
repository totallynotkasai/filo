import { describe, it, expect } from 'vitest';
import {
  buildWriteErrorToast,
  extractPreservedTmpPath,
} from '@renderer/lib/boards/writeErrorToast';
import { createErrorToastAggregator } from '@renderer/lib/utils/errorToastAggregator';
import type { WriteErrorInfo } from '@renderer/lib/boards/writeStateTracking';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';

describe('extractPreservedTmpPath (M5)', () => {
  it('parses the (data preserved at <tmp>) annotation from the error message', () => {
    // The exact shape `atomicWriteFile` produces, after IPC marshals it into an
    // IpcEnvelopeError whose message is main's `String(err)`.
    const tmp = 'C:\\Users\\andre\\My Files\\Book Vault\\Notes.md.a1b2c3d4e5f6.tmp';
    const err = new IpcEnvelopeError(
      'vault:write-existing-file-text',
      `Error: ENOSPC: no space left on device, rename '...' -> '...' (data preserved at ${tmp})`,
      'ENOSPC',
    );
    expect(extractPreservedTmpPath(err)).toBe(tmp);
  });

  it('honours an explicit preservedTmpPath property when present', () => {
    const tmp = '/vault/Notes.md.deadbeef.tmp';
    const err = Object.assign(new Error('ENOSPC'), { preservedTmpPath: tmp });
    expect(extractPreservedTmpPath(err)).toBe(tmp);
  });

  it('extracts from a bare string error too', () => {
    const tmp = '/vault/sub dir/A B.md.0011.tmp';
    expect(extractPreservedTmpPath(`EIO (data preserved at ${tmp})`)).toBe(tmp);
  });

  it('returns the FULL tmp path even when the destination itself contains .tmp', () => {
    // Greedy capture backtracks to the FINAL `.tmp)`, so an `.tmp` embedded in
    // the destination path doesn't truncate the real preserved path.
    const tmp = '/vault/build.tmp/Notes.md.99.tmp';
    expect(extractPreservedTmpPath(`ENOSPC (data preserved at ${tmp})`)).toBe(tmp);
  });

  it('returns undefined for an ordinary error with no preserved tmp', () => {
    expect(extractPreservedTmpPath(new Error('EACCES: permission denied'))).toBeUndefined();
    expect(extractPreservedTmpPath('plain failure')).toBeUndefined();
    expect(extractPreservedTmpPath(undefined)).toBeUndefined();
    expect(extractPreservedTmpPath(null)).toBeUndefined();
  });
});

describe('buildWriteErrorToast (M5)', () => {
  it('names the preserved tmp location in the toast text', () => {
    const tmp = '/vault/Notes.md.cafef00d.tmp';
    const info: WriteErrorInfo = {
      kind: 'component',
      path: 'Notes.md',
      error: new IpcEnvelopeError('vault:write-existing-file-text', `ENOSPC (data preserved at ${tmp})`, 'ENOSPC'),
    };
    const { context, message } = buildWriteErrorToast(info);
    expect(context).toBe('File save failed');
    expect(message).toContain(tmp);
    expect(message).toContain('preserved on disk');
    // Must NOT claim the data is lost when it is recoverable.
    expect(message).not.toContain('not on disk yet');
  });

  it('falls back to the "not on disk yet" copy when nothing was preserved', () => {
    const info: WriteErrorInfo = {
      kind: 'component',
      path: 'Notes.md',
      error: new Error('EACCES'),
    };
    const { message } = buildWriteErrorToast(info);
    expect(message).toContain('not on disk yet');
    expect(message).toContain('(Notes.md)');
  });

  it('uses a kind-specific context (the aggregator coalescing key)', () => {
    expect(buildWriteErrorToast({ kind: 'board', error: new Error('x') }).context).toBe('Board save failed');
    expect(buildWriteErrorToast({ kind: 'config', error: new Error('x') }).context).toBe('Settings save failed');
    expect(buildWriteErrorToast({ kind: 'component', error: new Error('x') }).context).toBe('File save failed');
  });
});

describe('write-error coalescing (L2)', () => {
  it('N rapid same-kind board failures collapse into ONE count-badged toast', () => {
    const pushed: string[] = [];
    const updates: Array<{ id: string; text: string }> = [];
    const toasts = new Map<string, string>();
    let nextId = 0;
    const aggregator = createErrorToastAggregator({
      pushToast: (opts) => {
        const id = `t${nextId++}`;
        toasts.set(id, opts.text);
        pushed.push(opts.text);
        return id;
      },
      updateToastText: (id, text) => {
        if (!toasts.has(id)) return false;
        toasts.set(id, text);
        updates.push({ id, text });
        return true;
      },
    });

    // Three board writes fail in quick succession (e.g. three dirty
    // .board.json on a full disk) — mirrors the App.svelte wiring.
    for (const path of ['a.board.json', 'b.board.json', 'c.board.json']) {
      const info: WriteErrorInfo = { kind: 'board', path, error: new Error('ENOSPC') };
      const { context, message } = buildWriteErrorToast(info);
      aggregator({ context, error: info.error, message });
    }

    // Exactly one toast was opened; the 2nd and 3rd updated it in place.
    expect(pushed).toHaveLength(1);
    expect(updates).toHaveLength(2);
    // Final text carries the count badge.
    expect(updates[updates.length - 1].text).toContain('(3×)');
    expect(updates[updates.length - 1].text).toContain('Board save failed');
  });

  it('different write kinds get separate toasts (distinct coalescing keys)', () => {
    let pushCount = 0;
    const toasts = new Map<string, string>();
    let nextId = 0;
    const aggregator = createErrorToastAggregator({
      pushToast: (opts) => {
        const id = `t${nextId++}`;
        toasts.set(id, opts.text);
        pushCount++;
        return id;
      },
      updateToastText: (id, text) => {
        if (!toasts.has(id)) return false;
        toasts.set(id, text);
        return true;
      },
    });

    for (const kind of ['board', 'config', 'component'] as const) {
      const { context, message } = buildWriteErrorToast({ kind, path: 'x', error: new Error('ENOSPC') });
      aggregator({ context, error: new Error('ENOSPC'), message });
    }

    expect(pushCount).toBe(3);
  });
});

/**
 * A9-L10 — two same-kind write failures that PRESERVED bytes at DIFFERENT tmp
 * locations must each keep their own toast. Pre-fix the aggregator keyed only
 * by `context` (the write kind), so the second failure's `updateToastText`
 * overwrote the first's text — hiding the first recovery location in-session.
 */
describe('A9-L10 — distinct preserved-tmp locations keep separate toasts', () => {
  function makeAgg(): { aggregator: ReturnType<typeof createErrorToastAggregator>; pushed: string[]; toasts: Map<string, string> } {
    const pushed: string[] = [];
    const toasts = new Map<string, string>();
    let nextId = 0;
    const aggregator = createErrorToastAggregator({
      pushToast: (opts) => {
        const id = `t${nextId++}`;
        toasts.set(id, opts.text);
        pushed.push(opts.text);
        return id;
      },
      updateToastText: (id, text) => {
        if (!toasts.has(id)) return false;
        toasts.set(id, text);
        return true;
      },
    });
    return { aggregator, pushed, toasts };
  }

  // Mirrors the App.svelte write-error wiring: build → feed (context + coalesceKey).
  function feed(
    aggregator: ReturnType<typeof createErrorToastAggregator>,
    info: WriteErrorInfo,
  ): void {
    const { context, message, coalesceKey } = buildWriteErrorToast(info);
    aggregator({ context, error: info.error, message, coalesceKey });
  }

  function preserveErr(tmp: string): IpcEnvelopeError {
    return new IpcEnvelopeError('vault:write-existing-file-text', `ENOSPC (data preserved at ${tmp})`, 'ENOSPC');
  }

  it('buildWriteErrorToast emits a per-path coalesceKey only when bytes were preserved', () => {
    const tmp = '/vault/A.md.1111.tmp';
    const preserved = buildWriteErrorToast({ kind: 'component', path: 'A.md', error: preserveErr(tmp) });
    expect(preserved.coalesceKey).toBe(`File save failed::${tmp}`);

    const plain = buildWriteErrorToast({ kind: 'component', path: 'A.md', error: new Error('EACCES') });
    expect(plain.coalesceKey).toBeUndefined();
  });

  it('two same-kind failures preserved at DIFFERENT paths each open their own toast', () => {
    const { aggregator, pushed } = makeAgg();
    const tmpA = '/vault/A.md.1111.tmp';
    const tmpB = '/vault/B.md.2222.tmp';
    feed(aggregator, { kind: 'component', path: 'A.md', error: preserveErr(tmpA) });
    feed(aggregator, { kind: 'component', path: 'B.md', error: preserveErr(tmpB) });

    // Pre-fix: ONE toast whose text was overwritten with only tmpB (tmpA lost).
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toContain(tmpA);
    expect(pushed[1]).toContain(tmpB);
  });

  it('the SAME preserved path failing twice still collapses into one counted toast', () => {
    const { aggregator, pushed, toasts } = makeAgg();
    const tmp = '/vault/A.md.1111.tmp';
    feed(aggregator, { kind: 'component', path: 'A.md', error: preserveErr(tmp) });
    feed(aggregator, { kind: 'component', path: 'A.md', error: preserveErr(tmp) });

    expect(pushed).toHaveLength(1);
    const finalText = [...toasts.values()][0];
    expect(finalText).toContain('(2×)');
    expect(finalText).toContain(tmp);
  });

  it('a non-preserve failure still coalesces by kind (no coalesceKey)', () => {
    const { aggregator, pushed } = makeAgg();
    feed(aggregator, { kind: 'component', path: 'A.md', error: new Error('EACCES') });
    feed(aggregator, { kind: 'component', path: 'B.md', error: new Error('EACCES') });
    expect(pushed).toHaveLength(1);
  });
});
