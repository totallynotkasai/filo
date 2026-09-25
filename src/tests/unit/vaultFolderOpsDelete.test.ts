import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { DocumentBoard, MindMapBoard } from '@renderer/schema/index';
import { historyStore } from '@renderer/stores/history.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `vaultStore.delete` on a file or folder: every open note under the deleted
 * path goes missing (nothing queued for it may recreate it), and any
 * Document Board tab pointing at one of those notes closes, even when the
 * Document Board's own `.board.json` lives outside the deleted tree.
 *
 * Otherwise deleting `Notes/2026/` while a Document Board at
 * `Boards/Daily.board.json` showed `Notes/2026/foo.md` would leave the tab
 * open and the note's model live, showing a file that no longer exists.
 *
 * A vault swap during the post-delete awaits skips the in-memory cascade:
 * the outgoing vault's state belongs to the vault being torn down.
 *
 * The item itself moves into Filo's trash, and the delete pushes one
 * CascadeDeleteCommand, so Ctrl+Z moves it back and restores its tiles.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

let vault: MemoryVault;

/**
 * An in-memory vault holding `files` (its `vault:trash-move` takes the file or
 * folder out of `files` into its trash), with `routes` answering the other
 * channels. Every channel asked for is recorded in `channels`.
 */
let channels: string[] = [];
function installFiloStub(routes: Record<string, InvokeRoute>, files: Record<string, string> = {}): void {
  vault = installMemoryVault(files);
  channels = [];
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    channels.push(channel);
    const handler = routes[channel];
    return handler ? await handler(...args) : await base(channel, ...args);
  }) as typeof window.filo.invoke;
}

function makeMindMapFixture(boardId: string, tileId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 0,
        updatedAt: 0,
        filePath,
      },
    },
    connections: {},
    frames: [],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function open(rel: string): Promise<NoteModel> {
  const m = noteStore.acquire(rel, `view:${rel}`);
  await m.loaded;
  return m;
}

function makeDocumentBoardFixture(boardPath: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardPath.replace(/[^a-z0-9]/gi, '_'),
      type: 'document',
      name: boardPath.split('/').pop() ?? 'Doc',
      emoji: '',
      filePath,
      createdAt: 0,
      updatedAt: 0,
      settings: {},
    } as unknown as DocumentBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

/**
 * `vaultStore.delete` confirms through `uiStore.openConfirm`. `autoConfirm()`
 * polls until the modal config is present, then fires its `onConfirm` so the
 * test body proceeds without a real user click.
 */
