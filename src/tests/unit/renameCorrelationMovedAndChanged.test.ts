/**
 * A note another program moves to a free path and changes in the same moment
 * (an agent moving `Plot.md` into a new folder and fixing its links) is a
 * move, not a delete plus a create: the bytes differ, but the name is the
 * same and nothing was at the new path. The new path is reported as changed
 * too, so the moved note meets the edit.
 */
import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(filename: string, type: FileChangeEvent['type'] = 'document'): FileChangeEvent {
  return { type, filename, eventType: 'rename' };
}

const sizes: Record<string, number> = { 'Plot.md': 480, '01 Story/Plot.md': 495 };
const sizeOf = (p: string): number | null => sizes[p] ?? null;
const hashOf = (p: string): string => `hash-of-${p}`;
const free = (): boolean => false;

describe('correlateRenames: a note moved and changed at once', () => {
  it('pairs a same-named note moved to a free path although its bytes changed, and names the new path as changed', async () => {
    const res = await correlateRenames([ev('Plot.md'), ev('01 Story/Plot.md')], (p) => p === '01 Story/Plot.md', sizeOf, hashOf, true, [], free);
    expect(res.renames).toEqual([{ oldPath: 'Plot.md', newPath: '01 Story/Plot.md' }]);
    expect(res.changedOnMove).toEqual(['01 Story/Plot.md']);
    expect(res.filtered).toEqual([]);
  });

  it('a move that kept its bytes is not named as changed', async () => {
    const res = await correlateRenames([ev('Plot.md'), ev('01 Story/Plot.md')], (p) => p === '01 Story/Plot.md', () => 480, () => 'same', true, [], free);
    expect(res.renames).toHaveLength(1);
    expect(res.changedOnMove).toEqual([]);
  });

  it('is not a move onto a path that already held a file (a merge into a same-named note)', async () => {
    const res = await correlateRenames(
      [ev('Ideas/Plot.md'), ev('Story/Plot.md')],
      (p) => p === 'Story/Plot.md',
      sizeOf,
      hashOf,
      true,
      [],
      (p) => p === 'Story/Plot.md' || p === 'Ideas/Plot.md',
    );
    expect(res.renames).toEqual([]);
    expect(res.changedOnMove).toEqual([]);
  });

  it('an empty new note is a new placeholder, not the old note moved', async () => {
    const res = await correlateRenames([ev('Plot.md'), ev('01 Story/Plot.md')], (p) => p === '01 Story/Plot.md', (p) => (p === 'Plot.md' ? 480 : 0), hashOf, true, [], free);
    expect(res.renames).toEqual([]);
  });

  it('only notes: a board or an attachment whose bytes changed still needs them to match', async () => {
    const board = await correlateRenames(
      [ev('Plan.board.json', 'board'), ev('Boards/Plan.board.json', 'board')],
      (p) => p.startsWith('Boards/'),
      (p) => (p.startsWith('Boards/') ? 900 : 800),
      hashOf,
      true,
      [],
      free,
    );
    expect(board.renames).toEqual([]);
    const image = await correlateRenames(
      [ev('a.png', 'attachment'), ev('img/a.png', 'attachment')],
      (p) => p.startsWith('img/'),
      (p) => (p.startsWith('img/') ? 900 : 800),
      hashOf,
      true,
      [],
      free,
    );
    expect(image.renames).toEqual([]);
  });

  it('two candidates for the same name stay a delete and creates', async () => {
    const res = await correlateRenames(
      [ev('Plot.md'), ev('A/Plot.md'), ev('B/Plot.md')],
      (p) => p !== 'Plot.md',
      () => 500,
      hashOf,
      true,
      [],
      free,
    );
    expect(res.renames).toEqual([]);
  });

  it('without the presence probe (older callers), a changed same-named pair is still refused', async () => {
    const res = await correlateRenames([ev('Plot.md'), ev('01 Story/Plot.md')], (p) => p === '01 Story/Plot.md', sizeOf, hashOf, true, []);
    expect(res.renames).toEqual([]);
  });

  it('a sync conflict copy is still reported as one, not taken for a move', async () => {
    const res = await correlateRenames(
      [ev('Plot.md'), ev('Plot (conflicted copy 2026-10-08).md')],
      (p) => p !== 'Plot.md',
      sizeOf,
      hashOf,
      true,
      [],
      free,
    );
    expect(res.renames).toEqual([]);
  });
});
