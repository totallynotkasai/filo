import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { dropStaleSeededFrontmatterCache } from '@renderer/lib/vault/staleSeededFrontmatter';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests, __clearRecentSelfWritesForTests } from '@renderer/lib/boards/writeStateTracking';
import { UpdatePropertiesCommand } from '@renderer/commands/index';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 — Phase 2 regression cover.
 *
 * The HIGH this phase closes: the write path serializes from an in-memory full
 * FM cache rather than from current disk + a field delta, so a cache that went
 * STALE for a not-open doc silently reverts an external edit.
 *
 *   2.1 — On a sync-frontmatter / reload-silently external edit, the reconciler
 *         refreshes the documentStore FM cache ONLY for an open editor. A Kanban
 *         card / Task row seeded once but never opened keeps a stale cache; the
 *         next field edit merges over it and the source-preserving write DROPS
 *         the externally-added key. Fix: drop the seeded-but-not-open cache so
 *         the next field edit's seed re-reads fresh disk.
 *
 *   2.2 — UpdatePropertiesCommand undo/redo rebased onto that same stale cache
 *         (it trusted `documentStore.getFrontmatter(docId)` whenever the file
 *         was hydrated). Fix: for a not-open doc, rebase onto a FRESH disk read.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

/**
 * Hydrates the board cache with one Kanban board carrying a single text tile
 * def backed by `${title}.md` (the `tileBacksMarkdownPath` title convention),
 * so `dropStaleSeededFrontmatterCache` can resolve `relPath → contentId`.
 */
