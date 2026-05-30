/**
 * Convention-path helpers shared by board components (Kanban, TaskList,
 * future board types). The deduplication / normalisation primitives below
 * (`fileNameSafe`, `nextUniqueMdPath`, `normalizeRootFolder`,
 * `titleFromRelPath`) are pure — no IPC, no Svelte.
 *
 * `getActiveContentFolder` / `getActiveContentFolderAbs` resolve the cascade
 * for "where does a new file land": vault-wide pin → per-board pin → vault
 * root. They read `vaultStore` reactively so callers in templates / $derived
 * stay live; the rest of the file remains pure for unit-test reuse.
 */
import type { V7BoardFileData } from '../boards/boardSaver';
import type { Board } from '../../schema/index';
import { vaultStore } from '../../stores/vault.svelte';
import { normalizePath, stripLeadingSlash } from '../utils/path';

/**
 * Strips OS-illegal filename characters and collapses whitespace. Returns
 * `'Untitled'` for inputs that reduce to an empty string.
 */
export function fileNameSafe(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

/**
 * Returns a vault-relative path of the form `<folder>/<baseName>.md` that
 * doesn't collide with any text tile already known to the board cache.
 * Folder may be empty (vault root). Collisions get `" (N)"` suffixes; the
 * lowest free integer ≥ 2 wins.
 *
 * The cache covers loaded boards only — files that exist on disk but
 * aren't surfaced as tiles can still collide. Callers that care about
 * disk-level collisions should re-check after vault:write returns.
 */
export function nextUniqueMdPath(
  cache: Record<string, V7BoardFileData>,
  folder: string,
  baseName: string,
): string {
  const prefix = folder ? `${folder}/` : '';
  const taken = new Set<string>();
  for (const data of Object.values(cache)) {
    for (const def of Object.values(data.tileDefs ?? {})) {
      const d = def as Record<string, unknown>;
      if (d.type === 'text' && d.title) taken.add(`${prefix}${d.title}.md`);
    }
  }
  const candidate = `${prefix}${baseName}.md`;
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has(`${prefix}${baseName} (${n}).md`)) n++;
  return `${prefix}${baseName} (${n}).md`;
}

/**
 * Inverse of `nextUniqueMdPath` for display purposes: strips the leading
 * folder prefix and the trailing `.md` extension to recover the title that
 * was used to build the path.
 */
export function titleFromRelPath(relPath: string, folder: string): string {
  const prefix = folder ? `${folder}/` : '';
  return relPath.replace(prefix, '').replace(/\.md$/, '');
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
 * `BaseBoardSettingsSchema` carries `defaultFolder` since the schema change
 * in step 1 of the per-board-default plan.
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
