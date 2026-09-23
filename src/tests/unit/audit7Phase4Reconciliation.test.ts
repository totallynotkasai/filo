import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeExternalChangesSlice,
  promptExternalEditOnSync,
} from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import {
  getBaseline,
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import {
  markRecentSelfWrite,
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { __resetDrainGuardForTests } from '@renderer/lib/vault/vaultOperations';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-7 Phase 4 — external-edit reconciliation cluster.
 *
 *  - L13/L16: every reload entry point re-stamps the pre-write drift baseline
 *    to the disk identity it applied, so the next keystroke doesn't re-detect
 *    the absorbed external edit and re-prompt.
 *  - L14: the reconcile defers while a full index rebuild is in flight, so it
 *    never captures a null `previousByPath` (which routes a dirty editor to a
 *    spurious prompt-user).
 *  - L15: recent self-writes are filtered inside the handler (single
 *    authority), covering the partial-read-retry timer that re-invokes it.
 *  - L17: the rename-cascade breadcrumb is laid down BEFORE the tag-flush bail,
 *    so a swap-interrupted cascade still leaves a recovery trail.
 */

function ctxFor(): VaultContext {
  return {
    getVaultPath: () => '/vault',
    setVaultPath: () => {},
    getFileTree: () => [],
    setFileTree: () => {},
    getSearchQuery: () => '',
    setSearchQuery: () => {},
    getIsLoading: () => false,
    setIsLoading: () => {},
    getExpandedFolders: () => new Set(),
    setExpandedFolders: () => {},
    getSelectedPaths: () => new Set(),
    setSelectedPaths: () => {},
    getProject: () => null,
    setProject: () => {},
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

// ── L13 / L16 — reload re-stamps the drift baseline ──────────────────────

describe('Audit-7 L13/L16 — reload re-stamps the drift baseline', () => {
  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    __clearRecentSelfWritesForTests();
    clearToasts();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    clearToasts();
    vaultStore.setPath('');
  });

  it('applyReloadFromDisk stamps the baseline from diskIdentity (keyed by filename)', () => {
    documentStore.loadDocument({
      docId: 'd1',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'old',
      htmlContent: '<p>old</p>',
      richText: [],
    });
    expect(getBaseline('Notes.md')).toBeUndefined();

    documentStore.applyReloadFromDisk('d1', 'new body', [], { tag: 'x' }, undefined, {
      mtimeMs: 5000,
      size: 42,
    });

    expect(getBaseline('Notes.md')).toEqual({ mtimeMs: 5000, size: 42 });
  });

  it('applyReloadFromDisk WITHOUT diskIdentity leaves the prior baseline untouched', () => {
    documentStore.loadDocument({
      docId: 'd1',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'old',
      htmlContent: '<p>old</p>',
      richText: [],
    });
    noteBaseline('Notes.md', 1000, 10);

    documentStore.applyReloadFromDisk('d1', 'new body', []);

    // Unchanged — in-memory reloads (no disk read) must not invent a baseline.
    expect(getBaseline('Notes.md')).toEqual({ mtimeMs: 1000, size: 10 });
  });

  it('reload-silently (watcher event) re-anchors the baseline to the new disk identity', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const bigBody = '# Note\n' + 'x'.repeat(2000) + '\n';

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: bigBody, mtimeMs: 1 };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: bigBody,
      htmlContent: '',
      richText: [],
    });

    // External edit: same length (no material shrink), fresh mtime.
    const newBody = '# Note\n' + 'y'.repeat(2000) + '\n';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: newBody, mtimeMs: 2 };
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // The clean editor absorbed the external body…
    expect(documentStore.getDocument('doc_A')?.body).toBe(newBody);
    // …and the baseline now equals the just-read disk identity, so the next
    // keystroke's pre-write stat (mtime 2, that size) won't re-detect drift.
    expect(getBaseline('Notes.md')).toEqual({ mtimeMs: 2, size: byteLen(newBody) });
  });

  it('promptExternalEditOnSync Reload re-anchors the baseline (gateway-drift path)', async () => {
    const reloadedBody = 'reloaded disk body';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text')
        return { success: true, content: reloadedBody, mtimeMs: 7 };
      return { success: true };
    });
    documentStore.loadDocument({
      docId: 'doc_B',
      filename: 'Drift.md',
      title: 'Drift',
      body: 'local',
      htmlContent: '',
      richText: [],
    });

    const choice = promptExternalEditOnSync({ path: 'Drift.md' });
    const toast = uiStore.toasts.find(
      (t) => typeof t.text === 'string' && t.text.includes('modified externally'),
    );
    expect(toast).toBeDefined();
    const reloadIdx = toast!.actions?.findIndex((a) => a.label === 'Reload') ?? -1;
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    uiStore.invokeToastAction(toast!.id, reloadIdx);

    await expect(choice).resolves.toBe('reload');
    expect(getBaseline('Drift.md')).toEqual({ mtimeMs: 7, size: byteLen(reloadedBody) });
  });
});

