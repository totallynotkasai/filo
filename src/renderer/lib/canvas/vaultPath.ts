import { normalizePath } from '../utils/path';

/**
 * Pure helpers used by the canvas drop handler to detect whether an
 * OS-dragged file already lives inside the open vault. When true, we link
 * the file as a tile reference instead of copying it (which would otherwise
 * create a duplicate sibling like "NotesTest (1).md").
 *
 * Path comparison is case-insensitive — Windows is case-preserving but not
 * case-sensitive, and macOS file systems are case-insensitive by default.
 * The returned relative path preserves the original casing of the input so
 * the on-disk path resolves correctly on case-sensitive Linux file systems.
 */

export function isInsideVault(absPath: string, vaultDir: string): boolean {
  if (!absPath || !vaultDir) return false;
  const a = normalizePath(absPath).toLowerCase();
  const v = normalizePath(vaultDir).toLowerCase();
  return a === v || a.startsWith(v + '/');
}

export function vaultRelativeFromAbsolute(absPath: string, vaultDir: string): string {
  if (!absPath || !vaultDir) return '';
  const n = normalizePath(absPath);
  const vn = normalizePath(vaultDir);
  // Use case-insensitive prefix detection but slice from the *original* string
  // so casing of subpath segments is preserved.
  if (n.toLowerCase() === vn.toLowerCase()) return '';
  if (!n.toLowerCase().startsWith(vn.toLowerCase() + '/')) return '';
  return n.slice(vn.length + 1);
}
