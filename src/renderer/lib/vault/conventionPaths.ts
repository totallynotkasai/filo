/**
 * Where a new note lands and what its file is called. A note's path is picked
 * once, at creation, from its title; after that the path is its identity and
 * is never re-derived. The naming primitives below (`fileNameSafe`,
 * `nextUniqueMdPath`, `normalizeRootFolder`) are pure — no IPC, no Svelte.
 *
 * `getActiveContentFolder` resolves "where does a new file land": the board's
 * own folder with board folders on, else the vault-wide Root Directory, else
 * the vault root. It reads `vaultStore` reactively so callers in templates /
 * $derived stay live; the rest of the file remains pure for unit-test reuse.
 */
import type { BoardFileData } from '../boards/boardSaver';
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
 * authority, and `noteStore.createUnique` bumps again on EEXIST.
 */
export function nextUniqueMdPath(
  cache: Record<string, BoardFileData>,
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
 * cycle. `noteStore.createUnique` still re-checks exclusively.
 */
export function nextFreeMdPath(
  cache: Record<string, BoardFileData>,
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
 * The folder new files go in. With board folders on it is the board's own
 * pin (`settings.defaultFolder`, which a new board sets to its folder); with
 * them off it is the vault-wide Root Directory. The other pin is ignored, so
 * the sidebar's one tree button always shows where files go. Empty ⇒ the
 * vault root. Vault-relative, POSIX, no leading or trailing '/'.
 */
export function resolveContentFolder(opts: {
  boardFolders: boolean;
  rootFolder: string | undefined | null;
  boardFolder: unknown;
}): string {
  if (!opts.boardFolders) return normalizeRootFolder(opts.rootFolder);
  return typeof opts.boardFolder === 'string' ? normalizeRootFolder(opts.boardFolder) : '';
}

/**
 * `resolveContentFolder` for the open vault and `board` (`null` when no
 * board is active: with board folders on, files then go to the vault root).
 * Reads `vaultStore` reactively, so callers in templates / $derived stay live.
 * Every board variant's settings carry `defaultFolder`.
 */
export function getActiveContentFolder(board: Board | null): string {
  return resolveContentFolder({
    boardFolders: vaultStore.project?.settings?.general?.boardFolders === true,
    rootFolder: vaultStore.activeRootFolder,
    boardFolder: (board?.settings as { defaultFolder?: unknown } | undefined)?.defaultFolder,
  });
}
