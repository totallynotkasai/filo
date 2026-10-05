import { basename, extname } from 'path';
import type { FileChangeEvent } from './fileWatcherTypes';
import { detectConflictCopyPath } from '../../shared/conflictCopy';

/**
 * Case-only rename support. Windows and macOS are case-insensitive by
 * default, so renaming `foo.md` → `Foo.md` fires events under both cases;
 * lowercasing the bucket key on these platforms lets the pair fire as a
 * synthetic rename so tile references propagate.
 *
 * On case-sensitive systems (Linux) we keep the strict-case keying:
 * two genuinely different files `foo.md` and `Foo.md` can coexist,
 * and we'd rather miss a case-only rename than fabricate one.
 */
const DEFAULT_CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
function basenameKey(filename: string, caseInsensitive: boolean): string {
  const b = basename(filename);
  return caseInsensitive ? b.toLowerCase() : b;
}

/**
 * Minimum byte size for cross-basename rename pairing. Below this threshold
 * the chance of two unrelated files sharing a size grows quickly — a vault
 * full of small `.md` notes typically has many ~50-200 byte files that
 * collide by coincidence. Above 256 bytes, a same-size+same-extension match
 * has a much higher prior of being a true rename. Matters most on sync
 * vaults, where a mispairing would silently rewrite tile references /
 * `.filo/tags.json` onto the wrong file.
 *
 * With a hash probe, a smaller file still pairs on a whole-content SHA-1
 * match. // DECISION: two different non-empty files with identical bytes,
 * one deleted and one created in the same moment, are indistinguishable from
 * a move; following it moves tile references onto an identical note, which is
 * less harmful than treating every renamed small note as deleted.
 */
const CROSS_BASENAME_MIN_SIZE_BYTES = 256;

/**
 * Extensions that are interchangeable when correlating a cross-basename
 * rename, so retyping `Notes.txt` → `Notes.md` in a file manager still
 * propagates tile references. Deliberately narrow: adding image formats
 * (`.png` ↔ `.jpg`) would reintroduce same-size false positives.
 */
const TEXT_LIKE_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);

/**
 * File-size threshold below which a content-hash match is required when a
 * hash probe is provided. Hashing multi-MB files in the watcher hot path is
 * too expensive (larger files are handled separately below).
 */
const CROSS_BASENAME_HASH_REQUIRED_BELOW = 10 * 1024 * 1024;

/**
 * "Balanced" content-identity check for a same-basename missing+present pair
 * before treating it as a rename.
 *
 * Two *unrelated* files sharing a basename across folders (a `Notes.md` /
 * `README.md` per folder) deleted and created in one batch would otherwise
 * be paired, silently rewriting every tile reference onto the new file with
 * no undo.
 *
 * A genuine move preserves bytes, so refuse on a POSITIVE size or hash
 * mismatch; an uncached side is not a mismatch (the SHA-1 cache is seeded
 * only for `.md`, so attachments and `.board.json` rely on size alone). See
 * the body for the cold-cache, empty-file and small-file refusals.
 *
 * Returns true when the pair is safe to treat as a move.
 */
/** SHA-1 of the empty buffer — the universal hash of every zero-byte file. */
const EMPTY_BUFFER_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

function parentFolder(filename: string): string {
  const i = filename.lastIndexOf('/');
  return i >= 0 ? filename.slice(0, i) : '';
}

