/**
 * Audit-19 EXT-1 / ERR-4 — runtime board discovery.
 *
 * `board:list` used to run only at vault open, so a `.board.json` that
 * appeared mid-session (a sync client delivering another machine's board, a
 * copy, an external folder rename) — or one that failed to load at open
 * because OneDrive held a lock / the file was online-only — stayed invisible
 * until the vault was reopened ("reopen the vault" was the only advice).
 *
 * `adoptBoardAtRuntime(relPath, captured)` loads one board and merges it into
 * the live stores the same way the vault-open candidate does: cache + path map
 * + `project.boards` + project connections/frames, loader repairs marked dirty,
 * broken-ref detection re-run. A board whose id is already loaded from a
 * DIFFERENT file is not adopted (the duplicate-id notice explains why).
 *
 * Vault-identity discipline: the load awaits disk; a swap during it must not
 * inject the outgoing vault's board into the new vault's cache, so the function
 * re-checks `isStillSameVault(captured)` after every await. Pinned by
 * `ci:reconciler-vault-guard` Part 3.
 */
import { loadBoard, isTransientBoardLoadError } from '../lib/boards/boardLoader';
import { isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { samePath } from '../lib/utils/path';
import { reportError } from '../lib/utils/errorBus';
import { boardCacheStore } from './boardCache.svelte';
import { vaultStore } from './vault.svelte';
import { uiStore } from './ui.svelte';

export type AdoptOutcome = 'adopted' | 'already' | 'duplicate' | 'failed';

/** The boardId whose stored path matches `rel` (case-folded), or null. */
export function findLoadedBoardIdForPath(rel: string): string | null {
  for (const [boardId, boardPath] of Object.entries(boardCacheStore.paths)) {
    if (samePath(boardPath, rel)) return boardId;
  }
  return null;
}

// Transient in-flight dedupe, keyed by vault GENERATION (an outgoing-vault entry never matches; a rename mid-load just misses it).
// allow-module-state: generation-keyed transient dedupe
const inFlight = new Map<string, Promise<AdoptOutcome>>(); // allow-no-rename-transfer: lives for one load only

// allow-module-state: last failure reason per path, read by the Retry prompt right after the attempt
const lastFailure = new Map<string, { message: string; transient: boolean }>(); // allow-no-rename-transfer: diagnostic only, overwritten on the next attempt

/** The reason the most recent adoption of `relPath` failed (for the Retry prompt). */
export function lastAdoptFailure(relPath: string): { message: string; transient: boolean } | undefined {
  return lastFailure.get(relPath.toLowerCase());
}

export function adoptBoardAtRuntime(relPath: string, captured: VaultIdentity): Promise<AdoptOutcome> {
  const key = `${captured.generation}|${relPath.toLowerCase()}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = adoptOnce(relPath, captured).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function adoptOnce(relPath: string, captured: VaultIdentity): Promise<AdoptOutcome> {
  const vaultRoot = captured.path;
  if (!vaultRoot || !isStillSameVault(captured)) return 'failed';
  if (findLoadedBoardIdForPath(relPath)) return 'already';

  const result = await loadBoard(vaultRoot, relPath);
  if (!isStillSameVault(captured)) return 'failed';
  if (!result.ok) {
    const transient = isTransientBoardLoadError(result.error);
    lastFailure.set(relPath.toLowerCase(), { message: result.message, transient });
    // A transient failure is re-offered by the caller's Retry prompt; anything
    // else (parse / schema / version) is surfaced once here.
    if (!transient) {
      reportError('boardDiscovery', new Error(`${result.error}: ${result.message}`), `Filo couldn't load "${relPath}": ${result.message}`);
    }
    return 'failed';
  }
  lastFailure.delete(relPath.toLowerCase());
  // A concurrent adoption / rename rebind may have registered it meanwhile.
  if (findLoadedBoardIdForPath(relPath)) return 'already';

  const { data } = result;
  const id = data.board.id;
  const existingPath = boardCacheStore.paths[id];
  if (existingPath !== undefined) {
    // Same id already loaded from another file (a copy, or a sync conflict
    // fork that keeps the compound suffix). Never adopt over it and never
    // tell the user which one to delete — both files stay untouched.
    uiStore.pushToast({
      text:
        `Two board files use the same id: "${existingPath}" (loaded) and "${relPath}" (not loaded). ` +
        'Both files are unchanged on disk. To use the other one, open it in a text editor, or rename it and give it a new "id".',
      type: 'warning',
      duration: 0,
      sticky: true,
      dedupeKey: `dup-board:${relPath}`,
    });
    return 'duplicate';
  }

  boardCacheStore.replaceCache({ ...boardCacheStore.cache, [id]: data });
  boardCacheStore.replacePaths({ ...boardCacheStore.paths, [id]: relPath });
  const project = vaultStore.getProject();
  if (project) {
    project.boards = [...project.boards.filter((b) => b.id !== id), data.board];
    Object.assign(project.connections, data.connections);
    project.frames.push(...data.frames);
  }
  // Mirror commitVaultCandidate: loader repairs are persisted on the next write.
  if (result.groupsBackfilled || result.orphansPruned || result.boardIdsNormalized) {
    boardCacheStore.markDirty(id);
  }
  vaultStore.recomputeBrokenRefsNow();
  return 'adopted';
}
