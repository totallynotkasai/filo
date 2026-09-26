/**
 * Separator and vault-relative path primitives shared by the main process and
 * the renderer, so both sides agree on one rule (the renderer can't import
 * Node's `path`, and two hand-written copies drift).
 *
 * The renderer reaches these through `lib/utils/path.ts`; the main process
 * imports them from here. Case-folded identity keys live in `vaultPath.ts`.
 */

/**
 * Backslashes → forward slashes, nothing else. Idempotent on POSIX paths.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Strip leading slashes (one or more), so `'/Notes.md'` and `'Notes.md'` key
 * the same.
 */
export function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * An absolute or directory path in comparable form: forward slashes, trailing
 * slashes stripped. Case is kept (callers that need a case-insensitive match
 * fold it themselves, or use `samePath`).
 */
export function normalizePath(p: string): string {
  return toPosix(p).replace(/\/+$/, '');
}

/**
 * Absolute path → vault-relative POSIX path, or `null` when the path is
 * outside the vault (or `vaultRoot` is empty). The prefix match is
 * case-insensitive, because Windows and macOS volumes are, and requires a
 * separator boundary, so `/vault-other` never counts as inside `/vault`. The
 * returned slice keeps the path's own casing, because it becomes a stored key.
 * Trailing slashes are ignored on both sides; the vault root itself maps to
 * `''`.
 *
 * This is string-only: it does not resolve `.` / `..` segments. Code that
 * checks a path against a security boundary must resolve it first (the main
 * process uses `path.relative` for that, see `utils/pathHelpers.ts`).
 */
export function toVaultRelative(absolutePath: string, vaultRoot: string): string | null {
  if (!vaultRoot) return null;
  const root = normalizePath(vaultRoot);
  const abs = normalizePath(absolutePath);
  const rootKey = root.toLowerCase();
  const absKey = abs.toLowerCase();
  if (absKey === rootKey) return '';
  if (!absKey.startsWith(rootKey + '/')) return null;
  return abs.slice(root.length + 1);
}
