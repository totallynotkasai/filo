/**
 * Write-path round trips that each reproduce, through the UI/command → write
 * path, a way a user's data was once lost:
 *
 *   - `vaultStore.save()` returns true while a prior fire-and-forget write
 *     is still recorded as failed (`failedVaultPaths`).
 *   - in-app rename revert re-injects the OUTGOING vault's cache snapshot
 *     after a vault swap landed mid-rename.
 *   - the conflict prompt's Reload shows a stale snapshot instead of the
 *     file as it is when the user clicks.
 *   - Kanban column-reorder undo drops an out-of-band-added column.
 *   - ReplaceAll undo clobbers a post-replace external edit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { ReorderColumnCommand } from '@renderer/commands/index';
import { ReplaceAllCommand, planFor } from '@renderer/commands/replaceAllCommand';
import {
  markPathFailed,
  hasFailedWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { cancelAllPendingWrites } from '@renderer/lib/boards/boardSaver';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

// ── save() boolean honesty ──────────────────────────────────────────────

describe('save() consults failedVaultPaths', () => {
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

// ── rename revert vault-identity guard ──────────────────────────────────

function makeMiniMindMap(id: string): BoardFileData {
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

describe('in-app rename revert skips a swapped-away vault', () => {
  beforeEach(() => {
    noteStore.__resetForTests();
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
    noteStore.__resetForTests();
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

// ── Conflict Reload shows the file as it is when clicked ──────────────────────

describe('conflict Reload applies current disk, not a snapshot from detection time', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    registerNotePrompts();
    vault = installMemoryVault({ 'Notes.md': '---\nstatus: v1\n---\nbody1\n' });
    const ctx: VaultContext = {
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
      resolveRecoveryDismissed: () => {},
    };
    slice = makeExternalChangesSlice(ctx);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    vi.restoreAllMocks();
  });

  it('Reload reads the LATEST disk content even when the file changed again after detection', async () => {
    const m = noteStore.acquire('Notes.md', 'editor');
    await m.loaded;
    noteStore.setBody('Notes.md', 'dirty local\n', 'editor');

    // External edit #1 → v2; the watcher fires, surfacing the conflict prompt.
    vault.writeExternally('Notes.md', '---\nstatus: v2\n---\nbody2\n');
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const findToast = () =>
      uiStore.toasts.find((t) => t.actions?.[0]?.label === 'Reload' && t.text.includes('changed by another program'));
    await vi.waitFor(() => expect(findToast()).toBeDefined());

    // External edit #2 → v3 lands BEFORE the user clicks (no new dispatch).
    vault.writeExternally('Notes.md', '---\nstatus: v3\n---\nbody3\n');

    await findToast()!.actions![0].handler();
    await vi.waitFor(() => expect(m.body).toBe('body3\n'));
    expect(m.frontmatter).toEqual({ status: 'v3' });
    expect(m.hasUnsavedBody).toBe(false);
  });
});

// ── Kanban column reorder keeps out-of-band survivors ────────────────────

function makeKanbanThreeColumns(): BoardFileData {
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

describe('ReorderColumnCommand.undo preserves an out-of-band column', () => {
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

// ── ReplaceAll undo drift check ────────────────────────────────────────────────

describe('ReplaceAll undo skips files changed since the replace', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    vault = installMemoryVault({ 'a.md': 'hello frodo', 'b.md': 'hello frodo' });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    vaultStore.setPath('');
  });

  it('undo reverts an untouched file but preserves one externally edited after the replace', async () => {
    const cmd = new ReplaceAllCommand('/vault', [
      planFor('a.md', 'hello frodo', [{ start: 6, before: 'frodo', after: 'sam' }]),
      planFor('b.md', 'hello frodo', [{ start: 6, before: 'frodo', after: 'sam' }]),
    ]);

    await cmd.execute();
    expect(vault.read('a.md')).toBe('hello sam');
    expect(vault.read('b.md')).toBe('hello sam');

    // External edit to a.md AFTER the replace (its disk content no longer
    // matches what execute wrote).
    vault.writeExternally('a.md', 'hello sam — and an external addition');

    await cmd.undo();

    // a.md is preserved (skipped, not clobbered); b.md still matched what we
    // wrote, so it reverts cleanly.
    expect(vault.read('a.md')).toBe('hello sam — and an external addition');
    expect(vault.read('b.md')).toBe('hello frodo');

    const skippedToast = uiStore.toasts.find((t) => t.text.includes('Undo skipped'));
    expect(skippedToast).toBeDefined();
  });
});
