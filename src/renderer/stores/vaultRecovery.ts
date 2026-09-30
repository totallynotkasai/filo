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
    /** @internal test-only */
    clearRecoveryPendingPaths(): void {
      ctx.setRecoveryPendingPaths([]);
    },

    /**
     * User acknowledgement of the Recovery modal. Drops the pending-paths
     * list AND clears the on-disk `.filo/.dirty` sentinel. Safe to call more
     * than once (the second call no-ops).
     *
     * Clears via `syncSentinelIfIdle`, not an unconditional `markClean`: a
     * write still pending when the modal is acknowledged must keep its
     * breadcrumb. It markCleans iff the write tracker is idle, else re-marks
     * dirty with this session's remaining paths.
     */
    async acknowledgeRecovery(): Promise<void> {
      ctx.setRecoveryPendingPaths([]);
      const vaultRoot = ctx.getVaultPath();
      if (vaultRoot) {
        syncSentinelIfIdle(vaultRoot);
        // `syncSentinelIfIdle` enqueues its markClean/markDirty fire-and-forget
        // on the sentinel mutex; await the tail so the dismiss is reflected on
        // disk before we resolve.
        await flushDirtyFlagSentinel();
      }
      // Signal the recovery sequencer (if any) so the next pending sentinel
      // can surface.
      ctx.resolveRecoveryDismissed();
    },

    /**
     * Bypassed close of the Recovery modal (Esc / X / backdrop).
     *
     * Un-parks the recovery sequencer so steps 2–4 (tag-rewrite Resume/Discard,
     * rename-cascade retry, snapshot listing) still run this session, but does
     * NOT clear the pending paths or the `.filo/.dirty` sentinel: a bypassed
     * close isn't an acknowledgement (only Dismiss is), so recovery re-queues
     * on the next launch.
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
