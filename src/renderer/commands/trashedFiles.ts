/**
 * Moving the files a delete command removes into Filo's trash, and back on
 * undo. Commands keep only the trash id of each file, never its content: the
 * file itself waits in `.filo/trash` until undo or Settings → Trash restores
 * it, whatever its type or size.
 */
import type { Command } from './Command';
import { noteStore } from '../stores/notes.svelte';
import { uiStore } from '../stores/ui.svelte';
import { historyStore } from '../stores/history.svelte';
import { registerDeleteUndo, reindexUnder, syncRestoredNotes, syncRestoredTree } from '../stores/trash.svelte';
import { restoreTrashed, trashVaultPath, type DrainToken } from '../lib/vault/vaultOperations';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { whereRestored } from '../lib/vault/restoredItems';
import { reportError } from '../lib/utils/errorBus';

/**
 * Opt-in note delete for a command that removes a task or a card. When the
 * user picks "Delete … and file", the note moves into Filo's trash with it and
 * undo moves it back. Absent these options the command is placement-only and
 * the file stays on disk.
 */
export interface DeleteWithFileOptions {
  /** Vault-relative note to move into Filo's trash with the item. */
  filePath?: string;
  /** Vault root; required when `filePath` is set. */
  vaultRoot?: string;
  /**
   * The drained op the first execute runs inside, if any: its trash move then
   * runs under that drain instead of waiting for the op to finish.
   */
  drain?: DrainToken;
}

/** A file or folder the command moved into Filo's trash. */
export interface TrashedItem {
  /** Vault-relative path it had. */
  rel: string;
  trashId: string;
  /**
   * Where it would be now had it moved with a folder above it renamed since
   * (`commandPaths.ts`); its restore goes there when its own folder is gone.
   */
  movedTo?: string;
}

/** Where a restored item landed: its old path, or beside it when that was taken. */
export interface RestoredItem {
  rel: string;
  restoredPath: string;
}

/**
 * Moves each path into Filo's trash, one after the other. A path already gone
 * is skipped silently (the goal, "not here any more", holds); any other
 * failure is reported and the path stays where it is. `within` is the token of
 * the drained op this runs inside, if any.
 *
 * A caller that must know which paths stayed where they were, and says so
 * itself, passes `refused`: those paths are collected there, not reported.
 */
export async function trashFiles(
  vaultRoot: string,
  rels: string[],
  context: string,
  within?: DrainToken,
  refused?: string[],
): Promise<TrashedItem[]> {
  const identity = captureVaultIdentity();
  const trashed: TrashedItem[] = [];
  const refuse = (rel: string, err: unknown): void => {
    if (refused) refused.push(rel);
    else reportError(context, err, `Couldn't move "${rel}" to Filo's trash; it was not deleted.`);
  };
  for (const rel of rels) {
    if (!isStillSameVault(identity)) break;
    try {
      const result = await trashVaultPath(vaultRoot, rel, within);
      if (result.success) {
        trashed.push({ rel, trashId: result.trashId });
        continue;
      }
      if (result.code === 'ENOENT') continue;
      refuse(rel, new Error(result.error ?? result.code ?? 'vault:trash-move failed'));
    } catch (err) {
      refuse(rel, err);
    }
  }
  if (!isStillSameVault(identity)) return trashed;
  for (const item of trashed) {
    // Nothing queued for these notes may recreate them, and their open views
    // show them as missing.
    noteStore.forgetDeleted(item.rel);
    await reindexUnder(item.rel);
  }
  return trashed;
}

/**
 * Moves each trashed item back. An item this session already restored some
 * other way (Settings → Trash) counts as restored where that restore put it,
 * if it is still there; a file that is merely at the old path is not taken for
 * it (it may be a new note of the same name). Returns where each item landed;
 * the others are reported.
 *
 * A caller that puts tiles back passes `nameTaken`: the old paths of items
 * gone from the trash some other way (emptied, or restored on another
 * machine) where another file has the name now are collected there, not
 * reported. A tile put back there would show that other file, and a redo
 * would trash it, so the caller leaves those tiles off and says so
 * (`sayLeftOff`).
 */
