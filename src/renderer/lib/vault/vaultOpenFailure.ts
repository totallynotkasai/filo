/**
 * Why a vault didn't open, for the callers that act on it: Home drops a recent
 * vault only when its folder is confirmed gone, never when the user stayed in
 * the current vault or the drive holding it is briefly unavailable.
 */
import { IpcEnvelopeError } from '@shared/ipcEnvelope';

export type OpenVaultFailure =
  /** The user chose to stay in the current vault. */
  | 'cancelled'
  /** The folder isn't there (the drive or share holding it is). */
  | 'missing'
  /** The drive or network share holding the folder can't be reached. */
  | 'unavailable'
  /** Anything else; `openVault` has already reported it. */
  | 'failed';

/** Filled in by `openVault` when it returns false. */
export interface OpenVaultReport {
  failure?: OpenVaultFailure;
}

/** Records `failure` on `report` (when given) and returns false, for `return openFailed(...)`. */
export function openFailed(report: OpenVaultReport | undefined, failure: OpenVaultFailure): false {
  if (report) report.failure = failure;
  return false;
}

/**
 * Only the first step of an open, `vault:init-config`, says whether the folder
 * exists: its codes come from a `stat` of the folder itself. The same code
 * from a later read means something else.
 */
export function openVaultFailureOf(err: unknown): OpenVaultFailure {
  if (!(err instanceof IpcEnvelopeError) || err.channel !== 'vault:init-config') return 'failed';
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
  if (err.code === 'ENODEV') return 'unavailable';
  return 'failed';
}