function hydrateBoardWithTextTile(
  boardId: string,
  defs: Array<{ tileId: string; contentId: string; title: string }>,
): void {
  const tileDefs: Record<string, unknown> = {};
  for (const d of defs) {
    tileDefs[d.tileId] = {
      id: d.tileId,
      type: 'text',
      title: d.title,
      contentId: d.contentId,
      style: {},
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }
  const data = {
    board: {
      id: boardId,
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    },
    tileDefs: tileDefs as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  } as unknown as V7BoardFileData;
  boardCacheStore.hydrate({ [boardId]: data }, { [boardId]: `${boardId}.board.json` });
}

function makeCtx(): VaultContext {
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

// ── 2.1 — the dropStaleSeededFrontmatterCache helper in isolation ────────────

describe('Phase 2 / 2.1 — dropStaleSeededFrontmatterCache', () => {
  beforeEach(() => {
    documentStore.clear();
    boardCacheStore.clear();
  });
  afterEach(() => {
    documentStore.clear();
    boardCacheStore.clear();
  });

  it('clears a seeded-but-not-open doc backed by the path', () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', contentId: 'doc-closed', title: 'Closed' }]);
    documentStore.setFrontmatter('doc-closed', { priority: 'high' });

    dropStaleSeededFrontmatterCache('Closed.md');

    expect(documentStore.hasFrontmatter('doc-closed')).toBe(false);
  });

  it('PRESERVES an OPEN editor’s cache (the reconciler keeps it fresh)', () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', contentId: 'doc-open', title: 'Open' }]);
    documentStore.loadDocument({
      docId: 'doc-open',
      filename: 'Open.md',
      title: 'Open',
      body: 'body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-open', { priority: 'high' });

    dropStaleSeededFrontmatterCache('Open.md');

    expect(documentStore.getFrontmatter('doc-open')).toEqual({ priority: 'high' });
  });

  it('leaves an unrelated path’s cache untouched', () => {
    hydrateBoardWithTextTile('kb', [
      { tileId: 't1', contentId: 'doc-a', title: 'A' },
      { tileId: 't2', contentId: 'doc-b', title: 'B' },
    ]);
    documentStore.setFrontmatter('doc-a', { x: 1 });
    documentStore.setFrontmatter('doc-b', { y: 2 });

    dropStaleSeededFrontmatterCache('A.md');

    expect(documentStore.hasFrontmatter('doc-a')).toBe(false);
    expect(documentStore.getFrontmatter('doc-b')).toEqual({ y: 2 });
  });
});

// ── 2.1 — driven through the real external-change handler + a field edit ─────

describe('Phase 2 / 2.1 — external edit to a not-open card is not reverted', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    slice = makeExternalChangesSlice(makeCtx());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  const INITIAL = '---\ncompleted: false\n---\ncard body';
  const EXTERNAL = '---\ncompleted: false\nstatus: blocked\n---\ncard body';

  it('drops the stale seeded cache so the next field edit re-reads fresh disk', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', contentId: 'doc1', title: 'Card' }]);

    // Prime the index from the INITIAL bytes (no status) so the handler sees a
    // real previous entry and the classifier returns frontmatter-only.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: INITIAL };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Card.md']);

    // The card was field-edited once: its FM cache is SEEDED (no status) but it
    // is NOT open as a Document tab.
    documentStore.setFrontmatter('doc1', { completed: false });
    expect(documentStore.getDocument('doc1')).toBeUndefined();

    // An external editor adds `status: blocked`. Drive the watcher handler.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content: EXTERNAL };
      return { success: true };
    });
    await slice.handleExternalMarkdownChanges(['Card.md']);

    // 2.1: the not-open seeded cache was dropped (so the next seed re-reads disk).
    // Pre-fix it survived stale (no status) and the field write below dropped the
    // external key.
    expect(documentStore.hasFrontmatter('doc1')).toBe(false);
  });

  it('end-to-end: the next field edit preserves the externally-added key on disk', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', contentId: 'doc1', title: 'Card' }]);

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: INITIAL };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Card.md']);
    documentStore.setFrontmatter('doc1', { completed: false });

    // External add + watcher handler.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content: EXTERNAL };
      if (channel === 'vault:stat') return { success: true, mtimeMs: 9, size: EXTERNAL.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    await slice.handleExternalMarkdownChanges(['Card.md']);

    // Now the user toggles `completed` on the (still not-open) card.
    const tile = { id: 't1', type: 'text', contentId: 'doc1', title: 'Card', tags: [] } as unknown as Tile;
    const writer = makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ t1: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
    await writer.updateTileFrontmatter('t1', { completed: true });

    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWrite(captured), 'no markdown write captured').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );

    const written = lastWrite(captured);
    expect(written).toContain('status: blocked'); // external key survived (re-read disk)
    expect(written).toContain('completed: true'); // the user's edit applied
    expect(written).toContain('card body'); // body intact
  });
});

// ── 2.2 — UpdatePropertiesCommand rebases onto fresh disk for a not-open doc ──

describe('Phase 2 / 2.2 — Properties undo rebases onto fresh disk, not a stale cache', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
  });

  it('undo preserves an external key the STALE not-open cache never saw', async () => {
    const calls: Captured[] = [];
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        // Disk carries an externally-added `reviewed: true` the cache lacks.
        return {
          success: true,
          content: '---\npriority: high\nreviewed: true\n---\nDisk body\n',
          mtimeMs: 1,
          size: 60,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 60 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });

    // STALE seeded cache for a NOT-open doc: knows `priority`, never saw the
    // externally-added `reviewed`. No loadDocument → docState is null.
    documentStore.setFrontmatter('doc-stale', { priority: 'high' });
    expect(documentStore.getDocument('doc-stale')).toBeUndefined();

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Stale.md', docId: 'doc-stale', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'Stale.md', docId: 'doc-stale', fm: { priority: 'high' } },
    );

    // Undo reverts priority high → low. Pre-fix it rebased onto the stale cache
    // and the write dropped `reviewed`; post-fix it rebases onto fresh disk.
    await cmd.undo();

    const undoWrite = calls.filter((c) => c.channel === 'vault:write-existing-file-text').pop();
    expect(undoWrite?.args[2]).toContain('priority: low'); // owned key reverted
    expect(undoWrite?.args[2]).toContain('reviewed: true'); // external key survived
  });
});