async function autoConfirm(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (uiStore.confirmDialog) {
      const cfg = uiStore.confirmDialog;
      uiStore.closeConfirm();
      cfg.onConfirm(false);
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const FILES = {
  'Notes/2026/foo.md': '---\ntitle: foo\n---\nfoo body\n',
  'Notes/2026/bar.md': '---\ntitle: bar\n---\nbar body\n',
  'Other/bar.md': '---\ntitle: kept\n---\nkept\n',
};

const ROUTES: Record<string, InvokeRoute> = {
  'vault:read-tree': async () => ({ ok: true, tree: [] }),
  'board:save': async () => ({ success: true }),
};

describe('vaultStore.delete — open notes and Document Boards under the deleted path', () => {
  beforeEach(() => {
    restoreFiloDefault();
    uiStore.closeConfirm();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    uiStore.closeConfirm();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    vaultStore.setPath('');
  });

  it('every open note under the deleted folder goes missing; others stay', async () => {
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');
    const kept = await open('Other/bar.md');

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(foo.status).toBe('missing');
    expect(kept.status).toBe('ready');
    expect(vault.read('Notes/2026/foo.md')).toBeUndefined();
  });

  it('an edit typed into the note lands before the delete and is never written after it', async () => {
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');
    noteStore.setBody('Notes/2026/foo.md', 'last words\n', 'view:Notes/2026/foo.md');

    const pending = vaultStore.delete('/vault/Notes/2026/foo.md');
    await autoConfirm();
    expect(await pending).toBe(true);

    // The drain wrote the edit before the move, so the trashed copy has it.
    expect(vault.writes.some(([, rel, text]) => rel === 'Notes/2026/foo.md' && text.includes('last words'))).toBe(true);
    expect(foo.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites('Notes/2026/foo.md')).toBe(false);
    await noteStore.flushAll();
    expect(vault.read('Notes/2026/foo.md')).toBeUndefined();
  });

  it('bails before the in-memory cascade when the vault swaps during the post-delete flush', async () => {
    // The disk delete already succeeded against the old vault, so the op
    // reports success and skips the cross-vault cascade — leaving the note
    // model for the deleted path untouched (it belongs to the outgoing
    // vault, which the swap is tearing down).
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');

    // Bump the vault generation during the first flushAllDirty that runs
    // AFTER ensureAllLoaded (not the drain's flush before it).
    let ensureLoadedDone = false;
    let swapped = false;
    const ensureSpy = vi
      .spyOn(boardCacheStore, 'ensureAllLoaded')
      .mockImplementation(async () => {
        ensureLoadedDone = true;
      });
    const origFlush = boardCacheStore.flushAllDirty.bind(boardCacheStore);
    const flushSpy = vi
      .spyOn(boardCacheStore, 'flushAllDirty')
      .mockImplementation(async () => {
        const result = await origFlush();
        if (ensureLoadedDone && !swapped) {
          swapped = true;
          beginVaultGeneration('/other-vault');
        }
        return result;
      });

    try {
      const pending = vaultStore.delete('/vault/Notes/2026');
      await autoConfirm();
      const ok = await pending;

      expect(ok).toBe(true);
      expect(swapped).toBe(true);
      expect(foo.status).toBe('ready');
    } finally {
      ensureSpy.mockRestore();
      flushSpy.mockRestore();
      __resetVaultIdentityForTests();
    }
  });

  it('bails before the in-memory cascade when the vault swaps during the tags-drop flush', async () => {
    // Two bails follow the tags-drop flush: one before the Document Board
    // filePath-clear loop and one before the notes are told. Swapping during
    // the flush must skip both, leaving the outgoing vault's state untouched.
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');
    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });

    let swapped = false;
    const flushSpy = vi
      .spyOn(fileTagsStore, 'flushPendingSave')
      .mockImplementation(async () => {
        swapped = true;
        beginVaultGeneration('/other-vault');
        return { ok: true };
      });

    try {
      const pending = vaultStore.delete('/vault/Notes/2026');
      await autoConfirm();
      const ok = await pending;

      expect(ok).toBe(true);
      expect(swapped).toBe(true);
      expect((boardCacheStore.cache.daily?.board as { filePath?: string }).filePath).toBe(
        'Notes/2026/foo.md',
      );
      expect(foo.status).toBe('ready');
    } finally {
      flushSpy.mockRestore();
      __resetVaultIdentityForTests();
    }
  });

  it('closes Document Board tabs whose filePath points at a .md under the deleted folder, even when the .board.json lives outside the tree', async () => {
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');

    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });
    tabStore.open('daily', 'Daily', 'document', '');

    expect(tabStore.tabs.some((t) => t.boardId === 'daily')).toBe(true);

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(tabStore.tabs.some((t) => t.boardId === 'daily')).toBe(false);
    expect(foo.status).toBe('missing');
  });

  it('exact-file delete forgets only the matching note and leaves siblings intact', async () => {
    installFiloStub(ROUTES, FILES);
    const foo = await open('Notes/2026/foo.md');
    const bar = await open('Notes/2026/bar.md');

    const pending = vaultStore.delete('/vault/Notes/2026/foo.md');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(foo.status).toBe('missing');
    expect(bar.status).toBe('ready');
    expect(vault.read('Notes/2026/bar.md')).toBe(FILES['Notes/2026/bar.md']);
  });

  it('the cancel button returns false without moving anything to the trash', async () => {
    installFiloStub(ROUTES, FILES);
    const pending = vaultStore.delete('/vault/Notes/2026/foo.md');
    for (let i = 0; i < 50; i++) {
      if (uiStore.confirmDialog) {
        const cfg = uiStore.confirmDialog;
        uiStore.closeConfirm();
        cfg.onCancel?.();
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const ok = await pending;
    expect(ok).toBe(false);
    expect(channels).not.toContain('vault:trash-move');
    expect(vault.trash.size).toBe(0);
    expect(vault.read('Notes/2026/foo.md')).toBe(FILES['Notes/2026/foo.md']);
  });

  /**
   * When a folder delete removes the .md a Document Board's `filePath`
   * points at, the cached board entry must have its filePath cleared and
   * the cleared value flushed to disk BEFORE the cleanup wipes the cache.
   * Otherwise the .board.json on disk retains the dangling path.
   */
  it('clears the Document Board filePath and persists the cleared value to disk', async () => {
    const boardSavePayloads: Array<{ relPath: string; filePath: string }> = [];
    installFiloStub({
      ...ROUTES,
      'board:save': async (_vaultRoot: unknown, relPath: unknown, jsonStr: unknown) => {
        try {
          const parsed = JSON.parse(jsonStr as string) as { board?: { filePath?: string } };
          boardSavePayloads.push({
            relPath: relPath as string,
            filePath: parsed.board?.filePath ?? '<missing>',
          });
        } catch {
          boardSavePayloads.push({ relPath: relPath as string, filePath: '<parse-error>' });
        }
        return { success: true };
      },
    }, FILES);

    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    const dailyWrites = boardSavePayloads.filter(
      (w) => w.relPath === 'Boards/Daily.board.json',
    );
    expect(dailyWrites.length).toBeGreaterThanOrEqual(1);
    expect(dailyWrites.some((w) => w.filePath === '')).toBe(true);
  });
});

