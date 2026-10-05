/**
 * A file dropped from the OS file manager onto a board: is it already in the
 * open vault? Every board's drop handler asks this first. A file in the vault
 * is linked by its path, as a sidebar drop is; copying it would make a second
 * note (`Plan (1).md`) that edits then go to. Only a file from outside the
 * vault is copied or imported.
 *
 * A file in a hidden folder of the vault (`.filo/recovery`, `.filo/trash`, a
 * sync client's `.stversions`) counts as outside it, and is copied in. Filo
 * neither shows nor saves inside those folders, and their contents are pruned
 * or emptied without asking, so a link there would be a tile whose edits
 * can't be kept.
 *
 * Paths compare case-insensitively (Windows is case-preserving but not
 * case-sensitive, and so is macOS by default). The vault-relative path keeps
 * the input's own casing, so it resolves on a case-sensitive file system too.
 */
import { toVaultRelative } from '../utils/path';

/** True when a folder on `relPath` (not the file itself) is hidden: its name starts with a dot. */
export function isInHiddenFolder(relPath: string): boolean {
  return relPath.split('/').slice(0, -1).some((part) => part.startsWith('.'));
}

/** True when `absPath` is the vault folder or anything inside it. */
export function isInsideVault(absPath: string, vaultDir: string): boolean {
  return !!absPath && toVaultRelative(absPath, vaultDir) !== null;
}

/**
 * The OS path of a dropped file. Electron removed `File.path`, so this falls
 * back to the preload's `webUtils.getPathForFile` bridge. Undefined when
 * neither yields one (the caller says so).
 */
export function resolveDroppedFilePath(file: File): string | undefined {
  const legacyPath = (file as File & { path?: unknown }).path;
  if (typeof legacyPath === 'string' && legacyPath.length > 0) return legacyPath;
  try {
    const resolved = window.filo.getPathForFile?.(file);
    if (resolved) return resolved;
  } catch {
    // Bridge unavailable in some contexts (the popped-out sidebar).
  }
  return undefined;
}

/** A dropped file already in the vault: link it by `relPath`. */
export interface InVaultDrop {
  kind: 'in-vault';
  file: File;
  relPath: string;
}

/** A dropped file from outside the vault: the only kind a drop may copy or import. */
export interface OutsideDrop {
  kind: 'outside';
  file: File;
  sourcePath: string;
}

/**
 * Where a dropped file lives, or null when the OS gave no path for it. A file
 * that is the vault folder itself is neither (null), since there is nothing
 * to link or copy.
 */
export function classifyDroppedFile(file: File, vaultRoot: string): InVaultDrop | OutsideDrop | null {
  const sourcePath = resolveDroppedFilePath(file);
  if (!sourcePath) return null;
  if (!isInsideVault(sourcePath, vaultRoot)) return { kind: 'outside', file, sourcePath };
  const relPath = toVaultRelative(sourcePath, vaultRoot);
  if (relPath && isInHiddenFolder(relPath)) return { kind: 'outside', file, sourcePath };
  return relPath ? { kind: 'in-vault', file, relPath } : null;
}
