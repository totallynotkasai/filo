/**
 * Folder pins: the vault-wide Root Directory (`general.activeRootFolder`) and
 * each board's `settings.defaultFolder`. Both name a folder by vault-relative
 * path, so a rename of that folder (or one above it) must carry them along,
 * and a delete must clear them; otherwise the next file created through the
 * pin recreates the old folder via `mkdir -p`. The path rules live in
 * `folderPinPaths.ts`.
 */

import { boardStore } from '../../stores/board.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import type { FileTreeNode } from '../../../shared/types';
import { normalizePath, samePath, stripLeadingSlash } from '../utils/path';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { directoryExistsInTree, flattenTreePaths } from './vaultTreeSort';
import { folderMoveOfFileRename, pinIsUnder, rebasePin } from './folderPinPaths';

interface GeneralWithRoot {
  activeRootFolder?: string;
}

/** Every pin currently set: the Root Directory and each cached board's folder. */
export function allPins(general: GeneralWithRoot | undefined): string[] {
  const pins: string[] = [];
  if (general?.activeRootFolder) pins.push(general.activeRootFolder);
  for (const data of Object.values(boardStore.cache)) {
    const pin = (data.board as { settings?: { defaultFolder?: string } }).settings?.defaultFolder;
    if (pin) pins.push(pin);
  }
  return pins;
}

/**
 * Carries every pin under `oldFolder` over to `newFolder`: the Root Directory
 * (then `markMetaDirty`, which saves `app.json`) and each cached board's
 * `defaultFolder` (the board is marked dirty). Returns what moved, so the
 * caller can name those boards in its rename-cascade sentinel and flush
 * `app.json` before clearing it.
 */
export function followRenameInPins(
  general: GeneralWithRoot | undefined,
  markMetaDirty: () => void,
  oldFolder: string,
  newFolder: string,
): { rootMoved: boolean; boardIds: string[] } {
  let rootMoved = false;
  if (general?.activeRootFolder) {
    const next = rebasePin(general.activeRootFolder, oldFolder, newFolder);
    if (next !== null && next !== general.activeRootFolder) {
      general.activeRootFolder = next;
      markMetaDirty();
      rootMoved = true;
    }
  }
  const boardIds = boardStore.clearBoardDefaultFolderIfMatches(oldFolder, newFolder);
  return { rootMoved, boardIds };
}

/**
 * A pin a delete cleared: a board's folder pin, or the Root Directory when
 * `boardId` is null. The field is named `defaultFolder` so a command holding
 * it follows renames (`PATH_FIELDS`).
 */
export interface ClearedPin {
  boardId: string | null;
  defaultFolder: string;
}

/** The pins at or under `folder` (vault-relative), before a delete clears them. */
export function pinsUnder(general: GeneralWithRoot | undefined, folder: string): ClearedPin[] {
  const out: ClearedPin[] = [];
  if (general?.activeRootFolder && pinIsUnder(general.activeRootFolder, folder)) {
    out.push({ boardId: null, defaultFolder: general.activeRootFolder });
  }
  for (const [boardId, data] of Object.entries(boardStore.cache)) {
    const pin = (data.board as { settings?: { defaultFolder?: string } }).settings?.defaultFolder;
    if (pin && pinIsUnder(pin, folder)) out.push({ boardId, defaultFolder: pin });
  }
  return out;
}

/**
 * Puts back pins a delete cleared (its move failed, or it was undone). A pin
 * the user set to something else meanwhile is left alone.
 */
export function restoreClearedPins(
  pins: readonly ClearedPin[],
  general: GeneralWithRoot | undefined,
  markMetaDirty: () => void,
): void {
  for (const { boardId, defaultFolder } of pins) {
    if (boardId === null) {
      if (general && !general.activeRootFolder) {
        general.activeRootFolder = defaultFolder;
        markMetaDirty();
      }
      continue;
    }
    const settings = (boardCacheStore.cache[boardId]?.board as { settings?: { defaultFolder?: string } } | undefined)?.settings;
    if (!boardCacheStore.cache[boardId] || settings?.defaultFolder) continue;
    boardCacheStore.updateBoardSettings(boardId, { ...settings, defaultFolder });
  }
}

/** No pin moved. */
export const NO_PIN_MOVES: { rootMoved: boolean; boardIds: string[] } = { rootMoved: false, boardIds: [] };

/**
 * The folder move behind a file rename made by another program, when a pin
 * sits in that folder and the disk confirms it: the old folder is gone and
 * the new one exists. Moving one file between two folders that both remain
 * gives the same paths, and must leave the pins alone. A case-only rename
 * (`notes` → `Notes`) is the same folder, so it needs no probe. `null` when
 * no pin is involved or a probe fails.
 */
export async function confirmedFolderMove(
  vaultRoot: string,
  oldRel: string,
  newRel: string,
  pins: readonly string[],
): Promise<{ oldFolder: string; newFolder: string } | null> {
  const move = folderMoveOfFileRename(oldRel, newRel);
  if (!move || !pins.some((pin) => pinIsUnder(pin, move.oldFolder))) return null;
  if (samePath(move.oldFolder, move.newFolder)) return move;
  try {
    const [oldExists, newExists] = await Promise.all([
      window.filo.invoke('vault:file-exists', vaultRoot, move.oldFolder),
      window.filo.invoke('vault:file-exists', vaultRoot, move.newFolder),
    ]);
    return oldExists !== true && newExists === true ? move : null;
  } catch {
    return null;
  }
}

/**
 * Clears every pin whose folder is no longer in `tree` (deleted by another
 * program, or moved where no rename could be matched), so the next file
 * created through it doesn't recreate the folder via `mkdir -p`.
 *
 * A board whose own `.board.json` is missing from the tree as well keeps its
 * pin: it is only provisionally missing while Filo looks for a rename (a board
 * folder renamed in Explorer). The rename carries the pin along; a board that
 * really went is evicted with it. Clearing it here would give the board an
 * unsaved change, and a false "unsaved changes" prompt.
 */
export function clearPinsOfMissingFolders(
  tree: FileTreeNode[],
  vaultRoot: string,
  general: GeneralWithRoot | undefined,
  clearRoot: (rel: string) => void,
): void {
  const root = normalizePath(vaultRoot);
  const exists = (pin: string): boolean => directoryExistsInTree(tree, `${root}/${stripLeadingSlash(pin)}`);
  const rootPin = general?.activeRootFolder ?? '';
  if (rootPin && !exists(rootPin)) clearRoot(rootPin);
  let files: Set<VaultPath> | null = null;
  for (const [boardId, data] of Object.entries(boardStore.cache)) {
    const settings = (data.board as { settings?: { defaultFolder?: string } }).settings;
    const pin = settings?.defaultFolder ?? '';
    if (!pin || exists(pin)) continue;
    files ??= new Set([...flattenTreePaths(tree, vaultRoot)].map((p) => vaultPath(p)));
    const boardPath = boardStore.paths[boardId];
    if (!boardPath || !files.has(vaultPath(boardPath))) continue;
    boardCacheStore.updateBoardSettings(boardId, { ...settings, defaultFolder: '' });
  }
}
