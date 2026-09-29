import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sidebarOrderStore } from '@renderer/stores/sidebarOrder.svelte';
import { sortTree } from '@renderer/lib/vault/vaultTreeSort';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileTreeNode } from '@shared/types';

/**
 * The top-level manual order is saved under '' (the vault root), the key the
 * tree reads; a drag at the top of the sidebar used to save it under the
 * vault's own path, so it was lost on the next read. An order saved that way
 * is still taken as the root's.
 */

const ROOT = 'C:/Vault';

function file(name: string): FileTreeNode {
  return { name, path: `${ROOT}/${name}`, isDirectory: false } as FileTreeNode;
}

const nodes = [file('a.md'), file('b.md'), file('c.md')];
const cfg = (manualOrder: Record<string, string[]>): Parameters<typeof sortTree>[1] => ({
  sortField: 'none', sortDirection: 'asc', groupField: 'none', groupDirection: 'asc', manualOrder,
});

beforeEach(() => {
  installFiloMock(() => null);
  sidebarOrderStore.seed({}, ROOT);
});
afterEach(() => {
  restoreFiloDefault();
});

describe('sidebar top-level order', () => {
  it('a reorder at the root is saved under the key the tree reads', () => {
    const order = [`${ROOT}/c.md`, `${ROOT}/a.md`, `${ROOT}/b.md`];
    sidebarOrderStore.set(ROOT, ROOT, order);
    expect(sidebarOrderStore.order['']).toEqual(order);
    expect(sortTree(nodes, cfg(sidebarOrderStore.order)).map((n) => n.name)).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('the root spelled differently is still the root', () => {
    sidebarOrderStore.set(ROOT, 'c:\\vault', [`${ROOT}/b.md`]);
    expect(Object.keys(sidebarOrderStore.order)).toEqual(['']);
  });

  it('an order saved under the vault path is read as the root order', () => {
    sidebarOrderStore.seed({ [ROOT]: [`${ROOT}/b.md`, `${ROOT}/a.md`] }, ROOT);
    expect(sidebarOrderStore.order['']).toEqual([`${ROOT}/b.md`, `${ROOT}/a.md`]);
    expect(sidebarOrderStore.order[ROOT]).toBeUndefined();
  });

  it('a folder keeps its own key', () => {
    sidebarOrderStore.set(ROOT, `${ROOT}/Notes`, [`${ROOT}/Notes/x.md`]);
    expect(sidebarOrderStore.order[`${ROOT}/Notes`]).toEqual([`${ROOT}/Notes/x.md`]);
  });
});
