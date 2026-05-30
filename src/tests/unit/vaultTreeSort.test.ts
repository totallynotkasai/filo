import { describe, it, expect } from 'vitest';
import type { FileTreeNode } from '../../shared/types';
import {
  sortTree,
  treesEqual,
  type SortConfig,
} from '@renderer/lib/vault/vaultTreeSort';

function file(name: string, opts: Partial<FileTreeNode> = {}): FileTreeNode {
  return {
    name,
    path: opts.path ?? `/vault/${name}`,
    isDirectory: false,
    extension: opts.extension ?? `.${name.split('.').pop()}`,
    modifiedAt: opts.modifiedAt ?? 1000,
    sizeBytes: opts.sizeBytes ?? 100,
    ...opts,
  };
}

function folder(name: string, children: FileTreeNode[], opts: Partial<FileTreeNode> = {}): FileTreeNode {
  return {
    name,
    path: opts.path ?? `/vault/${name}`,
    isDirectory: true,
    children,
    ...opts,
  };
}

const baseCfg: SortConfig = {
  sortField: 'name',
  sortDirection: 'asc',
  groupField: 'none',
  groupDirection: 'asc',
};

describe('treesEqual — structural-only equality', () => {
  it('returns true when only modifiedAt differs', () => {
    const a = [file('a.md', { modifiedAt: 1000 })];
    const b = [file('a.md', { modifiedAt: 9999 })];
    expect(treesEqual(a, b)).toBe(true);
  });

  it('returns true when only sizeBytes differs', () => {
    const a = [file('a.md', { sizeBytes: 100 })];
    const b = [file('a.md', { sizeBytes: 99999 })];
    expect(treesEqual(a, b)).toBe(true);
  });

  it('returns false when a new file appears', () => {
    const a = [file('a.md')];
    const b = [file('a.md'), file('b.md', { path: '/vault/b.md' })];
    expect(treesEqual(a, b)).toBe(false);
  });

  it('returns false when a file is renamed', () => {
    const a = [file('a.md')];
    const b = [file('renamed.md', { path: '/vault/renamed.md' })];
    expect(treesEqual(a, b)).toBe(false);
  });

  it('recurses into folder children', () => {
    const a = [folder('docs', [file('x.md', { path: '/vault/docs/x.md' })])];
    const b = [folder('docs', [file('x.md', { path: '/vault/docs/x.md', modifiedAt: 5000 })])];
    expect(treesEqual(a, b)).toBe(true);

    const c = [folder('docs', [file('y.md', { path: '/vault/docs/y.md' })])];
    expect(treesEqual(a, c)).toBe(false);
  });
});

describe('sortTree — sortField: none with manualOrder', () => {
  it('uses the manualOrder map to order children when sortField is none', () => {
    const nodes = [
      file('a.md', { path: '/vault/a.md' }),
      file('b.md', { path: '/vault/b.md' }),
      file('c.md', { path: '/vault/c.md' }),
    ];
    const sorted = sortTree(nodes, {
      ...baseCfg,
      sortField: 'none',
      manualOrder: { '': ['/vault/c.md', '/vault/a.md', '/vault/b.md'] },
    });
    expect(sorted.map((n) => n.path)).toEqual([
      '/vault/c.md',
      '/vault/a.md',
      '/vault/b.md',
    ]);
  });

  it('appends unknown items to the bottom in stable input order', () => {
    const nodes = [
      file('a.md', { path: '/vault/a.md' }),
      file('b.md', { path: '/vault/b.md' }),
      file('new.md', { path: '/vault/new.md' }),
    ];
    const sorted = sortTree(nodes, {
      ...baseCfg,
      sortField: 'none',
      manualOrder: { '': ['/vault/b.md', '/vault/a.md'] },
    });
    expect(sorted.map((n) => n.path)).toEqual([
      '/vault/b.md',
      '/vault/a.md',
      '/vault/new.md',
    ]);
  });

  it('puts folders before files when sortField is none', () => {
    const nodes = [
      file('a.md', { path: '/vault/a.md' }),
      folder('zfolder', [], { path: '/vault/zfolder' }),
      file('b.md', { path: '/vault/b.md' }),
    ];
    const sorted = sortTree(nodes, {
      ...baseCfg,
      sortField: 'none',
      manualOrder: {},
    });
    expect(sorted[0].isDirectory).toBe(true);
  });

  it('returns the input reference unchanged when nothing reorders (identity)', () => {
    const nodes = [
      folder('aaa', [], { path: '/vault/aaa' }),
      file('b.md', { path: '/vault/b.md' }),
    ];
    const sorted = sortTree(nodes, baseCfg);
    // Already in (folder, file) order with name asc — no reordering needed,
    // so sortTree should hand back the input reference for keyed-each reuse.
    expect(sorted).toBe(nodes);
  });
});
