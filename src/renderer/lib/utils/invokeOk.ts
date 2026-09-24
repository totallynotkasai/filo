/**
 * `invokeOk` — envelope-aware wrapper around `window.filo.invoke`.
 *
 * Used by every renderer callsite that hits a channel returning
 * `{ ok | success: true | false, ... }`. On the success branch the
 * promise resolves with the narrowed `SuccessOf<C>` (caller gets
 * `.path`, `.bytes`, etc. directly with no envelope dance). On the
 * failure branch the promise rejects with `IpcEnvelopeError` carrying
 * the original error message and optional code — the existing
 * trackComponentWrite / errorBus pipeline catches the throw and
 * surfaces it the same way a real exception would.
 *
 * Lives renderer-side (not on the contextBridge surface) because
 * Electron's `contextBridge` strips custom Error subclass fields via
 * structured clone — putting this on `window.filo` would lose the
 * `channel` / `code` data on every throw. The bridge stays minimal;
 * the envelope check happens in the renderer's own context.
 *
 * `assertIpcOk` is the underlying envelope check — it accepts both
 * `ok` and `success` discriminators and is tolerant of bare-result
 * channels. Calling `invokeOk` on a bare channel is gated by
 * `EnvelopeChannel` — TS rejects `invokeOk('vault:file-exists', ...)`
 * at compile time.
 */

import { assertIpcOk } from '@shared/ipcEnvelope';
import type {
  EnvelopeChannel,
  ChannelArgs,
  SuccessOf,
} from '@shared/ipcContracts';

export async function invokeOk<C extends EnvelopeChannel>(
  channel: C,
  ...args: ChannelArgs<C>
): Promise<SuccessOf<C>> {
  // `window.filo.invoke` is strictly typed against `IpcChannelMap`, so
  // the args tuple is validated here at compile time. `assertIpcOk`
  // throws on `{ ok | success: false }`; the `as` below narrows the
  // discriminated union to its success branch — TS allows the
  // narrowing cast since `SuccessOf<C>` is a member of `ChannelResult<C>`.
  const result = await window.filo.invoke(channel, ...args);
  assertIpcOk(result, channel);
  return result as SuccessOf<C>;
}
