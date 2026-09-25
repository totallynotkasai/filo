import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { uiStore } from '../../stores/ui.svelte';
import { vaultSwapResettable } from '../../core/vaultLifecycle';
import { normalizePath, toPosix } from '../utils/path';

/**
 * "Keep local" ALWAYS backs up the external bytes first. Every Keep-local
 * path overwrites a file another device / editor changed; without a backup a
 * synced-vault conflict resolved in Filo's favour would destroy the other
 * machine's edit outright.
 *
 * `backupExternalVersion(vaultRoot, rel)` snapshots the CURRENT disk bytes
 * of `rel` into `.filo/recovery/` (via `recovery:snapshot`: byte-exact read +
 * atomic write) and resolves `true` when the caller may proceed with the
 * overwrite:
 *   - ENOENT → nothing to back up → proceed.
 *   - snapshot OK → proceed, with an info toast naming the backup location.
 *   - any other failure (locked, > 25 MB) → a danger confirm
 *     "Overwrite it anyway?"; Cancel → `false` (the caller defers).
 *
 * Deduped per (rel, mtimeMs, size): a handler-level call followed by the
 * drift gate's own call for the same bytes snapshots (and confirms) once.
 * The CI gate `gates:keep-local-backup` requires a call in every Keep-local
 * handler / branch.
 */

type StatLike = { mtimeMs: number; size: number };

const decided = new Map<string, { key: string; proceed: Promise<boolean> }>();

vaultSwapResettable('keepLocalBackup', () => {
  decided.clear();
});

function displayName(rel: string): string {
  const i = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
  return i >= 0 ? rel.slice(i + 1) : rel;
}

/** Absolute snapshot path → vault-relative, forward slashes (for the toast). */
function toVaultRelative(vaultRoot: string, abs: string): string {
  const a = toPosix(abs);
  const root = normalizePath(vaultRoot);
  return a.toLowerCase().startsWith(root.toLowerCase() + '/') ? a.slice(root.length + 1) : a;
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof IpcEnvelopeError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function confirmOverwriteWithoutBackup(rel: string, reason: string): Promise<boolean> {
  return uiStore.confirmAsync({
    title: 'Overwrite without a backup?',
    body: `Filo couldn't back up the other version of "${displayName(rel)}" (${reason}). Overwrite it anyway?`,
    confirmLabel: 'Overwrite anyway',
    cancelLabel: 'Cancel',
    danger: true,
  });
}

async function runBackup(vaultRoot: string, rel: string): Promise<boolean> {
  try {
    const snap = await invokeOk('recovery:snapshot', vaultRoot, rel);
    const where = typeof snap?.path === 'string' ? toVaultRelative(vaultRoot, snap.path) : '.filo/recovery/';
    uiStore.pushToast({
      text: `Kept your version of "${displayName(rel)}". The other version is saved in ${where}.`,
      type: 'info',
      duration: 8000,
    });
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return true; // gone since the stat — nothing to back up
    const reason =
      code === 'RECOVERY_SNAPSHOT_TOO_LARGE'
        ? 'the file is larger than 25 MB'
        : code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
          ? 'the file is locked by another program'
          : err instanceof Error ? err.message : String(err);
    return confirmOverwriteWithoutBackup(rel, reason);
  }
}

/**
 * Snapshot the on-disk version of `rel` before a Keep-local overwrite.
 * Resolves `true` → proceed with the overwrite, `false` → the user cancelled
 * an un-backed-up overwrite (the caller must defer / not write).
 */
export async function backupExternalVersion(vaultRoot: string, rel: string): Promise<boolean> {
  let stat: StatLike;
  try {
    stat = await invokeOk('vault:stat', vaultRoot, rel);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return true; // nothing on disk to protect
    if (code === 'NO_ACTIVE_VAULT') return false; // vault closed under us — don't write
    return confirmOverwriteWithoutBackup(rel, code ?? (err instanceof Error ? err.message : String(err)));
  }
  const key = `${stat.mtimeMs}|${stat.size}`;
  const prior = decided.get(rel);
  if (prior && prior.key === key) return prior.proceed;
  const proceed = runBackup(vaultRoot, rel);
  decided.set(rel, { key, proceed });
  // A cancelled decision must not be cached: the user may choose Keep local
  // again (e.g. after closing the locking program) and deserves a retry.
  void proceed.then((ok) => {
    if (!ok && decided.get(rel)?.proceed === proceed) decided.delete(rel);
  });
  return proceed;
}

/** `'missing'` for no file, else the file's mtime and size. */
async function diskStamp(vaultRoot: string, rel: string): Promise<string> {
  try {
    const stat = await invokeOk('vault:stat', vaultRoot, rel);
    return `${stat.mtimeMs}|${stat.size}`;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
}

/** How many times `backupThenRead` starts over while another program keeps writing. */
const BACKUP_READ_ATTEMPTS = 3;

export type BackupThenRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'cancelled' | 'changing' };

/**
 * Backs up the version on disk, then runs `read`, and hands back what `read`
 * saw only when the file didn't change from before the backup to after the
 * read. The caller then builds its overwrite on exactly the bytes that were
 * backed up: backing up and reading separately would let a third write land
 * in between and be overwritten with no copy kept.
 *
 * `cancelled`: the backup failed and the user declined to overwrite anyway.
 * `changing`: another program kept writing the file on every attempt.
 */
export async function backupThenRead<T>(
  vaultRoot: string,
  rel: string,
  read: () => Promise<T>,
): Promise<BackupThenRead<T>> {
  for (let attempt = 0; attempt < BACKUP_READ_ATTEMPTS; attempt++) {
    const before = await diskStamp(vaultRoot, rel);
    if (!(await backupExternalVersion(vaultRoot, rel))) return { ok: false, reason: 'cancelled' };
    const value = await read();
    if ((await diskStamp(vaultRoot, rel)) === before) return { ok: true, value };
  }
  return { ok: false, reason: 'changing' };
}

/** Test-only. */
export function __resetKeepLocalBackupForTests(): void {
  decided.clear();
}
