/**
 * A board file changed outside Filo while Filo has unsaved changes to it: one
 * prompt per board path, whichever side notices first (the watcher, or the
 * board writer's drift check before a save), and one set of actions.
 *
 *  - Reload: the pending write is cancelled and the board is read from disk
 *    into the cache (the load re-stamps the drift baseline), so the next save
 *    builds on the other program's version.
 *  - Keep local: the other version is copied to `.filo/recovery/` and the
 *    baseline moves to it, so the next save writes Filo's version without
 *    asking again.
 *  - Dismissed: nothing is written; the next save asks again.
 */
import { uiStore } from './ui.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { boardStore } from './board.svelte';
import { historyStore } from './history.svelte';
import { vaultStore } from './vault.svelte';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { cancelBoardWrite } from '../lib/boards/boardSaver';
import { loadBoard } from '../lib/boards/boardLoader';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { backupExternalVersion } from '../lib/vault/keepLocalBackup';
import { baselineSeq, noteBaseline } from '../lib/vault/fileBaselineRegistry';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { samePath } from '../lib/utils/path';

export type BoardDriftChoice = 'reload' | 'keep-local' | 'defer';

/**
 * In-flight prompt registry. While a Reload / Keep-local toast is open for
 * `path`, every concurrent caller awaits the SAME Promise so a save storm
 * doesn't stack duplicate toasts. Cleared when the promise settles, so a later
 * external edit + write race opens a fresh prompt.
 *
 * Reset on vault swap so a stale unresolved entry can't block a fresh prompt
 * for the same path in the new vault.
 */
const inFlightDriftPrompts = new Map<string, Promise<BoardDriftChoice>>();
vaultSwapResettable('vaultExternalChanges.inFlightDriftPrompts', () => inFlightDriftPrompts.clear());
/** `resolveBoardDrift` in progress per path: one answer, carried out once. */
const inFlightResolutions = new Map<string, Promise<BoardDriftChoice>>();
vaultSwapResettable('boardDrift.inFlightResolutions', () => inFlightResolutions.clear());
// On rename, move an in-flight prompt to the new key so it isn't stranded under
// the old one and a post-rename save doesn't open a duplicate prompt.
registerPathRenamable('vaultExternalChanges.inFlightDriftPrompts', (oldRel, newRel) => {
  const inflight = inFlightDriftPrompts.get(oldRel);
  if (inflight === undefined) return;
  inFlightDriftPrompts.delete(oldRel);
  inFlightDriftPrompts.set(newRel, inflight);
});

/**
 * The Reload / Keep-local question for a board changed outside Filo. Only
 * asks: `resolveBoardDrift` acts on the answer.
 *
 * Promise-backed toast: 15s cap (never sticky); a timeout or dismiss resolves
 * 'defer' so the paused write aborts instead of stranding.
 */
export function promptBoardExternalEdit(args: { path: string }): Promise<BoardDriftChoice> {
  const { path } = args;
  // A save storm produces ONE toast + ONE decision.
  const existing = inFlightDriftPrompts.get(path);
  if (existing) return existing;

  const promise = new Promise<BoardDriftChoice>((resolve) => {
    uiStore.pushToast({
      text:
        `"${path}" was changed outside Filo while you had unsaved changes to it. Reload it (your changes since the ` +
        'last save are dropped), or keep your version (the other one is copied to .filo/recovery/ first)?',
      type: 'warning',
      duration: 0,
      // Dismissed: the writer aborts without touching disk OR cache; the next
      // save asks again.
      onDismiss: () => resolve('defer'),
      actions: [
        { label: 'Reload', handler: () => resolve('reload') },
        {
          label: 'Keep local',
          // allow-keep-local-no-backup: resolves to resolveBoardDrift, whose keepLocalVersion backs up first
          handler: () => resolve('keep-local'),
        },
      ],
    });
  });

  inFlightDriftPrompts.set(path, promise);
  void promise.finally(() => {
    if (inFlightDriftPrompts.get(path) === promise) inFlightDriftPrompts.delete(path);
  });
  return promise;
}

/** Test-only: a view of the in-flight prompt registry. */
export function __inFlightDriftPromptsForTests(): {
  size: number;
  has: (path: string) => boolean;
} {
  return {
    size: inFlightDriftPrompts.size,
    has: (path: string) => inFlightDriftPrompts.has(path),
  };
}

/** The cached board whose file is `rel`. */
export function findBoardIdForPath(rel: string): string | null {
  for (const [boardId, boardPath] of Object.entries(boardStore.paths)) {
    // Case-insensitive, separator-agnostic: an externally-edited `.board.json`
    // whose OS-reported casing differs from the stored casing must still match.
    if (samePath(boardPath, rel)) return boardId;
  }
  return null;
}

