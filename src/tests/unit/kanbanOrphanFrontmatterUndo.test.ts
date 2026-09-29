/**
 * Undo works for a kanban card whose note no view holds.
 *
 * `UpdateCardFieldCommand` sends its patch to the note writer as a frontmatter
 * delta, which lands on a fresh read of the file: untouched keys and the body
 * on disk are kept, and a stale vault index is never the write source. A file
 * that can't be read fails loudly instead of being recreated from the index.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

const DISK = '---\npriority: low\nstatus: active\n---\nbody content';

describe('UpdateCardFieldCommand on a note no view holds', () => {
  let vault: MemoryVault;

  const mdWrites = (): string[] => vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , t]) => t);

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Card.md': DISK });
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    // A stale index entry: never the write source.
    vaultIndexStore.restoreMetadata('Card.md', {
      path: 'Card.md',
      title: 'Card',
      tags: [],
      frontmatter: { priority: 'low' },
      rawFrontmatter: 'priority: low',
      content: 'stale index body',
      lastModified: 0,
    });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    restoreFiloDefault();
  });

  it('execute writes the patched frontmatter and keeps the body and untouched keys', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe('---\npriority: high\nstatus: active\n---\nbody content');
  });

  it('undo writes the inverse patch back', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    await cmd.undo();
    await noteStore.flushAll();
    expect(mdWrites().length).toBeGreaterThanOrEqual(2);
    expect(vault.read('Card.md')).toContain('priority: low');
    expect(vault.read('Card.md')).toContain('status: active');
  });

  it('handles a missing vault gracefully (nothing written)', async () => {
    vaultStore.setPath('');
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(mdWrites()).toEqual([]);
    expect(vault.read('Card.md')).toBe(DISK);
  });

  it('deep-clones the patch so caller-side mutation cannot poison', async () => {
    const patch: Record<string, unknown> = { priority: 'high' };
    const inverse: Record<string, unknown> = { priority: 'low' };
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', patch, inverse);
    patch.priority = 'poisoned';

    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toContain('priority: high');
    expect(vault.read('Card.md')).not.toContain('poisoned');
  });

  it('clears a field via an unset delta (empty value → key removed)', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: '' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).not.toContain('priority:');
    expect(vault.read('Card.md')).toContain('status: active');
  });

  it('assembles over the fresh disk body, not the stale index', async () => {
    vault.writeExternally('Card.md', '---\npriority: low\n---\nfresh disk body — index is stale');

    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();

    const written = vault.read('Card.md') ?? '';
    expect(written).toContain('fresh disk body');
    expect(written).not.toContain('stale index body');
    expect(written).toContain('priority: high');
  });

  it('a note that cannot be read fails loudly and is not recreated from the index', async () => {
    vault.remove('Card.md');

    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    const result = await noteStore.flushAll();

    expect(result.failed).toContain('Card.md');
    expect(mdWrites()).toEqual([]);
    expect(vault.read('Card.md')).toBeUndefined();
  });
});