export async function restoreFiles(vaultRoot: string, items: TrashedItem[], context: string, nameTaken?: string[]): Promise<RestoredItem[]> {
  const identity = captureVaultIdentity();
  const restored: RestoredItem[] = [];
  const failed: string[] = [];
  for (const item of items) {
    if (!isStillSameVault(identity)) return restored;
    try {
      const result = await restoreTrashed(vaultRoot, item.trashId, item.rel, undefined, item.movedTo);
      if (result.success) {
        restored.push({ rel: item.rel, restoredPath: result.restoredPath });
        continue;
      }
      if (result.code === 'TRASH_ITEM_MISSING') {
        const landed = whereRestored(item.trashId);
        const back = landed ? await window.filo.invoke('vault:file-exists', vaultRoot, landed).catch(() => false) : false;
        if (landed && back) {
          restored.push({ rel: item.rel, restoredPath: landed });
          continue;
        }
        failed.push(item.rel);
        if (nameTaken && (await window.filo.invoke('vault:file-exists', vaultRoot, item.rel).catch(() => false))) {
          nameTaken.push(item.rel);
          continue;
        }
        uiStore.toast(`"${item.rel}" is no longer in Filo's trash, so it wasn't brought back.`, 'warning', 6000);
        continue;
      }
      failed.push(item.rel);
      reportError(context, new Error(result.error ?? result.code ?? 'vault:trash-restore failed'), `Couldn't restore "${item.rel}" from Filo's trash.`);
    } catch (err) {
      failed.push(item.rel);
      reportError(context, err, `Couldn't restore "${item.rel}" from Filo's trash.`);
    }
  }
  if (!isStillSameVault(identity)) return restored;
  if (restored.length > 0) {
    const rels = restored.map((r) => r.restoredPath);
    await syncRestoredNotes(rels);
    // The command puts its tiles back as soon as this returns; the sidebar
    // tree catches up in turn with the watcher's queue, which can be busy
    // (a big rename elsewhere) and must not hold the tiles back.
    void syncRestoredTree(rels, identity).catch((err: unknown) => {
      reportError(context, err, "The restored files are back, but the sidebar couldn't show them yet. It shows them after its next refresh.");
    });
  }
  const moved = restored.filter((r) => r.restoredPath !== r.rel);
  if (moved.length > 0) {
    uiStore.toast(
      `Restored beside ${moved.length === 1 ? 'a file' : `${moved.length} files`} now using the old name: ${moved.map((m) => `"${m.restoredPath}"`).join(', ')}.`,
      'info',
      6000,
    );
  }
  return restored;
}

/** Tells the user which items an undo left off, because their file's name is another file's now. */
export function sayLeftOff(paths: readonly string[], what: string): void {
  if (paths.length === 0) return;
  const names = paths.map((p) => `"${p}"`).join(', ');
  const one = paths.length === 1;
  uiStore.toast(
    `${names} ${one ? 'is' : 'are'} no longer in Filo's trash, and another file has ${one ? 'that name' : 'those names'} now, so ${one ? `its ${what} was` : `their ${what}s were`} left off.`,
    'warning',
    8000,
  );
}

// allow-module-state: keyed by command objects, which leave with the history at a vault swap
const offeredToTrashList = new WeakSet<Command>();

/**
 * Lets Settings → Trash restore what a board's own delete moved to the trash
 * (a tile, card or task deleted with its file) through that delete's undo,
 * while it is still in the history, so the tile comes back with its file, as
 * a sidebar delete's does. `trashIds` names the entries its files are in now,
 * and `alsoBack` what else comes back ("its card"); a command calls this after
 * each move into the trash, and is offered once.
 */
export function offerUndoToTrashList(command: Command, trashIds: () => string[], alsoBack: string): void {
  if (offeredToTrashList.has(command) || trashIds().length === 0) return;
  offeredToTrashList.add(command);
  registerDeleteUndo({
    trashIds,
    alsoBack,
    undo: async () => (await historyStore.undoStep(command, `Undo ${command.description}`)) && trashIds().length === 0,
    inHistory: () => historyStore.holds(command),
  });
}

/**
 * The items `restoreFiles` did not bring back. A command keeps their trash ids,
 * so the file is still findable by a later undo (after a redo) instead of
 * being forgotten while it waits in the trash.
 */
export function stillTrashed(items: TrashedItem[], restored: RestoredItem[]): TrashedItem[] {
  const back = new Set(restored.map((r) => r.rel));
  return items.filter((item) => !back.has(item.rel));
}

/** `path` with its `from` prefix (a file, or a folder above it) replaced by `to`. */
export function retargetPath(path: string, from: string, to: string): string {
  if (from === to) return path;
  const lower = path.toLowerCase();
  const fromLower = from.toLowerCase();
  if (lower === fromLower) return to;
  if (lower.startsWith(`${fromLower}/`)) return to + path.slice(from.length);
  return path;
}
