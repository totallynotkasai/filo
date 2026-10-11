/**
 * Case-only rename on a case-insensitive filesystem.
 *
 * The bucket key is folded on Win/macOS so `Notes.md` and `notes.md` land in
 * the same `byBase` bucket. But the partition into `missing[]` vs `present[]`
 * uses `relPathExists`, which on a case-insensitive FS returns true for BOTH
 * casings after the rename — because `statSync('notes.md')` and
 * `statSync('Notes.md')` both succeed. So the strict
 * `missing===1 && present===1` gate fails, no synthetic rename emits, and
 * every tile that referenced the file shows a broken-ref badge.
 *
 * The fix adds a fallback inside the per-bucket loop: when the bucket
 * has exactly two same-type events whose full paths differ only by
 * case, and we're on a case-insensitive filesystem, pair them by
 * emission order (the first event = oldPath, the second = newPath).
 *
 * The function takes an optional `caseInsensitiveFs` arg so tests can
 * exercise both branches on any host platform; production callers
 * default to the module-level `process.platform` detection.
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

/**
 * Case-insensitive existence probe: relPathExists returns true if any
 * casing of the path is in the set. Mirrors how statSync behaves on
 * Windows / macOS after a case-only rename.
 */
function existsCaseInsensitive(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
}

describe('correlateRenames — case-only rename', () => {
  it('case-insensitive FS pairs Notes.md ↔ notes.md when both watchers report present', async () => {
    // After `Notes.md` → `notes.md`, the OS fires events for BOTH
    // casings (Windows ReadDirectoryChangesW reports the OLD name as
    // deleted-by-rename and the NEW name as created-by-rename). On a
    // case-insensitive FS the existence probe sees both as present.
    const events = [ev('Notes.md'), ev('notes.md')];
    const exists = existsCaseInsensitive('notes.md');
    const { filtered, renames } = await correlateRenames(
      events,
      exists,
      undefined,
      undefined,
      true,
    );
    expect(renames).toEqual([{ oldPath: 'Notes.md', newPath: 'notes.md' }]);
    expect(filtered).toEqual([]);
  });

  it('case-sensitive FS does not pair two distinct casings (they are different files)', async () => {
    // On Linux, `Notes.md` and `notes.md` can genuinely co-exist as
    // separate files. The bucket key is strict-case, so they land in
    // SEPARATE buckets — neither passes the bucket.length >= 2 gate.
    const events = [ev('Notes.md'), ev('notes.md')];
    const exists = existsAmong('Notes.md', 'notes.md');
    const { filtered, renames } = await correlateRenames(
      events,
      exists,
      undefined,
      undefined,
      false,
    );
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('three-casing bucket is skipped (ambiguous, too many candidates)', async () => {
    // A multi-step rename (Notes.md → NOTES.md → notes.md) could produce
    // three events in the same case-folded bucket. We can't reliably
    // synthesize a rename from this — better to emit delete + create.
    const events = [ev('Notes.md'), ev('NOTES.md'), ev('notes.md')];
    const exists = existsCaseInsensitive('notes.md');
    const { renames } = await correlateRenames(
      events,
      exists,
      undefined,
      undefined,
      true,
    );
    expect(renames).toEqual([]);
  });

  it('genuine cross-basename rename still works (regression check)', async () => {
    // Renames where the basename changes (and case-only doesn't apply)
    // continue to flow through the cross-basename same-size pass.
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes: (rel: string) => number | null = (p) =>
      p === 'Foo.md' || p === 'Bar.md' ? 512 : null;
    const { renames } = await correlateRenames(events, exists, sizes, undefined, true);
    expect(renames).toEqual([{ oldPath: 'Foo.md', newPath: 'Bar.md' }]);
  });

  it('case-only fallback does not fire when the two events differ in type', async () => {
    // A `document` + `attachment` event in the same case-folded bucket
    // should not be paired even if their paths differ only by case.
    const events = [
      ev('image.png', 'document'),
      ev('Image.png', 'attachment'),
    ];
    const exists = existsCaseInsensitive('Image.png');
    const { renames } = await correlateRenames(
      events,
      exists,
      undefined,
      undefined,
      true,
    );
    expect(renames).toEqual([]);
  });

  it('case-only fallback does not fire when paths differ in directory case', async () => {
    // `Notes/foo.md` and `notes/foo.md` would case-fold to the SAME
    // bucket key (basenameKey only looks at the basename) but represent
    // EITHER (a) the same file on a case-insensitive FS, OR (b) two
    // different folders. Either way, the case-only fallback requires
    // the FULL paths to differ only by case (we check
    // `bucket[0].filename.toLowerCase() === bucket[1].filename.toLowerCase()`
    // AND `bucket[0].filename !== bucket[1].filename`). Same basename
    // in different parent directories has identical lowercase forms
    // only if the parents also differ by case — which is exactly the
    // case we DO want to handle (folder-level case-only rename of the
    // containing directory). Cover the negative case where the parent
    // differs by content, not just case.
    const events = [ev('Notes/foo.md'), ev('Other/foo.md')];
    const exists = existsAmong('Notes/foo.md', 'Other/foo.md');
    const { renames } = await correlateRenames(
      events,
      exists,
      undefined,
      undefined,
      true,
    );
    expect(renames).toEqual([]);
  });
});
