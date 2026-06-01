import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __testRegisterFlusher as registerMarkdownFlusher,
  flushAllMarkdownWriters,
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '../../renderer/lib/vault/markdownFileWriter';

/**
 * Phase 8 (P1-6) regression guard: `flushAllMarkdownWriters` must surface
 * per-owner failures so `vaultStore.save()` can honestly report "Save
 * failed" instead of flashing the success toast while a `.md` write was
 * actually rejected.
 *
 * Previously the registry used `Promise.all` with per-callback `.catch`,
 * swallowing every per-writer failure. The new contract: returns
 * `{ ok, failed: [{ ownerId, error }] }` so the caller can decide how
 * to surface aggregate status.
 */
describe('flushAllMarkdownWriters — aggregate status', () => {
  beforeEach(() => {
    __resetMarkdownFlushersForTests();
  });
  afterEach(() => {
    __resetMarkdownFlushersForTests();
  });

  it('returns ok=0 and empty failed when no flushers are registered', async () => {
    const result = await flushAllMarkdownWriters();
    expect(result).toEqual({ ok: 0, failed: [] });
  });

  it('returns ok=N when every flusher resolves', async () => {
    registerMarkdownFlusher('a', async () => undefined);
    registerMarkdownFlusher('b', async () => undefined);
    registerMarkdownFlusher('c', async () => undefined);

    const result = await flushAllMarkdownWriters();
    expect(result.ok).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('returns failed entries when flushers throw, with the rest still counted as ok', async () => {
    const errA = new Error('A failed');
    const errC = new Error('C failed');
    registerMarkdownFlusher('a', async () => {
      throw errA;
    });
    registerMarkdownFlusher('b', async () => undefined);
    registerMarkdownFlusher('c', async () => {
      throw errC;
    });

    const result = await flushAllMarkdownWriters();
    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map((f) => f.ownerId).sort()).toEqual(['a', 'c']);
    const failedById = new Map(result.failed.map((f) => [f.ownerId, f.error]));
    expect(failedById.get('a')).toBe(errA);
    expect(failedById.get('c')).toBe(errC);
  });

  it('waits for every flusher (Promise.allSettled) — one throw does not short-circuit the rest', async () => {
    const calls: string[] = [];
    registerMarkdownFlusher('a', async () => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push('a');
      throw new Error('boom');
    });
    registerMarkdownFlusher('b', async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push('b');
    });

    const result = await flushAllMarkdownWriters();
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(1);
  });
});
