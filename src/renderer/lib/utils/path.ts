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
import { normalizePath } from '../../../shared/pathUtils';

// One implementation, shared with the main process (`src/shared/pathUtils.ts`).
export { toPosix, stripLeadingSlash, normalizePath, toVaultRelative, hasHiddenSegment } from '../../../shared/pathUtils';

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
