/**
 * Cold-cache rename — the same-basename correlation pass
 * refuses to pair on basename alone when BOTH the size and hash probes are
 * supplied (the production configuration) yet NEITHER can perform an identity
 * comparison: the missing (old) side was never observed, so its size and hash
 * are both unknown.
 *
 * A cold cache (vault just opened, no reconcile walk yet, the old path never
 * seen) is exactly when file identity is unknowable. Pairing two same-basename
 * files across folders there would silently rewrite tile `file`/`src`/
 * `coverImage` refs (and `.filo/tags.json`) onto a possibly-unrelated file with
 * no undo. The safe outcome is delete+create, recoverable via the broken-ref
 * relink once the cache warms.
 *
 * Probe-absent / single-probe callers (legacy tests) keep the plain
 * basename-only pairing — the guard only tightens the both-probes path.
 */
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

describe('correlateRenames — cold-cache same-basename refusal', () => {
  it('refuses a same-basename pair when the old side has no observable size OR hash', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    // Missing (old) side never observed → null size + null hash (cold cache).
    // Present (new) side is observable, but that alone can't confirm identity.
    const relPathSize = (rel: string) => (rel === 'B/Notes.md' ? 4096 : null);
    const relPathHash = async (rel: string) =>
      rel === 'B/Notes.md' ? 'presenthashdeadbeef' : null;

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

  it('still pairs a same-basename move when the old side IS observable and matches (warm cache)', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    // Warm cache: both sides report the same (cached) size + hash.
    const relPathSize = () => 4096;
    const relPathHash = async () => 'sharedcontenthash';

    const { renames } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );

    expect(renames).toEqual([{ oldPath: 'A/Notes.md', newPath: 'B/Notes.md' }]);
  });

  it('still pairs on basename alone when NO probes are supplied (legacy callers, pre-2.1 behaviour)', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');

    const { renames } = await correlateRenames(events, exists, undefined, undefined, false);

    expect(renames).toEqual([{ oldPath: 'A/Notes.md', newPath: 'B/Notes.md' }]);
  });

  it('does not over-refuse when only a size probe is supplied (guard requires BOTH probes)', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    // Only a size probe; missing side null. The cold-cache guard needs both
    // probes to engage, so the balanced basename-only pairing is preserved.
    const relPathSize = (rel: string) => (rel === 'B/Notes.md' ? 4096 : null);

    const { renames } = await correlateRenames(events, exists, relPathSize, undefined, false);

    expect(renames).toEqual([{ oldPath: 'A/Notes.md', newPath: 'B/Notes.md' }]);
  });
});

describe('correlateRenames — small-file floor on the same-basename pass', () => {
  it('refuses a <256-byte same-basename pair with no hash corroboration (size coincidence)', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    // Coincidental equal size on two tiny unrelated files; no hash to corroborate.
    const relPathSize = () => 100;
    const relPathHash = async () => null;

    const { renames, filtered } = await correlateRenames(
      events,
      exists,
      relPathSize,
      relPathHash,
      false,
    );

    expect(renames).toEqual([]);
    expect(filtered).toHaveLength(2); // delete + create (broken-ref relink path)
  });

  it('still pairs a <256-byte same-basename move when the hashes positively match', async () => {
    const events = [ev('A/Notes.md'), ev('B/Notes.md')];
    const exists = existsAmong('B/Notes.md');
    const relPathSize = () => 100;
    // Confirmed identical content — a real move regardless of size.
    const relPathHash = async () => 'samecontenthash';

    const { renames } = await correlateRenames(events, exists, relPathSize, relPathHash, false);

    expect(renames).toEqual([{ oldPath: 'A/Notes.md', newPath: 'B/Notes.md' }]);
  });

  it('still pairs a >=256-byte same-basename move on size alone (documented attachment balance)', async () => {
    const events = [ev('A/photo.png', 'attachment'), ev('B/photo.png', 'attachment')];
    const exists = existsAmong('B/photo.png');
    const relPathSize = () => 4096; // above the floor
    const relPathHash = async () => null; // attachments are never hash-seeded

    const { renames } = await correlateRenames(events, exists, relPathSize, relPathHash, false);

    expect(renames).toEqual([{ oldPath: 'A/photo.png', newPath: 'B/photo.png' }]);
  });
});
