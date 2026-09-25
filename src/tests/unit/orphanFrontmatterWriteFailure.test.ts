/**
 * A frontmatter edit to a note no view has open (a Kanban / Task field edit)
 * whose `.md` was deleted by another program can't land, and must say so
 * rather than swallow it: the path goes into the failed set (the save
 * indicator's sticky error) AND into `flushAll().failed`, so Ctrl+S reports
 * the failure instead of a false "Saved". The deleted file is never
 * recreated from memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setWriteStateListener, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('a frontmatter edit to an unopened note whose file was deleted', () => {
  let maxFailed = 0;
  let vault: MemoryVault;
  const TEXT = '---\nstatus: todo\n---\nbody';

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Tasks/orphan.md': TEXT, 'Tasks/healthy.md': TEXT });
    maxFailed = 0;
    setWriteStateListener((info) => {
      maxFailed = Math.max(maxFailed, info.failed);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setWriteStateListener(null);
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('marks the path failed and reports it from flushAll instead of dropping the edit', async () => {
    const relPath = 'Tasks/orphan.md';
    // The index still has the file (the edit was made from it), but the file
    // is gone by the time the write runs.
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, TEXT));
    vault.remove(relPath);

    noteStore.patchFrontmatter(relPath, { set: { status: 'done' }, unset: [] });
    const result = await noteStore.flushAll();

    expect(maxFailed).toBeGreaterThan(0);
    expect(result.failed).toContain(relPath);
    expect(vault.read(relPath)).toBeUndefined();
    expect(vault.writes.filter(([, rel]) => rel === relPath)).toEqual([]);
  });

  it('a healthy edit does NOT mark the path failed (no false positive)', async () => {
    const relPath = 'Tasks/healthy.md';
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, TEXT));

    noteStore.patchFrontmatter(relPath, { set: { status: 'done' }, unset: [] });
    const result = await noteStore.flushAll();

    expect(maxFailed).toBe(0);
    expect(result.failed).toEqual([]);
    expect(vault.read(relPath)?.startsWith('---\nstatus: done\n---\nbody')).toBe(true);
  });
});
