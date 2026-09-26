import { describe, it, expect } from 'vitest';
import type { FileTreeNode } from '@shared/types';
import { vaultPath } from '@shared/vaultPath';
import {
  sameTag,
  tagMatchesFilter,
  filesMatchingTag,
  filterTreeToFiles,
} from '@renderer/lib/vault/sidebarTagFilter';

describe('tagMatchesFilter', () => {
  it('matches the tag and its child tags, ignoring case and a leading #', () => {
    expect(tagMatchesFilter('project', 'project')).toBe(true);
    expect(tagMatchesFilter('project/a', 'project')).toBe(true);
    expect(tagMatchesFilter('Project/A/b', '#project')).toBe(true);
    expect(tagMatchesFilter('projects', 'project')).toBe(false);
    expect(tagMatchesFilter('work/project', 'project')).toBe(false);
    expect(tagMatchesFilter('project', 'project/a')).toBe(false);
  });

  it('an empty filter matches nothing', () => {
    expect(tagMatchesFilter('x', '')).toBe(false);
  });

  it('sameTag folds case', () => {
    expect(sameTag('Work', 'work')).toBe(true);
    expect(sameTag('work', 'work/a')).toBe(false);
  });
});

describe('filesMatchingTag', () => {
  it('returns case-folded vault paths of the files carrying the tag or a child', () => {
    const set = filesMatchingTag('project', [
      { path: 'A.md', tags: ['project'] },
      { path: 'Sub/B.md', tags: ['misc', 'project/x'] },
      { path: 'C.md', tags: ['projects'] },
      { path: 'Media/Pic.PNG', tags: ['Project'] },
    ]);
    expect([...set].sort()).toEqual(['a.md', 'media/pic.png', 'sub/b.md']);
  });
});

const ROOT = 'C:\\Vault';
const file = (rel: string): FileTreeNode => ({
  name: rel.split('/').pop() ?? rel,
  path: `${ROOT}\\${rel.split('/').join('\\')}`,
  isDirectory: false,
});
const dir = (rel: string, children: FileTreeNode[]): FileTreeNode => ({
  ...file(rel),
  isDirectory: true,
  children,
});

describe('filterTreeToFiles', () => {
  const tree: FileTreeNode[] = [
    dir('Work', [
      dir('Work/Deep', [file('Work/Deep/Sub.md'), file('Work/Deep/Other.md')]),
      file('Work/Plan.md'),
    ]),
    dir('Empty', [file('Empty/Nope.md')]),
    file('Loose.md'),
    file('Untagged.md'),
  ];

  it('keeps the matching files and the folders above them, and drops folders with none', () => {
    const keep = new Set([vaultPath('work/deep/sub.md'), vaultPath('Loose.md')]);
    const out = filterTreeToFiles(tree, ROOT, keep);
    expect(out.map((n) => n.name)).toEqual(['Work', 'Loose.md']);
    const work = out[0];
    expect(work?.children?.map((n) => n.name)).toEqual(['Deep']);
    expect(work?.children?.[0]?.children?.map((n) => n.name)).toEqual(['Sub.md']);
  });

  it('does not change the input tree', () => {
    filterTreeToFiles(tree, ROOT, new Set([vaultPath('Loose.md')]));
    expect(tree[0]?.children).toHaveLength(2);
  });

  it('an empty set leaves nothing', () => {
    expect(filterTreeToFiles(tree, ROOT, new Set())).toEqual([]);
  });
});
