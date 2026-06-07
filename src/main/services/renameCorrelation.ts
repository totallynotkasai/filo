import { basename, extname } from 'path';
import type { FileChangeEvent } from './fileWatcherTypes';

/**
 * Phase 31 B2.4 — case-only rename support. Windows and macOS are
 * case-insensitive by default, so renaming `foo.md` → `Foo.md` fires
 * watcher events under the two cases but the bucket key in `byBase`
 * (legacy: strict-case basename) split them into separate buckets and
 * never paired them. Lowercasing the bucket key on these platforms
 * lets the missing+present pair fire as a synthetic rename so tile
 * references propagate.
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
 * has a much higher prior of being a true rename.
 *
 * Phase 19 S1 — protects sync vaults (Dropbox/iCloud) where rename
 * correlation fires constantly: small files commonly collide on size and
 * silent mispairing would rewrite tile references / `.filo/tags.json` to
 * the wrong file.
 */
const CROSS_BASENAME_MIN_SIZE_BYTES = 256;

/**
 * Sprint B / B8 — extensions that are interchangeable when correlating a
 * cross-basename rename. A user retyping `Notes.txt` → `Notes.md` in their
 * file manager triggers a delete-of-old + create-of-new pair; if the file
 * has identical contents the size matches, and we want the correlator to
 * emit a single synthetic rename event so tile references propagate
 * automatically. The strict same-extension guard from Phase 19 S1 would
 * otherwise force a delete + create, breaking every tile that pointed at
 * the old file.
 *
 * The set is deliberately narrow: only formats Filo treats as "text-like
 * notes". Adding image formats (`.png` ↔ `.jpg`) here would re-introduce
 * the false-positive risk Phase 19 S1 was added to fix.
 */
const TEXT_LIKE_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);

/**
 * Phase 31 A4.3 — file-size threshold below which a hash-based content
 * match is required when a hash probe is provided. Files >=10 MB keep
 * size-only matching with the legacy 256-byte floor; large same-size
 * collisions are vanishingly rare in real vaults, and hashing multi-MB
 * files inside the per-watcher hot path is too expensive.
 */
const CROSS_BASENAME_HASH_REQUIRED_BELOW = 10 * 1024 * 1024;

