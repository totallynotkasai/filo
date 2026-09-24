/**
 * Write-path remediation — Phase 3 (the ◐ "verify first" items).
 *
 * Each block reproduces, through the UI/command → write round-trip, the bug a
 * Phase-3 item fixed, and is bite-verified by temp-reverting the fix (the
 * expected red count is noted per block):
 *
 *   3.1 — `vaultStore.save()` returns true while a prior fire-and-forget write
 *         is still recorded as failed (`failedVaultPaths`).              → 1 red
 *   3.2 — in-app rename revert re-injects the OUTGOING vault's cache snapshot
 *         after a vault swap landed mid-rename.                          → 1 red
 *   3.3 — `syncTile` mtime-only guard misses a same-mtime, different-size
 *         external edit (size-blind).                                    → 1 red
 *   3.4 — `promptModifiedFile` Reload replays the stale first-detection
 *         snapshot instead of re-reading current disk.                   → 1 red
 *   3.5 — Kanban column-reorder undo drops an out-of-band-added column.  → 1 red
 *   3.6 — ReplaceAll undo clobbers a post-replace external edit.         → 1 red
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { ReorderColumnCommand } from '@renderer/commands/index';
import { ReplaceAllCommand } from '@renderer/commands/replaceAllCommand';
import {
  markPathFailed,
  hasFailedWrites,
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { cancelAllPendingWrites } from '@renderer/lib/boards/boardSaver';
import { __resetMarkdownFileWriterForTests } from '@renderer/lib/vault/markdownFileWriter';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, MindMapBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// ── 3.1 — save() boolean honesty ──────────────────────────────────────────────

describe('Phase 3 / 3.1 — save() consults failedVaultPaths', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ success: true }));
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('hasFailedWrites() reflects the failed-path set', () => {
    expect(hasFailedWrites()).toBe(false);
    markPathFailed('/vault', 'note.md');
    expect(hasFailedWrites()).toBe(true);
  });

  it('save() returns false while a settled write is still failed (no pending writes)', async () => {
    // Clean baseline: nothing pending, nothing failed → honest success.
    expect(await vaultStore.save()).toBe(true);

    // A fire-and-forget timer write FAILED and settled — it left the path in
    // `failedVaultPaths` but is no longer in any scheduler's pending/in-flight
    // map, so the `flushAll*` drains below all report clean. Pre-fix `save()`
    // returned true; now it consults `hasFailedWrites()` and stays honest.
    markPathFailed('/vault', 'note.md');
    expect(await vaultStore.save()).toBe(false);
  });
});

// ── 3.2 — rename revert vault-identity guard ──────────────────────────────────

function makeMiniMindMap(id: string): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('Phase 3 / 3.2 — in-app rename revert skips a swapped-away vault', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    // Capture identity matches '/vault' at rename time.
    beginVaultGeneration('/vault');
  });
  afterEach(() => {
    cancelAllPendingWrites();
    restoreFiloDefault();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  it('does NOT re-inject the outgoing vault cache when the vault swaps mid-rename', async () => {
    // Old vault board, present before the rename starts.
    boardCacheStore.hydrate({ mm: makeMiniMindMap('mm') }, { mm: 'mm.board.json' });

    installFiloMock((channel: string) => {
      if (channel === 'vault:rename') {
        // Simulate the vault swapping DURING the (drained) rename IPC: the
        // pre-swap hook clears the cache + the NEW vault loads its own board,
        // and main-side assertActiveVault rejects the rename issued against
        // the now-inactive old root.
        boardCacheStore.clear();
        boardCacheStore.hydrate({ 'mm-new': makeMiniMindMap('mm-new') }, { 'mm-new': 'new.board.json' });
        beginVaultGeneration('/vault-B');
        return { success: false, code: 'EACCES' };
      }
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return { success: true };
    });

    const result = await vaultStore.rename('/vault/mm.board.json', '/vault/renamed.board.json');

    expect(result.success).toBe(false);
    // The guard skipped the in-memory revert, so the NEW vault's cache is
    // intact and the OUTGOING vault's snapshot was NOT re-injected. Pre-fix
    // `replaceCache(cacheSnapshot)` ran and clobbered the new vault with `mm`.
    expect(boardCacheStore.cache['mm-new']).toBeDefined();
    expect(boardCacheStore.cache.mm).toBeUndefined();
  });
});

// ── 3.3 — syncTile mtime + size guard ─────────────────────────────────────────

function makeKanbanWithTextTile(): V7BoardFileData {
  const def: TileDefinition = {
    id: 't1',
    type: 'text',
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    createdAt: 0,
    updatedAt: 0,
    filePath: 'note.md',
  };
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [{ tileId: 't1' }] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: def },
    connections: {},
    frames: [],
  };
}

describe('Phase 3 / 3.3 — syncTile guard compares mtime AND size', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    restoreFiloDefault();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('same mtime but different size → external-edit prompt fires (no silent clobber)', async () => {
    const writeCalls: unknown[][] = [];
    let statCall = 0;
    installFiloMock({
      'vault:stat': () => {
        statCall++;
        // IDENTICAL mtimeMs across the before-read and before-write stats
        // (coarse-resolution clock), but the size moved — an external edit
        // the mtime-only guard would have missed.
        return statCall === 1
          ? { success: true, mtimeMs: 1000, size: 100 }
          : { success: true, mtimeMs: 1000, size: 145 };
      },
      'vault:read-file-text': () => ({
        success: true,
        content: '---\ntitle: Note\n---\nDisk body',
      }),
      'vault:write-existing-file-text': (...args: unknown[]) => {
        writeCalls.push(args);
        return { success: true };
      },
      'vault:file-exists': () => true,
      'board:save': () => ({ success: true }),
    });

    boardCacheStore.hydrate({ kb: makeKanbanWithTextTile() }, { kb: 'tasks.board.json' });
    documentStore.loadDocument({
      filename: 'note.md',
      title: 'Note',
      body: 'Local body to write',
      htmlContent: '',
      richText: [],
    });
    documentStore.markDirty('note.md');

    const syncPromise = boardCacheStore.syncTile('t1');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const promptToast = uiStore.toasts.find((t) =>
      t.text.includes('modified externally between Filo'),
    );
    expect(promptToast).toBeDefined();

    // Reload → the write is skipped, so the external (size-changed) edit
    // survives. Pre-fix the size-blind guard wrote straight over it.
    uiStore.invokeToastAction(promptToast!.id, 0);
    const result = await syncPromise;
    expect(result.wrote).toBe(false);
    expect(result.skippedReason).toBe('external-edit-reload');
    expect(writeCalls.length).toBe(0);
  });
});

// ── 3.4 — promptModifiedFile re-reads fresh disk on Reload ─────────────────────

describe('Phase 3 / 3.4 — external-edit Reload applies current disk, not the captured snapshot', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let diskContent: string;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __clearRecentSelfWritesForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');
    diskContent = '---\nstatus: v1\n---\nbody1';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: diskContent };
      return { success: true };
    });
    ctx = {
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
    } as unknown as VaultContext;
    slice = makeExternalChangesSlice(ctx);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vi.restoreAllMocks();
  });

  it('Reload reads the LATEST disk content even when the file changed again after detection', async () => {
    await vaultIndexStore.applyChanges(['Notes.md']); // index v1
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'dirty local',
      htmlContent: '<p>dirty local</p>',
      richText: [],
    });
    documentStore.updateContent('Notes.md', '<p>dirty local</p>', 'dirty local'); // isDirty = true

    // External edit #1 → v2; the watcher fires, surfacing the prompt with the
    // v2 snapshot captured as `next`.
    diskContent = '---\nstatus: v2\n---\nbody2';
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const toast = uiStore.toasts.find(
      (t) => t.actions?.[0]?.label === 'Reload' && t.text.includes('was modified externally'),
    );
    expect(toast).toBeDefined();

    // External edit #2 → v3 lands BEFORE the user clicks (no new dispatch).
    diskContent = '---\nstatus: v3\n---\nbody3';

    await toast!.actions![0].handler();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Pre-fix the Reload replayed the captured v2 snapshot; the fix re-reads
    // disk and applies the current v3 body.
    expect(documentStore.getDocument('Notes.md')?.body).toBe('body3');
  });
});

// ── 3.5 — Kanban column reorder keeps out-of-band survivors ────────────────────

function makeKanbanThreeColumns(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Board',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'col-A', title: 'A', position: 0, collapsed: false, tilePlacements: [] },
        { id: 'col-B', title: 'B', position: 1, collapsed: false, tilePlacements: [] },
        { id: 'col-C', title: 'C', position: 2, collapsed: false, tilePlacements: [] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('Phase 3 / 3.5 — ReorderColumnCommand.undo preserves an out-of-band column', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanThreeColumns() }, { kb: 'kb.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  const ids = () =>
    ((boardCacheStore.cache.kb!.board as KanbanBoard).columns ?? []).map((c) => c.id);

  it('a column added between reorder execute and undo survives the undo', () => {
    const cmd = new ReorderColumnCommand('kb', ['col-A', 'col-B', 'col-C'], ['col-B', 'col-A', 'col-C']);
    cmd.execute();
    expect(ids()).toEqual(['col-B', 'col-A', 'col-C']);

    // Out-of-band column add (NOT on the undo stack) — e.g. another action /
    // external board edit between the reorder and its undo.
    boardCacheStore.insertKanbanColumnAt(
      'kb',
      { id: 'col-D', title: 'D', position: 3, collapsed: false, tilePlacements: [] } as KanbanBoard['columns'][number],
      3,
    );
    expect(ids()).toContain('col-D');

    cmd.undo();

    // Pre-fix the stale-order replay dropped col-D; the append-survivors fix
    // keeps it while still restoring the captured A,B,C order.
    expect(ids()).toContain('col-D');
    expect(ids().slice(0, 3)).toEqual(['col-A', 'col-B', 'col-C']);
  });
});

// ── 3.6 — ReplaceAll undo drift check ─────────────────────────────────────────

interface FileMap {
  [path: string]: string;
}

function installReplaceAllStub(filesystem: FileMap): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'vault:read-file-text') {
      const p = String(args[1]);
      const content = filesystem[p];
      if (content === undefined) return { success: false, error: 'ENOENT', code: 'ENOENT' };
      return { success: true, content };
    }
    if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
      filesystem[String(args[1])] = String(args[2]);
      return { success: true };
    }
    if (channel === 'vault:stat') return { success: true, mtimeMs: 0, size: 0 };
    return { success: true };
  });
}

describe('Phase 3 / 3.6 — ReplaceAll undo skips files changed since the replace', () => {
  beforeEach(() => {
    vaultIndexStore.clear();
    documentStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultIndexStore.clear();
    documentStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('');
  });

  it('undo reverts an untouched file but preserves one externally edited after the replace', async () => {
    const filesystem: FileMap = { 'a.md': 'hello frodo', 'b.md': 'hello frodo' };
    installReplaceAllStub(filesystem);

    const cmd = new ReplaceAllCommand('/vault', [
      { path: 'a.md', originalContent: 'hello frodo', nextContent: 'hello sam', replacementCount: 1 },
      { path: 'b.md', originalContent: 'hello frodo', nextContent: 'hello sam', replacementCount: 1 },
    ]);

    await cmd.execute();
    expect(filesystem['a.md']).toBe('hello sam');
    expect(filesystem['b.md']).toBe('hello sam');

    // External edit to a.md AFTER the replace (its disk content no longer
    // matches what execute wrote).
    filesystem['a.md'] = 'hello sam — and an external addition';

    await cmd.undo();

    // a.md is preserved (skipped, not clobbered); b.md still matched what we
    // wrote, so it reverts cleanly. Pre-fix undo blindly wrote `originalContent`
    // over a.md, destroying the external edit.
    expect(filesystem['a.md']).toBe('hello sam — and an external addition');
    expect(filesystem['b.md']).toBe('hello frodo');

    const skippedToast = uiStore.toasts.find((t) => t.text.includes('Undo skipped'));
    expect(skippedToast).toBeDefined();
  });
});
