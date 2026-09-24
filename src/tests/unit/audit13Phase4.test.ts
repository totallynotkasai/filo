import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeExternalChangesSlice,
  resetPartialReadRetryInflight,
} from '@renderer/stores/vaultExternalChanges';
import {
  dispatchExternalChange,
  _resetRegistryForTests,
} from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
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
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-13 Phase 4 — case-folding & external-edit reconciliation.
 *
 *   M4  — self-write suppression consults the drift baseline: a genuine
 *         external edit landing inside the window is kept, not dropped.
 *   L1  — a clean-editor reload threads rawFrontmatter into
 *         originalFrontmatterCache so an external key keeps its comment.
 *   L5  — a closed-file body-only edit re-stamps the drift baseline so the
 *         next field write doesn't false-flag "modified externally".
 *   L14 — a case-divergent board reload rebinds boardPaths to the OS casing.
 *   L15 — the partial-read retry re-enters through the rename queue.
 */

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

function makeCtx(overrides: Partial<VaultContext> = {}): VaultContext {
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
    resolveRecoveryDismissed: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
    ...overrides,
  };
}

// ── M4 — self-write suppression baseline tiebreak ─────────────────────────

describe('Audit-13 M4 — self-write window consults the drift baseline', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetVaultIdentityForTests();
    clearToasts();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    slice = makeExternalChangesSlice(makeCtx());
  });

  afterEach(() => {
    // Restore the `applyChanges` spy so it doesn't leak into later describes
    // (it would no-op their real index reads).
    vi.restoreAllMocks();
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    __clearRecentSelfWritesForTests();
    clearToasts();
  });

  it('keeps a recent-self-write path whose disk stat DIVERGED from the baseline (real external edit)', async () => {
    markRecentSelfWrite('Notes.md');
    noteBaseline('Notes.md', 100, 50); // what Filo last wrote
    const applySpy = vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockResolvedValue(undefined);
    installFiloMock({
      // A second writer touched it after us → mtime + size diverge.
      'vault:stat': () => ({ success: true, mtimeMs: 200, size: 999 }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // Not dropped — it flows through to the classifier path.
    expect(applySpy).toHaveBeenCalledWith(['Notes.md']);
  });

  it('drops a recent-self-write echo whose disk stat MATCHES the baseline', async () => {
    markRecentSelfWrite('Notes.md');
    noteBaseline('Notes.md', 100, 50);
    const applySpy = vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockResolvedValue(undefined);
    installFiloMock({
      // Our own echo — stat equals the baseline we wrote.
      'vault:stat': () => ({ success: true, mtimeMs: 100, size: 50 }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    expect(applySpy).not.toHaveBeenCalled();
  });

  it('drops a recent-self-write when no baseline anchor exists (data-safe default)', async () => {
    markRecentSelfWrite('Notes.md');
    // No noteBaseline → getBaseline returns undefined.
    const applySpy = vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockResolvedValue(undefined);
    installFiloMock({ 'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }) });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    expect(applySpy).not.toHaveBeenCalled();
  });

  it('passes a non-self-write path through unconditionally (never stats)', async () => {
    const applySpy = vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockResolvedValue(undefined);
    installFiloMock({
      'vault:stat': () => {
        throw new Error('non-self-write path must not be stat-probed');
      },
    });

    await slice.handleExternalMarkdownChanges(['Other.md']);

    expect(applySpy).toHaveBeenCalledWith(['Other.md']);
  });
});

// ── L1 — reload threads rawFrontmatter into originalFrontmatterCache ───────

describe('Audit-13 L1 — clean-editor reload refreshes originalFrontmatterCache', () => {
  beforeEach(() => {
    documentStore.clear();
    __resetBaselinesForTests();
  });

  afterEach(() => {
    documentStore.clear();
    __resetBaselinesForTests();
  });

  it('handleExternalChange on a CLEAN editor stores the threaded rawFrontmatter', () => {
    documentStore.loadDocument({
      docId: 'd1',
      filename: 'N.md',
      title: 'N',
      body: 'old',
      htmlContent: '<p>old</p>',
      richText: [],
    });
    // Clean editor → reload branch. Thread the disk FM source bytes.
    documentStore.handleExternalChange(
      'd1',
      'new body',
      [],
      { added: 'val' },
      'added: val # keep this comment',
      { mtimeMs: 5, size: 10 },
    );

    expect(documentStore.getOriginalFrontmatterSource('d1')).toBe(
      'added: val # keep this comment',
    );
  });

  it('refreshes the stale baseline to the new disk bytes when an external key is added', () => {
    documentStore.loadDocument({
      docId: 'd2',
      filename: 'M.md',
      title: 'M',
      body: 'old',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('d2', { a: 1 }, 'a: 1');
    expect(documentStore.getOriginalFrontmatterSource('d2')).toBe('a: 1');

    // An external editor adds a commented key. The reload threads the FRESH
    // disk source so the byte-preservation baseline advances past the pre-edit
    // bytes; the old (undefined-passing) path left it at `a: 1`, dropping the
    // new key's comment on the next body-only save.
    documentStore.handleExternalChange(
      'd2',
      'new body',
      [],
      { a: 1, b: 2 },
      'a: 1\nb: 2 # added externally',
      { mtimeMs: 9, size: 20 },
    );

    expect(documentStore.getOriginalFrontmatterSource('d2')).toBe(
      'a: 1\nb: 2 # added externally',
    );
  });
});

// ── L5 — closed-file body-only edit re-stamps the drift baseline ──────────

describe('Audit-13 L5 — closed-file body-only edit re-anchors the baseline', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    __clearRecentSelfWritesForTests();
    __resetVaultIdentityForTests();
    clearToasts();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    slice = makeExternalChangesSlice(makeCtx());
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    clearToasts();
  });

  it('re-stamps noteBaseline to the new disk identity for a no-editor body change', async () => {
    const before = '---\ntag: x\n---\n# Before\n' + 'a'.repeat(200);
    const after = '---\ntag: x\n---\n# After (changed body)\n' + 'b'.repeat(200);

    // Prime the index with the previous content (mtime 1) — no editor open.
    installFiloMock({
      'vault:read-file-text': () => ({ success: true, content: before, mtimeMs: 1 }),
    });
    await vaultIndexStore.applyChanges(['Closed.md']);
    // A deliberately STALE baseline (pre-edit) — simulates the gap the fix closes.
    noteBaseline('Closed.md', 1, byteLen(before));

    // External body-only edit (frontmatter unchanged), fresh mtime, no editor.
    installFiloMock({
      'vault:read-file-text': () => ({ success: true, content: after, mtimeMs: 2 }),
    });
    await slice.handleExternalMarkdownChanges(['Closed.md']);

    // Baseline re-stamped to the absorbed disk identity, so the next in-app
    // field edit's pre-write drift check won't false-flag "modified externally".
    expect(getBaseline('Closed.md')).toEqual({ mtimeMs: 2, size: byteLen(after) });
  });
});

// ── L14 — board reload rebinds boardPaths to the OS casing ────────────────

function makeBoard(name: string): V7BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function installRoutes(routes: Record<string, (...args: unknown[]) => unknown>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => routes[channel]?.(...args),
    on: () => () => {},
    send: () => {},
  };
}

describe('Audit-13 L14 — case-divergent board reload rebinds the stored path', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('rebinds boardPaths[boardId] to the OS-reported casing after a silent reload', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: 'Folder/Board.board.json' });
    __clearRecentSelfWritesForTests();

    installRoutes({
      'board:load': () => makeBoard('from-disk'),
      'vault:stat': () => ({ ok: true, mtimeMs: 1, size: 1 }),
    });

    // OS reports the change with diverged (lower) casing on a case-insensitive FS.
    await dispatchExternalChange({
      kind: 'board',
      filename: 'folder/board.board.json',
      eventType: 'change',
    });

    // The board reloaded…
    expect((boardCacheStore.cache.kb!.board as KanbanBoard).name).toBe('from-disk');
    // …and the stored path tracks the OS casing now (no stale-casing desync →
    // no phantom-file write / "missing on disk" eviction on a synced FS).
    expect(boardStore.paths.kb).toBe('folder/board.board.json');
  });
});

// ── L15 — partial-read retry re-enters through the rename queue ────────────

describe('Audit-13 L15 — partial-read retry routes through the rename queue', () => {
  const bigBody = '# Big\n' + 'x'.repeat(5000) + '\n';
  const tinyBody = '# Tiny\n';

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    __resetVaultIdentityForTests();
    clearToasts();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
  });

  it('re-enters via ctx.enqueueRenameQueueWork, not a bare handler call', async () => {
    const enqueueSpy = vi.fn(<T>(task: () => Promise<T>) => task());
    const slice = makeExternalChangesSlice(
      makeCtx({ enqueueRenameQueueWork: enqueueSpy as VaultContext['enqueueRenameQueueWork'] }),
    );

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: bigBody };
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

    // Flip to a drastic shrink → classifier returns partial-read-retry.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: tinyBody };
      return { success: true };
    });

    vi.useFakeTimers();
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    // Fire the first retry (500ms backoff).
    await vi.advanceTimersByTimeAsync(500);

    expect(enqueueSpy).toHaveBeenCalled();
  });
});
