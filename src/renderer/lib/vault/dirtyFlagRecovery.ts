/**
 * Dirty-flag recovery — survives abnormal shutdown.
 *
 * Every debounced vault write has a 300ms window where the in-memory state
 * has changed but nothing is on disk yet. If the process is killed inside
 * that window (crash, power loss, OS kill) the user silently loses work.
 *
 * This module lays down a sentinel file at `.filo/.dirty` for the duration
 * of any pending write. If that sentinel is present at the next vault open,
 * the app knows the last session ended mid-write and can notify the user.
 *
 * A sentinel file is used instead of a flag inside `workspace.json` because
 * workspace.json is itself written on a 300ms debounce — a flag there would
 * race with normal workspace writes. The sentinel is a separate file no
 * other subsystem touches.
 */
import { reportError } from '../utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { onVaultSwap } from '../../core/vaultLifecycle';

const DIRTY_SENTINEL_PATH = '.filo/.dirty';

/**
 * Promise-chained mutex serialising every sentinel mutation (markDirty,
 * markClean). Without this, two concurrent `endWrite` calls can issue
 * `markDirty(['a'])` and `markClean()` in either order — and because the
 * underlying IPC writes/deletes the same file, the disk state ends up
 * non-deterministic ("did the dirty win or the clean?"). Serialising
 * forces a deterministic last-writer-wins ordering matched to the order
 * the writers were called.
 *
 * Trade-off: serialising lengthens the tail of a burst of sentinel ops
 * by ~5–15ms each. Acceptable because sentinel writes only happen on
 * write-state transitions (counter 0→1, 1→0), not on every keystroke.
 */
let sentinelMutex: Promise<unknown> = Promise.resolve();

function withSentinelLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = sentinelMutex.then(fn, fn);
  // The chain head must survive a rejected predecessor so the next caller
  // still runs — swallow errors at the chain level; individual ops surface
  // their own via `reportError`.
  sentinelMutex = next.catch(() => undefined);
  return next;
}

export interface RecoveryStatus {
  needsRecovery: boolean;
  dirtyAt?: number;
  /** Vault-relative paths of files that had pending writes at the time of the crash. */
  pendingPaths?: string[];
  /**
   * Why recovery is required when no sentinel could be read but the call did
   * not return cleanly with ENOENT. Lets the recovery UI distinguish "we know
   * the previous session ended dirty" from "we couldn't tell, assume the
   * worst" — the latter wants a different toast copy.
   */
  reason?: 'sentinel-unreadable';
}

interface SentinelPayload {
  dirtyAt: number;
  pendingPaths?: string[];
}

/**
 * Writes the sentinel file. Safe to call repeatedly — the body is idempotent
 * for a given session. Failures are swallowed (recovery is best-effort; a
 * failed sentinel write should not break the save path).
 *
 * `pendingPaths` is an optional snapshot of the vault-relative paths currently
 * queued for write. Persisting this lets a recovery handler surface exactly
 * which files were in-flight when the process died.
 */
export function markDirty(
  vaultRoot: string,
  pendingPaths?: readonly string[],
): Promise<void> {
  if (!vaultRoot) return Promise.resolve();
  const payload: SentinelPayload = { dirtyAt: Date.now() };
  if (pendingPaths && pendingPaths.length > 0) {
    payload.pendingPaths = [...pendingPaths];
  }
  return withSentinelLock(async () => {
    try {
      // Phase 31 A1.6 — the sentinel is load-bearing for crash recovery.
      // A silently-failed write (envelope `{ success: false }`) leaves
      // the user exposed: the next crash before save lands would have no
      // recovery breadcrumb. `invokeOk` surfaces the failure as a thrown
      // IpcEnvelopeError so the catch below reports it via errorBus.
      await invokeOk(
        'vault:write-file-text',
        vaultRoot,
        DIRTY_SENTINEL_PATH,
        JSON.stringify(payload),
      );
    } catch (err) {
      reportError(
        'dirtyFlag.mark',
        err,
        'Could not write the crash-recovery sentinel — a crash before save lands may lose data without warning',
      );
    }
  });
}

/**
 * Deletes the sentinel file. Called once the last pending write has
 * completed successfully. Absence of the sentinel is the "all clean"
 * state; we don't need to distinguish "never dirty" from "cleaned up".
 */
export function markClean(vaultRoot: string): Promise<void> {
  if (!vaultRoot) return Promise.resolve();
  return withSentinelLock(async () => {
    try {
      const { join } = await pathJoin();
      const fullPath = join(vaultRoot, DIRTY_SENTINEL_PATH);
      // Phase 31 A1.6 — invokeOk surfaces { ok:false } as a thrown
      // IpcEnvelopeError; we swallow ENOENT (sentinel already gone)
      // but escalate EACCES/EBUSY/etc so the user knows their "clean"
      // state didn't actually land on disk.
      try {
        await invokeOk('vault:delete', vaultRoot, fullPath);
      } catch (err) {
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
          // Already gone — that's the desired terminal state.
          return;
        }
        throw err;
      }
    } catch (err) {
      // Treat the thrown form of ENOENT the same way (some main-side
      // handlers historically threw rather than returning an envelope).
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return;
      }
      reportError(
        'dirtyFlag.clean',
        err,
        'Could not delete the crash-recovery sentinel — a phantom recovery prompt may appear on next vault open',
      );
    }
  });
}

