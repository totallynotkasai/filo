/**
 * "Provisionally missing" boards.
 *
 * On Windows, `fs.watch` reports an external FOLDER rename (Explorer, a sync
 * client moving a folder) as just `rename Projects` + `rename Work`: no child
 * events, so no live rename is correlated for the `.board.json` inside. Evicting
 * the board as soon as the tree refresh sees its path missing would discard its
 * pending edit and close its tabs before the reconcile walk pairs
 * `Projects/Plan.board.json → Work/Plan.board.json` seconds later.
 *
 * So a board whose file vanished is only PROVISIONALLY missing:
 *   1. its path is HELD (`holdBoardPath`): a write to it throws
 *      `BoardPathHeldError`, so it is recorded failed (crash sentinel stays
 *      dirty) and RETAINED, instead of `board:save` recreating the old folder;
 *   2. a `vault:reconcile` walk is kicked so the rename gets correlated, and a
 *      re-check is queued on the rename queue once the walk settled (and at
 *      least `RECHECK_GRACE_MS` passed — the fallback when the walk is
 *      throttled);
 *   3. the re-check (`recheckProvisionalBoard`) decides:
 *        - rebound by the reconcile rename → release + re-fire the retained
 *          write to the NEW path (its args read the path at fire time);
 *        - back on disk → release + re-fire;
 *        - still missing with no unsaved write → evict;
 *        - still missing WITH an unsaved write → a sticky prompt: save at the
 *          original location (recreates the file) or discard.
 *
 * Vault identity: both functions take the captured identity and bail after
 * every await (pinned by `gates:reconciler-vault-guard` Part 3).
 */
import {
  holdBoardPath,
  releaseBoardPath,
  boardHasUnsavedWrite,
  retryFailedBoardWrite,
} from '../lib/boards/boardWriteScheduler';
import { clearFailedPathAfterLateSuccess } from '../lib/boards/writeStateTracking';
import { isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { samePath } from '../lib/utils/path';
import { invokeOk } from '../lib/utils/invokeOk';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { boardCacheStore } from './boardCache.svelte';
import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';

export const RECHECK_GRACE_MS = 2000;
const MAX_UNKNOWN_RECHECKS = 3;

type Enqueue = (task: () => Promise<void>) => Promise<unknown>;

/** boardId → the path it went missing at (while the re-check is pending). */
const provisional = new Map<string, string>(); // allow-no-rename-transfer: keyed by boardId, the path is only the evidence being re-checked

vaultSwapResettable('boardProvisionalMissing', () => {
  for (const path of provisional.values()) releaseBoardPath(path);
  provisional.clear();
});

/**
 * Replaces the tree-refresh's immediate eviction. Idempotent per board while a
 * re-check is pending.
 */
export function markBoardProvisionallyMissing(
  boardId: string,
  relPath: string,
  captured: VaultIdentity,
  enqueue: Enqueue,
): void {
  if (provisional.has(boardId)) return;
  provisional.set(boardId, relPath);
  holdBoardPath(relPath);
  // Not awaited inside the rename queue: the walk synthesises the rename events
  // that the queue must process first (awaiting here would deadlock).
  const walk = invokeOk('vault:reconcile').then(
    () => undefined,
    () => undefined, // throttled / failed walk: the grace timer below is the fallback
  );
  const grace = new Promise<void>((resolve) => setTimeout(resolve, RECHECK_GRACE_MS));
  void Promise.all([walk, grace]).then(() =>
    enqueue(() => recheckProvisionalBoard(boardId, relPath, captured, enqueue)),
  );
}

function settle(boardId: string, relPath: string): void {
  provisional.delete(boardId);
  releaseBoardPath(relPath);
}

function evict(boardId: string, relPath: string, vaultRoot: string): void {
  settle(boardId, relPath);
  boardStore.cleanupMissingBoard(boardId);
  // The held write was recorded failed; the board (and its edit) is gone by
  // the user's / the disk's decision, so don't leave a phantom "save failed".
  clearFailedPathAfterLateSuccess(vaultRoot, relPath);
}

export async function recheckProvisionalBoard(
  boardId: string,
  relPath: string,
  captured: VaultIdentity,
  enqueue: Enqueue,
  attempt = 1,
): Promise<void> {
  if (!isStillSameVault(captured) || provisional.get(boardId) !== relPath) return;
  const current = boardCacheStore.paths[boardId];
  if (current === undefined) {
    settle(boardId, relPath); // evicted by another path meanwhile
    return;
  }
  if (!samePath(current, relPath)) {
    // The reconcile rename rebound the board: re-fire its retained write,
    // which now targets the new path.
    settle(boardId, relPath);
    await retryFailedBoardWrite(boardId);
    return;
  }
  let exists: boolean | null;
  try {
    exists = (await window.filo.invoke('vault:file-exists', captured.path, relPath)) === true;
  } catch {
    exists = null;
  }
  if (!isStillSameVault(captured) || provisional.get(boardId) !== relPath) return;
  if (exists === true) {
    settle(boardId, relPath);
    await retryFailedBoardWrite(boardId);
    return;
  }
  if (exists === null) {
    // Can't PROVE it's gone: keep the hold and look again.
    if (attempt < MAX_UNKNOWN_RECHECKS) {
      setTimeout(() => {
        void enqueue(() => recheckProvisionalBoard(boardId, relPath, captured, enqueue, attempt + 1));
      }, RECHECK_GRACE_MS);
      return;
    }
  }
  if (!boardHasUnsavedWrite(boardId)) {
    evict(boardId, relPath, captured.path);
    return;
  }
  promptMissingBoardWithUnsavedChanges(boardId, relPath, captured);
}

function promptMissingBoardWithUnsavedChanges(boardId: string, relPath: string, captured: VaultIdentity): void {
  const name = boardCacheStore.cache[boardId]?.board.name ?? relPath;
  uiStore.pushToast({
    text: `Board "${name}" was moved or deleted outside Filo while it had unsaved changes.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `board-missing:${boardId}`,
    actions: [
      {
        label: 'Save at original location',
        handler: async () => {
          if (!isStillSameVault(captured) || provisional.get(boardId) !== relPath) return;
          settle(boardId, relPath);
          await retryFailedBoardWrite(boardId);
          if (!isStillSameVault(captured)) return;
          await boardCacheStore.flushDirty(boardId);
        },
      },
      {
        label: 'Discard changes',
        handler: () => {
          if (!isStillSameVault(captured) || provisional.get(boardId) !== relPath) return;
          evict(boardId, relPath, captured.path);
        },
      },
    ],
  });
}
