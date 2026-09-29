/**
 * A file dropped from the OS file manager onto a board: is it already in the
 * open vault? Every board's drop handler asks this first. A file in the vault
 * is linked by its path, as a sidebar drop is; copying it would make a second
 * note (`Plan (1).md`) that edits then go to. Only a file from outside the
 * vault is copied or imported.
 *
 * Paths compare case-insensitively (Windows is case-preserving but not
 * case-sensitive, and so is macOS by default). The vault-relative path keeps
 * the input's own casing, so it resolves on a case-sensitive file system too.
 */
import { normalizePath } from '../utils/path';

/** True when `absPath` is the vault folder or anything inside it. */
export function isInsideVault(absPath: string, vaultDir: string): boolean {
  if (!absPath || !vaultDir) return false;
  const a = normalizePath(absPath).toLowerCase();
  const v = normalizePath(vaultDir).toLowerCase();
  return a === v || a.startsWith(v + '/');
}

/** `absPath` relative to the vault, in its own casing; '' when it isn't inside it. */
export function vaultRelativeFromAbsolute(absPath: string, vaultDir: string): string {
  if (!absPath || !vaultDir) return '';
  const n = normalizePath(absPath);
  const vn = normalizePath(vaultDir);
  // Case-insensitive prefix detection, sliced from the original string so
  // the casing of the subpath is kept.
  if (n.toLowerCase() === vn.toLowerCase()) return '';
  if (!n.toLowerCase().startsWith(vn.toLowerCase() + '/')) return '';
  return n.slice(vn.length + 1);
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
  const relPath = vaultRelativeFromAbsolute(sourcePath, vaultRoot);
  return relPath ? { kind: 'in-vault', file, relPath } : null;
}
