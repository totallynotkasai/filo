import * as path from 'path';
import {
  assertWithinVault,
  assertSafeRelativePath,
  assertNotInFiloDir,
} from '../utils/pathSecurity';

/**
 * Resolves a decoded `filo://media/<relPath>` request to an
 * absolute path, applying the SAME guards every generic renderer-facing vault
 * read enforces, in the same order:
 *
 *   1. `assertSafeRelativePath` — structural validation (depth bound, no
 *      empty segments, each segment a safe filename). Matches
 *      `vault:read-file-text`.
 *   2. `assertNotInFiloDir`     — the `.filo/` carve-out. Media tiles never
 *      legitimately point into `.filo/`; without this a hand-edited tile
 *      `file` (or a stray `fetch('filo://media/.filo/tags.json')`) would
 *      stream config bytes.
 *   3. `assertWithinVault`      — the primary containment check (canonicalises
 *      symlinks/junctions, refuses escapes).
 *
 * Throws on rejection; the protocol handler maps the throw to a 403. Kept as a
 * pure, electron-free function (mirroring `parseRangeHeader` in rangeHeader.ts)
 * so the security decision is unit-testable without the protocol glue.
 */
export function resolveServableMediaPath(vaultRoot: string, relPath: string): string {
  assertSafeRelativePath(relPath);
  assertNotInFiloDir(vaultRoot, relPath);
  const absPath = path.join(vaultRoot, relPath);
  assertWithinVault(vaultRoot, absPath);
  return absPath;
}
