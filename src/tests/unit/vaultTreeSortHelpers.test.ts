/**
 * Coverage for the vaultTreeSort helpers the original suite
 * (`vaultTreeSort.test.ts`) doesn't reach: every `compareByField` arm,
 * grouped secondary sort, manual order with unknown children, and the
 * filter / path helpers used by the sidebar.
 */
import { describe, it, expect } from 'vitest';
import type { FileTreeNode } from '../../shared/types';
import {
  compareByField,
  sortTree,
  filterTree,
  treesEqual,
  flattenTreePaths,
  directoryExistsInTree,
  type SortConfig,
} from '@renderer/lib/vault/vaultTreeSort';
import { toVaultRelative } from '@renderer/lib/utils/path';

function file(name: string, opts: Partial<FileTreeNode> = {}): FileTreeNode {
  return {
    name,
    path: `/vault/${name}`,
    isDirectory: false,
    extension: `.${name.split('.').pop()}`,
    ...opts,
  };
}

function folder(name: string, children: FileTreeNode[] = [], opts: Partial<FileTreeNode> = {}): FileTreeNode {
  return { name, path: `/vault/${name}`, isDirectory: true, children, ...opts };
}

const cfg = (over: Partial<SortConfig> = {}): SortConfig => ({
  sortField: 'name',
  sortDirection: 'asc',
  groupField: 'none',
  groupDirection: 'asc',
  ...over,
});

const names = (nodes: FileTreeNode[]): string[] => nodes.map((n) => n.name);

describe('compareByField', () => {
  it('sorts two folders by name regardless of field, honouring direction', () => {
    const a = folder('a');
    const b = folder('b');
    expect(compareByField(a, b, 'size', 'asc')).toBeLessThan(0);
    expect(compareByField(a, b, 'size', 'desc')).toBeGreaterThan(0);
  });

  it("returns 0 for 'none'", () => {
    expect(compareByField(file('a.md'), file('b.md'), 'none', 'asc')).toBe(0);
  });

  it('compares by name both directions', () => {
    expect(compareByField(file('a.md'), file('b.md'), 'name', 'asc')).toBeLessThan(0);
    expect(compareByField(file('a.md'), file('b.md'), 'name', 'desc')).toBeGreaterThan(0);
  });

  it('compares by modified time, treating missing as 0', () => {
    const old = file('a.md', { modifiedAt: 1 });
    const fresh = file('b.md', { modifiedAt: 5 });
    const none = file('c.md', { modifiedAt: undefined });
    expect(compareByField(old, fresh, 'modified', 'asc')).toBeLessThan(0);
    expect(compareByField(old, fresh, 'modified', 'desc')).toBeGreaterThan(0);
    expect(compareByField(none, old, 'modified', 'asc')).toBeLessThan(0);
    expect(compareByField(old, none, 'modified', 'asc')).toBeGreaterThan(0);
  });

  it('compares by size, treating missing as 0', () => {
    const small = file('a.md', { sizeBytes: 1 });
    const none = file('b.md', { sizeBytes: undefined });
    expect(compareByField(none, small, 'size', 'asc')).toBeLessThan(0);
    expect(compareByField(small, none, 'size', 'asc')).toBeGreaterThan(0);
  });

  it('compares by extension case-insensitively, tie-breaking on name', () => {
    const md = file('z.md', { extension: '.MD' });
    const png = file('a.png');
    const md2 = file('a.md');
    const noExt = file('README', { extension: undefined });
    expect(compareByField(md, png, 'type', 'asc')).toBeLessThan(0);
    expect(compareByField(md2, md, 'type', 'asc')).toBeLessThan(0);
    expect(compareByField(md2, md, 'type', 'desc')).toBeGreaterThan(0);
    expect(compareByField(noExt, md2, 'type', 'asc')).toBeLessThan(0);
    expect(compareByField(md2, noExt, 'type', 'asc')).toBeGreaterThan(0);
  });
});