/**
 * Audit2 2.1 — "balanced" content-identity check for a same-basename
 * missing+present pair before treating it as a rename.
 *
 * The same-basename pass pairs a 1-missing + 1-present bucket as a move, but
 * two *unrelated* files that merely share a basename across folders (the
 * textbook PKM layout — a `Notes.md` / `README.md` / `index.md` per folder)
 * deleted and created in a single watcher batch would otherwise be paired,
 * silently rewriting every tile reference from the deleted file onto the
 * unrelated new one (`propagateRename`) with no undo.
 *
 * A genuine move preserves bytes, so when size/hash are observable we require
 * them to match. The policy is deliberately *balanced*, not strict: refuse
 * only on a POSITIVE size or hash mismatch, and fall back to basename-only
 * pairing when a probe is absent or a side's value is uncached. That keeps a
 * cold cache (cold start before the first reconcile walk) and unhashed file
 * types from blocking a legitimate rename — the SHA-1 rename-hash cache is
 * seeded only for `.md` (see fileWatcher's reconcile walk), so attachments
 * and `.board.json` rely on the size match alone. Production always supplies
 * both probes; callers/tests that omit them keep the pre-2.1 behaviour.
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
  // 6.2.H6 — empty / identical-empty guard.
  //
  // Two files in DIFFERENT folders sharing a basename and both being
  // zero-byte (or both content-hashing to the empty buffer SHA1) is
  // overwhelmingly an unrelated delete + create pair, not a move — every
  // user's vault accumulates empty placeholder `Notes.md` / `README.md`
  // across folders. The pre-fix gate refused only on POSITIVE mismatches,
  // so two empties (same size 0, same SHA1) passed and we silently
  // rewrote every tile reference. The cross-basename pass had a 256-byte
  // floor that already covered this — the same-basename pass was missing
  // the parallel guard.
  //
  // Same-folder empty renames (`drafts/Old.md` → `drafts/New.md`) hit
  // the cross-basename pass with its own 256-byte floor, so an empty file
  // there also won't pair — the user-facing broken-ref relink covers
  // that rare case. We only refuse here when the parent folders DIFFER.
  const isEmpty = (mSize === 0 && pSize === 0) || (mHash === EMPTY_BUFFER_SHA1 && pHash === EMPTY_BUFFER_SHA1);
  if (isEmpty && parentFolder(missing.filename) !== parentFolder(present.filename)) {
    return false;
  }
  // Audit-4 DI-17 (cold-cache) — when BOTH probes were supplied (production
  // always supplies both) yet NEITHER could perform a comparison, we have zero
  // evidence the two same-basename files share bytes: the missing (old) side
  // was never observed, so its size AND hash are both unknown. A cold cache
  // (vault just opened, no reconcile walk yet, the old path never seen) is
  // exactly when identity is unknowable — pairing on basename alone here would
  // rewire tile `file`/`src`/`coverImage` refs (and `.filo/tags.json`) to a
  // possibly-unrelated file with no undo. Refuse: the pair falls through to
  // delete+create, recoverable via the broken-ref relink once the cache warms.
  // Probe-absent callers (legacy tests) keep the pre-2.1 basename-only pairing,
  // so this only tightens the production both-probes path.
  if (relPathSize && relPathHash) {
    const sizeComparable = mSize !== null && pSize !== null;
    const hashComparable = mHash !== null && pHash !== null;
    // A CONFIRMED content match is the strongest move signal — pair regardless
    // of size (even a tiny file with a real hash match is a genuine move). This
    // also exempts confirmed moves from the small-file floor below.
    if (hashComparable && mHash === pHash) return true;
    // DI-17 — neither size nor hash comparable ⇒ fully cold cache (missing side
    // never observed) ⇒ refuse rather than pair on basename alone.
    if (!sizeComparable && !hashComparable) return false;
    // L15 (Audit-6) — apply the cross-basename pass's small-file floor here too.
    // Without a positive hash match, an equal SIZE is the only signal, and tiny
    // files collide on size constantly (the per-folder Notes.md / README.md /
    // index.md layout), so a <256-byte same-basename "move" is more likely an
    // unrelated delete+create than a real move — refuse and let it surface as
    // delete+create (recoverable via the broken-ref relink). This is the
    // coincidence-prone band; a >=256-byte same-size pair keeps the balanced
    // size-only pairing (a moved attachment / .board.json is never hash-seeded,
    // and a large same-size+same-basename pair has a high move prior — see the
    // asymmetric-hash attachment-move test). Equal-size only: an unequal size is
    // already refused above.
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
 *      event share a size, the same `type`, AND the same file extension
 *      AND the size is ≥ {@link CROSS_BASENAME_MIN_SIZE_BYTES}, attempt
 *      to pair them. Phase 31 A4.3 adds a content-hash gate: for files
 *      smaller than `CROSS_BASENAME_HASH_REQUIRED_BELOW` the pair MUST
 *      have matching `relPathHash` values (the missing side's hash is
 *      retrieved from `relPathHash`'s cache; the present side is hashed
 *      from disk). Without the hash gate, two unrelated files of the
 *      same size + extension would silently merge tile references on
 *      rename — exactly the false-positive Phase 19 S1 was added to fix,
 *      now extended below the 256-byte floor to the 10 MB ceiling.
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
   * Polish phase 1.4 — accepts either a sync probe (legacy tests) or a
   * Promise-returning probe (production fileWatcher's async hash with
   * concurrency-bounded fs.promises.readFile). The body awaits the
   * return value, so a Promise resolves naturally; a sync probe's
   * non-Promise return value works under the await operator unchanged.
   */
  relPathHash?: (relPath: string) => string | null | Promise<string | null>,
  /**
   * Phase A.2 — test-only override for the platform-detected
   * case-insensitive flag. Defaults to the module constant so production
   * callers don't need to pass anything. Lets tests exercise both
   * partition branches on any host CI runner.
   */
  caseInsensitiveFs: boolean = DEFAULT_CASE_INSENSITIVE_FS,
): Promise<{
  filtered: FileChangeEvent[];
  renames: Array<{ oldPath: string; newPath: string }>;
}> {
  const renames: Array<{ oldPath: string; newPath: string }> = [];
  const suppressedKeys = new Set<string>();
  const byBase: Map<string, FileChangeEvent[]> = new Map();
  const correlatable: FileChangeEvent[] = [];
  for (const c of events) {
    if (c.type !== 'document' && c.type !== 'board' && c.type !== 'attachment') continue;
    correlatable.push(c);
    // Phase 31 B2.4 — bucket by case-folded basename on case-insensitive
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
      // Audit2 2.1 — gate the same-basename pair on a content-identity check
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
        if (await sameBasenameBytesPreserved(miss, pres, relPathSize, relPathHash)) {
          renames.push({ oldPath: miss.filename, newPath: pres.filename });
          suppressedKeys.add(`${miss.type}:${miss.filename}`);
          suppressedKeys.add(`${pres.type}:${pres.filename}`);
        }
      }
      continue;
    }
    // Phase A.2 — case-only rename on a case-insensitive filesystem.
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
  // additional guards (Phase 19 S1) suppress the most common false positives
  // on sync vaults: (a) skip files smaller than CROSS_BASENAME_MIN_SIZE_BYTES
  // because tiny files frequently share sizes by coincidence, and (b) require
  // the missing + present pair to share a file extension — a `.png` deletion
  // pairing with a `.jpg` creation of the same size is never a true rename.
  if (relPathSize) {
    const missingBySize = new Map<number, FileChangeEvent[]>();
    const presentBySize = new Map<number, FileChangeEvent[]>();
    for (const c of correlatable) {
      if (suppressedKeys.has(`${c.type}:${c.filename}`)) continue;
      const sz = relPathSize(c.filename);
      if (sz === null) continue;
      if (sz < CROSS_BASENAME_MIN_SIZE_BYTES) continue;
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
      // Sprint B / B8 — exact same-extension OR both sides in the
      // text-like set (`.md`, `.txt`, `.markdown`). A user retyping a
      // file extension from `.txt` to `.md` (common when adopting Filo
      // from a plain-text note tool) should still get a synthetic
      // rename so tile references propagate. The text-like exemption
      // is narrow on purpose — anything broader would re-introduce the
      // image/binary false-positive risk Phase 19 S1 was added to fix.
      const mExt = extname(m.filename).toLowerCase();
      const pExt = extname(p.filename).toLowerCase();
      const sameExt = mExt === pExt;
      const bothTextLike = TEXT_LIKE_EXTENSIONS.has(mExt) && TEXT_LIKE_EXTENSIONS.has(pExt);
      if (!sameExt && !bothTextLike) continue;
      // Phase 31 A4.3 — content-hash gate for files below the size
      // threshold. Two unrelated files of identical byte-length but
      // different content would silently pair without this; the
      // expensive part (computing the hash on disk) only runs for
      // the small set that actually reach this point — at most one
      // missing + one present per size bucket.
      //
      // Hash check is OPT-IN via the optional `relPathHash` probe so
      // existing tests (which exercise only the size-only path) keep
      // working. The production fileWatcher always passes the probe,
      // so the safety guard is active in real vaults — any caller
      // that omits the probe falls back to the legacy 256-byte floor.
      if (relPathHash && sz < CROSS_BASENAME_HASH_REQUIRED_BELOW) {
        // Polish phase 1.4 — `await` is harmless for sync probes
        // (Promise.resolve wraps), and serialises hash reads across
        // candidates. The watcher hot path bounds concurrency upstream
        // (see hashAsync semaphore in fileWatcher.notifyRenderers);
        // the iteration here is already tiny (one candidate per size
        // bucket) so the serialisation cost is negligible.
        const missingHash = await relPathHash(m.filename);
        const presentHash = await relPathHash(p.filename);
        if (!missingHash || !presentHash) continue;
        if (missingHash !== presentHash) continue;
      } else if (sz >= CROSS_BASENAME_HASH_REQUIRED_BELOW) {
        // Sprint C / C-A5-3 — above the hash ceiling we have neither a
        // hash nor a same-basename anchor: two unrelated >=10 MB files
        // with identical size + extension would silently merge tile
        // references (the legacy 256-byte floor offered no defence at
        // this scale). Refuse cross-basename pairing for large files
        // entirely. Renames of large media within the same basename
        // still pair through the same-basename pass earlier; the only
        // case lost is large-file rename WITH a basename change, which
        // is uncommon and recoverable via the broken-tile relink flow.
        //
        // The legacy 256-byte floor (still enforced at the bucket
        // population step) handles the lower bound; this branch closes
        // the upper bound. The mid-range (256 B–10 MB) keeps using the
        // hash gate above when a probe is supplied; a caller that
        // omits the probe still falls through to a size-only pair in
        // that range, matching the pre-existing test contract.
        continue;
      }
      renames.push({ oldPath: m.filename, newPath: p.filename });
      suppressedKeys.add(`${m.type}:${m.filename}`);
      suppressedKeys.add(`${p.type}:${p.filename}`);
    }
  }

  const filtered = events.filter(c => !suppressedKeys.has(`${c.type}:${c.filename}`));
  return { filtered, renames };
}
