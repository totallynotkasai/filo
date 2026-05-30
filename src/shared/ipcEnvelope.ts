/**
 * ipcEnvelope — shared between preload + renderer.
 *
 * The main-process IPC handlers catch their own exceptions and resolve
 * with `{ ok: false, error }` (or `{ success: false, error }`) instead
 * of letting the promise reject. A renderer call site that just awaits
 * the invoke result would see a resolved promise on disk-write failure
 * (EPERM, EACCES, ENOSPC, antivirus file lock) and treat it as success.
 *
 * `assertIpcOk` turns those `{ ok|success: false }` envelopes into a
 * thrown `IpcEnvelopeError` so the existing trackComponentWrite /
 * errorBus / `failedVaultPaths` pipeline picks the failure up the same
 * way it would a thrown exception. Bare-result channels (raw arrays,
 * strings, booleans, `null`) pass through untouched.
 *
 * `window.filo.invokeOk` (Phase 1, CONSOLIDATION_PLAN_2026-05-25.md) is
 * implemented in `src/main/preload.ts` on top of this function so the
 * preload + renderer side both honour the same envelope contract.
 */

export class IpcEnvelopeError extends Error {
  readonly channel: string;
  readonly code?: string;
  constructor(channel: string, message: string, code?: string) {
    super(message);
    this.name = 'IpcEnvelopeError';
    this.channel = channel;
    this.code = code;
  }
}

type EnvelopeShape = {
  ok?: unknown;
  success?: unknown;
  error?: unknown;
  code?: unknown;
};

/**
 * Throws `IpcEnvelopeError` if `result` is an envelope object whose
 * `ok` / `success` field is `false`. Returns the result unchanged so
 * callers can chain.
 *
 * Tolerant of non-envelope payloads — many IPC handlers return bare
 * arrays / strings / null on success (e.g. `board:list`). Those are
 * passed through untouched. Type narrowing from the union to the
 * success branch is the caller's responsibility (see `invokeOk` for
 * the typed wrapper).
 */
export function assertIpcOk<R>(result: R, channel: string): R {
  if (result === null || typeof result !== 'object') return result;
  const envelope = result as EnvelopeShape;
  const hasOk = 'ok' in envelope;
  const hasSuccess = 'success' in envelope;
  if (!hasOk && !hasSuccess) return result;
  const flag = hasOk ? envelope.ok : envelope.success;
  if (flag !== false) return result;
  const message = typeof envelope.error === 'string' && envelope.error.length > 0
    ? envelope.error
    : `${channel} reported failure`;
  const code = typeof envelope.code === 'string' ? envelope.code : undefined;
  throw new IpcEnvelopeError(channel, message, code);
}
