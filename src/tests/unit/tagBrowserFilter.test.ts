import { describe, it, expect } from 'vitest';
import { filterTagNames, countTagUsage, tagBrowserRows } from '@renderer/lib/tags/tagBrowserFilter';

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
  it('counts files and tiles per tag, once per carrier', () => {
    const counts = countTagUsage(
      [{ tags: ['a', 'b'] }, { tags: ['a', 'a'] }, { tags: [] }],
      [{ tags: ['b'] }, { tags: ['c', 'a'] }],
    );
    expect(counts.get('a')).toMatchObject({ files: 2, tiles: 1 });
    expect(counts.get('b')).toMatchObject({ files: 1, tiles: 1 });
    expect(counts.get('c')).toMatchObject({ files: 0, tiles: 1 });
    expect(counts.get('a/x')).toBeUndefined();
  });

  it('counts `Project` and `project` as one tag, once per carrier', () => {
    const counts = countTagUsage(
      [{ tags: ['Project'] }, { tags: ['project', 'Project'] }, { tags: ['project'] }],
      [{ tags: ['PROJECT'] }],
    );
    expect(counts.size).toBe(1);
    expect(counts.get('project')).toMatchObject({ files: 3, tiles: 1 });
  });
});

describe('tagBrowserRows', () => {
  it('shows one row per tag whatever its case, under the registered spelling', () => {
    const usage = countTagUsage([{ tags: ['project'] }, { tags: ['project'] }, { tags: ['Project'] }], []);
    expect(tagBrowserRows(['Project'], usage)).toEqual([{ name: 'Project', files: 3, tiles: 0 }]);
  });

  it('an unregistered tag shows the spelling most carriers use', () => {
    const usage = countTagUsage([{ tags: ['Idea'] }, { tags: ['idea'] }, { tags: ['idea'] }], [{ tags: ['IDEA'] }]);
    expect(tagBrowserRows([], usage)).toEqual([{ name: 'idea', files: 3, tiles: 1 }]);
  });

  it('keeps registered tags nobody uses, sorted by name', () => {
    expect(tagBrowserRows(['zeta', 'Alpha'], new Map())).toEqual([
      { name: 'Alpha', files: 0, tiles: 0 },
      { name: 'zeta', files: 0, tiles: 0 },
    ]);
  });
});
