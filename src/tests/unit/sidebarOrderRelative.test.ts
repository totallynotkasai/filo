import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sidebarOrderStore } from '@renderer/stores/sidebarOrder.svelte';
import { sortTree } from '@renderer/lib/vault/vaultTreeSort';
import { flushAllMisc } from '@renderer/lib/boards/miscWriteScheduler';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileTreeNode } from '@shared/types';

/**
 * `.filo/sidebar-order.json` holds vault-relative paths, so the manual order
 * survives the vault being opened from another folder or synced to another
 * machine. A file written with absolute paths is still read.
 */

const ROOT = 'C:\\Users\\me\\Vault';
const OTHER_ROOT = 'D:/Sync/Vault';

function node(root: string, rel: string, isDirectory = false): FileTreeNode {
  return { name: rel.split('/').pop() ?? rel, path: `${root}\\${rel.replace(/\//g, '\\')}`, isDirectory } as FileTreeNode;
}

const cfg = (manualOrder: Record<string, string[]>): Parameters<typeof sortTree>[1] => ({
  sortField: 'none', sortDirection: 'asc', groupField: 'none', groupDirection: 'asc', manualOrder,
});

let saved: string[] = [];

beforeEach(() => {
  saved = [];
  __resetDirtyTrackingForTests();
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'config:save' && args[1] === 'sidebar-order.json') saved.push(String(args[2]));
    if (channel === 'vault:read-file-text') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return null;
  });
  setActiveVaultPath(ROOT);
  sidebarOrderStore.seed({}, ROOT);
});
afterEach(() => {
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('sidebar order file', () => {
  it('a reorder is written with vault-relative paths', async () => {
    sidebarOrderStore.set(ROOT, ROOT, [node(ROOT, 'b.md').path, node(ROOT, 'a.md').path]);
    sidebarOrderStore.set(ROOT, `${ROOT}\\Notes`, [node(ROOT, 'Notes/y.md').path, node(ROOT, 'Notes/x.md').path]);
    await flushAllMisc();
    expect(JSON.parse(saved.at(-1) ?? '{}')).toEqual({ '': ['b.md', 'a.md'], Notes: ['Notes/y.md', 'Notes/x.md'] });
  });

  it('a relative file orders the tree wherever the vault is opened', () => {
    const file = { '': ['b.md', 'a.md'], Notes: ['Notes/y.md', 'Notes/x.md'] };
    sidebarOrderStore.seed(file, OTHER_ROOT);
    const top = sortTree([node(OTHER_ROOT, 'a.md'), node(OTHER_ROOT, 'b.md')], cfg(sidebarOrderStore.order));
    expect(top.map((n) => n.name)).toEqual(['b.md', 'a.md']);
    const notes = sortTree(
      [node(OTHER_ROOT, 'Notes/x.md'), node(OTHER_ROOT, 'Notes/y.md')],
      cfg(sidebarOrderStore.order),
      `${OTHER_ROOT}/Notes`,
    );
    expect(notes.map((n) => n.name)).toEqual(['y.md', 'x.md']);
  });

  it('a file with absolute paths (an older version) is still read, and written back relative', async () => {
    sidebarOrderStore.seed({ '': [`${ROOT}\\b.md`, `${ROOT}\\a.md`], [`${ROOT}\\Notes`]: [`${ROOT}\\Notes\\y.md`] }, ROOT);
    const top = sortTree([node(ROOT, 'a.md'), node(ROOT, 'b.md')], cfg(sidebarOrderStore.order));
    expect(top.map((n) => n.name)).toEqual(['b.md', 'a.md']);

    sidebarOrderStore.set(ROOT, `${ROOT}\\Other`, [node(ROOT, 'Other/z.md').path]);
    await flushAllMisc();
    expect(JSON.parse(saved.at(-1) ?? '{}')).toEqual({
      '': ['b.md', 'a.md'],
      Notes: ['Notes/y.md'],
      Other: ['Other/z.md'],
    });
  });
});
