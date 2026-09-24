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
 * writeTimer guard, looked up by note path via `forceWriteForDocument`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __testRegisterFlusher as registerMarkdownFlusher,
  forceWriteForDocument,
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '../../renderer/lib/vault/markdownFileWriter';

describe('forceWriteForDocument (Sprint 35.1)', () => {
  beforeEach(() => {
    __resetMarkdownFlushersForTests();
  });
  afterEach(() => {
    __resetMarkdownFlushersForTests();
  });

  it('calls the forceWrite callback for writers matching the note path, bypassing the flush short-circuit', async () => {
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
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('Notes/A.md');

    expect(forceCalls).toBe(1);
    expect(flushCalls).toBe(0);
    expect(result.ok).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('skips writers whose note path does not match', async () => {
    let forceCallsA = 0;
    let forceCallsB = 0;

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        forceCallsA++;
      },
      getNotePath: () => 'Notes/A.md',
    });
    registerMarkdownFlusher('text-tile:t2', async () => {}, {
      forceWrite: async () => {
        forceCallsB++;
      },
      getNotePath: () => 'Notes/B.md',
    });

    await forceWriteForDocument('Notes/A.md');

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
      getNotePath: () => 'Notes/A.md',
    });

    await forceWriteForDocument('Notes/A.md');

    expect(flushCalls).toBe(1);
  });

  it('matches the note path case-insensitively', async () => {
    let forceCalls = 0;
    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        forceCalls++;
      },
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('notes/a.md');

    expect(forceCalls).toBe(1);
    expect(result.ok).toBe(1);
  });

  it('returns ok=0 and empty failed when no writers match', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {},
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('Notes/Other.md');

    expect(result.ok).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('captures multiple writers for the same doc (sibling views — TextTile + DocumentEditor on the same .md)', async () => {
    const calls: string[] = [];

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        calls.push('text-tile');
      },
      getNotePath: () => 'Notes/A.md',
    });
    registerMarkdownFlusher('document-editor:Notes/A.md', async () => {}, {
      forceWrite: async () => {
        calls.push('document-editor');
      },
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('Notes/A.md');

    expect(calls.sort()).toEqual(['document-editor', 'text-tile']);
    expect(result.ok).toBe(2);
  });

  it('surfaces per-writer failures', async () => {
    const errA = new Error('disk full');

    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {
        throw errA;
      },
      getNotePath: () => 'Notes/A.md',
    });
    registerMarkdownFlusher('text-tile:t2', async () => {}, {
      forceWrite: async () => {},
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('Notes/A.md');

    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ownerId).toBe('text-tile:t1');
    expect(result.failed[0].error).toBe(errA);
  });

  it('handles an empty note path gracefully', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {}, {
      forceWrite: async () => {},
      getNotePath: () => 'Notes/A.md',
    });

    const result = await forceWriteForDocument('');
    expect(result).toEqual({ ok: 0, failed: [] });
  });
});
