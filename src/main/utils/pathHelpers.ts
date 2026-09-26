/**
 * Main-process path helper that needs Node's `path`.
 *
 * `toPosix` / `stripLeadingSlash` / `toVaultRelative` live in
 * `src/shared/pathUtils.ts`, shared with the renderer. This one stays here
 * because it resolves `.` / `..` segments through `path.relative`, which the
 * `.filo/` and vault-boundary checks rely on: a string-only prefix slice would
 * pass `vault/a/../.filo/x` through as `a/../.filo/x`.
 */

import { relative as nodeRelative } from 'path';
import { toPosix } from '../../shared/pathUtils';

/**
 * A POSIX-form vault-relative path from an absolute path, for storage in
 * `.board.json` / `.filo/*.json` regardless of the host OS. The root itself
 * maps to `''`, as `path.relative(root, root)` does.
 */
export function relativePosix(root: string, absolutePath: string): string {
  return toPosix(nodeRelative(root, absolutePath));
}
