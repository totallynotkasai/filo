import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFlushAndQuit } from '@renderer/lib/vault/handleFlushAndQuit';
import { uiStore } from '@renderer/stores/ui.svelte';

/** Audit5 2.1 — the drain heartbeat is orthogonal to the terminal quit
 *  handshake; strip it so the handshake assertions stay focused. */
const handshakeOf = (sent: readonly string[]): string[] =>
  sent.filter((c) => c !== 'app:drain-heartbeat');

/**
 * 6.2.H4 — flush-and-quit handler. Pre-fix, the renderer slept 200 ms on a
 * save failure and unconditionally sent `app:ready-to-quit`; the user had
 * about 200 ms to read a toast naming a `<path>.<nonce>.tmp` location
 * before the window destroyed.
 *
 * The handler now sends `app:ready-to-quit` immediately on success, and
 * surfaces a Confirm with "Quit anyway" / "Stay open and retry" on
 * failure. The latter sends a new `app:cancel-quit` signal that the main
 * process uses to rewind `isFlushingForQuit` so the user can keep editing.
 */
describe('handleFlushAndQuit — 6.2.H4 save-failure confirm flow', () => {
  beforeEach(() => {
    uiStore.closeConfirm();
  });

  afterEach(() => {
    uiStore.closeConfirm();
    vi.useRealTimers();
  });

  it('happy path: save succeeds → sends ready-to-quit immediately, no Confirm', async () => {
    let sentChannel: string | null = null;
    await handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => true,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    expect(sentChannel).toBe('app:ready-to-quit');
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('save fails (returns false): opens Confirm with Quit anyway / Stay open labels', async () => {
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        sent.push(c);
      },
      reportError: () => {},
    });

    // Yield to let openConfirm fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Quit anyway');
    expect(uiStore.confirmDialog?.cancelLabel).toBe('Stay open and retry');

    // Audit5 2.1 — a drain heartbeat fired (so main re-armed its destroy
    // timer). Beyond that, awaiting-user has fired but no TERMINAL quit signal
    // yet — the window must stay alive until the user clicks something.
    expect(sent).toContain('app:drain-heartbeat');
    expect(handshakeOf(sent)).toEqual(['app:quit-awaiting-user']);

    // User picks "Quit anyway".
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(sent)).toEqual(['app:quit-awaiting-user', 'app:ready-to-quit']);
  });

  it('DI-04: emits app:quit-awaiting-user BEFORE opening the confirm on a save failure', async () => {
    // The heartbeat must reach main before the (open-ended) confirm appears so
    // main can clear its FLUSH_TIMEOUT_MS auto-destroy timer first — otherwise
    // the timer fires, destroys the window under the dialog, and discards the
    // user's choice + edits.
    const order: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        if (c === 'app:quit-awaiting-user') {
          // At heartbeat time the confirm must not be open yet.
          expect(uiStore.confirmDialog).toBeNull();
        }
        order.push(c);
      },
      reportError: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(uiStore.confirmDialog).not.toBeNull();
    // Audit5 2.1 — the heartbeat goes out first (before save() even resolves),
    // then the awaiting-user signal; neither precedes the confirm being closed.
    expect(order[0]).toBe('app:drain-heartbeat');
    expect(handshakeOf(order)).toEqual(['app:quit-awaiting-user']);

    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(order)).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });

  it('save fails + Stay open: sends app:cancel-quit (no ready-to-quit)', async () => {
    let sentChannel: string | null = null;
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.confirmDialog).not.toBeNull();
    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:cancel-quit');
  });

  it('save throws: also opens Confirm and routes both outcomes', async () => {
    let sentChannel: string | null = null;
    const reported: Array<[string, unknown, string]> = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => {
        throw new Error('disk full');
      },
      send: (c) => {
        sentChannel = c;
      },
      reportError: (ctx, err, msg) => {
        reported.push([ctx, err, msg]);
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toBe('App');
    expect(uiStore.confirmDialog).not.toBeNull();

    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:cancel-quit');
  });

  it('save returns true but saveStateStore reports error: still opens Confirm', async () => {
    // A debounced write that errored a few seconds ago can leave the
    // save-state at 'error' even when the per-call drains return true
    // for this flush. Don't quit silently in that case.
    let sentChannel: string | null = null;
    const promise = handleFlushAndQuit({
      saveStateState: () => 'error',
      save: async () => true,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(uiStore.confirmDialog).not.toBeNull();
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:ready-to-quit');
  });

  it('Audit5 2.1: beats immediately and re-beats every ~2s while save() drains, stopping once it settles', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let resolveSave!: (v: boolean) => void;
    const savePromise = new Promise<boolean>((res) => {
      resolveSave = res;
    });
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: () => savePromise,
      send: (c) => {
        sent.push(c);
      },
      reportError: () => {},
    });

    const beats = (): number => sent.filter((c) => c === 'app:drain-heartbeat').length;

    // One beat goes out synchronously, BEFORE save() resolves — so main's 5s
    // auto-destroy timer is already being re-armed while the drain runs.
    expect(sent).toEqual(['app:drain-heartbeat']);

    // Two more heartbeat intervals elapse while save() is still pending.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(beats()).toBe(3);

    // save() finally resolves OK → interval cleared, ready-to-quit sent.
    resolveSave(true);
    await promise;
    expect(sent[sent.length - 1]).toBe('app:ready-to-quit');

    // No further heartbeats once the drain settled (interval was cleared).
    const beatsAtSettle = beats();
    await vi.advanceTimersByTimeAsync(10000);
    expect(beats()).toBe(beatsAtSettle);
  });

  it('Audit-6 M5: awaits flushSentinel BEFORE app:ready-to-quit (happy path)', async () => {
    // The dirty-flag markClean save() queued while draining is fire-and-forget
    // on the sentinel mutex. If ready-to-quit goes out before it lands, main
    // destroys the renderer mid-IPC and `.filo/.dirty` survives → phantom
    // recovery next launch. The handler must AWAIT the sentinel flush first.
    const order: string[] = [];
    let resolveFlush!: () => void;
    const flushGate = new Promise<void>((r) => {
      resolveFlush = r;
    });

    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => true,
      send: (c) => {
        order.push(`send:${c}`);
      },
      reportError: () => {},
      flushSentinel: async () => {
        order.push('flush:start');
        await flushGate;
        order.push('flush:end');
      },
    });

    // save() has resolved and the sentinel flush is in-flight, gating the quit.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toContain('flush:start');
    // ready-to-quit must NOT fire while flushSentinel is still pending.
    expect(order).not.toContain('send:app:ready-to-quit');

    resolveFlush();
    await promise;

    // Strict ordering: the sentinel flush fully settled before ready-to-quit
    // (the orthogonal drain heartbeat is filtered out).
    const relevant = order.filter((e) => e !== 'send:app:drain-heartbeat');
    expect(relevant).toEqual(['flush:start', 'flush:end', 'send:app:ready-to-quit']);
  });

  it('Audit-6 M5: awaits flushSentinel before ready-to-quit on "Quit anyway"', async () => {
    // On a save failure the user picks "Quit anyway" — the sentinel is DIRTY
    // (failed paths). Flushing that markDirty before ready-to-quit keeps the
    // next launch's recovery prompt accurate.
    const order: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        order.push(`send:${c}`);
      },
      reportError: () => {},
      flushSentinel: async () => {
        order.push('flush');
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    uiStore.confirmDialog!.onConfirm(false); // Quit anyway
    uiStore.closeConfirm();
    await promise;

    // flush ran, then ready-to-quit — and the flush preceded the quit signal.
    expect(order).toContain('flush');
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('send:app:ready-to-quit'));
  });
});
