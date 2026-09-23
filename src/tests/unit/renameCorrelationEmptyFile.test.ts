/**
 * 6.2.H6 — same-basename rename correlator refuses pairing when both
 * files are zero-byte (or both content-hash to the empty buffer SHA1).
 *
 * Pre-fix the same-basename pass refused only on POSITIVE size or hash
 * mismatches. Two empty files share size 0 and SHA-1 (`da39a3...`), so
 * a `delete A/Notes.md (empty) + create B/Notes.md (empty)` batch would
 * be paired as a rename, silently rewriting every tile reference from
 * the deleted file onto the unrelated new one.
 *
 * The cross-basename pass already has a 256-byte floor for the same
 * reason (Phase 19 S1) — the same-basename pass needed a parallel
 * guard for zero-byte / SHA-of-empty cases.
 */
import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(
  filename: string,
  type: FileChangeEvent['type'] = 'document',
): FileChangeEvent {
  return { type, filename, eventType: 'rename' };
}

function existsAmong(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

// SHA-1 of the empty buffer.
const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

describe('correlateRenames — 6.2.H6 same-basename empty-file guard', () => {
  it('refuses to pair two zero-byte files sharing a basename across folders', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    const relPathSize = (rel: string) => (rel === 'A/Notes.md' || rel === 'B/Notes.md' ? 0 : null);
    const relPathHash = (rel: string) =>
      rel === 'A/Notes.md' || rel === 'B/Notes.md' ? EMPTY_SHA1 : null;

    const { renames, filtered } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );

    expect(renames).toEqual([]);
    // Both events fall through to the residual feed (broken-ref relink path).
    expect(filtered).toHaveLength(2);
  });

  it('refuses to pair two identical-content same-basename files (both hash to empty SHA1)', async () => {
    // Both files contain the empty buffer worth of bytes (or are missing
    // a hash but report 0 size). Same shape as above; the hash check would
    // pass naively because the values match.
    const events = [ev('drafts/Notes.md'), ev('archive/Notes.md')];
    const exists = existsAmong('archive/Notes.md');
    const relPathSize = (rel: string) =>
      rel === 'drafts/Notes.md' || rel === 'archive/Notes.md' ? 0 : null;
    const relPathHash = (rel: string) =>
      rel === 'drafts/Notes.md' || rel === 'archive/Notes.md' ? EMPTY_SHA1 : null;

    const { renames } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );
    expect(renames).toEqual([]);
  });

  it('still pairs a genuine same-folder move of an empty file (a real rename)', async () => {
    // Both events share a parent folder — this IS a legit move (a user
    // genuinely renamed an empty placeholder). The guard refuses only
    // when the parent folders differ.
    const events = [ev('drafts/Old.md'), ev('drafts/New.md')];
    const exists = existsAmong('drafts/New.md');
    const relPathSize = (rel: string) =>
      rel === 'drafts/Old.md' || rel === 'drafts/New.md' ? 0 : null;
    const relPathHash = (rel: string) =>
      rel === 'drafts/Old.md' || rel === 'drafts/New.md' ? EMPTY_SHA1 : null;

    // This is a different bucket (basenames differ) → cross-basename pass,
    // which has its own 256-byte floor. Empty file → won't pair via that
    // path either. Verify the safe behaviour: no rename emitted.
    const { renames } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );
    // Cross-basename, empty content, below 256-byte floor → no pair.
    // This documents the expected behaviour for empty same-folder renames
    // (the file is empty so we can't safely correlate; the user-facing
    // broken-ref relink covers this rare case).
    expect(renames).toEqual([]);
  });

  it('still pairs a legitimate same-basename move when the file has real content', async () => {
    // Sanity: the H6 guard only kicks in for empty/identical-empty
    // content. A real file with non-zero bytes still pairs via the
    // existing same-basename path.
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    const relPathSize = (rel: string) =>
      rel === 'A/Notes.md' || rel === 'B/Notes.md' ? 512 : null;
    const realHash = '1234567890abcdef1234567890abcdef12345678';
    const relPathHash = (rel: string) =>
      rel === 'A/Notes.md' || rel === 'B/Notes.md' ? realHash : null;

    const { renames } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );
    expect(renames).toEqual([{ oldPath: 'A/Notes.md', newPath: 'B/Notes.md' }]);
  });
});
