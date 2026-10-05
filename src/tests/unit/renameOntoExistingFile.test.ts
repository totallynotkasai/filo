/**
 * A move can't land on an existing file without replacing it. So when the
 * watcher knew the "present" path held a file before the batch, the pair is
 * that file changed and the other gone, never a rename: pairing them handed
 * the replaced note's views and queued typing to the moved note, and the
 * typing was written over the moved text. A case-only rename still pairs.
 */
import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(filename: string): FileChangeEvent {
  return { type: 'document', filename, eventType: 'rename' };
}

const HASH = 'a'.repeat(40);
const sizeOf = (): number => 480;
const hashOf = (): string => HASH;

describe('correlateRenames and a path that already held a file', () => {
  it('A renamed over B (a known file) is A gone and B changed', async () => {
    const res = await correlateRenames(
      [ev('A.md'), ev('B.md')],
      (p) => p === 'B.md',
      sizeOf,
      hashOf,
      true,
      [],
      (p) => p === 'B.md' || p === 'A.md',
    );
    expect(res.renames).toEqual([]);
    expect(res.filtered.map((e) => e.filename)).toEqual(['A.md', 'B.md']);
  });

  it('the same move onto a free name pairs', async () => {
    const res = await correlateRenames([ev('A.md'), ev('C.md')], (p) => p === 'C.md', sizeOf, hashOf, true, [], (p) => p === 'A.md');
    expect(res.renames).toEqual([{ oldPath: 'A.md', newPath: 'C.md' }]);
  });

  it('a move into another folder onto a same-named known file is refused too', async () => {
    const res = await correlateRenames(
      [ev('Old/Plan.md'), ev('New/Plan.md')],
      (p) => p === 'New/Plan.md',
      sizeOf,
      hashOf,
      true,
      [],
      () => true,
    );
    expect(res.renames).toEqual([]);
  });

  it('a case-only rename on a case-sensitive disk still pairs, though both spellings are "known"', async () => {
    const res = await correlateRenames([ev('notes.md'), ev('Notes.md')], (p) => p === 'Notes.md', sizeOf, hashOf, false, [], () => true);
    expect(res.renames).toEqual([{ oldPath: 'notes.md', newPath: 'Notes.md' }]);
  });

  it('without the probe (older callers), nothing changes', async () => {
    const res = await correlateRenames([ev('A.md'), ev('B.md')], (p) => p === 'B.md', sizeOf, hashOf, true, []);
    expect(res.renames).toEqual([{ oldPath: 'A.md', newPath: 'B.md' }]);
  });
});
