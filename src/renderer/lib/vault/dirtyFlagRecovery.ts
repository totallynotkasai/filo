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
import { createId } from '../utils/ids';
import { currentVaultGeneration } from './vaultIdentity';
import { getMachineIdentity, ownSentinelPath } from './machineIdentity';
import { readOwnSentinel, clearOwnSentinel } from './machineSentinels';

/**
 * The sentinel is PER MACHINE (`.filo/.dirty.<machineId>`): `.filo/` syncs,
 * and a shared name would let machine B's clean shutdown delete machine A's
 * crash breadcrumb.
 */
const ownDirtyPath = (): string => ownSentinelPath('dirty');


/**
 * Per-launch session id, minted ONCE per renderer process, stamped into every
 * sentinel payload and compared in `checkRecovery`. Opening a vault can
 * schedule migration-repair writes that lay down a fresh sentinel before
 * `checkRecovery` runs; without this marker that self-written sentinel would
 * look like a prior crash and raise a spurious Recovery modal.
 */
const LAUNCH_ID = createId();

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

/**
 * Awaits the tail of the sentinel mutex chain so a fire-and-forget
 * `markClean` / `markDirty` enqueued by `endWrite` (via `syncSentinelIfIdle`)
 * has actually landed on disk before the caller proceeds.
 *
 * `handleFlushAndQuit` awaits this before signalling ready-to-quit: otherwise
 * main destroys the renderer before the final `markClean` IPC flushes, and the
 * next vault open shows a phantom recovery prompt.
 *
 * Resolves (never rejects) — the individual sentinel ops already surface their
 * own failures via `reportError`, and a rejected tail must not wedge the quit.
 * Captures the CURRENT tail: a markClean enqueued after this call (none should
 * be, post-drain) is not waited on, which is the intended "flush what's queued
 * now" semantics.
 */
export function flushDirtyFlagSentinel(): Promise<void> {
  return sentinelMutex.then(() => undefined, () => undefined);
}

/**
 * A locked / read-only share makes the sentinel both unreadable AND
 * unclearable, so `checkRecovery` would re-surface the "sentinel-unreadable"
 * toast (+ snapshot) on every vault open. Surface it ONCE per vault root per
 * session (not cleared on swap, so an A→B→A swap doesn't re-nag). Only the
 * repeat toast/snapshot is suppressed; the returned status is unchanged.
 */
const surfacedUnreadableSentinel = new Set<string>();

function shouldSurfaceUnreadableSentinel(vaultRoot: string): boolean {
  if (surfacedUnreadableSentinel.has(vaultRoot)) return false;
  surfacedUnreadableSentinel.add(vaultRoot);
  return true;
}

