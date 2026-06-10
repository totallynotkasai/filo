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

const DIRTY_SENTINEL_PATH = '.filo/.dirty';

/**
 * Audit-14 1.3 — per-launch session id, minted ONCE for the lifetime of this
 * renderer process. Stamped into every `.filo/.dirty` payload by `markDirty`
 * and compared in `checkRecovery`.
 *
 * Why: opening a vault that triggers a migration repair (groupsBackfilled /
 * orphan-prune / boardId-normalize) schedules board writes during the swap,
 * and each `beginWrite` lays down a FRESH `.filo/.dirty` for those repaired
 * paths. `checkRecovery` (which runs just after the commit) then reads a
 * sentinel THIS launch just wrote and — with no session marker — cannot tell
 * it from a genuine prior-crash breadcrumb, surfacing a spurious Recovery
 * modal naming the just-repaired boards. A sentinel whose `launchId` equals
 * `LAUNCH_ID` was written by THIS process, so it is treated as "self, not a
 * prior crash" and suppressed. A prior session's sentinel carries a different
 * id (or none, for legacy/pre-fix sentinels) and still prompts.
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
 * Audit-6 M5 — awaits the tail of the sentinel mutex chain so a fire-and-forget
 * `markClean` / `markDirty` enqueued by `endWrite` (via `syncSentinelIfIdle`)
 * has actually landed on disk before the caller proceeds.
 *
 * The quit path drains every pending write — each terminal `endWrite` enqueues
 * a `markClean` onto `sentinelMutex` — and then immediately sends
 * `app:ready-to-quit`; main destroys the renderer before that still-pending
 * `markClean` IPC flushes, so `.filo/.dirty` survives and the next vault open
 * shows a PHANTOM recovery prompt (the session actually shut down clean).
 * `handleFlushAndQuit` awaits this before signalling ready-to-quit.
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
 * Audit-8 L3 — a locked / read-only share (or a transient AV lock) makes the
 * `.filo/.dirty` sentinel both unreadable AND unclearable, so `checkRecovery`
 * would re-surface the same "sentinel-unreadable" forensic toast (+ snapshot)
 * on EVERY vault open. Track which vault roots have already surfaced it this
 * session and surface ONCE per vault per session. Keyed by `vaultRoot` so
 * distinct vaults stay independent and an A→B→A swap doesn't re-nag. Module-
 * scoped for the whole session; NOT cleared on swap (a re-opened same-path
 * vault should stay quiet). The returned `RecoveryStatus` is unchanged — only
 * the repeat toast/snapshot is suppressed, and the recovery modal already
 * gates the `sentinel-unreadable` reason out, so suppression has no other
 * downstream effect.
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
   * Audit-14 1.3 — the {@link LAUNCH_ID} of the process that wrote this
   * sentinel. Absent on legacy / pre-fix sentinels (treated as a prior
   * session, so they still prompt).
   */
  launchId?: string;
  /**
   * Audit-16 3.3 — the vault-identity generation active when this sentinel
   * was written. The launchId alone over-matched: it suppresses by PROCESS,
   * so a sentinel deliberately PRESERVED across a same-session swap-away
   * (the Don't-Save branch keeps `.filo/.dirty` precisely so reopening the
   * vault surfaces the Recovery modal) — or left by a failed write — was
   * swallowed on an A→B→A or close→reopen in the same session, and the
   * first clean write cycle then destroyed the breadcrumb permanently.
   * Suppression now requires BOTH the launchId and the generation of the
   * CURRENT open to match, scoping it to "written during this very vault
   * open" (the migration-repair case 1.3 actually targeted). Absent on
   * legacy sentinels (prompt, as before).
   */
  vaultGeneration?: number;
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
  // Audit-14 1.3 — stamp the per-launch session id so `checkRecovery` can tell
  // a sentinel THIS process wrote (e.g. a migration-repair write during open)
  // from a genuine prior-crash breadcrumb. Audit-16 3.3 — pair it with the
  // vault-identity generation so the suppression is scoped to this vault OPEN,
  // not the whole process (see SentinelPayload.vaultGeneration).
  const payload: SentinelPayload = {
    dirtyAt: Date.now(),
    launchId: LAUNCH_ID,
    vaultGeneration: currentVaultGeneration(),
  };
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
      // allow-direct-write: `.filo/.dirty` is a one-shot crash-recovery
      // sentinel, not a `.md` file — no editor hydrates from it.
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
    // Audit-8 L3 — surface the forensic toast + snapshot only on the FIRST
    // unreadable open for this vault this session (see
    // `surfacedUnreadableSentinel`); a read-only share can't self-heal, so an
    // unguarded toast nags on every open.
    if (shouldSurfaceUnreadableSentinel(vaultRoot)) {
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
    }
    return { needsRecovery: true, reason: 'sentinel-unreadable' };
  }
  if (!content) {
    // 6.4.M5 — a zero-byte `.filo/.dirty` is evidence of a crash that
    // interrupted `markDirty` between the create-empty-file step and the
    // JSON-payload write. The legacy code treated it as "cleanly absent",
    // silently hiding the crash. Treat as dirty with the same reason flag
    // as a sentinel-unreadable EACCES so the recovery UI surfaces the
    // "investigate manually" copy. No `dirtyAt` available — that's the
    // signal the recovery handler uses to detect the truncated case.
    //
    // Audit-7 M4 — the `sentinel-unreadable` reason is GATED OUT of the
    // recovery modal in `openVault` (`reason !== 'sentinel-unreadable'`), so
    // without a toast here the strongest mid-write-crash signal (the exact
    // case 6.4.M5 added) reached neither the modal nor any notification. Emit
    // a `reportError` so it routes through the same errorBus toast the EACCES
    // branch above uses — the user at least learns the previous session may
    // not have shut down cleanly.
    //
    // Audit-8 L3 — on a writable volume `markClean` deletes the sentinel on the
    // next edit/close so this surfaces once anyway, but a read-only share can't
    // clear it; the per-session/per-vault guard keeps the repeat quiet there too.
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
    // Audit-14 1.3 — a sentinel stamped with THIS launch's id was written by
    // the current process (e.g. a migration-repair write during the open that
    // is about to call us), not a prior crash. Suppress the prompt. A prior
    // session's sentinel carries a different id, and a legacy/pre-fix sentinel
    // carries none — both fall through and prompt as before.
    //
    // Audit-16 3.3 — the launchId must ALSO carry the CURRENT open's vault
    // generation. The repair writes that 1.3 targets fire after
    // `commitVaultCandidate`'s `beginVaultGeneration`, i.e. inside the same
    // open that is now calling checkRecovery, so they match. A sentinel
    // preserved by the Don't-Save swap-away (or left by a failed write)
    // carries an EARLIER generation — same process, different open — and
    // must prompt: it is the documented breadcrumb contract for "reopening
    // the outgoing vault surfaces the Recovery modal".
    if (
      parsed.launchId !== undefined
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
 * Test-only — the current process's {@link LAUNCH_ID}. Lets the 1.3 unit test
 * assert `markDirty` stamps it and craft a "prior session" sentinel with a
 * deliberately different id. Production code never needs this.
 */
export function __getLaunchIdForTests(): string {
  return LAUNCH_ID;
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
// chain that targets a vault root that's no longer active.
//
// G1 — but resetting straight to a fresh `Promise.resolve()` ORPHANS an
// in-flight `markClean(previousVault)`: `writeStateTracking.resetWriteTracking`
// (the `writeStateTracking` pre-swap handler, which `runAfter` orders before
// this one) enqueues that markClean onto `sentinelMutex` on the Save branch.
// If we drop the chain head, the NEXT vault's first `markDirty` enqueues on
// the fresh chain and can race the still-running markClean — on a reopened
// SAME-PATH vault the markClean would delete the new session's freshly-written
// `.filo/.dirty`, masking a real crash. So await the current tail until the
// chain is quiescent, THEN reset. The await costs one in-flight IPC delete
// (~ms); correctness wins over the prior fire-and-forget latency saving.
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
