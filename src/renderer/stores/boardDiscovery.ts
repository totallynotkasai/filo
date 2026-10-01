/**
 * Runtime board discovery: adopts a `.board.json` that appeared mid-session (a
 * sync client delivering another machine's board, a copy, an external folder
 * rename) or that failed to load at open (OneDrive lock / online-only file),
 * without reopening the vault.
 *
 * `adoptBoardAtRuntime(relPath, captured)` loads one board and merges it into
 * the live stores the same way the vault-open candidate does: cache + path map
 * + `project.boards` + project connections/frames, loader repairs marked dirty,
 * broken-ref detection re-run. A board whose id is already loaded from a
 * DIFFERENT file is not adopted (the duplicate-id notice explains why),
 * unless that file is gone from disk: then the board was renamed by another
 * program without the watcher pairing the two events, and it follows the
 * rename instead.
 *
 * Vault-identity discipline: the load awaits disk; a swap during it must not
 * inject the outgoing vault's board into the new vault's cache, so the function
 * re-checks `isStillSameVault(captured)` after every await. Pinned by
 * `gates:reconciler-vault-guard` Part 3.
 */
import { loadBoard, isTransientBoardLoadError } from '../lib/boards/boardLoader';
import { adoptLoadedBoardBaseline } from '../lib/boards/boardBaseline';
import { announceOlderFormatBoard } from '../lib/boards/migratedBoards';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { promptBoardLoadRetry } from '../lib/boards/boardLoadRetryPrompt';
import { boardLoadReason } from '../lib/boards/boardLoadFailedNotice';
import type { Board } from '../schema/index';
import { samePath } from '../lib/utils/path';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { reportError } from '../lib/utils/errorBus';
import { boardCacheStore } from './boardCache.svelte';
import { vaultStore } from './vault.svelte';
import { uiStore } from './ui.svelte';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { catchUpLoadedBoard, isBoardBeingCreated, markBoardUnloaded } from './unloadedBoards';
import { tabStore } from './tabs.svelte';

export type AdoptOutcome = 'adopted' | 'already' | 'duplicate' | 'renamed' | 'failed';

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
const lastFailure = new Map<VaultPath, { message: string; transient: boolean }>(); // allow-no-rename-transfer: diagnostic only, overwritten on the next attempt

/** The reason the most recent adoption of `relPath` failed (for the Retry prompt). */
export function lastAdoptFailure(relPath: string): { message: string; transient: boolean } | undefined {
  return lastFailure.get(vaultPath(relPath));
}

export interface AdoptOptions {
  /**
   * Don't surface a load failure or a duplicate id (the background tree scan:
   * a board that failed at vault open was already reported there, and the
   * watcher-driven adoption of a NEW file is not quiet).
   */
  quiet?: boolean;
}

export function adoptBoardAtRuntime(
  relPath: string,
  captured: VaultIdentity,
  opts: AdoptOptions = {},
): Promise<AdoptOutcome> {
  const key = `${captured.generation}|${vaultPath(relPath)}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = adoptOnce(relPath, captured, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function adoptOnce(relPath: string, captured: VaultIdentity, opts: AdoptOptions): Promise<AdoptOutcome> {
  const vaultRoot = captured.path;
  if (!vaultRoot || !isStillSameVault(captured)) return 'failed';
  if (findLoadedBoardIdForPath(relPath)) return 'already';
  // Filo is creating it: the create registers it, and its bytes may not be a board yet.
  if (isBoardBeingCreated(relPath)) return 'already';

  const result = await loadBoard(vaultRoot, relPath);
  if (!isStillSameVault(captured)) return 'failed';
  if (!result.ok) {
    // A create that began during the read: that read saw the empty reservation.
    if (isBoardBeingCreated(relPath)) return 'already';
    const transient = isTransientBoardLoadError(result.error);
    lastFailure.set(vaultPath(relPath), { message: boardLoadReason(result.error, result.message), transient });
    markBoardUnloaded(relPath, boardLoadReason(result.error, result.message));
    // A transient failure is re-offered by the caller's Retry prompt; anything
    // else (parse / schema / version) is surfaced once here.
    if (!transient && !opts.quiet) {
      reportError('boardDiscovery', new Error(`${result.error}: ${result.message}`), `Filo couldn't load "${relPath}": ${result.message}`);
    }
    return 'failed';
  }
  lastFailure.delete(vaultPath(relPath));
  // A concurrent adoption / rename rebind may have registered it meanwhile.
  if (findLoadedBoardIdForPath(relPath)) return 'already';

  const { data } = result;
  const id = data.board.id;
  const existingPath = boardCacheStore.paths[id];
  if (existingPath !== undefined) {
    // The loaded board's own file is gone: this is the same board, renamed or
    // moved by another program in a way the watcher reported as a delete plus
    // a create. Follow it like a rename, so it keeps its unsaved edits and tabs
    // rather than vanishing behind a false duplicate-id warning.
    if (await isGoneFromDisk(vaultRoot, existingPath)) {
      if (!isStillSameVault(captured)) return 'failed';
      if (boardCacheStore.paths[id] !== existingPath) return 'already';
      // Queued, not awaited: this may itself run on the rename queue.
      void vaultStore.enqueueRenameQueueWork(() => vaultStore.handleExternalRename(existingPath, relPath), {
        label: 'boardDiscovery.rename',
        message: `Filo couldn't follow the board moved from "${existingPath}" to "${relPath}". Reopen the vault to pick it up.`,
      });
      return 'renamed';
    }
    if (!isStillSameVault(captured)) return 'failed';
    if (opts.quiet) return 'duplicate'; // the background scan: the watcher / open paths notify
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

  // Renames made while it couldn't load are applied before it joins the cache.
  const caughtUp = catchUpLoadedBoard(relPath, data) > 0;
  boardCacheStore.replaceCache({ ...boardCacheStore.cache, [id]: data });
  boardCacheStore.replacePaths({ ...boardCacheStore.paths, [id]: relPath });
  adoptLoadedBoardBaseline(relPath, result.baseline);
  if (result.migratedFrom !== null) announceOlderFormatBoard(relPath);
  const project = vaultStore.getProject();
  if (project) {
    project.boards = [...project.boards.filter((b) => b.id !== id), data.board];
    Object.assign(project.connections, data.connections);
    project.frames.push(...data.frames);
  }
  // Mirror commitVaultCandidate: loader repairs (and caught-up renames) are
  // persisted on the next write.
  if (result.orphansPruned || result.boardIdsNormalized || caughtUp) {
    boardCacheStore.markDirty(id);
  }
  vaultStore.recomputeBrokenRefsNow();
  // A tab kept open for it while it couldn't load now shows it.
  tabStore.resolveUnloaded(relPath, data.board);
  return 'adopted';
}

