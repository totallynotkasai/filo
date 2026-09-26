import { describe, it, expect } from 'vitest';
import { filterTagNames, countTagUsage } from '@renderer/lib/tags/tagBrowserFilter';

const NAMES = ['home', 'misc', 'personal', 'personal/projects', 'work', 'work/project', 'work/project/q1'];

describe('filterTagNames', () => {
  it('an empty or blank query keeps every row', () => {
    expect(filterTagNames(NAMES, '')).toEqual(NAMES);
    expect(filterTagNames(NAMES, '   ')).toEqual(NAMES);
  });

  it('matches anywhere in the full path, ignoring case and a leading #', () => {
    expect(filterTagNames(NAMES, 'HOM')).toEqual(['home']);
    expect(filterTagNames(NAMES, '#misc')).toEqual(['misc']);
  });

  it('keeps the listed parents of a matching child, in list order', () => {
    expect(filterTagNames(NAMES, 'proj')).toEqual([
      'personal', 'personal/projects', 'work', 'work/project', 'work/project/q1',
    ]);
    expect(filterTagNames(NAMES, 'q1')).toEqual(['work', 'work/project', 'work/project/q1']);
  });

  it('does not invent a parent that is not a row', () => {
    expect(filterTagNames(['a/b'], 'b')).toEqual(['a/b']);
  });

  it('no match leaves nothing', () => {
    expect(filterTagNames(NAMES, 'zzz')).toEqual([]);
  });
});

describe('countTagUsage', () => {
  it('counts files and tiles per exact tag, once per carrier', () => {
    const counts = countTagUsage(
      [{ tags: ['a', 'b'] }, { tags: ['a', 'a'] }, { tags: [] }],
      [{ tags: ['b'] }, { tags: ['c', 'a'] }],
    );
    expect(counts.get('a')).toEqual({ files: 2, tiles: 1 });
    expect(counts.get('b')).toEqual({ files: 1, tiles: 1 });
    expect(counts.get('c')).toEqual({ files: 0, tiles: 1 });
    expect(counts.get('a/x')).toBeUndefined();
  });
});
