import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RECEIVE_CHANNELS } from '../../shared/types';

/**
 * Audit-15 P3.3 — the preload `on` wrapper must allowlist the channel a
 * renderer subscribes to. Previously `on` forwarded ANY channel string to
 * `ipcRenderer.on`, so a compromised renderer could attach a listener to an
 * arbitrary channel (receive-only, but the one un-gated bridge method —
 * `invoke`/`send` are already payload-validated). The fix throws unless the
 * channel is one of the known main→renderer events (`RECEIVE_CHANNELS`).
 *
 * The wrapper is exposed via `contextBridge.exposeInMainWorld('filo', api)` at
 * module load, so we mock `electron` to capture the exposed `api` and spy on
 * `ipcRenderer.on` / `removeListener`. The real `RECEIVE_CHANNELS` is used (not
 * mocked) so this stays in lockstep with the shipped allowlist.
 *
 * Bite-verify: remove the `RECEIVABLE_CHANNELS.has(channel)` guard in
 * preload.ts → the "rejects" specs go green-through.
 */

const onSpy = vi.fn();
const removeListenerSpy = vi.fn();
let exposed: Record<string, unknown> = {};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed = api;
    },
  },
  ipcRenderer: {
    on: (...args: unknown[]) => onSpy(...args),
    removeListener: (...args: unknown[]) => removeListenerSpy(...args),
    invoke: async () => undefined,
    send: () => {},
  },
  webUtils: {
    getPathForFile: () => '',
  },
}));

await import('../../main/preload');

type OnFn = (channel: string, callback: (...args: unknown[]) => void) => () => void;

describe('preload on wrapper — Audit-15 P3.3 receive-channel allowlist', () => {
  beforeEach(() => {
    onSpy.mockClear();
    removeListenerSpy.mockClear();
  });

  it('subscribes for every channel in RECEIVE_CHANNELS', () => {
    const on = exposed.on as OnFn;
    // Sanity: the shipped allowlist is non-empty (a collapsed list would make
    // the guard reject everything).
    expect(RECEIVE_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of RECEIVE_CHANNELS) {
      onSpy.mockClear();
      const cb = () => {};
      const unsub = on(channel, cb);
      expect(onSpy).toHaveBeenCalledTimes(1);
      expect(onSpy.mock.calls[0]?.[0]).toBe(channel);
      expect(typeof unsub).toBe('function');
    }
  });

  it('forwards args from main through to the callback', () => {
    const on = exposed.on as OnFn;
    const received: unknown[] = [];
    on('vault:files-changed', (...args: unknown[]) => received.push(...args));
    // The subscription registered with ipcRenderer.on is `(event, ...args) => cb(...args)`.
    const subscription = onSpy.mock.calls[0]?.[1] as (
      event: unknown,
      ...args: unknown[]
    ) => void;
    subscription({}, 'a', 'b');
    expect(received).toEqual(['a', 'b']);
  });

  it('returns an unsubscribe that calls removeListener for the same channel', () => {
    const on = exposed.on as OnFn;
    const cb = () => {};
    const unsub = on('vault:tree-updated', cb);
    expect(removeListenerSpy).not.toHaveBeenCalled();
    unsub();
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy.mock.calls[0]?.[0]).toBe('vault:tree-updated');
  });

  it('throws and does NOT subscribe for a request/response channel', () => {
    const on = exposed.on as OnFn;
    // A real channel, but a renderer→main invoke channel — not a broadcast the
    // renderer should ever listen on.
    expect(() => on('vault:read-file-text' as never, () => {})).toThrow(/not subscribable/i);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('throws for a fabricated channel name', () => {
    const on = exposed.on as OnFn;
    expect(() => on('totally:made-up' as never, () => {})).toThrow(/not subscribable/i);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('throws for a send-only channel (renderer→main, not receivable)', () => {
    const on = exposed.on as OnFn;
    expect(() => on('app:ready-to-quit' as never, () => {})).toThrow(/not subscribable/i);
    expect(onSpy).not.toHaveBeenCalled();
  });
});