/** Test-only: clears the per-session unreadable-sentinel dedupe set. */
export function __resetDirtyRecoveryDedupeForTests(): void {
  surfacedUnreadableSentinel.clear();
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
  /**
   * The {@link LAUNCH_ID} of the process that wrote this sentinel. When
   * absent, the sentinel is treated as a prior session's, so it prompts.
   */
  launchId?: string;
  /**
   * The vault-identity generation active when this sentinel was written.
   * Suppression requires BOTH launchId and the CURRENT open's generation to
   * match: launchId alone would also swallow a sentinel deliberately preserved
   * across a same-session swap-away (Don't-Save) or left by a failed write,
   * and the next clean write would destroy that breadcrumb.
   */
  vaultGeneration?: number;
  /** The writing machine (labels a foreign sentinel). */
  machineId?: string;
  hostname?: string;
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
  // Stamp launch id + vault generation so `checkRecovery` can tell a sentinel
  // written during THIS vault open from a prior-crash breadcrumb (see
  // SentinelPayload.vaultGeneration).
  const payload: SentinelPayload = {
    dirtyAt: Date.now(),
    launchId: LAUNCH_ID,
    vaultGeneration: currentVaultGeneration(),
    machineId: getMachineIdentity().machineId,
    hostname: getMachineIdentity().hostname,
  };
  if (pendingPaths && pendingPaths.length > 0) {
    payload.pendingPaths = [...pendingPaths];
  }
  return withSentinelLock(async () => {
    try {
      // The sentinel is load-bearing for crash recovery, so a failed write
      // must not be silent: `invokeOk` throws and the catch reports it.
      // allow-direct-write: `.filo/.dirty` is a one-shot crash-recovery
      // sentinel, not a `.md` file — no editor hydrates from it.
      await invokeOk(
        'vault:write-file-text',
        vaultRoot,
        ownDirtyPath(),
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
      // ENOENT (already gone) is the desired terminal state; EACCES/EBUSY/etc
      // escalate so the user knows "clean" didn't land. Clears only THIS
      // machine's sentinel (main refuses others).
      await clearOwnSentinel(vaultRoot, 'dirty');
    } catch (err) {
      // Treat a thrown ENOENT the same way.
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
 * Pre-commit stash of the prior session's sentinel status.
 *
 * Any write scheduled between commit and `checkRecovery` (e.g. loader-repaired
 * boards) REPLACES the on-disk sentinel with this session's pending set,
 * destroying a genuine prior-crash payload — which the self-write suppression
 * would then hide. So the candidate phase reads + stashes the sentinel BEFORE
 * the commit, and `checkRecovery` consumes the stashed copy.
 *
 * The stashed read skips self-write suppression: pre-commit, any sentinel
 * present is a prior session/open's breadcrumb and MUST prompt. (At stash time
 * the generation hasn't been bumped yet, so a Don't-Save-preserved sentinel
 * from a previous open of the SAME path would otherwise still match.)
 */
let stashedPreCommitStatus: { vaultRoot: string; status: RecoveryStatus } | null = null;

/**
 * Reads the sentinel and stashes the result for the next `checkRecovery`
 * call against the same `vaultRoot`. Called by `loadVaultCandidate` right
 * after `vault:init-config` (the registry must be armed for the read IPC).
 * Never rejects — read failures resolve to the `sentinel-unreadable` status
 * exactly as a live `checkRecovery` would.
 */
export async function stashRecoveryStatusBeforeCommit(vaultRoot: string): Promise<void> {
  if (!vaultRoot) return;
  const status = await readRecoveryStatus(vaultRoot, { suppressSelfWrites: false });
  stashedPreCommitStatus = { vaultRoot, status };
}

/** Test-only: drops the pre-commit stash. */
export function __resetRecoveryStashForTests(): void {
  stashedPreCommitStatus = null;
}

/**
 * Reads the sentinel to determine whether the previous session ended with
 * unflushed writes. Called once on vault open.
 *
 * Consumes the pre-commit stash when one exists for this `vaultRoot` (see
 * `stashRecoveryStatusBeforeCommit`); falls back to a live read otherwise.
 * The stash is single-consume and always cleared here so a stale entry from
 * an aborted open can't leak into a later check.
 *
 * ENOENT (sentinel missing) is the "all clean" path. Any OTHER read failure
 * means we can't prove the previous session was clean, so we flag
 * `needsRecovery: true` with `reason: 'sentinel-unreadable'` and toast.
 */
export async function checkRecovery(vaultRoot: string): Promise<RecoveryStatus> {
  const stash = stashedPreCommitStatus;
  stashedPreCommitStatus = null;
  if (stash && stash.vaultRoot === vaultRoot) {
    return stash.status;
  }
  return readRecoveryStatus(vaultRoot, { suppressSelfWrites: true });
}

/**
 * The actual sentinel read. `suppressSelfWrites: true` (the live-read path)
 * applies the launchId/generation suppression so
 * a sentinel written DURING the current open doesn't prompt; the pre-commit
 * stash path passes `false` (see `stashRecoveryStatusBeforeCommit`).
 */
async function readRecoveryStatus(
  vaultRoot: string,
  opts: { suppressSelfWrites: boolean },
): Promise<RecoveryStatus> {
  if (!vaultRoot) return { needsRecovery: false };
  let content: string;
  try {
    // ENOENT means the previous session shut down cleanly. Any other failure
    // means we couldn't prove cleanliness — surface it and snapshot the
    // sentinel. Reads THIS machine's sentinel only; another machine's is never
    // prompted for (its data isn't here).
    const result = await readOwnSentinel(vaultRoot, 'dirty');
    content = result.content;
  } catch (err) {
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      return { needsRecovery: false };
    }
    // Surface the toast + snapshot only on the FIRST unreadable open for this
    // vault this session (see `surfacedUnreadableSentinel`).
    if (shouldSurfaceUnreadableSentinel(vaultRoot)) {
      reportError(
        'dirtyFlag.check',
        err,
        "Couldn't read the crash-recovery sentinel — Filo can't verify the previous session shut down cleanly",
      );
      // Defensive: copy the raw sentinel bytes into
      // `.filo/recovery/<ts>/.dirty` before any session-side markDirty
      // overwrites the file. The renderer-side read failed (likely EACCES
      // or EBUSY) but the main-side `fs.copyFile` may still succeed if the
      // lock was momentary, or if the user can chmod the file later.
      // allow-envelope-bare: defensive best-effort snapshot — the user already
      // got an explicit toast (`dirtyFlag.check` reportError above); if the
      // snapshot ALSO fails we don't want to escalate.
      void window.filo.invoke('recovery:snapshot', vaultRoot, ownDirtyPath())
        .catch(() => { /* best-effort; user already saw the toast above */ });
    }
    return { needsRecovery: true, reason: 'sentinel-unreadable' };
  }
  if (!content) {
    // A zero-byte sentinel means a crash interrupted `markDirty` between
    // creating the file and writing the payload. Treat as dirty with the
    // unreadable reason (no `dirtyAt` marks the truncated case). That reason
    // is gated out of the recovery modal, so the toast is the only surface;
    // it's deduped per vault per session.
    if (shouldSurfaceUnreadableSentinel(vaultRoot)) {
      reportError(
        'dirtyFlag.check',
        new Error('zero-byte .filo/.dirty sentinel (truncated mid-write)'),
        "Filo found a truncated crash-recovery sentinel — it can't verify the previous session shut down cleanly. Check whether any recent edits are missing.",
      );
    }
    return { needsRecovery: true, reason: 'sentinel-unreadable' };
  }
  try {
    const parsed = JSON.parse(content) as SentinelPayload;
    // A sentinel stamped with THIS launch's id AND the current open's vault
    // generation was written during this very open (e.g. a migration-repair
    // write), not a prior crash — suppress. One from an earlier open of the
    // same process (Don't-Save swap-away, failed write) carries an earlier
    // generation and must prompt.
    if (
      opts.suppressSelfWrites
      && parsed.launchId !== undefined
      && parsed.launchId === LAUNCH_ID
      && parsed.vaultGeneration !== undefined
      && parsed.vaultGeneration === currentVaultGeneration()
    ) {
      return { needsRecovery: false };
    }
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
 * Test-only — the current process's {@link LAUNCH_ID}. Lets the unit test
 * assert `markDirty` stamps it and craft a "prior session" sentinel with a
 * deliberately different id. Production code never needs this.
 */
export function __getLaunchIdForTests(): string {
  return LAUNCH_ID;
}

// Vault-swap reset of the mutex chain, so the new vault's first sentinel op
// isn't queued behind ops targeting the outgoing vault.
//
// Await the current tail BEFORE resetting: `writeStateTracking`'s pre-swap
// handler (ordered first via `runAfter`) enqueues a `markClean(previousVault)`.
// Dropping the chain head would let the next vault's first `markDirty` race
// it — on a reopened SAME-PATH vault the markClean could delete the new
// session's fresh sentinel, masking a real crash.
onVaultSwap(
  'pre-swap',
  'dirtyFlagRecovery',
  async () => {
    const tail = sentinelMutex;
    await tail.catch(() => undefined);
    sentinelMutex = Promise.resolve();
  },
  { runAfter: ['writeStateTracking'] },
);