// ── L14 — defer reconcile while the index is rebuilding ──────────────────

describe('Audit-7 L14 — reconcile defers while the index rebuilds', () => {
  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __clearRecentSelfWritesForTests();
    clearToasts();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('');
  });

  it('awaits whenBuildComplete BEFORE reading the index (no null-baseline capture)', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const order: string[] = [];
    vi.spyOn(vaultIndexStore, 'isBuilding', 'get').mockReturnValue(true);
    const whenComplete = vi
      .spyOn(vaultIndexStore, 'whenBuildComplete')
      .mockImplementation(async () => {
        order.push('whenBuildComplete');
      });
    const applyChanges = vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockImplementation(async () => {
        order.push('applyChanges');
      });

    await slice.handleExternalMarkdownChanges(['X.md']);

    expect(whenComplete).toHaveBeenCalled();
    // The build-complete gate fires before the index read that would otherwise
    // capture previousByPath=null mid-clear.
    expect(order).toEqual(['whenBuildComplete', 'applyChanges']);
  });
});

// ── L15 — self-write filtering is internal (single authority) ────────────

describe('Audit-7 L15 — self-write filter inside the handler', () => {
  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetDirtyTrackingForTests();
    clearToasts();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('');
  });

  it('drops a recent self-write before any reconcile work (covers the retry-timer path)', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    markRecentSelfWrite('Self.md');
    const applyChanges = vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    await slice.handleExternalMarkdownChanges(['Self.md']);

    expect(applyChanges).not.toHaveBeenCalled();
  });

  it('still reconciles a path that is NOT a recent self-write', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const applyChanges = vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    await slice.handleExternalMarkdownChanges(['Fresh.md']);

    expect(applyChanges).toHaveBeenCalledWith(['Fresh.md']);
  });
});

// ── L17 — rename-cascade breadcrumb survives a swap-during-flush ──────────

describe('Audit-7 L17 — rename-cascade sentinel laid before the tag-flush bail', () => {
  let sentinelWrites: string[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    __resetVaultIdentityForTests();
    __resetDrainGuardForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    clearToasts();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');

    sentinelWrites = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') return undefined;
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (
        channel === 'vault:write-file-text' &&
        String(args[1]).includes('rename-cascade-pending.')
      ) {
        sentinelWrites.push(String(args[2]));
        return { success: true };
      }
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    __resetVaultIdentityForTests();
    __resetDrainGuardForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    vaultStore.setPath('');
  });

  it('writes the breadcrumb for the OUTGOING vault even when a swap lands mid tag-flush', async () => {
    // propagateRename touched a board → cache mutated → an interrupted cascade
    // must leave a recovery trail.
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue(undefined);
    vi.spyOn(boardStore, 'propagateRename').mockReturnValue(['b1']);
    vi.spyOn(boardCacheStore, 'renameBoardPath').mockReturnValue([]);
    // The swap lands DURING the synchronous tag flush — exactly the L17 window.
    vi.spyOn(fileTagsStore, 'flushPendingSave').mockImplementation(async () => {
      beginVaultGeneration('/vault2');
      return { ok: true };
    });
    // renameKey only runs AFTER the post-flush bail; spying lets us assert the
    // cascade bailed (didn't corrupt the new vault's index).
    const renameKey = vi.spyOn(vaultIndexStore, 'renameKey').mockReturnValue(undefined);

    const slice = makeExternalChangesSlice(ctxFor());
    await slice.handleExternalRename('Old.md', 'New.md');

    // The breadcrumb was written before the bail, against the outgoing vault.
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(sentinelWrites[sentinelWrites.length - 1]);
    const entry = payload.entries[payload.entries.length - 1];
    expect(entry.oldPath).toBe('Old.md');
    expect(entry.newPath).toBe('New.md');
    expect(entry.affectedBoardIds).toEqual(['b1']);
    expect(entry.tagsAffected).toBe(true);

    // …and the swap actually triggered the post-flush bail.
    expect(renameKey).not.toHaveBeenCalled();
  });
});
