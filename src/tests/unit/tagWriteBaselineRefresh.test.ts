import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  getBaseline,
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-6 M3 — the single-tag fast path writes the `.md` file DIRECTLY (not via
 * the markdown gateway). The gateway is the only other site that stamps the
 * pre-write drift baseline (mtime + size); without a refresh here, the next
 * gateway/editor write to the same file sees the tag write's mtime+size change
 * as an EXTERNAL edit and surfaces a false "modified externally" prompt.
 *
 * The fix stats the file after the tag write and refreshes the baseline. This
 * test drives a tag write through the store and asserts the baseline advanced
 * to the post-write stat (not the stale pre-write value that would false-trip
 * drift detection).
 */
describe('single-tag write refreshes the drift baseline (Audit-6 M3)', () => {
  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardStore.clearBoard();
    boardCacheStore.clear();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string) => {
      // tags:load returns a raw JSON string | null (no envelope); null → empty.
      if (channel === 'tags:load') return null;
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntitle: A\n---\nbody', mtimeMs: 1, size: 20 };
      }
      // The POST-write stat returns a DIFFERENT mtime+size than the pre-write
      // baseline below, so a successful refresh is observable.
      if (channel === 'vault:stat') return { success: true, mtimeMs: 99, size: 30 };
      if (channel === 'vault:file-exists') return true;
      return { success: true };
    });
    await fileTagsStore.hydrate('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    fileTagsStore.reset();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardStore.clearBoard();
    boardCacheStore.clear();
    vaultStore.setPath('');
  });

  it('advances the baseline to the post-write stat after a path tag add', async () => {
    // Pre-write baseline = the bytes the gateway last knew (hydrate-time).
    noteBaseline('Note.md', 1, 20);
    expect(getBaseline('Note.md')).toEqual({ mtimeMs: 1, size: 20 });

    fileTagsStore._applyAddTagToPath('Note.md', 'focus');

    // The write + baseline refresh run fire-and-forget; wait for the refresh.
    await vi.waitFor(
      () => {
        expect(getBaseline('Note.md')).toEqual({ mtimeMs: 99, size: 30 });
      },
      { timeout: 1000, interval: 20 },
    );

    // Specifically NOT the stale pre-write value — that is what would have
    // false-tripped the next write's drift check.
    expect(getBaseline('Note.md')).not.toEqual({ mtimeMs: 1, size: 20 });
  });
});
