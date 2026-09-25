/**
 * `isPathPending` is the single authority the external-change reconcilers and
 * the dirty sentinel consult ("does any writer have a pending or in-flight
 * write for path P?"). A note change still inside its debounce must already
 * count, so a crash mid-typing leaves the sentinel dirty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathPending, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('isPathPending — queued note writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    installMemoryVault({
      'Notes/a.md': '---\ntitle: a\n---\nbody\n',
      'Notes/Mixed.md': '---\ntitle: Mixed\n---\nbody\n',
    });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('reports a queued (not-yet-fired) note write as pending until it lands', async () => {
    expect(isPathPending('Notes/a.md')).toBe(false);
    noteStore.patchFrontmatter('Notes/a.md', { set: { k: 1 }, unset: [] });
    expect(isPathPending('Notes/a.md')).toBe(true);
    expect(await noteStore.flush('Notes/a.md')).toBe(true);
    expect(isPathPending('Notes/a.md')).toBe(false);
  });

  it('matches case-insensitively / slash-normalised (vaultPath identity)', async () => {
    noteStore.patchFrontmatter('Notes/Mixed.md', { set: { k: 1 }, unset: [] });
    // A watcher event differing only in case still resolves to pending.
    expect(isPathPending('notes/mixed.md')).toBe(true);
    await noteStore.flushAll();
  });

  it('does not report an unrelated path as pending', async () => {
    noteStore.patchFrontmatter('Notes/a.md', { set: { k: 1 }, unset: [] });
    expect(isPathPending('Notes/b.md')).toBe(false);
    await noteStore.flushAll();
  });
});
