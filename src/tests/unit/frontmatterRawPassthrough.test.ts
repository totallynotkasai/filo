/**
 * Body-only saves pass the frontmatter bytes through untouched.
 *
 * The note writer assembles every write on a fresh read of the file: a body
 * edit keeps the frontmatter source verbatim (comments, key order, quoting),
 * a frontmatter change patches only the keys it names, and an unparseable
 * block round-trips through a body edit instead of being dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteStore } from '../../renderer/stores/notes.svelte';
import { vaultStore } from '../../renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('note body saves — frontmatter passthrough', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  async function editBody(rel: string, body: string): Promise<void> {
    const m = noteStore.acquire(rel, 'view');
    await m.loaded;
    noteStore.setBody(rel, body, 'view');
    expect(await noteStore.flush(rel)).toBe(true);
  }

  it('emits the frontmatter bytes verbatim on a clean body-only save', async () => {
    vault = installMemoryVault({
      'passthrough-clean.md': ['---', '# pinned — keep this', 'zeta: 1', 'alpha: 2', '---', 'old body'].join('\n'),
    });

    await editBody('passthrough-clean.md', 'new body');

    expect(vault.read('passthrough-clean.md')).toBe(
      ['---', '# pinned — keep this', 'zeta: 1', 'alpha: 2', '---', 'new body', ''].join('\n'),
    );
  });

  it('source-preservingly patches frontmatter on a mutation (comment kept)', async () => {
    vault = installMemoryVault({
      'passthrough-dirty.md': ['---', '# pinned — keep this', 'zeta: 1', '---', 'old body'].join('\n'),
    });
    const m = noteStore.acquire('passthrough-dirty.md', 'view');
    await m.loaded;
    noteStore.patchFrontmatter('passthrough-dirty.md', { set: { status: 'done' }, unset: [] });
    noteStore.setBody('passthrough-dirty.md', 'new body', 'view');
    expect(await noteStore.flush('passthrough-dirty.md')).toBe(true);

    const written = vault.read('passthrough-dirty.md') ?? '';
    expect(written).toContain('# pinned — keep this');
    expect(written).toContain('status: done');
    expect(written).toContain('zeta: 1');
    expect(written).toContain('new body');
  });

  it('preserves an UNPARSEABLE frontmatter block on a clean body save', async () => {
    vault = installMemoryVault({
      'passthrough-unparseable.md': ['---', 'title: Keep me', '\tbad: indentation', '---', 'old body'].join('\n'),
    });

    await editBody('passthrough-unparseable.md', 'new body');

    const written = vault.read('passthrough-unparseable.md') ?? '';
    expect(written.startsWith('---')).toBe(true);
    expect(written).toContain('title: Keep me');
    expect(written).toContain('\tbad: indentation');
    expect(written).toContain('new body');
  });
});
