import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { removeTagWithUndo, renameTagWithUndo } from '@renderer/stores/tagUndo.svelte';
import { tagSweepStatus, whenTagSweepsIdle, withTagSweepProgress } from '@renderer/stores/tagSweepProgress.svelte';

/**
 * One vault-wide tag change at a time: a rename or delete asked for while
 * another is rewriting notes (from a double-click, the Tags popup, or a
 * toast's Undo) waits for it, rather than rewriting the same notes in turns.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('tag sweeps', () => {
  it('a delete asked for during a sweep starts only once it ends', async () => {
    const remove = vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockResolvedValue({ committed: false, writtenPaths: [] } as never);
    const running = deferred();
    const sweep = withTagSweepProgress('Renaming tag "#a" to "#b"', () => running.promise);
    expect(tagSweepStatus.running).toBe(true);

    const second = removeTagWithUndo('c');
    await new Promise((r) => setTimeout(r, 20));
    expect(remove).not.toHaveBeenCalled();

    running.resolve();
    await sweep;
    await second;
    expect(remove).toHaveBeenCalledWith('c');
  });

  it('a rename waits the same way', async () => {
    const rename = vi.spyOn(fileTagsStore, 'renameTagEverywhere').mockResolvedValue({ committed: false, writtenPaths: [] } as never);
    const running = deferred();
    const sweep = withTagSweepProgress('Deleting tag "#a"', () => running.promise);
    const second = renameTagWithUndo('x', 'y');
    await new Promise((r) => setTimeout(r, 20));
    expect(rename).not.toHaveBeenCalled();
    running.resolve();
    await sweep;
    await second;
    expect(rename).toHaveBeenCalledWith('x', 'y');
  });

  it('with nothing running there is no wait', async () => {
    let done = false;
    void whenTagSweepsIdle().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(true);
  });
});
