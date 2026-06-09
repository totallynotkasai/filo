import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcChannel, SendChannel } from '../shared/types';
import { RECEIVE_CHANNELS } from '../shared/types';
import { validateIpcPayload } from '../shared/ipcSchemas';

/**
 * Exposes a safe, typed IPC API to the renderer process via contextBridge.
 * All file system and native operations go through these channels.
 *
 * `invoke` runs the args through `validateIpcPayload` before forwarding to
 * `ipcRenderer.invoke`. A buggy or compromised renderer that hands a wrong
 * shape (e.g. an object for a string-typed path) is rejected with a
 * `BAD_PAYLOAD` error here — long before the call reaches main and bypasses
 * any handler-side `assertWithinVault` / `assertSafeFilename` checks.
 *
 * `send` (one-way push to main) runs the SAME `validateIpcPayload` gate
 * (M1, AUDIT_REMEDIATION_PLAN_2026-05-29). Previously `send` forwarded its
 * args to `ipcRenderer.send` unvalidated, so a renderer that bypassed
 * `invoke` could smuggle a malformed payload onto a push channel. `send`
 * is fire-and-forget (no Promise to reject), so a bad payload throws
 * synchronously here rather than resolving. Its channel arg is narrowed to
 * `SendChannel` so only the genuine push channels are reachable.
 *
 * The envelope-aware `invokeOk` wrapper (Phase 1,
 * CONSOLIDATION_PLAN_2026-05-25.md) lives renderer-side rather than on
 * the bridge — Electron's `contextBridge` strips custom Error subclass
 * fields via structured clone, which would lose the `channel` / `code`
 * data `IpcEnvelopeError` carries. The renderer-side helper at
 * `src/renderer/lib/utils/invokeOk.ts` calls this `invoke` and applies
 * `assertIpcOk` in the renderer's context where the throw preserves
 * the full error shape.
 *
 * `getPathForFile` is the Electron 32+ replacement for the removed `File.path`
 * property — it's the only way to resolve an OS-dropped `File` to its
 * absolute disk path in a `contextIsolation: true, sandbox: true` renderer.
 * Returns `''` for `File` objects not backed by a real on-disk file.
 */

class BadPayloadError extends Error {
  code = 'BAD_PAYLOAD';
  constructor(channel: string, detail: string) {
    super(`Invalid IPC payload for ${channel}: ${detail}`);
    this.name = 'BadPayloadError';
  }
}

/**
 * Audit-15 P3.3 — thrown when the renderer tries to `window.filo.on(...)` a
 * channel that isn't a known main→renderer event. Receive-only defence in
 * depth: a compromised renderer can't attach a listener to an arbitrary
 * channel string (the symmetric counterpart of `BadPayloadError` for `on`).
 */
class BadChannelError extends Error {
  code = 'BAD_CHANNEL';
  constructor(channel: string) {
    super(`Channel not subscribable from the renderer: ${channel}`);
    this.name = 'BadChannelError';
  }
}

const RECEIVABLE_CHANNELS = new Set<string>(RECEIVE_CHANNELS);

const api = {
  invoke: (channel: IpcChannel, ...args: unknown[]) => {
    const validation = validateIpcPayload(channel, args);
    if (!validation.ok) {
      return Promise.reject(new BadPayloadError(channel, validation.error));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: IpcChannel, callback: (...args: unknown[]) => void) => {
    // Audit-15 P3.3 — runtime allowlist. `on` was the only bridge method that
    // forwarded its channel unchecked; restrict subscriptions to the known
    // main→renderer events so a compromised renderer can't listen on an
    // arbitrary channel. Throwing (vs a silent no-op) mirrors `send`'s reject
    // and surfaces a typo'd channel loudly in dev — every legitimate caller
    // passes one of RECEIVE_CHANNELS, so this never fires in practice.
    if (!RECEIVABLE_CHANNELS.has(channel)) {
      throw new BadChannelError(channel);
    }
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },
  send: (channel: SendChannel, ...args: unknown[]) => {
    const validation = validateIpcPayload(channel, args);
    if (!validation.ok) {
      throw new BadPayloadError(channel, validation.error);
    }
    ipcRenderer.send(channel, ...args);
  },
  getPathForFile: (file: File): string => {
    try {
      const resolved = webUtils.getPathForFile(file);
      // Audit-12 S1 — register the resolved drop path as an approved
      // `vault:copy-file` source. `webUtils.getPathForFile` only returns a real
      // path for a `File` backed by an actual on-disk file the user dropped, so
      // this is a TRUSTED minting point a hostile renderer can't abuse: it
      // can't synthesise a `File` for `/etc/passwd`. Fired via the DIRECT
      // `ipcRenderer.send` (module-scoped, NOT the contextBridge-exposed
      // `api.send`), so the registration channel is unreachable from renderer
      // JS — `window.filo.send('vault:register-source-path', …)` hits the
      // `z.never()` payload schema and is rejected. Fire-and-forget; delivered
      // before the renderer's subsequent `vault:copy-file` invoke (FIFO on the
      // same renderer→main pipe). Registration failure must never break path
      // resolution, so it's swallowed.
      if (resolved) {
        try {
          ipcRenderer.send('vault:register-source-path', resolved);
        } catch {
          /* best-effort registration */
        }
      }
      return resolved;
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('filo', api);
