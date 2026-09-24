/**
 * Where a new note lands and what its file is called. A note's path is picked
 * once, at creation, from its title; after that the path is its identity and
 * is never re-derived. The naming primitives below (`fileNameSafe`,
 * `nextUniqueMdPath`, `normalizeRootFolder`) are pure — no IPC, no Svelte.
 *
 * `getActiveContentFolder` / `getActiveContentFolderAbs` resolve the cascade
 * for "where does a new file land": vault-wide pin → per-board pin → vault
 * root. They read `vaultStore` reactively so callers in templates / $derived
 * stay live; the rest of the file remains pure for unit-test reuse.
 */
import type { V7BoardFileData } from '../boards/boardSaver';
import type { Board } from '../../schema/index';
import { vaultStore } from '../../stores/vault.svelte';
import { normalizePath, normalizeVaultRelative, stripLeadingSlash } from '../utils/path';
import { flattenTreePaths } from './vaultTreeSort';
import { fileStemFromTitle } from '@shared/fileNames';

/**
 * The file stem for a note titled `name`: illegal characters become `-`,
 * reserved device names are prefixed, empty becomes `Untitled` (see
 * `fileStemFromTitle`). Only the filename is restricted; the title itself is
 * stored verbatim in frontmatter.
 */
export function fileNameSafe(name: string): string {
  return fileStemFromTitle(name);
}

/**
 * Returns a vault-relative path of the form `<folder>/<baseName>.md` that
 * doesn't collide with any text tile already known to the board cache.
 * Folder may be empty (vault root). Collisions get `" (N)"` suffixes; the
 * lowest free integer ≥ 2 wins.
 *
 * `taken` is case-folded (NTFS/APFS treat `Groceries.md` and
 * `groceries.md` as one file), holds every text def's `filePath`, and folds
 * in `extraTaken` (the on-disk tree, via `nextFreeMdPath`). This is only the
 * PRE-PICK: the create-exclusive `vault:create-file-text` channel is the
 * authority, and `createUniqueMdFile` bumps again on EEXIST.
 */
export function nextUniqueMdPath(
  cache: Record<string, V7BoardFileData>,
  folder: string,
  baseName: string,
  extraTaken: Iterable<string> = [],
): string {
  const prefix = folder ? `${folder}/` : '';
  const taken = new Set<string>();
  for (const data of Object.values(cache)) {
    for (const def of Object.values(data.tileDefs ?? {})) {
      if (def.type === 'text') taken.add(normalizeVaultRelative(def.filePath));
    }
  }
  for (const p of extraTaken) taken.add(normalizeVaultRelative(p));
  const isTaken = (p: string): boolean => taken.has(normalizeVaultRelative(p));
  const candidate = `${prefix}${baseName}.md`;
  if (!isTaken(candidate)) return candidate;
  let n = 2;
  while (isTaken(`${prefix}${baseName} (${n}).md`)) n++;
  return `${prefix}${baseName} (${n}).md`;
}

/**
 * Disk-aware pre-pick: `nextUniqueMdPath` over the board cache
 * PLUS every file in the live vault tree, so a file that exists on disk but is
 * on no board is not picked. The cache is a parameter (callers pass
 * `boardCacheStore.cache`) to keep this module free of a boardCache import
 * cycle. `createUniqueMdFile` still re-checks exclusively.
 */
export function nextFreeMdPath(
  cache: Record<string, V7BoardFileData>,
  folder: string,
  baseName: string,
): string {
  const root = vaultStore.path;
  const onDisk = root ? flattenTreePaths(vaultStore.rawTree ?? [], root) : [];
  return nextUniqueMdPath(cache, folder, baseName, onDisk);
}

/**
 * Normalises the user's pinned root folder (Sidebar > Set as Root) into a
 * vault-relative POSIX path with no leading or trailing slashes. Returns
 * an empty string when no root is pinned (i.e. drop into vault root).
 */
export function normalizeRootFolder(activeRootFolder: string | undefined | null): string {
  if (!activeRootFolder) return '';
  return normalizePath(stripLeadingSlash(activeRootFolder));
}

/**
 * Returns the vault-relative folder where new text files created on `board`
 * should land. POSIX slashes, no leading/trailing '/'. Empty string ⇒ vault
 * root.
 *
 * Cascade (highest precedence first):
 *   1. vaultStore.activeRootFolder   (vault-wide "Use as Root Directory")
 *   2. board.settings.defaultFolder  (per-board pin, persisted in .board.json)
 *   3. ''                            (vault root)
 *
 * Pass `null` when no board is active (e.g. drop fired before the board
 * router resolved); rule 2 is skipped.
 *
 * The board param is read through `.passthrough()`'s untyped escape hatch so
 * the helper is board-type-agnostic — every board variant's
 * `BaseBoardSettingsSchema` carries `defaultFolder`.
 */
export function getActiveContentFolder(board: Board | null): string {
  const vaultPin = normalizeRootFolder(vaultStore.activeRootFolder);
  if (vaultPin) return vaultPin;
  const perBoard = (board?.settings as { defaultFolder?: unknown } | undefined)?.defaultFolder;
  if (typeof perBoard === 'string' && perBoard.length > 0) {
    return normalizeRootFolder(perBoard);
  }
  return '';
}

/**
 * Absolute-path companion for callers that need a filesystem dir (e.g. OS
 * file drops onto the canvas). Returns `''` when there is no open vault.
 */
export function getActiveContentFolderAbs(board: Board | null): string {
  const vaultPath = vaultStore.path;
  if (!vaultPath) return '';
  const folder = getActiveContentFolder(board);
  if (!folder) return vaultPath;
  const root = normalizePath(vaultPath);
  return `${root}/${stripLeadingSlash(folder)}`;
}
