import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  WATCHER_HASH_MAX_BYTES,
  fnv1a32,
  sha1Hex,
  hashFileForRename,
} from '../../main/services/fileWatcherHash';

/**
 * Audit-4 DI-07 / DI-15 — the watcher's content hashes covered only the first
 * 4 KB of a file. Two distinct files that share a 4 KB head but diverge later
 * therefore hashed identical:
 *
 *   - DI-07: the cross-basename rename gate (`hashFileForRename`) paired them
 *     as a rename and `propagateRename` rewired tile refs onto the wrong file.
 *   - DI-15: the reconcile diff (`fnv1a32`) treated a deep `.board.json` edit
 *     past offset 4096 as unchanged and dropped the external edit.
 *
 * These tests pin the whole-file hashing window so a future refactor can't
 * silently reintroduce the truncation. The walk seed and the on-demand rename
 * probe both route through these helpers, so testing them covers both sites.
 */

/** 4 KB of 'a' followed by a distinct tail of equal length on both files. */
function headPlusTail(tail: string): Buffer {
  return Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from(tail, 'utf-8')]);
}

describe('fileWatcherHash — whole-file digests (DI-07/DI-15)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-hash-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hashFileForRename distinguishes two files that share a 4 KB head but diverge later (DI-07)', async () => {
    const a = join(dir, 'A.md');
    const b = join(dir, 'B.md');
    const bufA = headPlusTail('TAIL-AAAA');
    const bufB = headPlusTail('TAIL-BBBB');
    await fs.writeFile(a, bufA);
    await fs.writeFile(b, bufB);

    // Same total length — the size gate cannot tell them apart, so identity
    // rests entirely on the content hash.
    expect(bufA.length).toBe(bufB.length);
    // The first 4 KB are byte-identical, so the PRE-FIX 4 KB-prefix hash would
    // have collided (documented here so the regression is unmistakable).
    expect(sha1Hex(bufA.subarray(0, 4096))).toBe(sha1Hex(bufB.subarray(0, 4096)));

    const hashA = await hashFileForRename(a, bufA.length);
    const hashB = await hashFileForRename(b, bufB.length);
    expect(hashA).not.toBeNull();
    expect(hashB).not.toBeNull();
    // Whole-file digests differ — the gate now refuses to pair them.
    expect(hashA).not.toBe(hashB);
  });

  it('hashFileForRename returns identical digests for byte-identical files (legitimate rename still pairs)', async () => {
    const a = join(dir, 'Old.md');
    const b = join(dir, 'New.md');
    const buf = headPlusTail('IDENTICAL');
    await fs.writeFile(a, buf);
    await fs.writeFile(b, buf);

    const hashA = await hashFileForRename(a, buf.length);
    const hashB = await hashFileForRename(b, buf.length);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBeNull();
  });

  it('hashFileForRename returns null above the ceiling (size-only fallback)', async () => {
    const f = join(dir, 'big.md');
    await fs.writeFile(f, 'tiny on disk');
    // Pass a declared size over the ceiling — the guard short-circuits before
    // any read, so we don't need to materialise a 10 MB file.
    const hash = await hashFileForRename(f, WATCHER_HASH_MAX_BYTES + 1);
    expect(hash).toBeNull();
  });

  it('hashFileForRename returns null on a read error (missing file)', async () => {
    const hash = await hashFileForRename(join(dir, 'does-not-exist.md'), 100);
    expect(hash).toBeNull();
  });

  it('fnv1a32 hashes the whole buffer, not just the first 4 KB (DI-15)', () => {
    // Two buffers identical for the first 4096 bytes, differing only past it.
    const base = Buffer.alloc(5000, 0x62);
    const edited = Buffer.from(base);
    edited[4500] = 0x63; // a single byte change beyond offset 4096
    expect(base.subarray(0, 4096).equals(edited.subarray(0, 4096))).toBe(true);
    expect(fnv1a32(base)).not.toBe(fnv1a32(edited));
  });

  it('fnv1a32 is stable for equal buffers', () => {
    const a = Buffer.from('the same bytes');
    const b = Buffer.from('the same bytes');
    expect(fnv1a32(a)).toBe(fnv1a32(b));
  });
});
