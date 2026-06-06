import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import type { TagsFile } from '@renderer/schema/tagsFile';
import type { LoadTagsFileResult } from '@renderer/lib/vault/tagsStorage';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  beginVaultGeneration,
  captureVaultIdentity,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { repairRenameCascade } from '@renderer/lib/vault/renameCascadeRepair';
import type { RenameCascadeEntry } from '@renderer/lib/vault/renameCascadeSentinel';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-9 Phase 4 — coherence / recovery completeness (latent / self-healing).
 *
 *  A9-L7  fileTags 3-way merge base desync across a concurrent external reload
 *  A9-L8  markdown gateway post-write bookkeeping runs against the NEW vault on swap
 *  A9-L9  repairRenameCascade never re-applied the moved board's own path key
 *
 * (A9-L10 lives with the rest of the write-error coalescing tests in
 * writeErrorToast.test.ts.)
 */

// ── A9-L7 — tags.json merge-base survives a reload during an in-flight save ──

describe('A9-L7 — a concurrent external reload is not clobbered by an in-flight tags:save', () => {
  let savedSnapshots: string[];
  let suspended: boolean;
  let releaseSave: (() => void) | null;

  beforeEach(() => {
    savedSnapshots = [];
    suspended = false;
    releaseSave = null;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:save') {
        savedSnapshots.push(String(args[1]));
        // Suspend ONLY the first save so the test can land an external reload
        // while it is in flight; later saves (cleanup drain) resolve at once.
        if (!suspended) {
          suspended = true;
          return new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        return undefined;
      }
      return { success: true };
    });
  });

  afterEach(async () => {
    // Release any still-suspended save and drain so no armed timer leaks.
    releaseSave?.();
    await fileTagsStore.flush();
    restoreFiloDefault();
    fileTagsStore.reset();
  });

  function reloadResult(file: TagsFile): LoadTagsFileResult {
    return { file, fromFuture: false, noMigrationPath: false };
  }

  it('keeps the reload as the merge base so a later external edit to an untouched file is taken', async () => {
    // Disk baseline: a.png carries ['base'].
    const base: TagsFile = { version: 1, tags: {}, fileTags: { 'a.png': ['base'] } };
    fileTagsStore.commitFromCandidate('/vault', base);

    // The user re-tags a.png — arms the debounced save (nothing on disk yet).
    fileTagsStore.setFileTags('a.png', ['mine']);

    // Fire the save WITHOUT awaiting — it suspends inside tags:save.
    const flushP = fileTagsStore.flush();
    expect(releaseSave).not.toBeNull(); // confirm we are mid-save

    // An external reload lands DURING the in-flight save: a.png already matches
    // ours, and b.png is a NEW external entry we never touched.
    fileTagsStore.applyExternalReload(
      reloadResult({ version: 1, tags: {}, fileTags: { 'a.png': ['mine'], 'b.png': ['ext1'] } }),
    );

    // Release the suspended save; its trailing merge-base assignment must SKIP
    // (the reload advanced the base) instead of clobbering it back to the
    // pre-reload snapshot (which would forget b.png as a known-disk entry).
    releaseSave?.();
    await flushP;

    // A SECOND external reload changes b.png — a file we still never touched in
    // app. With the correct (reload-derived) base, the external value is taken.
    fileTagsStore.applyExternalReload(
      reloadResult({ version: 1, tags: {}, fileTags: { 'a.png': ['mine'], 'b.png': ['ext2'] } }),
    );

    // Post-fix: external edit to the untouched b.png wins (['ext2']).
    // Pre-fix: the stale base made b.png look like a pending in-app change, so
    // ['ext1'] was wrongly re-applied over the external ['ext2'].
    expect(fileTagsStore.file.fileTags['b.png']).toEqual(['ext2']);
    // a.png keeps the user's in-app value throughout.
    expect(fileTagsStore.file.fileTags['a.png']).toEqual(['mine']);
  });
});

// ── A9-L8 — gateway skips post-write bookkeeping when the vault swapped ──

