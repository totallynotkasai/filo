/**
 * A vault-wide tag rename or delete finds the notes to rewrite through the
 * note index. Started while the index is still being built (right after a
 * vault opens), it waits for the build, so it reads the index only once every
 * note is in it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTagRewriteSweep } from '@renderer/stores/fileTagsCascade.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tag sweep during the first index build', () => {
  it('reads the index only once the build has finished', async () => {
    let finishBuild!: () => void;
    const built = new Promise<void>((resolve) => { finishBuild = resolve; });
    const reads: number[] = [];
    let indexedNotes = 1;
    vi.spyOn(vaultIndexStore, 'whenBuildComplete').mockReturnValue(built);
    vi.spyOn(vaultIndexStore, 'allMetadata').mockImplementation(() => {
      reads.push(indexedNotes);
      return [];
    });

    const sweep = runTagRewriteSweep('work', 'job', '/vault');
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toEqual([]);

    // The build indexes the rest of the vault, then finishes.
    indexedNotes = 2;
    finishBuild();
    await sweep;
    expect(reads).toEqual([2]);
  });
});
