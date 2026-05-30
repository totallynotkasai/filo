/**
 * Sprint 35.1 regression — Keep-local on an external-edit toast must persist
 * the editor's current body to disk even when the 300ms debounce has already
 * fired and `writeTimer === null`.
 *
 * Bug: the previous Keep-local handler called `flushAllMarkdownWriters()`,
 * and each per-writer `flushPendingMarkdownWrite` early-returned on
 * `if (!writeTimer) return`. So if the debounce had already drained between
 * the user's last keystroke and the Keep-local click, the editor body sat
 * in memory while the external file content stayed on disk — silent loss.
 *
 * Fix: a parallel `forceWrite` callback per writer that bypasses the
 * writeTimer guard, looked up by docId via `forceWriteForDocument`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerMarkdownFlusher,
  forceWriteForDocument,
  __resetMarkdownFlushersForTests,
} from '../../renderer/lib/boards/markdownWriteRegistry';

describe('forceWriteForDocument (Sprint 35.1)', () => {
  beforeEach(() => {
    __resetMarkdownFlushersForTests();
  });
  afterEach(() => {
    __resetMarkdownFlushersForTests();
  });

  it('calls the forceWrite callback for writers matching the docId, bypassing the flush short-circuit', async () => {
    let flushCalls = 0;
    let forceCalls = 0;

    // Simulate TextTile after the 300ms debounce already fired: `writeTimer`
    // is conceptually null, so the flush returns early without writing.
    registerMarkdownFlusher('text-tile:t1', async () => {
      flushCalls++;
      // Mirrors the production guard: no pending timer → no-op.
    }, {
      forceWrite: async () => {
        forceCalls++;
      },
      getDocId: () => 'doc-A',
    });

    const result = await forceWriteForDocument('doc-A');

    expect(forceCalls).toBe(1);
    expect(flushCalls).toBe(0);
    expect(result.ok).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('skips writers whose docId does not match', async () => {
    let forceCallsA = 0;
    let forceCallsB = 0;

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        forceCallsA++;
      },
      getDocId: () => 'doc-A',
    });
    registerMarkdownFlusher('text-tile:t2', async () => {}, {
      forceWrite: async () => {
        forceCallsB++;
      },
      getDocId: () => 'doc-B',
    });

    await forceWriteForDocument('doc-A');

    expect(forceCallsA).toBe(1);
    expect(forceCallsB).toBe(0);
  });

  it('falls back to flush() for writers without forceWrite (bulk writers)', async () => {
    let flushCalls = 0;

    // Bulk writers (KanbanBoard, TaskListBoard, PropertiesPopup) register
    // without forceWrite — they don't have a writeTimer-guard pattern.
    // forceWriteForDocument should still call their flush so the bulk path
    // remains correct.
    registerMarkdownFlusher('kanban:k1', async () => {
      flushCalls++;
    }, {
      getDocId: () => 'doc-A',
    });

    await forceWriteForDocument('doc-A');

    expect(flushCalls).toBe(1);
  });

  it('returns ok=0 and empty failed when no writers match', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {},
      getDocId: () => 'doc-A',
    });

    const result = await forceWriteForDocument('doc-other');

    expect(result.ok).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('captures multiple writers for the same doc (sibling views — TextTile + DocumentEditor on the same .md)', async () => {
    const calls: string[] = [];

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        calls.push('text-tile');
      },
      getDocId: () => 'doc-A',
    });
    registerMarkdownFlusher('document-editor:doc-A', async () => {}, {
      forceWrite: async () => {
        calls.push('document-editor');
      },
      getDocId: () => 'doc-A',
    });

    const result = await forceWriteForDocument('doc-A');

    expect(calls.sort()).toEqual(['document-editor', 'text-tile']);
    expect(result.ok).toBe(2);
  });

  it('surfaces per-writer failures', async () => {
    const errA = new Error('disk full');

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        throw errA;
      },
      getDocId: () => 'doc-A',
    });
    registerMarkdownFlusher('text-tile:t2', async () => {}, {
      forceWrite: async () => {},
      getDocId: () => 'doc-A',
    });

    const result = await forceWriteForDocument('doc-A');

    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ownerId).toBe('text-tile:t1');
    expect(result.failed[0].error).toBe(errA);
  });

  it('handles empty docId gracefully', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {},
      getDocId: () => 'doc-A',
    });

    const result = await forceWriteForDocument('');
    expect(result).toEqual({ ok: 0, failed: [] });
  });
});
