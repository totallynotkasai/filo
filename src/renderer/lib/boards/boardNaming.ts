/**
 * A board's name and its `.board.json` file name are one value: the file stem
 * is the name, and `board.name` in the JSON is only a copy of it. These are
 * the pure rules for that name and for where a new board's file goes.
 */
import { fileNameProblem, nameTooLong } from '@shared/fileNames';
import { normalizeVaultRelative, normalizePath, stripLeadingSlash, toPosix } from '../utils/path';

export const BOARD_FILE_SUFFIX = '.board.json';

/** The board name a `.board.json` path carries: its file name without the suffix. */
export function boardNameFromPath(relPath: string): string {
  const base = toPosix(relPath).split('/').pop() ?? '';
  return base.toLowerCase().endsWith(BOARD_FILE_SUFFIX)
    ? base.slice(0, base.length - BOARD_FILE_SUFFIX.length)
    : base;
}

/** The folder a vault-relative path sits in ('' for the vault root). */
export function parentFolder(relPath: string): string {
  const posix = stripLeadingSlash(toPosix(relPath));
  const i = posix.lastIndexOf('/');
  return i >= 0 ? posix.slice(0, i) : '';
}

function lastSegment(relPath: string): string {
  return stripLeadingSlash(toPosix(relPath)).split('/').pop() ?? '';
}

function joinRel(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/**
 * Why `name` can't be a board name, or `null` when it can. The name is used
 * verbatim as the file stem, so the file-name rules apply as they are; a
 * name is never quietly changed into one that would differ from what the
 * user typed.
 */
export function boardNameProblem(name: string): string | null {
  const trimmed = name.trim();
  // The file is the name plus `.board.json`, and that whole name has to fit.
  return fileNameProblem(trimmed) ?? (nameTooLong(`${trimmed}${BOARD_FILE_SUFFIX}`) ? 'That name is too long.' : null);
}

/** The vault-relative path of the board file named `name` in `folder`. */
export function boardPathIn(folder: string, name: string): string {
  return joinRel(folder, `${name}${BOARD_FILE_SUFFIX}`);
}

export interface BoardPlaceOptions {
  /** `general.boardFolders`: each new board gets a folder of its own. */
  boardFolders: boolean;
  /** The vault-wide Root Directory, vault-relative ('' for none). */
  rootFolder: string;
}

export interface BoardPlace {
  /** The folder the `.board.json` goes in ('' for the vault root). */
  folder: string;
  /** The `.board.json` itself. */
  path: string;
  /** The folder the board keeps its files in: its own folder, or '' (no pin). */
  defaultFolder: string;
}

/**
 * Where a new board named `name` goes. With board folders on, a folder named
 * after the board inside the Root Directory (or the vault root) holds both
 * the `.board.json` and everything the board creates. With them off, the
 * file goes at the vault root, as it always has.
 */
export function plannedBoardPlace(name: string, opts: BoardPlaceOptions): BoardPlace {
  const trimmed = name.trim();
  if (!opts.boardFolders) {
    return { folder: '', path: boardPathIn('', trimmed), defaultFolder: '' };
  }
  const root = stripLeadingSlash(normalizePath(opts.rootFolder)).replace(/\/+$/, '');
  const folder = joinRel(root, trimmed);
  return { folder, path: boardPathIn(folder, trimmed), defaultFolder: folder };
}

/**
 * The folder that is renamed along with a board renamed from `oldName`: the
 * folder holding its `.board.json`, but only with board folders on and only
 * while that folder is still named after the board. A folder the user has
 * renamed, or the vault root, is left alone. Case-folded, as the file system
 * compares names.
 */
export function folderFollowingRename(
  boardPath: string,
  oldName: string,
  boardFolders: boolean,
): string | null {
  if (!boardFolders) return null;
  const folder = parentFolder(boardPath);
  if (!folder) return null;
  return normalizeVaultRelative(lastSegment(folder)) === normalizeVaultRelative(oldName.trim())
    ? folder
    : null;
}

/** `folder` with its last segment renamed to `name`. */
export function renamedFolder(folder: string, name: string): string {
  return joinRel(parentFolder(folder), name);
}

/**
 * `base` if it's free, else `base 2`, `base 3`, … The first free one wins.
 * For names Filo picks itself (a new tab's board, a template's board); a
 * name the user typed is refused when taken instead.
 */
export function freeBoardName(base: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(base)) return base;
  let n = 2;
  while (isTaken(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
