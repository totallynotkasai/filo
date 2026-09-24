import { promises as fsPromises } from 'fs';
import { createHash } from 'crypto';

/**
 * Content-hash ceiling for the watcher. Files larger
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
 * Hashes the whole buffer so an edit past the first 4 KB isn't missed (and
 * then overwritten by the local cache flush); the caller decides how many
 * bytes to read (whole file under the ceiling, 4 KB prefix above it).
 */
export function fnv1a32(buf: Buffer): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i] ?? 0; // i < buf.length guarantees defined; `?? 0` is a no-op XOR
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
 * Whole-file SHA-1 (capped at {@link WATCHER_HASH_MAX_BYTES}) for the
 * cross-basename rename gate. A prefix-only hash would let two files sharing
 * a head collide, mis-pairing them and rewiring tile refs onto the wrong file
 * (no undo for external renames).
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
