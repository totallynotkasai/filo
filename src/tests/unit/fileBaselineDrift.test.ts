/**
 * fileBaselineRegistry — the (mtime, size) baseline the board and config
 * writers compare a pre-write stat against, so an external edit landing in
 * their read->write gap is surfaced instead of silently overwritten.
 *
 * The end-to-end board drift path (real main-side board IO + real fs.stat) is
 * pinned by boardFileEncodingRoundTrip.test.ts; notes don't use baselines (the
 * note writer compares bodies on a fresh read, see noteWriter.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  noteBaseline,
  baselineSeq,
  getBaseline,
  hasBaselineDrifted,
  refreshBaselineAfterWrite,
  __resetBaselinesForTests,
} from '../../renderer/lib/vault/fileBaselineRegistry';
import { renameAllPathKeys } from '../../renderer/lib/vault/renamePathKeys';
import { fireVaultSwap } from '../../renderer/core/vaultLifecycle';

describe('fileBaselineRegistry — drift', () => {
  it('an mtime change is drift', () => {
    expect(hasBaselineDrifted({ mtimeMs: 1000, size: 100 }, { mtimeMs: 2000, size: 100 })).toBe(true);
  });

  it('a size change alone is drift (coarse-mtime collision guard)', () => {
    expect(hasBaselineDrifted({ mtimeMs: 1000, size: 100 }, { mtimeMs: 1000, size: 101 })).toBe(true);
  });

  it('the same mtime and size is our own echo, not drift', () => {
    expect(hasBaselineDrifted({ mtimeMs: 1000, size: 100 }, { mtimeMs: 1000, size: 100 })).toBe(false);
  });
});

describe('fileBaselineRegistry — contract', () => {
  beforeEach(() => __resetBaselinesForTests());
  afterEach(() => __resetBaselinesForTests());

  it('exposes noteBaseline/getBaseline/clearBaseline contract', () => {
    expect(getBaseline('Notes/x.md')).toBeUndefined();
    noteBaseline('Notes/x.md', 1234, 100);
    expect(getBaseline('Notes/x.md')).toMatchObject({ mtimeMs: 1234, size: 100 });
    noteBaseline('Notes/x.md', 5678, 200);
    expect(getBaseline('Notes/x.md')).toMatchObject({ mtimeMs: 5678, size: 200 });
  });

  it('rejects non-finite mtimes (NaN, Infinity)', () => {
    noteBaseline('Notes/y.md', NaN, 100);
    expect(getBaseline('Notes/y.md')).toBeUndefined();
    noteBaseline('Notes/y.md', Infinity, 100);
    expect(getBaseline('Notes/y.md')).toBeUndefined();
  });

  it('rejects non-finite sizes (NaN, Infinity) — never seeds a half-populated baseline', () => {
    noteBaseline('Notes/s.md', 1000, NaN);
    expect(getBaseline('Notes/s.md')).toBeUndefined();
    noteBaseline('Notes/s.md', 1000, Infinity);
    expect(getBaseline('Notes/s.md')).toBeUndefined();
  });

  it('rejects empty path / null mtime / null size', () => {
    noteBaseline('', 1000, 100);
    expect(getBaseline('')).toBeUndefined();
    noteBaseline('Notes/z.md', null, 100);
    expect(getBaseline('Notes/z.md')).toBeUndefined();
    noteBaseline('Notes/z2.md', 1000, null);
    expect(getBaseline('Notes/z2.md')).toBeUndefined();
  });

  it('a failed post-write stat keeps the prior baseline (no unguarded next write)', () => {
    noteBaseline('b.board.json', 1000, 100);
    refreshBaselineAfterWrite('b.board.json', undefined, undefined);
    expect(getBaseline('b.board.json')).toMatchObject({ mtimeMs: 1000, size: 100 });
    refreshBaselineAfterWrite('b.board.json', 2000, 120);
    expect(getBaseline('b.board.json')).toMatchObject({ mtimeMs: 2000, size: 120 });
  });

  it('a rename moves the baseline, including a folder\'s descendants', () => {
    noteBaseline('Old/b.board.json', 1000, 100);
    renameAllPathKeys('Old', 'New');
    expect(getBaseline('Old/b.board.json')).toBeUndefined();
    expect(getBaseline('New/b.board.json')).toMatchObject({ mtimeMs: 1000, size: 100 });
  });

  it('a vault swap drops every baseline, so the next vault\'s same-named file is not compared with ours', async () => {
    noteBaseline('b.board.json', 1000, 100);
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: false });
    expect(getBaseline('b.board.json')).toBeUndefined();
  });
});

describe('fileBaselineRegistry — a reader never rolls the baseline back', () => {
  beforeEach(() => __resetBaselinesForTests());
  afterEach(() => __resetBaselinesForTests());

  it('a load that began before a self-write does not replace the baseline that write stamped', () => {
    // The load takes its ticket and stats the file as the create left it...
    const seq = baselineSeq('K.board.json');
    // ...a save lands and stamps the bytes it wrote...
    refreshBaselineAfterWrite('K.board.json', 2000, 300);
    // ...then the load's older stat arrives. Stamping it would make the next
    // save see its own previous write as an external edit.
    noteBaseline('K.board.json', 1000, 100, { ifUnchangedSince: seq });
    expect(getBaseline('K.board.json')).toMatchObject({ mtimeMs: 2000, size: 300 });
  });

  it('a load with no self-write in between stamps as usual', () => {
    refreshBaselineAfterWrite('K.board.json', 2000, 300);
    const seq = baselineSeq('K.board.json');
    noteBaseline('K.board.json', 3000, 310, { ifUnchangedSince: seq });
    expect(getBaseline('K.board.json')).toMatchObject({ mtimeMs: 3000, size: 310 });
  });

  it('a self-write whose stat failed still invalidates an in-flight reader', () => {
    noteBaseline('K.board.json', 1000, 100);
    const seq = baselineSeq('K.board.json');
    refreshBaselineAfterWrite('K.board.json', undefined, undefined);
    noteBaseline('K.board.json', 1500, 200, { ifUnchangedSince: seq });
    expect(getBaseline('K.board.json')).toMatchObject({ mtimeMs: 1000, size: 100 });
  });

  it('the ticket follows a rename: with no write since, the stamp lands on the new path', () => {
    refreshBaselineAfterWrite('Old/K.board.json', 2000, 300);
    const seq = baselineSeq('Old/K.board.json');
    renameAllPathKeys('Old', 'New');
    noteBaseline('New/K.board.json', 3000, 310, { ifUnchangedSince: seq });
    expect(getBaseline('New/K.board.json')).toMatchObject({ mtimeMs: 3000, size: 310 });
  });

  it('the ticket follows a rename: a write to the new path after the ticket still wins', () => {
    refreshBaselineAfterWrite('Old/K.board.json', 1500, 200);
    const seq = baselineSeq('Old/K.board.json');
    renameAllPathKeys('Old', 'New');
    refreshBaselineAfterWrite('New/K.board.json', 2000, 300);
    noteBaseline('New/K.board.json', 1000, 100, { ifUnchangedSince: seq });
    expect(getBaseline('New/K.board.json')).toMatchObject({ mtimeMs: 2000, size: 300 });
  });

  it('a write to another path does not block the stamp', () => {
    const seq = baselineSeq('K.board.json');
    refreshBaselineAfterWrite('Other.board.json', 2000, 300);
    noteBaseline('K.board.json', 1000, 100, { ifUnchangedSince: seq });
    expect(getBaseline('K.board.json')).toMatchObject({ mtimeMs: 1000, size: 100 });
  });
});
