import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * M1 (AUDIT_REMEDIATION_PLAN_2026-05-29) — the preload `send` wrapper must run
 * the SAME `validateIpcPayload` gate `invoke` enforces. Previously `send`
 * forwarded its args to `ipcRenderer.send` unvalidated, so a renderer that
 * bypassed `invoke` could smuggle a malformed payload onto a push channel.
 *
 * The wrapper is exposed via `contextBridge.exposeInMainWorld('filo', api)` at
 * module load, so we mock `electron` to (a) capture the exposed `api` object
 * and (b) spy on `ipcRenderer.send` / `ipcRenderer.invoke`. The real
 * `validateIpcPayload` + `IPC_PAYLOAD_SCHEMAS` are exercised (not mocked) so
 * this is an integration test of the wrapper against the live schema map.
 */

const sendSpy = vi.fn();
const invokeSpy = vi.fn(async () => undefined);
let exposed: Record<string, unknown> = {};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed = api;
    },
  },
  ipcRenderer: {
    send: (...args: unknown[]) => sendSpy(...args),
    invoke: (...args: unknown[]) => invokeSpy(...args),
    on: () => {},
    removeListener: () => {},
  },
  webUtils: {
    getPathForFile: () => '',
  },
}));

await import('../../main/preload');

type SendFn = (channel: string, ...args: unknown[]) => void;
type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

describe('preload send wrapper — M1 payload validation', () => {
  beforeEach(() => {
    sendSpy.mockClear();
    invokeSpy.mockClear();
  });

  it('forwards a valid app:ready-to-quit (no args) to ipcRenderer.send', () => {
    const send = exposed.send as SendFn;
    send('app:ready-to-quit');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('app:ready-to-quit');
  });

  it('throws and does NOT forward when app:ready-to-quit is given a stray arg', () => {
    const send = exposed.send as SendFn;
    // `app:ready-to-quit` schema is `z.tuple([])` — any positional arg is a
    // shape violation, symmetric with how `invoke` would reject it.
    expect(() => send('app:ready-to-quit', { stray: 'arg' })).toThrow(/Invalid IPC payload/);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rejects (does not resolve) when invoke is given a malformed payload', async () => {
    const invoke = exposed.invoke as InvokeFn;
    // vault:read-tree expects a single non-empty string; an object is wrong.
    await expect(invoke('vault:read-tree', { not: 'a string' })).rejects.toThrow(
      /Invalid IPC payload/,
    );
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
