import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { Project, ProjectSettings } from '@renderer/schema/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 2 / 2.2 — external rename propagation must mirror the full in-app
 * rename follow-ups: activeRootFolder rewrite, per-board defaultFolder pin
 * rewrite, rename-cascade sentinel write/clear, and a failed-flush toast.
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) {
    uiStore.dismissToast(t.id);
  }
}

function makeMindMap(boardId: string, defaultFolder?: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: defaultFolder ? { defaultFolder } : {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeProject(): Project {
  const settings = {
    general: {
      globalFont: '',
      globalFontSize: 14,
      defaultBoardFontSize: {},
      systemFonts: [],
      globalToolbarScale: 1,
      boardToolbarScale: 1,
      tabBarScale: 1,
      minimapScale: 1,
      waypointScale: 1,
      toolbarColor: '',
      tabBarColor: '',
      radarEnabled: true,
      recentColors: [],
      activeRootFolder: 'OldRoot',
      sidebarSortField: 'none',
      sidebarSortDirection: 'asc',
      sidebarGroupField: 'none',
      sidebarGroupDirection: 'asc',
    },
  } as unknown as ProjectSettings;
  return {
    name: 'p',
    version: 1,
    boards: [],
    settings,
    theme: 'light',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Project;
}

function ctxFor(project: Project | null, opts?: { markMetaDirty?: () => void }): VaultContext {
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
    getProject: () => project,
    setProject: () => {},
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    markMetaDirty: opts?.markMetaDirty ?? (() => {}),
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

describe('vaultExternalChanges — external rename propagation (Phase 2.2)', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    clearToasts();
    vaultStore.setPath('/vault');
    __resetRenameCascadeSentinelForTests();
    // Suppress the "Failed to save board: …" breadcrumb the failing-flush
    // test deliberately triggers. Real call-sites still surface it via the
    // user-facing toast which we assert directly.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    clearToasts();
    __resetRenameCascadeSentinelForTests();
    vi.restoreAllMocks();
  });

  it('rewrites activeRootFolder when the rename source matches', async () => {
    const project = makeProject();
    let metaDirtyCount = 0;
    const ctx = ctxFor(project, { markMetaDirty: () => { metaDirtyCount += 1; } });
    slice = makeExternalChangesSlice(ctx);

    // Empty cache — flushAllDirty resolves with no failures.
    installFiloMock({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    await slice.handleExternalRename('OldRoot', 'NewRoot');

    expect(project.settings.general?.activeRootFolder).toBe('NewRoot');
    expect(metaDirtyCount).toBeGreaterThan(0);
  });

  it('rewrites activeRootFolder when the rename source is an ancestor', async () => {
    const project = makeProject();
    project.settings.general!.activeRootFolder = 'OldRoot/Sub';
    const ctx = ctxFor(project);
    slice = makeExternalChangesSlice(ctx);

    installFiloMock({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalRename('OldRoot', 'NewRoot');

    expect(project.settings.general?.activeRootFolder).toBe('NewRoot/Sub');
  });

  it('rewrites per-board defaultFolder pin on external rename', async () => {
    const a = makeMindMap('a', 'OldRoot');
    const b = makeMindMap('b', 'OldRoot/Sub');
    const c = makeMindMap('c', 'Unrelated');
    boardCacheStore.hydrate(
      { a, b, c },
      { a: 'a.board.json', b: 'b.board.json', c: 'c.board.json' },
    );

    const project = makeProject();
    const ctx = ctxFor(project);
    slice = makeExternalChangesSlice(ctx);

    installFiloMock({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalRename('OldRoot', 'NewRoot');

    expect(
      (boardCacheStore.cache.a.board as { settings?: { defaultFolder?: string } })
        .settings?.defaultFolder,
    ).toBe('NewRoot');
    expect(
      (boardCacheStore.cache.b.board as { settings?: { defaultFolder?: string } })
        .settings?.defaultFolder,
    ).toBe('NewRoot/Sub');
    // Unrelated board is left alone.
    expect(
      (boardCacheStore.cache.c.board as { settings?: { defaultFolder?: string } })
        .settings?.defaultFolder,
    ).toBe('Unrelated');
  });

  it('writes and clears the rename-cascade sentinel on full success', async () => {
    // Sprint C / C-A5-4 — sentinel is only written when the cascade
    // actually touched something. Give the test a board with a
    // defaultFolder pin matching OldRoot so clearBoardDefaultFolderIfMatches
    // marks the board dirty and the rename's cascade has real work.
    const a = makeMindMap('a', 'OldRoot');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    const project = makeProject();
    const ctx = ctxFor(project);
    slice = makeExternalChangesSlice(ctx);

    const writeCalls: Array<{ args: unknown[] }> = [];
    const deleteCalls: Array<{ args: unknown[] }> = [];
    const fakeDisk = { content: null as string | null };

    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        return fakeDisk.content === null
          ? { success: false, code: 'ENOENT' }
          : { success: true, content: fakeDisk.content };
      }
      if (channel === 'vault:write-file-text') {
        if (args[1] === '.filo/rename-cascade-pending.a1b2c3d4e5f6.json') {
          writeCalls.push({ args });
          fakeDisk.content = String(args[2]);
        }
        return { success: true };
      }
      if (channel === 'vault:delete') {
        if (
          typeof args[1] === 'string' &&
          args[1].endsWith('.filo/rename-cascade-pending.a1b2c3d4e5f6.json')
        ) {
          deleteCalls.push({ args });
          fakeDisk.content = null;
        }
        return { success: true };
      }
      return { success: true };
    });

    await slice.handleExternalRename('OldRoot', 'NewRoot');

    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    // Successful flush → clear is delete of the empty file.
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(fakeDisk.content).toBe(null);
  });

  it('Sprint C / C-A5-4 — skips sentinel write when the cascade touched no boards', async () => {
    // Empty cache + no boards → propagateRename, renameBoardPath, and
    // clearBoardDefaultFolderIfMatches all return empty. The pre-Sprint-C
    // behaviour was to still write + clear a sentinel; that's pure noise
    // on a watcher echo of an in-app rename whose cascade already ran.
    const project = makeProject();
    const ctx = ctxFor(project);
    slice = makeExternalChangesSlice(ctx);

    const writeCalls: Array<{ args: unknown[] }> = [];
    const deleteCalls: Array<{ args: unknown[] }> = [];

    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:write-file-text') {
        if (args[1] === '.filo/rename-cascade-pending.a1b2c3d4e5f6.json') {
          writeCalls.push({ args });
        }
        return { success: true };
      }
      if (channel === 'vault:delete') {
        if (
          typeof args[1] === 'string' &&
          args[1].endsWith('.filo/rename-cascade-pending.a1b2c3d4e5f6.json')
        ) {
          deleteCalls.push({ args });
        }
        return { success: true };
      }
      return { success: true };
    });

    await slice.handleExternalRename('OldFolder', 'NewFolder');

    // No sentinel write, no sentinel clear — the early-return triggered.
    expect(writeCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('surfaces a failed-flush toast and marks the sentinel when a .board.json write fails', async () => {
    // One board with a defaultFolder pin so the rename's cascade actually
    // marks it dirty (Sprint C / C-A5-4 — cascade work is now the gate
    // for the sentinel write). Pre-Sprint-C this just used an unrelated
    // pre-dirtied board, which no longer triggers the sentinel path.
    const a = makeMindMap('a', 'OldRoot');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    const project = makeProject();
    const ctx = ctxFor(project);
    slice = makeExternalChangesSlice(ctx);

    const sentinelWrites: Array<{ payload: string }> = [];
    // Simulate a disk-backed sentinel so the mark-failed read-modify-write
    // cycle can actually observe the prior write.
    const fakeSentinel = { content: null as string | null };

    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        if (args[1] === '.filo/rename-cascade-pending.a1b2c3d4e5f6.json') {
          if (fakeSentinel.content === null) {
            return { success: false, code: 'ENOENT' };
          }
          return { success: true, content: fakeSentinel.content };
        }
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:write-file-text') {
        if (args[1] === '.filo/rename-cascade-pending.a1b2c3d4e5f6.json') {
          sentinelWrites.push({ payload: String(args[2]) });
          fakeSentinel.content = String(args[2]);
          return { success: true };
        }
        return { success: true };
      }
      if (channel === 'vault:delete') {
        if (
          typeof args[1] === 'string' &&
          args[1].endsWith('.filo/rename-cascade-pending.a1b2c3d4e5f6.json')
        ) {
          fakeSentinel.content = null;
        }
        return { success: true };
      }
      if (channel === 'board:save') {
        return { success: false, error: 'EROFS' };
      }
      return { success: true };
    });

    await slice.handleExternalRename('OldRoot', 'NewRoot');

    const toast = uiStore.toasts.find((t) =>
      t.text.includes('External rename propagated') &&
      t.text.includes('failed to update'),
    );
    expect(toast).toBeDefined();
    expect(toast?.type).toBe('error');

    // The latest sentinel write should include a failedBoardIds field once
    // markRenameCascadeFlushFailed runs.
    const latest = sentinelWrites[sentinelWrites.length - 1];
    expect(latest?.payload).toBeDefined();
    expect(latest!.payload).toContain('failedBoardIds');
  });
});
