import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetMarkdownFlushersForTests } from '@renderer/lib/boards/markdownWriteRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

/**
 * Phase 4.3 (2026-05-30) — `renameTagEverywhere` / `removeTagEverywhere`
 * (and the retry handler) must flush `.filo/tags.json` synchronously after
 * the in-memory registry commit, mirroring the rename cascade's F3 flush.
 *
 * `commitTagRenameInMemory` / `commitTagRemovalInMemory` schedule a 300ms
 * debounced `tags.json` write (via renameTag / deleteTag / ensureTag), then
 * the caller synchronously flushes the cascaded board writes
 * (`flushTagRewriteBoardWrites`). A crash in that window left tile defs on
 * disk carrying the new tag name while `tags.json` still lacked the
 * definition (no colour / createdAt) — an orphan forward reference that
 * `pruneOrphanFileTags` can't repair.
 *
 * The fix drains the registry write (`flushPendingSave`) right after the
 * commit, before the board flush. These tests assert the new/removed
 * definition is on disk by the time the call resolves, WITHOUT advancing any
 * debounce timer (real timers; the suite completes well inside 300ms).
 */

describe('tag cascade — synchronous tags.json flush (Phase 4.3)', () => {
  let tagsSaves: string[];

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetMarkdownFlushersForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');

    tagsSaves = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') {
        tagsSaves.push(String(args[1]));
        return undefined;
      }
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });

    // Seed an 'old' tag definition and drain the resulting write so the
    // cascade's flush is the only tags:save we observe.
    await fileTagsStore.hydrate('/vault');
    fileTagsStore.ensureTag('old', '#abcdef');
    await fileTagsStore.flushPendingSave();
    tagsSaves.length = 0;
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    __resetDirtyTrackingForTests();
    __resetMarkdownFlushersForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    vaultStore.setPath('');
  });

  it('renameTagEverywhere persists the renamed definition before it returns', async () => {
    await fileTagsStore.renameTagEverywhere('old', 'new');

    // The registry rename reached disk synchronously inside the cascade —
    // not left on the 300ms misc debounce a crash could straddle.
    expect(tagsSaves.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(tagsSaves[tagsSaves.length - 1]);
    expect(latest.tags.new).toBeDefined();
    expect(latest.tags.old).toBeUndefined();
  });

  it('removeTagEverywhere persists the deletion before it returns', async () => {
    await fileTagsStore.removeTagEverywhere('old');

    expect(tagsSaves.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(tagsSaves[tagsSaves.length - 1]);
    expect(latest.tags.old).toBeUndefined();
  });

  it('the retry handler persists tags.json before it returns', async () => {
    // Seed a tagged .md file so the first sweep has a file to fail on, which
    // surfaces the retry toast.
    const metadata: FileMetadata = {
      path: 'A.md',
      title: 'A',
      headings: [],
      tags: ['old'],
      frontmatter: { tags: ['old'] },
      links: [],
      content: '---\ntags: [old]\n---\nbody\n',
      lastModified: 0,
    };
    vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([metadata]);
    vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    let failMd = true;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') {
        tagsSaves.push(String(args[1]));
        return undefined;
      }
      if (channel === 'vault:file-exists') return true;
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [old]\n---\nbody\n' };
      }
      if (channel === 'vault:write-file-text' || channel === 'vault:write-existing-file-text') {
        const rel = String(args[1]);
        if (rel.startsWith('.filo/')) return { success: true };
        if (failMd) throw new Error('EACCES');
        return { success: true };
      }
      return { success: true };
    });

    const toastsBefore = uiStore.toasts.length;
    await fileTagsStore.renameTagEverywhere('old', 'new');

    // First attempt failed the .md write → registry stayed at 'old', a
    // retry-capable toast appeared.
    expect(fileTagsStore.file.tags.old).toBeDefined();
    const failToasts = uiStore.toasts.slice(toastsBefore);
    expect(failToasts.length).toBe(1);
    const retryAction = failToasts[0].actions?.[0];
    expect(retryAction?.label).toContain('Retry');

    // Now let the .md write succeed and fire the retry.
    tagsSaves.length = 0;
    failMd = false;
    await retryAction!.handler();

    expect(tagsSaves.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(tagsSaves[tagsSaves.length - 1]);
    expect(latest.tags.new).toBeDefined();
    expect(latest.tags.old).toBeUndefined();

    for (const t of uiStore.toasts.slice(toastsBefore)) uiStore.dismissToast(t.id);
  });
});
