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
  foldersOpenForSearch,
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

  it('lists files group by group, each group in the Sort By order', () => {
    const nodes = [
      file('b.md', { sizeBytes: 10 }),
      file('a.png', { sizeBytes: 10 }),
      file('c.md', { sizeBytes: 5 }),
      file('d.png', { sizeBytes: 1 }),
    ];
    // Grouped by type (.md before .png), sizes ascending inside each group.
    const out = sortTree(nodes, cfg({ sortField: 'size', groupField: 'type' }));
    expect(names(out)).toEqual(['c.md', 'b.md', 'd.png', 'a.png']);
    const desc = sortTree(nodes, cfg({ sortField: 'size', groupField: 'type', groupDirection: 'desc' }));
    expect(names(desc)).toEqual(['d.png', 'a.png', 'c.md', 'b.md']);
  });

  it('breaks primary ties by name when groupField is none, so the order never depends on arrival', () => {
    const nodes = [file('b.md', { sizeBytes: 10 }), file('a.md', { sizeBytes: 10 })];
    expect(names(sortTree(nodes, cfg({ sortField: 'size' })))).toEqual(['a.md', 'b.md']);
  });

  it('under Sort By None, a folder never reordered by hand lists by name in natural order, and new files follow the hand-made order that way', () => {
    // The raw listing's order (Windows lists 1, 10, 2).
    const nodes = [file('Chapter 1.md'), file('Chapter 10.md'), file('Chapter 2.md'), folder('Part 10'), folder('Part 2')];
    expect(names(sortTree(nodes, cfg({ sortField: 'none' })))).toEqual(['Part 2', 'Part 10', 'Chapter 1.md', 'Chapter 2.md', 'Chapter 10.md']);
    const placed = sortTree(nodes, cfg({ sortField: 'none', manualOrder: { '': ['/vault/Chapter 10.md'] } }));
    expect(names(placed)).toEqual(['Part 2', 'Part 10', 'Chapter 10.md', 'Chapter 1.md', 'Chapter 2.md']);
  });

  it('puts "Chapter 2" before "Chapter 10", as File Explorer does', () => {
    const nodes = [file('Chapter 10.md'), file('Chapter 2.md'), file('chapter 1.md'), folder('Part 10'), folder('Part 9')];
    expect(names(sortTree(nodes, cfg()))).toEqual(['Part 9', 'Part 10', 'chapter 1.md', 'Chapter 2.md', 'Chapter 10.md']);
  });

  it('groups boards apart from other files under Group By Type, under any Sort By', () => {
    const nodes = [
      file('a.md', { extension: '.md' }),
      file('b.board.json', { extension: '.json' }),
      file('c.md', { extension: '.md' }),
      file('d.board.json', { extension: '.json' }),
      file('e.json', { extension: '.json' }),
    ];
    expect(names(sortTree(nodes, cfg({ groupField: 'type' })))).toEqual(['b.board.json', 'd.board.json', 'e.json', 'a.md', 'c.md']);
    // Under Sort By None, each group keeps the manual order.
    const manual = sortTree(nodes, cfg({ sortField: 'none', groupField: 'type', manualOrder: { '': ['/vault/c.md', '/vault/d.board.json'] } }));
    expect(names(manual)).toEqual(['d.board.json', 'b.board.json', 'e.json', 'c.md', 'a.md']);
  });

  it('groups names by first letter, dates by day and sizes by File Explorer bands', () => {
    const day = (d: number, h: number): number => new Date(2026, 9, d, h).getTime();
    const byName = sortTree(
      [file('beta.md', { sizeBytes: 1 }), file('Alpha.md', { sizeBytes: 9 }), file('apple.md', { sizeBytes: 5 }), file('2nd.md')],
      cfg({ sortField: 'size', groupField: 'name' }),
    );
    expect(names(byName)).toEqual(['2nd.md', 'apple.md', 'Alpha.md', 'beta.md']);

    const byDay = sortTree(
      [file('late.md', { modifiedAt: day(5, 23) }), file('next.md', { modifiedAt: day(6, 1) }), file('early.md', { modifiedAt: day(5, 1) })],
      cfg({ sortField: 'name', groupField: 'modified', groupDirection: 'desc' }),
    );
    expect(names(byDay)).toEqual(['next.md', 'early.md', 'late.md']);

    const bySize = sortTree(
      [file('b.md', { sizeBytes: 2_000_000 }), file('a.md', { sizeBytes: 20_000 }), file('c.md', { sizeBytes: 900_000 }), file('z.md', { sizeBytes: 0 })],
      cfg({ sortField: 'name', groupField: 'size' }),
    );
    // Empty, then Small (16 KB to 1 MB: a, c by name), then Medium.
    expect(names(bySize)).toEqual(['z.md', 'a.md', 'c.md', 'b.md']);
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

  it('keeps a folder whose own name matches, with everything inside it', () => {
    const chapter = folder('Chapter 1 - Blah', [
      file('Opening scene.md', { path: '/vault/Chapter 1 - Blah/Opening scene.md' }),
      folder('Research', [file('Maps.md', { path: '/vault/Chapter 1 - Blah/Research/Maps.md' })], {
        path: '/vault/Chapter 1 - Blah/Research',
      }),
    ]);
    const out = filterTree([chapter, file('Other.md')], 'chapter 1');
    expect(out).toEqual([chapter]);
  });

  it("finds a note by its title as well as its file name, and opens the folders above it", () => {
    const titles: Record<string, string> = { '/vault/Kanban 1/New Card (7).md': 'The Siege' };
    const titleOf = (n: FileTreeNode): string | null => titles[n.path] ?? null;
    const board = folder('Kanban 1', [
      file('New Card (7).md', { path: '/vault/Kanban 1/New Card (7).md' }),
      file('New Card.md', { path: '/vault/Kanban 1/New Card.md' }),
    ], { path: '/vault/Kanban 1' });
    const out = filterTree([board, file('Siege notes.md')], 'siege', titleOf);
    expect(names(out)).toEqual(['Kanban 1', 'Siege notes.md']);
    expect(names(out[0]?.children ?? [])).toEqual(['New Card (7).md']);
    expect([...foldersOpenForSearch([board], 'siege', titleOf)]).toEqual(['/vault/Kanban 1']);
    // Without the titles, only the file name counts.
    expect(names(filterTree([board], 'siege'))).toEqual([]);
  });
});

describe('foldersOpenForSearch', () => {
  it('opens a matching folder and the folders above any match, not the folders inside a match', () => {
    const tree = [
      folder('Book', [
        folder('Chapter 1 - Blah', [
          folder('Research', [file('Maps.md', { path: '/vault/Book/Chapter 1 - Blah/Research/Maps.md' })], {
            path: '/vault/Book/Chapter 1 - Blah/Research',
          }),
          folder('Drafts', [file('chapter 1 draft.md', { path: '/vault/Book/Chapter 1 - Blah/Drafts/chapter 1 draft.md' })], {
            path: '/vault/Book/Chapter 1 - Blah/Drafts',
          }),
        ], { path: '/vault/Book/Chapter 1 - Blah' }),
      ]),
    ];
    expect([...foldersOpenForSearch(tree, 'Chapter 1')].sort()).toEqual([
      '/vault/Book',
      '/vault/Book/Chapter 1 - Blah',
      '/vault/Book/Chapter 1 - Blah/Drafts',
    ]);
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