/**
 * Reads the board from disk into the cache in place of Filo's copy:
 * 'reloaded', or 'failed' when it couldn't (the file is locked, missing,
 * invalid) and Filo's copy stands.
 *
 * `guardPending` (the silent reconciler path) gives up with 'pending' when a
 * write for the board is pending once the read is back: an edit made during
 * the read is not dropped without asking.
 */
export async function reloadBoardFromDisk(
  rel: string,
  boardId: string,
  opts: { guardPending?: () => boolean } = {},
): Promise<'reloaded' | 'failed' | 'pending'> {
  // Capture vault identity before the async load, so a swap during it can't
  // merge the outgoing vault's board into the new vault's cache.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return 'failed';
  const result = await loadBoard(vaultRoot, rel);
  if (!isStillSameVault(captured)) return 'failed';
  if (!result.ok) {
    // Name the reason (a lock / offline placeholder is not a corrupt file)
    // and say what happens next.
    const reason =
      result.error === 'locked' ? 'the file is locked by another program'
        : result.error === 'offline' ? 'the file is online-only and could not be downloaded'
          : result.error === 'not-found' ? 'the file is missing'
            : `load failed: ${result.error}`;
    reportError(
      'externalChange.board',
      new Error(`${result.error}: ${result.message}`),
      `External change to "${rel}" couldn't be applied (${reason}). Filo's copy is unchanged; it will try again on the next change.`,
    );
    return 'failed';
  }
  if (opts.guardPending?.()) return 'pending';
  // The user chose the disk version (or had no unsaved changes): a queued
  // write of Filo's copy must not land on top of it.
  cancelBoardWrite(boardId, rel);
  // Rebind the stored path to the OS-reported casing. After a case-only
  // external rename the stale casing could later make a tree reconcile treat
  // the board as missing and evict it. `renameBoardPath` no-ops when the path
  // is byte-identical.
  const storedPath = boardStore.paths[boardId];
  if (storedPath) boardCacheStore.renameBoardPath(storedPath, rel);
  boardCacheStore.replaceCache({ ...boardStore.cache, [boardId]: result.data });
  // The board's undo steps were built on the version just replaced: undoing
  // one would write its old snapshot over the other change, with no drift
  // prompt (the load re-stamped the baseline). Tell the user only when there
  // was something to undo.
  if (historyStore.clearBoard(boardId) > 0) {
    uiStore.pushToast({
      text: `Undo history for "${boardNameOf(result.data, rel)}" was cleared because the board changed outside Filo.`,
      type: 'info',
      duration: 6000,
      dedupeKey: `board-reload-history:${boardId}`,
    });
  }
  return 'reloaded';
}

/** The board's name for a message: its name, else its file stem. */
function boardNameOf(data: { board?: { name?: string } }, rel: string): string {
  const name = data.board?.name;
  if (name) return name;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(/\.board\.json$/i, '');
}

/**
 * Keep local: copy the other version, then move the baseline to it, so the
 * next save writes Filo's version without asking again. False when there is
 * no copy and the user declined to overwrite without one.
 */
async function keepLocalVersion(rel: string): Promise<boolean> {
  const identity = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return false;
  const seq = baselineSeq(rel);
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    stat = await invokeOk('vault:stat', vaultRoot, rel);
  } catch {
    stat = null;
  }
  if (!(await backupExternalVersion(vaultRoot, rel))) return false;
  if (!isStillSameVault(identity)) return false;
  if (stat) noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
  return true;
}

/**
 * Asks once for `rel` and carries out the answer. Resolves to what happened:
 * 'reload' only when the board was read from disk, 'keep-local' only when
 * the other version was copied; otherwise 'defer' (nothing changed).
 */
export function resolveBoardDrift(rel: string): Promise<BoardDriftChoice> {
  // The watcher and the writer can both ask about one change: one answer, carried out once.
  const existing = inFlightResolutions.get(rel);
  if (existing) return existing;
  const resolution = (async (): Promise<BoardDriftChoice> => {
    const choice = await promptBoardExternalEdit({ path: rel });
    if (choice === 'reload') {
      const boardId = findBoardIdForPath(rel);
      return boardId && (await reloadBoardFromDisk(rel, boardId)) === 'reloaded' ? 'reload' : 'defer';
    }
    if (choice === 'keep-local') return (await keepLocalVersion(rel)) ? 'keep-local' : 'defer';
    return 'defer';
  })();
  inFlightResolutions.set(rel, resolution);
  void resolution.finally(() => {
    if (inFlightResolutions.get(rel) === resolution) inFlightResolutions.delete(rel);
  });
  return resolution;
}
