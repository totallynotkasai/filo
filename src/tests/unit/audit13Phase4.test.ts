import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import {
  dispatchExternalChange,
  _resetRegistryForTests,
} from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
import {
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Case-folding & external-edit reconciliation.
 *
 *   - A clean note that follows an external edit keeps that edit's
 *     frontmatter source (a comment on an added key) through the next
 *     body-only save.
 *   - A closed note's external body-only edit doesn't make the next field
 *     write look like a conflict, and the field write keeps the new body.
 *   - A case-divergent board reload rebinds boardPaths to the OS casing.
 */

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

// ── External edits on notes ────────────────────────────────────────────────

describe('external note edits flow into later saves', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let vault: MemoryVault;
  const conflicts: string[] = [];

  beforeEach(() => {
    vaultIndexStore.clear();
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetVaultIdentityForTests();
    clearToasts();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    conflicts.length = 0;
    setNotePromptHandlers({
      conflict: (m) => conflicts.push(m.relPath),
      deletedWithUnsavedBody: () => undefined,
      reloadShrank: () => undefined,
      dismiss: () => undefined,
    });
    slice = makeExternalChangesSlice(makeCtx());
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    clearToasts();
  });

  it('a clean editor follows an external commented key, and a body save keeps the comment', async () => {
    vault = installMemoryVault({ 'M.md': '---\na: 1\n---\nold\n' });
    const m = noteStore.acquire('M.md', 'text-tile:m');
    await m.loaded;

    vault.writeExternally('M.md', '---\na: 1\nb: 2 # added externally\n---\nnew body\n');
    await slice.handleExternalMarkdownChanges(['M.md']);
    // The note decides for itself (fire-and-forget from the watcher path).
    await vi.waitFor(() => expect(m.body).toBe('new body\n'));
    expect(m.frontmatter).toEqual({ a: 1, b: 2 });

    noteStore.setBody('M.md', 'new body edited', 'text-tile:m');
    await noteStore.flush('M.md');
    expect(vault.read('M.md')).toBe('---\na: 1\nb: 2 # added externally\n---\nnew body edited\n');
    expect(conflicts).toEqual([]);
    noteStore.release('M.md', 'text-tile:m');
  });

  it('a closed note\'s external body edit lets the next field write land without a conflict', async () => {
    const before = '---\ntag: x\n---\n# Before\n' + 'a'.repeat(200) + '\n';
    const after = '---\ntag: x\n---\n# After (changed body)\n' + 'b'.repeat(200) + '\n';
    vault = installMemoryVault({ 'Closed.md': before });
    await vaultIndexStore.applyChanges(['Closed.md']);

    vault.writeExternally('Closed.md', after);
    await slice.handleExternalMarkdownChanges(['Closed.md']);

    noteStore.patchFrontmatter('Closed.md', { set: { status: 'done' }, unset: [] });
    const result = await noteStore.flushAll();
    expect(result.failed).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(vault.read('Closed.md')).toBe(
      '---\ntag: x\nstatus: done\n---\n# After (changed body)\n' + 'b'.repeat(200) + '\n',
    );
  });
});

// ── Board reload rebinds boardPaths to the OS casing ────────────────

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

describe('case-divergent board reload rebinds the stored path', () => {
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