async function sameBasenameBytesPreserved(
  missing: FileChangeEvent,
  present: FileChangeEvent,
  relPathSize?: (relPath: string) => number | null,
  relPathHash?: (relPath: string) => string | null | Promise<string | null>,
): Promise<boolean> {
  let mSize: number | null = null;
  let pSize: number | null = null;
  if (relPathSize) {
    mSize = relPathSize(missing.filename);
    pSize = relPathSize(present.filename);
    // Both sizes known and unequal ⇒ not a pure move ⇒ refuse.
    if (mSize !== null && pSize !== null && mSize !== pSize) return false;
  }
  let mHash: string | null = null;
  let pHash: string | null = null;
  if (relPathHash) {
    mHash = await relPathHash(missing.filename);
    pHash = await relPathHash(present.filename);
    // Both hashes known and unequal ⇒ different content ⇒ refuse. A null
    // (uncached / unhashable) hash is not a mismatch — see the doc comment's
    // "balanced, not strict" rationale.
    if (mHash && pHash && mHash !== pHash) return false;
  }
  // Empty-file guard: two zero-byte same-basename files in DIFFERENT folders
  // (empty placeholder `Notes.md` / `README.md`) are overwhelmingly an
  // unrelated delete + create, not a move — yet they "match" on size and
  // hash. Only refuse when the parent folders differ.
  const isEmpty = (mSize === 0 && pSize === 0) || (mHash === EMPTY_BUFFER_SHA1 && pHash === EMPTY_BUFFER_SHA1);
  if (isEmpty && parentFolder(missing.filename) !== parentFolder(present.filename)) {
    return false;
  }
  // Cold cache: when BOTH probes were supplied (production always does) yet
  // NEITHER could compare, there is zero evidence the files share bytes —
  // pairing on basename alone would rewire tile refs to a possibly-unrelated
  // file with no undo. Refuse; it surfaces as delete+create, recoverable via
  // the broken-ref relink. Probe-absent callers keep basename-only pairing.
  if (relPathSize && relPathHash) {
    const sizeComparable = mSize !== null && pSize !== null;
    const hashComparable = mHash !== null && pHash !== null;
    // A CONFIRMED content match is the strongest move signal — pair regardless
    // of size (even a tiny file with a real hash match is a genuine move). This
    // also exempts confirmed moves from the small-file floor below.
    if (hashComparable && mHash === pHash) return true;
    // Neither size nor hash comparable ⇒ fully cold cache ⇒ refuse.
    if (!sizeComparable && !hashComparable) return false;
    // Apply the cross-basename small-file floor here too: with only an equal
    // SIZE as evidence, tiny files collide constantly, so a <256-byte
    // "move" is more likely an unrelated delete+create. A >=256-byte
    // same-size pair keeps size-only pairing (moved attachments /
    // .board.json are never hash-seeded).
    if (mSize !== null && pSize !== null && mSize === pSize && mSize < CROSS_BASENAME_MIN_SIZE_BYTES) {
      return false;
    }
  }
  return true;
}

/**
 * Correlates a batch of file-change events into rename pairs + a filtered
 * residual feed. Pure function — takes a `relPathExists` probe so callers
 * (production: `statSync`; tests: an in-memory map) decide post-flush
 * existence. An optional `relPathSize` probe enables the cross-basename
 * heuristic; without it, only same-basename pairs are emitted.
 *
 * Two passes:
 *   1. **Same-basename pass.** Within a single basename, if exactly one
 *      event refers to a now-missing file (the old path) and exactly one
 *      refers to a now-existing file (the new path), they form a rename
 *      pair and both are suppressed from the residual feed.
 *   2. **Cross-basename pass.** Among events the first pass did NOT pair,
 *      group by file size. When exactly one missing event and one present
 *      event share a non-zero size, the same `type`, AND the same file
 *      extension, attempt to pair them. Without a hash probe the size must
 *      be ≥ {@link CROSS_BASENAME_MIN_SIZE_BYTES}. Below `CROSS_BASENAME_HASH_REQUIRED_BELOW` the pair
 *      MUST also have matching `relPathHash` values (missing side from the
 *      cache, present side hashed from disk), so two unrelated same-size
 *      files never silently merge tile references.
 *
 * Ambiguous groups (two missing, two existing, more than two candidates)
 * fall through unchanged — better to emit delete + create than to
 * fabricate a false-positive rename.
 *
 * `document`, `board`, and `attachment` types are correlated; `config`
 * and `tree` pass through unchanged.
 */
