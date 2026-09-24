/**
 * Path helpers for the Electron main process.
 *
 * Mirrors `src/renderer/lib/utils/path.ts`. Centralising the primitives
 * (rather than inlining `.replace(/\\/g, '/')` per call site) avoids drift
 * between call sites; the `gates:no-inline-path-normalize` gate enforces
 * it.
 *
 * Kept deliberately small — no path joining, no absolute-relative
 * resolution. Use Node's `path` module for those.
 */

import { relative as nodeRelative } from 'path';

/**
 * Convert backslashes to forward slashes. The lowest-level normalizer.
 * Idempotent on already-POSIX paths.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Strip leading slashes. Useful for vault-relative paths that may
 * carry a leading separator from a join/relative chain.
 */
export function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Compute a POSIX-form vault-relative path from an absolute path.
 * Combines Node's `path.relative` (which preserves the OS separator)
 * with `toPosix` so the result is suitable for storage in `.board.json`
 * / `.filo/*.json` regardless of the host OS.
 *
 * If the absolute path is identical to the root, returns `''` — same
 * semantics as `path.relative(root, root)`.
 */
export function relativePosix(root: string, absolutePath: string): string {
  return toPosix(nodeRelative(root, absolutePath));
}
