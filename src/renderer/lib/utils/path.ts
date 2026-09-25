/**
 * Path comparison helpers for the renderer.
 *
 * The renderer can't import Node's `path` module, but file-tree nodes carry
 * native paths (backslashes on Windows) while several store getters
 * pre-normalize to forward slashes. Direct `===` comparisons silently fail
 * across that mismatch — `pathsEqual` and `samePath` are the canonical fixes.
 *
 * Two normalisations co-exist because they serve different shapes:
 *   - `normalizePath` is for absolute or directory paths (e.g. file-tree
 *     `path` fields). Separator-only; case-sensitive; strips trailing slash.
 *   - `normalizeVaultRelative` is for vault-relative paths stored in board
 *     JSON / frontmatter. Case-insensitive (Windows/macOS aren't case-
 *     sensitive in practice); strips leading slash so `'/Notes.md'` and
 *     `'Notes.md'` collapse to the same key. Lives in
 *     `src/shared/vaultPath.ts`; the re-export below keeps renderer
 *     call-sites working.
 */

import { normalizeVaultRelative as sharedNormalizeVaultRelative } from '../../../shared/vaultPath';

/**
 * Convert backslashes to forward slashes only. The lowest-level normalizer —
 * use when the caller doesn't want any slash stripping (e.g. preserving the
 * exact path shape but in POSIX form for storage or display).
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Strip leading slashes (one or more). Useful for vault-relative paths that
 * may or may not have a leading slash and need to be normalized to "no
 * leading slash" form for keying.
 */
export function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Normalize an absolute or directory path for comparison: backslashes →
 * forward slashes, trailing slashes stripped. Does NOT lower-case (callers
 * that need case-insensitive matching on Windows must do that themselves).
 */
export function normalizePath(p: string): string {
  return toPosix(p).replace(/\/+$/, '');
}

/**
 * True when two paths refer to the same on-disk location, ignoring separator
 * style and trailing slashes.
 */
export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Re-export of the canonical implementation in
 * `src/shared/vaultPath.ts`. New callers should prefer the branded
 * `vaultPath()` constructor from the shared module — it normalises AND types
 * the result so the value can be safely used as a `Map<VaultPath, _>` /
 * `Record<VaultPath, _>` / `Set<VaultPath>` key.
 */
export const normalizeVaultRelative = sharedNormalizeVaultRelative;

/**
 * Case-insensitive, separator-agnostic equality for vault-relative paths.
 * Treats backslashes and forward slashes as equivalent and strips leading
 * slashes. Use this for "is this the same vault file?" checks — never use
 * raw `===` on paths because Windows is case-preserving but not
 * case-sensitive.
 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return sharedNormalizeVaultRelative(a) === sharedNormalizeVaultRelative(b);
}

/**
 * Absolute path → vault-relative POSIX path, or `null` when the path is
 * outside the vault (or no vault is open). The prefix match is
 * case-insensitive and requires a separator boundary, so `/vault-other`
 * never counts as inside `/vault`; the returned slice keeps the original
 * casing because it becomes a stored key. The vault root itself maps to `''`.
 */
export function toVaultRelative(absolutePath: string, vaultPath: string): string | null {
  if (!vaultPath) return null;
  const root = normalizePath(vaultPath).toLowerCase();
  const candidate = toPosix(absolutePath).toLowerCase();
  if (candidate === root) return '';
  if (!candidate.startsWith(root + '/')) return null;
  return toPosix(absolutePath).slice(root.length + 1);
}
