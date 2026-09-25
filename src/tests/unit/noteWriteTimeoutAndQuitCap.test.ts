import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleFlushAndQuit,
  __resetQuitDrainingForTests,
} from '@renderer/lib/vault/handleFlushAndQuit';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import {
  isPathPending,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-11 Phase 2 — write liveness (network-volume quit hang & UI freeze).
 *
 * WC-1/QC-1/QC-2: every debounced write scheduler that can reach an unbounded
 * await (a stuck IPC on a dropped OneDrive/SMB volume, or an interactive drift
 * prompt) now carries `writeTimeoutMs`, so a wedged write resolves the flush as
 * a failure instead of hanging `flushAll` → `save()` → quit forever.
 *
 * WC-1 (half 2) / QC-3: the quit drain is additionally capped by an absolute
 * deadline in `handleFlushAndQuit`, so even an unbounded await surfaces the
 * existing "Save failed" confirm instead of freezing the quit.
 *
 * QC-4: a re-entrant `app:flush-and-quit` dispatch no-ops.
 */

/** Strip the orthogonal drain heartbeat so handshake assertions stay focused. */
const handshakeOf = (sent: readonly string[]): string[] =>
  sent.filter((c) => c !== 'app:drain-heartbeat');


describe('Audit-11 WC-1 — the note writer bounds a wedged write', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('noteStore.flushAll aborts at the write timeout instead of hanging on a wedged IPC', async () => {
    // The fresh read never resolves (a dropped network volume). Without the
    // writer's timeout this flush, and `save()`/quit that fold it in, would
    // freeze forever. The sentinel write resolves so markDirty stays quiet.
    installFiloMock({
      'vault:read-file-text': () => new Promise(() => {}), // never settles
      'vault:write-file-text': () => ({ success: true }),
    });

    vi.useFakeTimers();
    noteStore.patchFrontmatter('Wedged.md', patchToFrontmatterDelta({ priority: 'high' }));

    const flushed = noteStore.flushAll();
    // Cross the 60 s bound: the flush resolves to its timeout, marks the path
    // failed, and attributes the failure.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await flushed;

    expect(result.failed).toContain('Wedged.md');
    // The path is recorded failed (sentinel stays dirty), not silently cleaned.
    expect(isPathPending('Wedged.md')).toBe(true);
  }, 10_000);
});
describe('Audit-11 WC-1 (half 2) / QC-3 / QC-4 — quit drain cap', () => {
  beforeEach(() => {
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });

  it('caps the drain: stops beating + opens the Save-failed confirm when save() never resolves', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    // save() never resolves — a stall the per-write bound somehow didn't catch,
    // or an unbounded await. Pre-fix the heartbeat re-armed main's destroy timer
    // forever and quit froze.
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: () => new Promise<boolean>(() => {}),
      send: (c) => sent.push(c),
      reportError: () => {},
    });
    const beats = (): number => sent.filter((c) => c === 'app:drain-heartbeat').length;

    // Before the deadline: beating, no terminal/awaiting signal, no confirm.
    await vi.advanceTimersByTimeAsync(2000);
    expect(beats()).toBeGreaterThanOrEqual(2);
    expect(handshakeOf(sent)).toEqual([]);
    expect(uiStore.confirmDialog).toBeNull();

    // Cross the 60 s absolute deadline (total elapsed now > 60 s).
    await vi.advanceTimersByTimeAsync(60_000);

    // Beating stopped, awaiting-user emitted, the Save-failed confirm is open.
    expect(handshakeOf(sent)).toContain('app:quit-awaiting-user');
    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');
    const beatsAtDeadline = beats();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(beats()).toBe(beatsAtDeadline);

    // Resolve the confirm so the handler completes (no leaked promise).
    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(sent)).toContain('app:cancel-quit');
  });

  it('QC-3: does not hang on a wedged flushSentinel — still sends ready-to-quit', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => true,
      send: (c) => sent.push(c),
      reportError: () => {},
      flushSentinel: () => new Promise<void>(() => {}), // never resolves
    });
    // save() succeeds → happy path → the terminal sentinel flush races its own
    // 5 s deadline. Cross it; the handler proceeds to ready-to-quit anyway.
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    expect(sent).toContain('app:ready-to-quit');
  });

  it('QC-4: a re-entrant dispatch does not start a second save()', async () => {
    let saveCalls = 0;
    let resolveSave!: (v: boolean) => void;
    const savePromise = new Promise<boolean>((r) => {
      resolveSave = r;
    });
    const deps = {
      saveStateState: (): 'idle' => 'idle',
      save: (): Promise<boolean> => {
        saveCalls++;
        return savePromise;
      },
      send: (): void => {},
      reportError: (): void => {},
    };

    const p1 = handleFlushAndQuit(deps);
    // Second dispatch while the first is still draining — must no-op.
    const p2 = handleFlushAndQuit(deps);
    expect(saveCalls).toBe(1);

    resolveSave(true);
    await Promise.all([p1, p2]);
    expect(saveCalls).toBe(1);

    // After the first drain settled, the guard is released so a genuine later
    // quit can drain again (savePromise is already resolved, so it completes).
    const p3 = handleFlushAndQuit(deps);
    await p3;
    expect(saveCalls).toBe(2);
  });
});
