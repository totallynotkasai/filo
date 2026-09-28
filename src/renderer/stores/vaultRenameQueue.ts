/**
 * vaultRenameQueue — the one chain every watcher reconcile runs on.
 *
 * `vault:file-renamed` and `vault:tree-updated` / `vault:files-changed` work
 * is appended here so it runs in arrival order: two renames touching the same
 * `.board.json` can't interleave, and a tree reconcile can't evict a board
 * whose rebind is still queued.
 *
 * The chain belongs to one vault. A task enqueued for a vault that has since
 * been let go is skipped, and so is any task while a vault is being let go
 * (from `retireVaultGeneration` to the next vault's commit): the stores it
 * would read are being reset. The vault store (which owns the swap) resets the
 * chain head once the swap's resets have run.
 */
import { reportError } from '../lib/utils/errorBus';
import { isVaultTearingDown } from '../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault, isVaultRetired } from '../lib/vault/vaultIdentity';

// allow-module-state: the vault store resets it at every swap, and it can't subscribe to the swap it fires
let renameQueue: Promise<unknown> = Promise.resolve();

/**
 * Appends `task`. With `errorContext`, a rejection is reported via
 * `reportError` so listener-driven tasks (which can't await) still surface
 * failures; the returned promise rejects either way. A rejection doesn't
 * break the chain: each task re-reads authoritative state at start.
 */
export function enqueueRenameQueueWork<T>(
  task: () => Promise<T>,
  errorContext?: { label: string; message: string },
): Promise<T | undefined> {
  // Captured at enqueue: resetting the chain head on swap doesn't cancel work
  // already chained on the prior tail, so an outgoing-vault task could
  // otherwise resume against the new vault's cache. Skipping resolves
  // `undefined`, which keeps the chain alive without an error toast.
  const captured = captureVaultIdentity();
  const guardedTask = (): Promise<T | undefined> => {
    if (isVaultRetired() || isVaultTearingDown() || !isStillSameVault(captured)) return Promise.resolve(undefined);
    return task();
  };
  const next = renameQueue.then(guardedTask, guardedTask);
  renameQueue = next.catch(() => undefined);
  if (errorContext) {
    next.catch((err) => {
      reportError(errorContext.label, err, errorContext.message);
    });
  }
  return next;
}

/**
 * Resolves once everything enqueued so far has run. Leaving a vault waits for
 * it before its last unsaved-work check, so a write a reconcile queues (a
 * rebound board path, a tag move) is saved rather than cancelled by the swap.
 * A task that enqueues more work is waited for too (bounded, so a watcher
 * storm can't hold the leave forever).
 */
export async function settleRenameQueue(): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    const tail = renameQueue;
    await tail;
    if (tail === renameQueue) return;
  }
}

/** Drops the chain head (vault swap): the next vault's first task runs on an empty chain. */
export function resetRenameQueue(): void {
  renameQueue = Promise.resolve();
}
