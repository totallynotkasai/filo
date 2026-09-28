import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import type { TagsFile } from '@renderer/schema/tagsFile';
import type { LoadTagsFileResult } from '@renderer/lib/vault/tagsStorage';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
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
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * Audit-9 Phase 4 — coherence / recovery completeness (latent / self-healing).
 *
 *  A9-L7  fileTags 3-way merge base desync across a concurrent external reload
 *  A9-L8  note writer post-write bookkeeping must not run against the NEW vault on swap
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
    return { file, fromFuture: false, noMigrationPath: false, corrupt: false };
  }

  it('keeps the reload as the merge base so a later external edit to an untouched file is taken', async () => {
    // Disk baseline: a.png carries ['base'].
    const base: TagsFile = { version: 1, tags: {}, fileTags: { 'a.png': ['base'] } };
    fileTagsStore.commitFromCandidate('/vault', base);

    // The user re-tags a.png — arms the debounced save (nothing on disk yet).
    fileTagsStore.setFileTags('a.png', ['mine']);

    // Fire the save WITHOUT awaiting — it suspends inside tags:save.
    const flushP = fileTagsStore.flush();
    // Audit-19 EXT-8 — the save awaits a pre-write `tags:load` first, so the
    // suspended `tags:save` starts a few microtasks later.
    await vi.waitFor(() => expect(releaseSave).not.toBeNull()); // confirm we are mid-save

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

// ── A9-L8 — the note writer skips post-write bookkeeping when the vault swapped ──

describe('A9-L8 — post-write index bookkeeping is skipped after a mid-write vault swap', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    vault = installMemoryVault({
      'Notes/L8.md': '---\ntitle: L8\n---\norig\n',
      'Notes/L8b.md': '---\ntitle: L8\n---\norig\n',
    });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    vaultIndexStore.clear();
    setActiveVaultPath('');
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('does NOT restore the outgoing vault metadata into the new vault index', async () => {
    const relPath = 'Notes/L8.md';
    const m = noteStore.acquire(relPath, 'text-tile');
    await m.loaded;

    const restoreSpy = vi.spyOn(vaultIndexStore, 'restoreMetadata');
    // A vault swap lands while the write IPC is in flight.
    vault.beforeWrite = (rel) => {
      if (rel === relPath) beginVaultGeneration('/vault2');
    };

    noteStore.setBody(relPath, 'edited body', 'text-tile');
    await noteStore.flush(relPath);

    // The disk write committed against the vault it was issued for, but the
    // index restore was skipped: it would have upserted the OLD vault's
    // metadata for relPath into the NEW vault's index.
    expect(vault.read(relPath)).toContain('edited body');
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('still restores metadata on the normal (no-swap) path', async () => {
    const relPath = 'Notes/L8b.md';
    const m = noteStore.acquire(relPath, 'text-tile');
    await m.loaded;

    const restoreSpy = vi.spyOn(vaultIndexStore, 'restoreMetadata');
    noteStore.setBody(relPath, 'edited body', 'text-tile');
    await noteStore.flush(relPath);

    expect(restoreSpy).toHaveBeenCalledWith(relPath, expect.anything());
  });
});

// ── A9-L9 — recovery re-applies the moved board's own path key ──

describe('A9-L9 — repairRenameCascade re-applies the moved board path key', () => {
  const movedTo = new Set(['sub/b1.board.json', 'img/b.png', 'Assets']);

  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      // clearPendingRenameCascade reads the sentinel; ENOENT → nothing to clear.
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      // Each rename below already happened on disk: only the new path exists.
      if (channel === 'vault:file-exists') return movedTo.has(String(args[1]));
      if (channel === 'tags:load') return null;
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetRenameCascadeSentinelForTests();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('calls renameBoardPath, marks the moved board dirty, and counts it as repaired', async () => {
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);
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

  it('re-asserts the media-tag keys in tags.json for every entry and keeps the sentinel if that flush fails', async () => {
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);
    vi.spyOn(boardCacheStore, 'flushAllDirty').mockResolvedValue({ failed: [] });
    const renameFile = vi.spyOn(fileTagsStore, 'renameFile').mockImplementation(() => {});
    const renameFolder = vi.spyOn(fileTagsStore, 'renameFolder').mockImplementation(() => {});
    vi.spyOn(fileTagsStore, 'flushPendingSave').mockResolvedValue({ ok: false });

    const entries: RenameCascadeEntry[] = [
      { id: 'e1', timestamp: 1, oldPath: 'img/a.png', newPath: 'img/b.png', affectedBoardIds: [] },
      { id: 'e2', timestamp: 2, oldPath: 'Media', newPath: 'Assets', affectedBoardIds: [] },
    ];
    const repaired = await repairRenameCascade(entries, '/vault', 'Retry', captureVaultIdentity());

    expect(renameFile).toHaveBeenCalledWith('img/a.png', 'img/b.png');
    expect(renameFolder).toHaveBeenCalledWith('Media', 'Assets');
    // A failed tags.json write keeps the breadcrumb (null = not cleared).
    expect(repaired).toBeNull();
  });
});