describe('sortTree', () => {
  it('puts folders first then sorts files by the primary field', () => {
    const out = sortTree([file('b.md'), folder('z'), file('a.md'), folder('y')], cfg());
    expect(names(out)).toEqual(['y', 'z', 'a.md', 'b.md']);
  });

  it('uses the group field as a secondary sort for primary ties', () => {
    const nodes = [
      file('b.md', { sizeBytes: 10 }),
      file('a.png', { sizeBytes: 10 }),
      file('c.md', { sizeBytes: 5 }),
    ];
    const out = sortTree(nodes, cfg({ sortField: 'size', groupField: 'name', groupDirection: 'desc' }));
    expect(names(out)).toEqual(['c.md', 'b.md', 'a.png']);
  });

  it('leaves primary ties in input order when groupField is none', () => {
    const nodes = [file('b.md', { sizeBytes: 10 }), file('a.md', { sizeBytes: 10 })];
    expect(names(sortTree(nodes, cfg({ sortField: 'size' })))).toEqual(['b.md', 'a.md']);
  });

  it('returns the same array when nothing changes (identity preserved)', () => {
    const nodes = [folder('a', [file('x.md', { path: '/vault/a/x.md' })]), file('b.md')];
    expect(sortTree(nodes, cfg())).toBe(nodes);
  });

  it('returns a new directory node when its children re-sort', () => {
    const child = [file('b.md', { path: '/vault/d/b.md' }), file('a.md', { path: '/vault/d/a.md' })];
    const dir = folder('d', child);
    const out = sortTree([dir], cfg());
    expect(out).not.toBe([dir]);
    expect(out[0]).not.toBe(dir);
    expect(names(out[0]?.children ?? [])).toEqual(['a.md', 'b.md']);
  });

  it("manual order ('none') ranks known children and leaves unknown ones last, folders first", () => {
    const nodes = [file('c.md'), file('a.md'), folder('f'), file('b.md')];
    const out = sortTree(
      nodes,
      cfg({ sortField: 'none', manualOrder: { '': ['/vault/b.md', '/vault/a.md'] } }),
    );
    expect(names(out)).toEqual(['f', 'b.md', 'a.md', 'c.md']);
  });

  it("manual order ('none') with no recorded order still leads with folders", () => {
    const out = sortTree([file('a.md'), folder('f'), file('b.md'), folder('g')], cfg({ sortField: 'none' }));
    expect(names(out)).toEqual(['f', 'g', 'a.md', 'b.md']);
  });

  it("manual order ('none') treats an empty recorded order like no order", () => {
    const out = sortTree([file('a.md'), folder('f')], cfg({ sortField: 'none', manualOrder: { '': [] } }));
    expect(names(out)).toEqual(['f', 'a.md']);
  });
});

describe('filterTree', () => {
  const tree = [
    folder('Notes', [file('Plan.md', { path: '/vault/Notes/Plan.md' }), file('x.md', { path: '/vault/Notes/x.md' })]),
    folder('Empty', [file('other.md', { path: '/vault/Empty/other.md' })]),
    folder('NoChildren', undefined),
    file('plan-b.md'),
    file('zzz.md'),
  ];

  it('returns the input untouched for an empty query', () => {
    expect(filterTree(tree, '')).toBe(tree);
  });

  it('keeps case-insensitive matches and prunes folders with no matches', () => {
    const out = filterTree(tree, 'PLAN');
    expect(names(out)).toEqual(['Notes', 'plan-b.md']);
    expect(names(out[0]?.children ?? [])).toEqual(['Plan.md']);
  });
});

describe('treesEqual', () => {
  it('detects length, path, isDirectory, name and child differences', () => {
    const base = [folder('a', [file('x.md')])];
    expect(treesEqual(base, [])).toBe(false);
    expect(treesEqual(base, [folder('a', [file('x.md')], { path: '/other' })])).toBe(false);
    expect(treesEqual(base, [{ ...folder('a', [file('x.md')]), isDirectory: false }])).toBe(false);
    expect(treesEqual(base, [folder('a', [file('x.md')], { name: 'b' })])).toBe(false);
    expect(treesEqual(base, [folder('a', [file('y.md')])])).toBe(false);
    expect(treesEqual(base, [folder('a', [file('x.md')])])).toBe(true);
    expect(treesEqual([file('a.md')], [file('a.md')])).toBe(true);
  });
});

describe('toVaultRelative', () => {
  it('returns null without a vault path', () => {
    expect(toVaultRelative('/vault/a.md', '')).toBeNull();
  });

  it('returns empty string for the root itself (case-insensitive)', () => {
    expect(toVaultRelative('/Vault', '/vault')).toBe('');
  });

  it('returns the relative path for a child and null outside the vault', () => {
    expect(toVaultRelative('C:\\Vault\\Notes\\A.md', 'C:\\vault')).toBe('Notes/A.md');
    expect(toVaultRelative('/elsewhere/a.md', '/vault')).toBeNull();
    expect(toVaultRelative('/vault-other/a.md', '/vault')).toBeNull();
  });
});

describe('flattenTreePaths', () => {
  it('collects relative file paths under the root, skipping folders and outsiders', () => {
    const tree = [
      folder('Notes', [file('A.md', { path: '/Vault/Notes/A.md' })], { path: '/Vault/Notes' }),
      file('b.md', { path: '/Vault/b.md' }),
      file('out.md', { path: '/elsewhere/out.md' }),
    ];
    expect([...flattenTreePaths(tree, '/vault')].sort()).toEqual(['Notes/A.md', 'b.md']);
  });
});

describe('directoryExistsInTree', () => {
  const tree = [
    folder('Notes', [folder('Deep', [], { path: '/vault/Notes/Deep' })], { path: '/vault/Notes' }),
    file('Deep', { path: '/vault/File' }),
  ];

  it('finds a nested directory case-insensitively', () => {
    expect(directoryExistsInTree(tree, '/VAULT/notes/deep')).toBe(true);
  });

  it('does not match a file or a missing path', () => {
    expect(directoryExistsInTree(tree, '/vault/File')).toBe(false);
    expect(directoryExistsInTree(tree, '/vault/Missing')).toBe(false);
  });
});