/**
 * Reads the sentinel to determine whether the previous session ended with
 * unflushed writes. Called once on vault open.
 *
 * Two failure modes are deliberately split. ENOENT (sentinel missing) is the
 * "all clean" path — the last session shut down without a pending write. Any
 * OTHER read failure (EACCES, IO_ERROR, the IPC itself throwing) means the
 * sentinel is unreadable: we can't prove the previous session was clean, so
 * we flag `needsRecovery: true` with `reason: 'sentinel-unreadable'` and
 * surface a toast so the user knows to investigate manually. The original
 * code lumped both branches into `needsRecovery: false`, which silently
 * skipped recovery the moment Filo couldn't see its own sentinel.
 */
export async function checkRecovery(vaultRoot: string): Promise<RecoveryStatus> {
  if (!vaultRoot) return { needsRecovery: false };
  let content: string;
  try {
    // Phase 37 / 37.6 — canonical two-arg form. `pathJoin` no longer needed
    // here because the IPC handler resolves the relative path against the
    // active vaultRoot.
    // Phase 1 (CONSOLIDATION_PLAN) — invokeOk; ENOENT means the previous
    // session shut down cleanly (no pending writes). Any other failure
    // means we couldn't prove cleanliness — surface it and snapshot the
    // (unreadable) sentinel for forensic recovery.
    const result = await invokeOk('vault:read-file-text', vaultRoot, DIRTY_SENTINEL_PATH);
    content = result.content;
  } catch (err) {
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      return { needsRecovery: false };
    }
    reportError(
      'dirtyFlag.check',
      err,
      "Couldn't read the crash-recovery sentinel — Filo can't verify the previous session shut down cleanly",
    );
    // Phase 31 A2.4 — defensive: copy the raw sentinel bytes into
    // `.filo/recovery/<ts>/.dirty` before any session-side markDirty
    // overwrites the file. The renderer-side read failed (likely EACCES
    // or EBUSY) but the main-side `fs.copyFile` may still succeed if the
    // lock was momentary, or if the user can chmod the file later.
    // allow-envelope-bare: defensive best-effort snapshot — the user already
    // got an explicit toast (`dirtyFlag.check` reportError above); if the
    // snapshot ALSO fails we don't want to escalate.
    void window.filo.invoke('recovery:snapshot', vaultRoot, DIRTY_SENTINEL_PATH)
      .catch(() => { /* best-effort; user already saw the toast above */ });
    return { needsRecovery: true, reason: 'sentinel-unreadable' };
  }
  if (!content) {
    // Empty sentinel — treat as cleanly absent. A zero-byte sentinel can
    // happen mid-write; the next sentinel write will repopulate it.
    return { needsRecovery: false };
  }
  try {
    const parsed = JSON.parse(content) as SentinelPayload;
    const pendingPaths = Array.isArray(parsed.pendingPaths)
      ? parsed.pendingPaths.filter((p): p is string => typeof p === 'string')
      : undefined;
    return {
      needsRecovery: true,
      dirtyAt: parsed.dirtyAt,
      ...(pendingPaths && pendingPaths.length > 0 ? { pendingPaths } : {}),
    };
  } catch {
    return { needsRecovery: true };
  }
}

/**
 * Lightweight `path.join` shim for the renderer. We can't `import { join }`
 * from 'path' directly (Node-only), but every platform we ship on uses `/`
 * as a valid separator inside sub-paths, and the vault root already ends
 * without a trailing separator.
 */
async function pathJoin(): Promise<{ join: (...parts: string[]) => string }> {
  return {
    join: (...parts: string[]) =>
      parts
        .filter(Boolean)
        .join('/')
        .replace(/\\/g, '/') // allow-inline-normalize: paired with /\/+/g collapse below
        .replace(/\/+/g, '/'),
  };
}

// Phase 3 (IMPL_PLAN 2026-05-25) — vault-swap reset. The mutex chain
// head holds promises tethered to the outgoing vault's `.filo/.dirty`
// path. A straggling `markDirty` / `markClean` enqueued just before
// swap would otherwise drag the new vault's first sentinel op behind a
// chain that targets a vault root that's no longer active. Resetting
// to a fresh `Promise.resolve()` at pre-swap drops the prior chain.
onVaultSwap('pre-swap', 'dirtyFlagRecovery', () => {
  sentinelMutex = Promise.resolve();
});
