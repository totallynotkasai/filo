import type { VaultContext } from './vaultStoreTypes';
import { markClean } from '../lib/vault/dirtyFlagRecovery';

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
     */
    async acknowledgeRecovery(): Promise<void> {
      ctx.setRecoveryPendingPaths([]);
      const vaultRoot = ctx.getVaultPath();
      if (vaultRoot) await markClean(vaultRoot);
      // Phase 3 / 3.3 — signal the recovery sequencer (if any) so the next
      // pending sentinel can surface. No-op when no sequencer is waiting.
      ctx.resolveRecoveryDismissed();
    },
  };
}
