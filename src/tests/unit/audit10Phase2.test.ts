import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A body-only editor save must never drop the note's frontmatter. The body is
 * applied to a fresh read of the file, whose YAML block is kept verbatim, so
 * every key survives, including a present-but-empty one a re-dump would lose.
 */
describe('a body-only save keeps the on-disk frontmatter block', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vi.restoreAllMocks();
  });

  it('preserves every key of the YAML block, byte for byte', async () => {
    const relPath = 'Adopted.md';
    const disk = '---\ntitle: Keep\ntags:\n  - x\n  - y\nemptyKey:\n---\nold body\n';
    const vault = installMemoryVault({ [relPath]: disk });
    const m = noteStore.acquire(relPath, 'text-tile:t1');
    await m.loaded;

    noteStore.setBody(relPath, 'new body', 'text-tile:t1');
    expect(await noteStore.flush(relPath)).toBe(true);

    expect(vault.read(relPath)).toBe('---\ntitle: Keep\ntags:\n  - x\n  - y\nemptyKey:\n---\nnew body\n');
    // The display sees the real frontmatter too.
    expect(m.frontmatter.title).toBe('Keep');
    noteStore.release(relPath, 'text-tile:t1');
  });
});
