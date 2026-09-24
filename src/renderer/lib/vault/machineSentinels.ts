/**
 * Read / delete helpers for per-machine crash-recovery sentinels.
 *
 * A machine reads and deletes ITS OWN sentinel only. Other machines'
 * sentinels are never read here (see `recovery:list-sentinels` for the
 * informational listing).
 */
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import type { SentinelKind } from '@shared/sentinelPaths';
import { ownSentinelPath } from './machineIdentity';
import { normalizePath } from '../utils/path';

export interface SentinelRead {
  content: string;
  relPath: string;
}

function isEnoent(err: unknown): boolean {
  return err instanceof IpcEnvelopeError && err.code === 'ENOENT';
}

/**
 * Reads this machine's `kind` sentinel. When it doesn't exist, throws the
 * ENOENT `IpcEnvelopeError` so callers keep their "absent = clean" branch.
 */
export async function readOwnSentinel(vaultRoot: string, kind: SentinelKind): Promise<SentinelRead> {
  const own = ownSentinelPath(kind);
  const res = await invokeOk('vault:read-file-text', vaultRoot, own);
  return { content: res.content, relPath: own };
}

/** Deletes a sentinel file; ENOENT (already gone) is success. Other failures throw. */
export async function deleteSentinelFile(vaultRoot: string, relPath: string): Promise<void> {
  const fullPath = `${normalizePath(vaultRoot)}/${relPath}`;
  try {
    // Crash-recovery sentinel cleanup (`.filo/`), not user content — ALLOWLISTed in check-no-raw-disk-shape-ipc.
    await invokeOk('vault:delete', vaultRoot, fullPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

/** Deletes THIS machine's `kind` sentinel. */
export async function clearOwnSentinel(vaultRoot: string, kind: SentinelKind): Promise<void> {
  await deleteSentinelFile(vaultRoot, ownSentinelPath(kind));
}
