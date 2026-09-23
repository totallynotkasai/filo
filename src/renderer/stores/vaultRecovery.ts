import type { VaultContext } from './vaultStoreTypes';
import { syncSentinelIfIdle } from '../lib/boards/writeStateTracking';
import { flushDirtyFlagSentinel } from '../lib/vault/dirtyFlagRecovery';

/**
 * Vault slice — recovery UX state. `recoveryPendingPaths` is populated by
 * `openVault` when the dirty-flag sentinel surfaces orphaned writes; the
 * RecoveryFiles modal reads / clears the list.
 */
export function makeRecoverySlice(ctx: VaultContext) {
  return {
    clearRecoveryPendingPaths(): void {
      ctx.setRecoveryPendingPaths([]);
    },

    /**
     * User acknowledgement of the Recovery modal. Drops the pending-paths
     * list AND clears the on-disk `.filo/.dirty` sentinel.
     *
     * Audit-17 3.3 — EVERY close path of the modal calls this now: the
     * Dismiss button directly, and Esc / backdrop / X via the Modal's
     * `beforeClose` hook in AppShell. The old "Esc preserves the sentinel
     * for next launch" contract was doubly broken: the parked recovery
     * sequencer never resolved (steps 2–4 — tag-rewrite, rename-cascade,
     * snapshot listing — silently skipped for the session), and the
     * session's first scheduled write replaced the sentinel anyway (the
     * pre-commit stash in Audit-17 3.2 is what actually preserves the
     * prior payload now). Safe to call more than once per close — the
     * second call no-ops (paths already cleared, resolver consumed).
     *
     * Audit-14 1.2 — clear via `syncSentinelIfIdle`, NOT an unconditional
     * `markClean`. Every other sentinel-clear gates on the write tracker being
     * idle (no in-flight / pending / failed paths); acknowledging the modal
     * while a write is still pending (e.g. the migration-repair writes that
     * surfaced the prompt, or an edit landing concurrently) must NOT wipe the
     * breadcrumb for that genuinely-unflushed file. `syncSentinelIfIdle`
     * markCleans iff the tracker is idle, else re-marks dirty with the
     * CURRENT session's remaining paths — correctly dropping the acknowledged
     * old paths while preserving any still-pending write.
     */
    async acknowledgeRecovery(): Promise<void> {
      ctx.setRecoveryPendingPaths([]);
      const vaultRoot = ctx.getVaultPath();
      if (vaultRoot) {
        syncSentinelIfIdle(vaultRoot);
        // `syncSentinelIfIdle` enqueues its markClean/markDirty fire-and-forget
        // on the sentinel mutex; await the tail so the disk state has settled
        // before we resolve — preserving the prior `await markClean` semantics
        // (the dismiss deterministically reflects on disk).
        await flushDirtyFlagSentinel();
      }
      // Phase 3 / 3.3 — signal the recovery sequencer (if any) so the next
      // pending sentinel can surface. No-op when no sequencer is waiting.
      ctx.resolveRecoveryDismissed();
    },

    /**
     * Audit-18 4.1 — bypassed close of the Recovery modal (Esc / X / backdrop).
     *
     * UN-PARKS the recovery sequencer so steps 2–4 (tag-rewrite Resume/Discard,
     * rename-cascade retry, snapshot listing) still run this session — that is
     * the part of the Audit-17 3.3 fix this KEEPS — but it does NOT clear the
     * pending-paths list or the on-disk `.filo/.dirty` sentinel, so recovery
     * RE-QUEUES on the next launch.
     *
     * A17-3.3 routed every close path (including Esc/X/backdrop) through
     * `acknowledgeRecovery`, which over-reached: a bypassed close is NOT a user
     * acknowledgement of "I've reviewed these files", so it shouldn't destroy
     * the breadcrumb. Only the explicit Dismiss button does (the comment in
     * `runRecoverySequencer` step 1 — "its Dismiss button is the only 'user
     * acknowledged' signal" — always intended this). This is a NARROWING of
     * A17-3.3, not a reversal: the sequencer is still un-parked so steps 2–4
     * never silently skip again.
     *
     * Idempotent: a second call no-ops (the resolver is consumed on first call).
     */
    bypassRecoveryModalClose(): void {
      // Deliberately NOT touching `recoveryPendingPaths` or the sentinel — the
      // breadcrumb survives so the prior session's unflushed files re-surface
      // next launch (unless this session's first write clears it via the
      // normal `syncSentinelIfIdle` path, which is the correct active-use case).
      ctx.resolveRecoveryDismissed();
    },
  };
}
