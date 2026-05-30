import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerMarkdownFlusher,
  unregisterMarkdownFlusher,
  flushAllMarkdownWriters,
  __resetMarkdownFlushersForTests,
} from '../../renderer/lib/boards/markdownWriteRegistry';

/**
 * Phase G.1 — `markdownWriteRegistry` flush contract test (carry-over from
 * IMPL_PLAN_2026-05-24 Phase 4.1).
 *
 * `TextTile` and `DocumentEditor` both register their per-editor debounced
 * `.md` write through `registerMarkdownFlusher`. `vaultStore.save()` and the
 * Electron `before-quit` handler drain every entry via
 * `flushAllMarkdownWriters`. The contract those consumers depend on:
 *
 *   1. Every registered owner's flush callback is invoked exactly once.
 *   2. `flushAllMarkdownWriters` awaits each callback before returning — a
 *      slow flusher (in-flight IPC) must NOT short-circuit; otherwise
 *      Ctrl+S flashes "Saved" before the disk write completes and the
 *      next process exit can drop the queued bytes.
 *   3. A rejected flusher lands in `failed[]` with the owner id intact, so
 *      the Ctrl+S toast can refuse to report success and the offending
 *      tile can be surfaced to the user.
 *
 * Without this contract, a future refactor could swap the dispatcher for
 * sync semantics (return-before-await) and the failure mode would only
 * surface as silent data loss in production. The aggregate-status test
 * (`markdownWriteRegistryAggregate.test.ts`) covers the result shape; this
 * file locks down the *dispatch* contract that consumers rely on.
 */
describe('markdownWriteRegistry — flush contract', () => {
  beforeEach(() => {
    __resetMarkdownFlushersForTests();
  });
  afterEach(() => {
    __resetMarkdownFlushersForTests();
  });

  it('invokes every registered flush callback and reports them via the {ok, failed} result', async () => {
    const invoked: string[] = [];
    registerMarkdownFlusher('text-tile:t1', async () => {
      invoked.push('text-tile:t1');
    });
    registerMarkdownFlusher('text-tile:t2', async () => {
      invoked.push('text-tile:t2');
    });
    registerMarkdownFlusher('document-editor:d1', async () => {
      invoked.push('document-editor:d1');
    });

    const result = await flushAllMarkdownWriters();

    expect(invoked.sort()).toEqual([
      'document-editor:d1',
      'text-tile:t1',
      'text-tile:t2',
    ]);
    expect(result.ok).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('awaits a slow flusher to completion before resolving', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let resolved = false;
    registerMarkdownFlusher('text-tile:slow', async () => {
      await gate;
      resolved = true;
    });

    const flushPromise = flushAllMarkdownWriters();

    // Microtask flush: confirm flushAll has NOT resolved before the gate opens.
    // If the dispatcher accidentally fires-and-forgets, this resolves early
    // and the assertion below fails.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    let outerResolvedEarly = false;
    void flushPromise.then(() => {
      outerResolvedEarly = !resolved;
    });
    await Promise.resolve();
    expect(outerResolvedEarly).toBe(false);

    // Open the gate; flushAll should now resolve with the slow flusher counted.
    release!();
    const result = await flushPromise;
    expect(resolved).toBe(true);
    expect(result.ok).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('routes a rejected flusher into failed[] with the owner id intact', async () => {
    const boom = new Error('disk full');
    registerMarkdownFlusher('text-tile:ok', async () => undefined);
    registerMarkdownFlusher('text-tile:bad', async () => {
      throw boom;
    });

    const result = await flushAllMarkdownWriters();

    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ownerId).toBe('text-tile:bad');
    expect(result.failed[0].error).toBe(boom);
  });

  it('a rejected flusher does not cancel sibling flushers — every callback runs', async () => {
    const calls: string[] = [];
    registerMarkdownFlusher('a', async () => {
      calls.push('a');
      throw new Error('A failed');
    });
    registerMarkdownFlusher('b', async () => {
      // Force the dispatcher to wait for this one even after `a` already rejected.
      await new Promise((r) => setTimeout(r, 5));
      calls.push('b');
    });
    registerMarkdownFlusher('c', async () => {
      calls.push('c');
      throw new Error('C failed');
    });

    const result = await flushAllMarkdownWriters();

    expect(calls.sort()).toEqual(['a', 'b', 'c']);
    expect(result.ok).toBe(1);
    expect(result.failed.map((f) => f.ownerId).sort()).toEqual(['a', 'c']);
  });

  it('after unregisterMarkdownFlusher, the dropped owner is not flushed', async () => {
    let aCalls = 0;
    let bCalls = 0;
    registerMarkdownFlusher('a', async () => {
      aCalls++;
    });
    registerMarkdownFlusher('b', async () => {
      bCalls++;
    });
    unregisterMarkdownFlusher('a');

    const result = await flushAllMarkdownWriters();

    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.failed).toEqual([]);
  });
});