export async function correlateRenames(
  events: FileChangeEvent[],
  relPathExists: (relPath: string) => boolean,
  relPathSize?: (relPath: string) => number | null,
  /**
   * Sync (tests) or Promise-returning (production's bounded async hash)
   * probe; the body awaits either.
   */
  relPathHash?: (relPath: string) => string | null | Promise<string | null>,
  /**
   * Test-only override for the platform-detected
   * case-insensitive flag. Defaults to the module constant so production
   * callers don't need to pass anything. Lets tests exercise both
   * partition branches on any host CI runner.
   */
  caseInsensitiveFs: boolean = DEFAULT_CASE_INSENSITIVE_FS,
  /**
   * OneDrive device names seen for this vault. The watcher passes
   * `os.hostname()` + the `.filo/machines` registry.
   */
  knownHosts: readonly string[] = [],
  /**
   * Whether a path held a file before this batch. A move can't land on an
   * existing file without replacing it, so a "present" path that was already
   * a file is that file changed, not the missing one moved: pairing them
   * would hand the replaced note's views, queued typing and tiles to the
   * moved one, and its typing would be written over the moved text. A
   * case-only rename (the same path, spelled otherwise) still pairs.
   */
  wasPresentBefore?: (relPath: string) => boolean,
): Promise<{
  filtered: FileChangeEvent[];
  renames: Array<{ oldPath: string; newPath: string }>;
  /** Pairs REFUSED because the present file is a sync conflict copy of the missing one. */
  conflicts: Array<{ copyPath: string; canonicalPath: string; client: string }>;
}> {
  const renames: Array<{ oldPath: string; newPath: string }> = [];
  const conflicts: Array<{ copyPath: string; canonicalPath: string; client: string }> = [];
  // OneDrive keeps both sides of a conflict by RENAMING the
  // local file to `Note-<DEVICE>.md` (same bytes) and downloading the other
  // version as `Note.md`. If the download lands after this batch closes, the
  // batch holds a missing `Note.md` + a present `Note-<DEVICE>.md` with equal
  // hashes, and pairing them rebinds every tile, editor and tag to the LOSING
  // copy. Refuse exactly that shape — the present file's canonical name IS the
  // missing path — and report it instead. Any other pair still correlates.
  const samePathFold = (a: string, b: string): boolean =>
    caseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
  const conflictCopyOf = (present: string, missing: string): { client: string } | null => {
    const hit = detectConflictCopyPath(present, { knownHosts, exists: (c) => samePathFold(c, missing) });
    return hit && samePathFold(hit.canonicalName, missing) ? { client: hit.client } : null;
  };
  // A replace of an existing file, not a move onto a free name (see `wasPresentBefore`).
  const replacesFile = (present: string, missing: string): boolean =>
    wasPresentBefore !== undefined
    && present.toLowerCase() !== missing.toLowerCase()
    && wasPresentBefore(present);
  const suppressedKeys = new Set<string>();
  const byBase: Map<string, FileChangeEvent[]> = new Map();
  const correlatable: FileChangeEvent[] = [];
  for (const c of events) {
    if (c.type !== 'document' && c.type !== 'board' && c.type !== 'attachment') continue;
    correlatable.push(c);
    // Bucket by case-folded basename on case-insensitive
    // filesystems so `foo.md` → `Foo.md` pairs even though the watcher
    // reports the original cases. The events themselves still carry the
    // on-disk casing, so the synthetic rename event reports e.g.
    // `{ oldPath: 'foo.md', newPath: 'Foo.md' }`, not the lowercased key.
    const base = basenameKey(c.filename, caseInsensitiveFs);
    const bucket = byBase.get(base) ?? [];
    bucket.push(c);
    byBase.set(base, bucket);
  }
  for (const [, bucket] of byBase) {
    if (bucket.length < 2) continue;
    const missing: FileChangeEvent[] = [];
    const present: FileChangeEvent[] = [];
    for (const c of bucket) {
      if (relPathExists(c.filename)) present.push(c);
      else missing.push(c);
    }
    if (missing.length === 1 && present.length === 1) {
      // Gate the same-basename pair on a content-identity check
      // so a delete + unrelated create of two different files sharing a
      // basename across folders isn't mis-correlated into a rename (which
      // would silently rewire tile references to the wrong file). A refusal
      // here leaves both events to flow on: the cross-basename pass below
      // (also content-gated) handles the same-size case, otherwise they
      // surface as delete + create (recoverable via the broken-ref relink).
      const miss = missing[0];
      const pres = present[0];
      // The length checks above guarantee both index-0 reads are defined;
      // narrow for the type-checker (the guard can't fail at runtime).
      if (miss !== undefined && pres !== undefined) {
        const cc = conflictCopyOf(pres.filename, miss.filename);
        if (cc) {
          conflicts.push({ copyPath: pres.filename, canonicalPath: miss.filename, client: cc.client });
        } else if (!replacesFile(pres.filename, miss.filename) && await sameBasenameBytesPreserved(miss, pres, relPathSize, relPathHash)) {
          renames.push({ oldPath: miss.filename, newPath: pres.filename });
          suppressedKeys.add(`${miss.type}:${miss.filename}`);
          suppressedKeys.add(`${pres.type}:${pres.filename}`);
        }
      }
      continue;
    }
    // Case-only rename on a case-insensitive filesystem.
    // `relPathExists` calls statSync, which succeeds for BOTH casings
    // after the rename (the OS folds the lookup). So the
    // missing/present partition above lands both events in `present`,
    // and the strict-pairing branch above bails. Fallback: when we have
    // exactly two same-type events whose full paths differ only by
    // case (the bucket key already collapsed them via basenameKey), pair
    // them by emission order — the earlier-seen casing is the old path,
    // the later-seen is the new path. Skipping when more than two
    // casings appear avoids ambiguity from multi-step renames.
    const oldEvent = bucket[0];
    const newEvent = bucket[1];
    if (
      caseInsensitiveFs &&
      missing.length === 0 &&
      present.length === 2 &&
      bucket.length === 2 &&
      oldEvent !== undefined &&
      newEvent !== undefined &&
      oldEvent.type === newEvent.type &&
      oldEvent.filename !== newEvent.filename &&
      oldEvent.filename.toLowerCase() === newEvent.filename.toLowerCase()
    ) {
      renames.push({ oldPath: oldEvent.filename, newPath: newEvent.filename });
      suppressedKeys.add(`${oldEvent.type}:${oldEvent.filename}`);
      suppressedKeys.add(`${newEvent.type}:${newEvent.filename}`);
    }
  }

  // Cross-basename pass: bucket leftover events by size and pair when each
  // bucket has exactly one missing + one present of the same type. Two
  // additional guards suppress the most common false positives on sync
  // vaults: (a) files smaller than CROSS_BASENAME_MIN_SIZE_BYTES pair only on
  // a content-hash match, because tiny files frequently share sizes by
  // coincidence, and (b) require
  // the missing + present pair to share a file extension — a `.png` deletion
  // pairing with a `.jpg` creation of the same size is never a true rename.
  if (relPathSize) {
    const missingBySize = new Map<number, FileChangeEvent[]>();
    const presentBySize = new Map<number, FileChangeEvent[]>();
    for (const c of correlatable) {
      if (suppressedKeys.has(`${c.type}:${c.filename}`)) continue;
      const sz = relPathSize(c.filename);
      if (sz === null) continue;
      // Below the floor only a content-hash match can pair (the hash gate
      // below always applies at this size when the probe is given). A typical
      // note is under 256 bytes, so without this a renamed note never pairs.
      // Two empty files match on anything, so they never pair.
      if (sz === 0) continue;
      if (sz < CROSS_BASENAME_MIN_SIZE_BYTES && !relPathHash) continue;
      if (relPathExists(c.filename)) {
        const b = presentBySize.get(sz) ?? [];
        b.push(c);
        presentBySize.set(sz, b);
      } else {
        const b = missingBySize.get(sz) ?? [];
        b.push(c);
        missingBySize.set(sz, b);
      }
    }
    for (const [sz, missingBucket] of missingBySize) {
      const presentBucket = presentBySize.get(sz);
      if (!presentBucket) continue;
      if (missingBucket.length !== 1 || presentBucket.length !== 1) continue;
      const m = missingBucket[0];
      const p = presentBucket[0];
      // length checks above guarantee both are defined; narrow for the type-checker.
      if (m === undefined || p === undefined) continue;
      if (m.type !== p.type) continue;
      if (replacesFile(p.filename, m.filename)) continue;
      // Exact same-extension OR both sides text-like (see
      // TEXT_LIKE_EXTENSIONS), so a `.txt` → `.md` retype still pairs.
      const mExt = extname(m.filename).toLowerCase();
      const pExt = extname(p.filename).toLowerCase();
      const sameExt = mExt === pExt;
      const bothTextLike = TEXT_LIKE_EXTENSIONS.has(mExt) && TEXT_LIKE_EXTENSIONS.has(pExt);
      if (!sameExt && !bothTextLike) continue;
      // Content-hash gate below the size threshold: two unrelated files of
      // identical length would otherwise pair. Only runs for at most one
      // missing + one present per size bucket. Opt-in via the probe; the
      // production watcher always passes it.
      if (relPathHash && sz < CROSS_BASENAME_HASH_REQUIRED_BELOW) {
        // Serialised awaits are fine: at most one candidate pair per bucket.
        const missingHash = await relPathHash(m.filename);
        const presentHash = await relPathHash(p.filename);
        if (!missingHash || !presentHash) continue;
        if (missingHash !== presentHash) continue;
      } else if (sz >= CROSS_BASENAME_HASH_REQUIRED_BELOW) {
        // Above the hash ceiling there's neither a hash nor a basename
        // anchor, so two unrelated same-size large files would silently
        // merge tile references. Refuse cross-basename pairing entirely;
        // same-basename moves still pair above, and a large rename WITH a
        // basename change is recoverable via the broken-tile relink.
        continue;
      }
      const cc = conflictCopyOf(p.filename, m.filename);
      if (cc) {
        // Both events flow on as delete + create (the delete prompt is
        // non-destructive by default); the renderer gets a notice.
        conflicts.push({ copyPath: p.filename, canonicalPath: m.filename, client: cc.client });
        continue;
      }
      renames.push({ oldPath: m.filename, newPath: p.filename });
      suppressedKeys.add(`${m.type}:${m.filename}`);
      suppressedKeys.add(`${p.type}:${p.filename}`);
    }
  }

  const filtered = events.filter(c => !suppressedKeys.has(`${c.type}:${c.filename}`));
  return { filtered, renames, conflicts };
}
