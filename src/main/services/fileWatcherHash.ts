import { promises as fsPromises } from 'fs';
import { createHash } from 'crypto';

/**
 * Audit-4 DI-07 / DI-15 — content-hash ceiling for the watcher. Files larger
 * than this are not content-hashed; the reconcile diff and the cross-basename
 * rename gate fall back to size + mtime. Reading multi-MB media on the watcher
 * hot path is too costly, and a >10 MB same-size collision is vanishingly
 * rare. The single ceiling is shared by the reconcile-walk seed and the
 * on-demand rename probe so a seeded digest always matches an on-demand one —
 * mismatched windows would stop legitimate renames from pairing.
 */
export const WATCHER_HASH_MAX_BYTES = 10 * 1024 * 1024;

/**
 * FNV-1a 32-bit over the WHOLE buffer. Used by the reconcile walk to detect a
 * "same mtime + same size but different bytes" rewrite that `fs.stat` alone
 * misses (FAT/SMB second-resolution mtime, or an atomic temp-rename that
 * preserves mtime).
 *
 * Audit-4 DI-15 — the pre-fix hash covered only the first 4 KB, so a
 * `.board.json` edited past offset 4096 with an unchanged size + coarse mtime
 * hashed "equal" and the external edit was dropped (then overwritten by the
 * local cache flush). Hashing the whole buffer closes that window; the caller
 * decides how many bytes to read (whole file under the ceiling, 4 KB prefix
 * above it).
 */
export function fnv1a32(buf: Buffer): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    // FNV prime 16777619, kept inside int32 via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** SHA-1 hex digest of a buffer. */
export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Audit-4 DI-07 — whole-file SHA-1 (capped at {@link WATCHER_HASH_MAX_BYTES})
 * for the cross-basename rename gate. The pre-fix probe hashed only the first
 * 4 KB, so two unrelated files sharing a 4 KB head but diverging later hashed
 * identical; `correlateRenames` then mis-paired them and `propagateRename`
 * rewired tile `file` / `src` / `coverImage` refs onto the wrong file (no undo
 * for external renames). Reading the whole file gives real content identity.
 *
 * Returns `null` above the ceiling (the correlator refuses to pair on size
 * alone there) or on any read error. MUST stay byte-identical to the
 * reconcile-walk seed's digest — both go through {@link sha1Hex} over the
 * whole file — or a seeded hash won't match an on-demand one and legitimate
 * renames stop pairing.
 */
export async function hashFileForRename(absPath: string, size: number): Promise<string | null> {
  if (size > WATCHER_HASH_MAX_BYTES) return null;
  try {
    return sha1Hex(await fsPromises.readFile(absPath));
  } catch {
    return null;
  }
}