/** True only when the disk says the file isn't there; a failed probe proves nothing. */
async function isGoneFromDisk(vaultRoot: string, relPath: string): Promise<boolean> {
  try {
    return (await window.filo.invoke('vault:file-exists', vaultRoot, relPath)) === false;
  } catch {
    return false;
  }
}

// allow-module-state: per-session record of untracked paths already tried (cleared on vault swap below)
const scanned = new Set<VaultPath>(); // allow-no-rename-transfer: a renamed file is simply a new untracked path
let scanInFlight: Promise<void> | null = null;

vaultSwapResettable('boardDiscovery', () => {
  scanned.clear();
  lastFailure.clear();
  scanInFlight = null;
});

/**
 * Runtime discovery from the tree refresh: adopt every
 * `.board.json` in the tree that no loaded board points at. Each such path is
 * tried ONCE per session (a board that failed at open was already reported;
 * the explicit Retry / sidebar paths call `adoptBoardAtRuntime` directly), and
 * at most one scan runs at a time.
 */
export function adoptUntrackedTreeBoards(treePaths: Iterable<string>, captured: VaultIdentity): Promise<void> {
  if (scanInFlight) return scanInFlight;
  const candidates: string[] = [];
  for (const p of treePaths) {
    if (!p.toLowerCase().endsWith('.board.json')) continue;
    const key = vaultPath(p);
    if (scanned.has(key)) continue;
    if (findLoadedBoardIdForPath(p)) continue;
    // Not marked scanned: once the create settles, the board is loaded (or, if
    // the create failed, the file is worth a try on the next refresh).
    if (isBoardBeingCreated(p)) continue;
    scanned.add(key);
    candidates.push(p);
  }
  if (candidates.length === 0) return Promise.resolve();
  scanInFlight = (async () => {
    try {
      for (const rel of candidates) {
        if (!isStillSameVault(captured)) return;
        await adoptBoardAtRuntime(rel, captured, { quiet: true });
      }
    } finally {
      scanInFlight = null;
    }
  })();
  return scanInFlight;
}

/**
 * The sidebar double-click on a board the session doesn't
 * know (appeared mid-session, or failed to load at open): adopt it, then hand
 * back the board to open. A transient failure re-offers the Retry notice; any
 * other failure / duplicate was already surfaced by the adoption.
 */
export async function adoptAndFindBoard(relPath: string): Promise<Board | undefined> {
  const captured = captureVaultIdentity();
  const outcome = await adoptBoardAtRuntime(relPath, captured);
  // A followed rename runs on the rename queue; wait for it to land.
  if (outcome === 'renamed') await vaultStore.enqueueRenameQueueWork(async () => undefined);
  if (!isStillSameVault(captured)) return undefined;
  const boardId = findLoadedBoardIdForPath(relPath);
  const board = boardId ? vaultStore.getProject()?.boards.find((b) => b.id === boardId) : undefined;
  if (!board && outcome === 'failed') {
    const reason = lastAdoptFailure(relPath);
    if (reason?.transient) promptBoardLoadRetry(captured.path, relPath, reason.message);
  }
  return board;
}