describe('vaultStore.delete — the item goes to Filo\'s trash and Ctrl+Z brings it back', () => {
  beforeEach(() => {
    restoreFiloDefault();
    uiStore.closeConfirm();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    historyStore.clear();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    uiStore.closeConfirm();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
  });

  async function deleteConfirmed(absPath: string): Promise<boolean> {
    const pending = vaultStore.delete(absPath);
    await autoConfirm();
    return pending;
  }

  it('the deleted folder is in the trash under its old path, with every file in it', async () => {
    installFiloStub(ROUTES, FILES);
    expect(await deleteConfirmed('/vault/Notes/2026')).toBe(true);

    expect(channels).toContain('vault:trash-move');
    expect(channels).not.toContain('vault:delete');
    const entries = [...vault.trash.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0].originalPath).toBe('Notes/2026');
    expect([...entries[0].files.keys()].sort()).toEqual(['Notes/2026/bar.md', 'Notes/2026/foo.md']);
    expect(vault.read('Other/bar.md')).toBe(FILES['Other/bar.md']);
  });

  it('undo (the pushed CascadeDeleteCommand) moves the note back and restores its tiles', async () => {
    installFiloStub(ROUTES, FILES);
    const fixture = makeMindMapFixture('mm', 't_foo', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'Boards/mm.board.json' });
    boardStore.setBoard(fixture.board, boardCacheStore.getFullTilesForBoard('mm'), {}, []);
    historyStore.setActiveBoard('mm');
    const foo = await open('Notes/2026/foo.md');

    expect(await deleteConfirmed('/vault/Notes/2026/foo.md')).toBe(true);
    expect(vault.read('Notes/2026/foo.md')).toBeUndefined();
    expect(boardCacheStore.cache.mm.tileDefs.t_foo).toBeUndefined();
    expect(foo.status).toBe('missing');
    expect(historyStore.canUndo).toBe(true);

    await historyStore.undo();
    await settle();
    await foo.loaded;

    expect(vault.read('Notes/2026/foo.md')).toBe(FILES['Notes/2026/foo.md']);
    expect(vault.trash.size).toBe(0);
    expect(boardCacheStore.cache.mm.tileDefs.t_foo).toBeDefined();
    expect(foo.status).toBe('ready');
    expect(foo.body).toBe('foo body\n');
  });

  it('undo of a folder delete brings every file back', async () => {
    installFiloStub(ROUTES, FILES);
    const fixture = makeMindMapFixture('mm', 't_foo', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'Boards/mm.board.json' });
    boardStore.setBoard(fixture.board, boardCacheStore.getFullTilesForBoard('mm'), {}, []);
    historyStore.setActiveBoard('mm');

    expect(await deleteConfirmed('/vault/Notes/2026')).toBe(true);
    await historyStore.undo();
    await settle();

    expect(vault.read('Notes/2026/foo.md')).toBe(FILES['Notes/2026/foo.md']);
    expect(vault.read('Notes/2026/bar.md')).toBe(FILES['Notes/2026/bar.md']);
    expect(boardCacheStore.cache.mm.tileDefs.t_foo).toBeDefined();
  });

  it('a note on no board still gets an undoable command', async () => {
    installFiloStub(ROUTES, FILES);
    // A board is active (so history has a stack) but nothing on it shows the note.
    const fixture = makeMindMapFixture('mm', 't_foo', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'Boards/mm.board.json' });
    boardStore.setBoard(fixture.board, boardCacheStore.getFullTilesForBoard('mm'), {}, []);
    historyStore.setActiveBoard('mm');

    expect(await deleteConfirmed('/vault/Other/bar.md')).toBe(true);
    expect(vault.read('Other/bar.md')).toBeUndefined();
    expect(historyStore.canUndo).toBe(true);

    await historyStore.undo();
    await settle();
    expect(vault.read('Other/bar.md')).toBe(FILES['Other/bar.md']);
    expect(vault.trash.size).toBe(0);
    expect(boardCacheStore.cache.mm.tileDefs.t_foo).toBeDefined();
  });

  it('a failed move to the trash deletes nothing and says so', async () => {
    installFiloStub(ROUTES, FILES);
    const fixture = makeMindMapFixture('mm', 't_foo', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'Boards/mm.board.json' });
    const foo = await open('Notes/2026/foo.md');
    vault.failNextTrashMove('Notes/2026/foo.md', 'EBUSY');

    expect(await deleteConfirmed('/vault/Notes/2026/foo.md')).toBe(false);
    expect(vault.read('Notes/2026/foo.md')).toBe(FILES['Notes/2026/foo.md']);
    expect(vault.trash.size).toBe(0);
    expect(boardCacheStore.cache.mm.tileDefs.t_foo).toBeDefined();
    expect(foo.status).toBe('ready');
    expect(uiStore.toasts.some((t) => t.text.includes("Couldn't move \"foo.md\" to Filo's trash"))).toBe(true);
  });
});