describe('A9-L8 — post-write index bookkeeping is skipped after a mid-write vault swap', () => {
  function bodyWriteArgs(docId: string, relPath: string, body: string): WriteArgs {
    return {
      vaultRoot: '/vault',
      relPath,
      frontmatter: documentStore.getFrontmatter(docId) ?? {},
      body,
      callerId: `text-tile:${docId}`,
      docId,
    };
  }

  function loadHydratedDoc(docId: string, relPath: string): void {
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'L8',
      body: 'orig',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'L8' }, 'title: L8');
    markHydrated(relPath, false);
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
  });

  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('does NOT restore the outgoing vault metadata into the new vault index', async () => {
    const docId = 'doc-l8-swap';
    const relPath = 'Notes/L8.md';
    const callerId = `text-tile:${docId}`;
    loadHydratedDoc(docId, relPath);
    beginVaultGeneration('/vault'); // identity captured at write entry

    const restoreSpy = vi.spyOn(vaultIndexStore, 'restoreMetadata');
    installFiloMock((channel: string) => {
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      if (channel === 'vault:write-existing-file-text') {
        // A vault swap lands while the write IPC is in flight.
        beginVaultGeneration('/vault2');
        return { ok: true, success: true };
      }
      return { ok: true, success: true };
    });

    documentStore.updateContent(docId, '<p>x</p>', 'edited body', callerId);
    scheduleMarkdownWrite(bodyWriteArgs(docId, relPath, 'edited body'));
    await flushMarkdownWrite(callerId);

    // The disk write committed against whatever vault was active, but the
    // renderer-state index restore was skipped — it would have upserted the OLD
    // vault's FileMetadata for relPath into the NEW vault's index.
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('still restores metadata on the normal (no-swap) path', async () => {
    const docId = 'doc-l8-noswap';
    const relPath = 'Notes/L8b.md';
    const callerId = `text-tile:${docId}`;
    loadHydratedDoc(docId, relPath);
    beginVaultGeneration('/vault');

    const restoreSpy = vi.spyOn(vaultIndexStore, 'restoreMetadata');
    installFiloMock((channel: string) => {
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });

    documentStore.updateContent(docId, '<p>x</p>', 'edited body', callerId);
    scheduleMarkdownWrite(bodyWriteArgs(docId, relPath, 'edited body'));
    await flushMarkdownWrite(callerId);

    expect(restoreSpy).toHaveBeenCalledWith(relPath, expect.anything());
  });
});

// ── A9-L9 — recovery re-applies the moved board's own path key ──

describe('A9-L9 — repairRenameCascade re-applies the moved board path key', () => {
  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string) => {
      // clearPendingRenameCascade reads the sentinel; ENOENT → nothing to clear.
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (channel === 'tags:load') return null;
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetRenameCascadeSentinelForTests();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('calls renameBoardPath, marks the moved board dirty, and counts it as repaired', async () => {
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(boardCacheStore, 'renameBoardPath').mockReturnValue(['b1']);
    const markDirtySpy = vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});
    vi.spyOn(boardStore, 'propagateRename').mockReturnValue([]);
    const flushSpy = vi
      .spyOn(boardCacheStore, 'flushAllDirty')
      .mockResolvedValue({ failed: [] });

    const entries: RenameCascadeEntry[] = [
      {
        id: 'e1',
        timestamp: 1,
        oldPath: 'b1.board.json',
        newPath: 'sub/b1.board.json',
        affectedBoardIds: ['b1'],
        tagsAffected: false,
      },
    ];

    const repaired = await repairRenameCascade(entries, '/vault', 'Retry', captureVaultIdentity());

    // The moved board's own path key was re-applied (pre-fix: never called),
    // the board marked dirty so flushAllDirty rewrites it under the new name,
    // and it counts toward the repaired total.
    expect(renameSpy).toHaveBeenCalledWith('b1.board.json', 'sub/b1.board.json');
    expect(markDirtySpy).toHaveBeenCalledWith('b1');
    expect(flushSpy).toHaveBeenCalled();
    expect(repaired).toBe(1);
  });
});
