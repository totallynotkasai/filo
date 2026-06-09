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
     * Explicit user acknowledgement of the Recovery modal. Drops the
     * pending-paths list AND clears the on-disk `.filo/.dirty` sentinel.
     *
     * Distinct from `clearRecoveryPendingPaths` because the sentinel must
     * survive Esc / backdrop / X-button closes of the modal — otherwise
     * a user who closes the modal without reading it would silently lose
     * the breadcrumb. Only the explicit "Dismiss" button calls this.
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
  };
}
