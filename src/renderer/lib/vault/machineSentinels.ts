/**
 * Read / delete helpers for per-machine crash-recovery sentinels.
 *
 * A machine reads ITS OWN sentinel and, when that is absent, the LEGACY
 * shared one (`LEGACY_SENTINEL_PATHS`). A legacy sentinel is handled
 * once and then deleted by the owning module;
 * new code never writes a legacy name. Other machines' sentinels are never
 * read here (see `recovery:list-sentinels` for the informational listing).
 */
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { LEGACY_SENTINEL_PATHS, type SentinelKind } from '@shared/sentinelPaths';
import { ownSentinelPath } from './machineIdentity';
import { normalizePath } from '../utils/path';

export interface SentinelRead {
  content: string;
  source: 'own' | 'legacy';
  relPath: string;
}

export function legacySentinelPath(kind: SentinelKind): string {
  return LEGACY_SENTINEL_PATHS[kind];
}

/**
 * `vaultRoot|kind` pairs whose LEGACY sentinel was read this session. The
 * owning module's next clear / write retires it (`clearOwnSentinel` /
 * `retireConsumedLegacySentinel`), so a legacy file is handled exactly once and
 * the common case costs no extra IPC.
 */
// allow-module-state: per-session one-shot migration flags (legacy files are consumed once)
const legacyConsumed = new Set<string>();

function isEnoent(err: unknown): boolean {
  return err instanceof IpcEnvelopeError && err.code === 'ENOENT';
}

/**
 * Reads this machine's `kind` sentinel, falling back to the legacy shared one.
 * Throws the own read's error when it isn't ENOENT; when neither exists, throws
 * the ENOENT `IpcEnvelopeError` so callers keep their "absent = clean" branch.
 */
export async function readOwnOrLegacySentinel(vaultRoot: string, kind: SentinelKind): Promise<SentinelRead> {
  const own = ownSentinelPath(kind);
  try {
    const res = await invokeOk('vault:read-file-text', vaultRoot, own);
    return { content: res.content, source: 'own', relPath: own };
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  const legacy = legacySentinelPath(kind);
  const res = await invokeOk('vault:read-file-text', vaultRoot, legacy);
  legacyConsumed.add(`${vaultRoot}|${kind}`);
  return { content: res.content, source: 'legacy', relPath: legacy };
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

/** Deletes the consumed legacy `kind` sentinel (once) if it was read this session. */
export async function retireConsumedLegacySentinel(vaultRoot: string, kind: SentinelKind): Promise<void> {
  const key = `${vaultRoot}|${kind}`;
  if (!legacyConsumed.has(key)) return;
  await deleteSentinelFile(vaultRoot, legacySentinelPath(kind));
  legacyConsumed.delete(key);
}

/** Deletes THIS machine's `kind` sentinel, plus the legacy one when it was consumed. */
export async function clearOwnSentinel(vaultRoot: string, kind: SentinelKind): Promise<void> {
  await deleteSentinelFile(vaultRoot, ownSentinelPath(kind));
  await retireConsumedLegacySentinel(vaultRoot, kind);
}

/** Test-only. */
export function __resetLegacySentinelFlagsForTests(): void {
  legacyConsumed.clear();
}
