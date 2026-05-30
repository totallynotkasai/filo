import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(filename: string, type: FileChangeEvent['type'] = 'document'): FileChangeEvent {
  return { type, filename, eventType: 'rename' };
}

function existsAmong(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('correlateRenames — cross-folder move (delete + create) → single rename', () => {
  it('emits one rename and suppresses both source events when basenames match', async () => {
    const events = [ev('Foo.md'), ev('Notes/Foo.md')];
    // After the move, only Notes/Foo.md exists.
    const { filtered, renames } = await correlateRenames(events, existsAmong('Notes/Foo.md'));
    expect(renames).toEqual([{ oldPath: 'Foo.md', newPath: 'Notes/Foo.md' }]);
    expect(filtered).toEqual([]);
  });

  it('emits the rename even for deeply nested moves', async () => {
    const events = [ev('a/b/Inner.md'), ev('x/y/Inner.md')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('x/y/Inner.md'));
    expect(renames).toEqual([{ oldPath: 'a/b/Inner.md', newPath: 'x/y/Inner.md' }]);
    expect(filtered).toEqual([]);
  });

  it('correlates a board file rename (.board.json) too', async () => {
    const events = [ev('Old.board.json', 'board'), ev('Sub/Old.board.json', 'board')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('Sub/Old.board.json'));
    expect(renames).toEqual([{ oldPath: 'Old.board.json', newPath: 'Sub/Old.board.json' }]);
    expect(filtered).toEqual([]);
  });
});

describe('correlateRenames — non-rename cases pass through unchanged', () => {
  it('passes through events with different basenames', async () => {
    const events = [ev('Foo.md'), ev('Notes/Bar.md')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('Foo.md', 'Notes/Bar.md'));
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('passes through a single event (no possible rename)', async () => {
    const events = [ev('Foo.md')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('Foo.md'));
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('does not correlate config / tree types', async () => {
    const events = [
      ev('.filo/x.json', 'config'),
      ev('.filo/sub/x.json', 'config'),
    ];
    const { filtered, renames } = await correlateRenames(events, existsAmong('.filo/sub/x.json'));
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });
});

describe('correlateRenames — attachments', () => {
  it('correlates an attachment cross-folder move by basename', async () => {
    const events = [
      ev('attachments/x.png', 'attachment'),
      ev('attachments/sub/x.png', 'attachment'),
    ];
    const { filtered, renames } = await correlateRenames(events, existsAmong('attachments/sub/x.png'));
    expect(renames).toEqual([{ oldPath: 'attachments/x.png', newPath: 'attachments/sub/x.png' }]);
    expect(filtered).toEqual([]);
  });
});

describe('correlateRenames — same-size heuristic for cross-basename renames', () => {
  function sizeAmong(map: Record<string, number>): (rel: string) => number | null {
    return (p) => (p in map ? map[p] : null);
  }

  it('pairs a single missing + single present of the same size and same type', async () => {
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    // Both files were once seen with size 512 (above the 256-byte min);
    // after the rename only Bar exists, but the cache still holds Foo's
    // last-known size.
    const sizes = sizeAmong({ 'Foo.md': 512, 'Bar.md': 512 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([{ oldPath: 'Foo.md', newPath: 'Bar.md' }]);
    expect(filtered).toEqual([]);
  });

  it('pairs a cross-folder cross-basename rename via the size heuristic', async () => {
    // The hardest case: both folder and basename change in one rename. The
    // same-basename pass cannot pair these (no shared basename); the size
    // pass must catch them. This is the cross-directory branch of P1-1.
    const events = [ev('notes/Old.md'), ev('archive/Renamed.md')];
    const exists = existsAmong('archive/Renamed.md');
    const sizes = sizeAmong({ 'notes/Old.md': 1234, 'archive/Renamed.md': 1234 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([
      { oldPath: 'notes/Old.md', newPath: 'archive/Renamed.md' },
    ]);
    expect(filtered).toEqual([]);
  });

  it('does NOT pair when sizes differ', async () => {
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes = sizeAmong({ 'Foo.md': 512, 'Bar.md': 1024 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('does NOT pair when a size has more than one missing + one present', async () => {
    const events = [ev('A.md'), ev('B.md'), ev('X.md'), ev('Y.md')];
    const exists = existsAmong('X.md', 'Y.md');
    // Two missing both 1024, two present both 1024 → ambiguous, pass through.
    const sizes = sizeAmong({ 'A.md': 1024, 'B.md': 1024, 'X.md': 1024, 'Y.md': 1024 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('does NOT pair across different change types (document vs board)', async () => {
    const events = [ev('Foo.md'), ev('Foo.board.json', 'board')];
    const exists = existsAmong('Foo.board.json');
    const sizes = sizeAmong({ 'Foo.md': 512, 'Foo.board.json': 512 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('does NOT pair below the cross-basename min size (Phase 19 S1)', async () => {
    // Two .md files of size 100 bytes each — well under the 256-byte floor.
    // Pre-Phase-19 this would have paired silently and rewritten tile
    // references to the wrong file.
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes = sizeAmong({ 'Foo.md': 100, 'Bar.md': 100 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('does NOT pair when extensions differ (Phase 19 S1)', async () => {
    // Two attachments of the same size but different extensions can't be a
    // single rename — an OS rename preserves the extension.
    const events = [
      ev('attachments/hero.png', 'attachment'),
      ev('attachments/banner.jpg', 'attachment'),
    ];
    const exists = existsAmong('attachments/banner.jpg');
    const sizes = sizeAmong({
      'attachments/hero.png': 4096,
      'attachments/banner.jpg': 4096,
    });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('Sprint B / B8 — pairs `.txt` → `.md` (text-like extension swap)', async () => {
    // A user retypes `Notes.txt` to `Notes.md` in their file manager — same
    // contents, different extension. The strict same-ext guard would force
    // a delete+create pair; the B8 exemption lets the correlator emit a
    // synthetic rename so tile references propagate without manual fix-up.
    const events = [ev('Notes.txt'), ev('Notes.md')];
    const exists = existsAmong('Notes.md');
    const sizes = sizeAmong({ 'Notes.txt': 4096, 'Notes.md': 4096 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([{ oldPath: 'Notes.txt', newPath: 'Notes.md' }]);
    expect(filtered).toEqual([]);
  });

  it('Sprint B / B8 — pairs `.markdown` → `.md` (text-like extension swap)', async () => {
    const events = [ev('Spec.markdown'), ev('Spec.md')];
    const exists = existsAmong('Spec.md');
    const sizes = sizeAmong({ 'Spec.markdown': 2048, 'Spec.md': 2048 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([{ oldPath: 'Spec.markdown', newPath: 'Spec.md' }]);
    expect(filtered).toEqual([]);
  });

  it('Sprint B / B8 — text-like exemption does NOT cross into binary formats', async () => {
    // `.png` is not in the text-like set, so a `.png` ↔ `.md` pair still
    // falls through as delete + create — guards against the broad ext
    // relaxation that Phase 19 S1 was designed to prevent.
    const events = [
      ev('hero.png', 'attachment'),
      ev('hero.md'),
    ];
    const exists = existsAmong('hero.md');
    const sizes = sizeAmong({ 'hero.png': 4096, 'hero.md': 4096 });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('still pairs cross-basename when both above min size and extensions match', async () => {
    // Regression for Phase 4's cross-basename heuristic — the Phase 19 floor
    // must not break legitimate large-file renames.
    const events = [ev('Notes/old name.md'), ev('Notes/new name.md')];
    const exists = existsAmong('Notes/new name.md');
    const sizes = sizeAmong({
      'Notes/old name.md': 4096,
      'Notes/new name.md': 4096,
    });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([
      { oldPath: 'Notes/old name.md', newPath: 'Notes/new name.md' },
    ]);
    expect(filtered).toEqual([]);
  });

  it('does NOT pair when relPathSize is omitted (back-compat)', async () => {
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const { renames } = await correlateRenames(events, exists);
    expect(renames).toEqual([]);
  });

  it('Phase 31 A4.3 — refuses to pair two same-size files with different content hashes', async () => {
    // Two unrelated .md files of identical byte length but different content.
    // Pre-A4.3 this would silently pair them and rewrite tile references to
    // the wrong file. The content-hash gate now refuses the pair.
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes = sizeAmong({ 'Foo.md': 1024, 'Bar.md': 1024 });
    const hashes = (rel: string): string | null => {
      if (rel === 'Foo.md') return 'aaaa1111';
      if (rel === 'Bar.md') return 'bbbb2222';
      return null;
    };
    const { renames, filtered } = await correlateRenames(events, exists, sizes, hashes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('Phase 31 A4.3 — pairs when content hashes match (legitimate cross-basename rename)', async () => {
    const events = [ev('OldName.md'), ev('NewName.md')];
    const exists = existsAmong('NewName.md');
    const sizes = sizeAmong({ 'OldName.md': 1024, 'NewName.md': 1024 });
    // Same hash on both — the user renamed the file without editing it.
    const hashes = (rel: string): string | null => {
      if (rel === 'OldName.md' || rel === 'NewName.md') return 'matchhash';
      return null;
    };
    const { renames, filtered } = await correlateRenames(events, exists, sizes, hashes);
    expect(renames).toEqual([{ oldPath: 'OldName.md', newPath: 'NewName.md' }]);
    expect(filtered).toEqual([]);
  });

  it('Sprint C / C-A5-3 — refuses cross-basename pairing for files >= 10 MB even when hash probe is provided', async () => {
    // Two large attachments of identical byte length and extension. The
    // hash probe is supplied (production fileWatcher always passes one)
    // but the size is above CROSS_BASENAME_HASH_REQUIRED_BELOW so the
    // hash check is bypassed; pre-Sprint-C this fell through to a silent
    // size-only pair, exposing tile references to silent merge across
    // unrelated >=10 MB files. The fix refuses cross-basename pairing
    // outright above the ceiling — large-file renames inside the same
    // basename still pair through the same-basename pass earlier.
    const tenMB = 10 * 1024 * 1024;
    const events = [
      ev('media/old.mp4', 'attachment'),
      ev('media/new.mp4', 'attachment'),
    ];
    const exists = existsAmong('media/new.mp4');
    const sizes = sizeAmong({
      'media/old.mp4': tenMB,
      'media/new.mp4': tenMB,
    });
    // Even with a hash probe present, sz >= ceiling → bypass hash → refuse
    // pair (this is the bug we're fixing).
    const hashes = (rel: string): string | null => {
      if (rel === 'media/old.mp4' || rel === 'media/new.mp4') return 'sharedhash';
      return null;
    };
    const { renames, filtered } = await correlateRenames(events, exists, sizes, hashes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('Sprint C / C-A5-3 — refuses cross-basename pairing for files >= 10 MB when no hash probe is provided', async () => {
    // Same scenario, but the caller omitted the hash probe — pre-Sprint-C
    // this also silently paired because the legacy 256-byte floor was the
    // only large-file guard. The new branch refuses regardless of probe.
    const tenMB = 10 * 1024 * 1024;
    const events = [
      ev('media/clip-A.mp4', 'attachment'),
      ev('media/clip-B.mp4', 'attachment'),
    ];
    const exists = existsAmong('media/clip-B.mp4');
    const sizes = sizeAmong({
      'media/clip-A.mp4': tenMB,
      'media/clip-B.mp4': tenMB,
    });
    const { renames, filtered } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('Sprint C / C-A5-3 — same-basename pairing of a 50 MB rename still works (cross-folder, basename preserved)', async () => {
    // The ceiling only affects the CROSS-basename pass. A large file whose
    // basename stays the same across a folder move still pairs via the
    // same-basename pass earlier, regardless of size.
    const fiftyMB = 50 * 1024 * 1024;
    const events = [
      ev('old-folder/movie.mp4', 'attachment'),
      ev('new-folder/movie.mp4', 'attachment'),
    ];
    const exists = existsAmong('new-folder/movie.mp4');
    const sizes = sizeAmong({
      'old-folder/movie.mp4': fiftyMB,
      'new-folder/movie.mp4': fiftyMB,
    });
    const { renames, filtered } = await correlateRenames(events, exists, sizes);
    expect(renames).toEqual([
      { oldPath: 'old-folder/movie.mp4', newPath: 'new-folder/movie.mp4' },
    ]);
    expect(filtered).toEqual([]);
  });

  it('first prefers same-basename pairing, falling back to size heuristic for leftovers', async () => {
    // Basename Foo.md matches across two paths (cross-folder rename) — that's
    // the first pass. Size heuristic doesn't kick in for them, but it still
    // pairs the unrelated Spec.md ↔ Spec2.md by size (above the 256-byte
    // floor and same extension).
    const events = [
      ev('Foo.md'),
      ev('Sub/Foo.md'),
      ev('Spec.md'),
      ev('Spec2.md'),
    ];
    const exists = existsAmong('Sub/Foo.md', 'Spec2.md');
    const sizes = sizeAmong({
      'Foo.md': 10,
      'Sub/Foo.md': 10,
      'Spec.md': 1024,
      'Spec2.md': 1024,
    });
    const { filtered, renames } = await correlateRenames(events, exists, sizes);
    expect(renames.sort((a, b) => a.oldPath.localeCompare(b.oldPath))).toEqual([
      { oldPath: 'Foo.md', newPath: 'Sub/Foo.md' },
      { oldPath: 'Spec.md', newPath: 'Spec2.md' },
    ]);
    expect(filtered).toEqual([]);
  });
});

describe('correlateRenames — Phase 31 B2.4 case-only rename', () => {
  const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

  it('pairs `foo.md` → `Foo.md` on case-insensitive filesystems (Win/macOS)', async () => {
    const events = [ev('foo.md'), ev('Foo.md')];
    // After the rename only Foo.md is present.
    const { filtered, renames } = await correlateRenames(events, existsAmong('Foo.md'));
    if (isCaseInsensitive) {
      expect(renames).toEqual([{ oldPath: 'foo.md', newPath: 'Foo.md' }]);
      expect(filtered).toEqual([]);
    } else {
      // On case-sensitive Linux these are genuinely different filenames
      // and the correlator must NOT pair them (would lose one if the
      // user intended to keep both).
      expect(renames).toEqual([]);
      expect(filtered).toEqual(events);
    }
  });
});

describe('correlateRenames — ambiguous batches fall back to delete + create', () => {
  it('falls back when two events with the same basename are both missing', async () => {
    const events = [ev('Foo.md'), ev('Notes/Foo.md')];
    // Both gone — neither exists after the flush.
    const { filtered, renames } = await correlateRenames(events, existsAmong());
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('falls back when two events with the same basename are both present', async () => {
    const events = [ev('Foo.md'), ev('Notes/Foo.md')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('Foo.md', 'Notes/Foo.md'));
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('falls back for three-or-more candidates with the same basename', async () => {
    const events = [ev('Foo.md'), ev('A/Foo.md'), ev('B/Foo.md')];
    const { filtered, renames } = await correlateRenames(events, existsAmong('A/Foo.md', 'B/Foo.md'));
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });
});
