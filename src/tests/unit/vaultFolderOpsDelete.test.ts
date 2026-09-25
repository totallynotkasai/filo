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
import type { DocumentBoard } from '@renderer/schema/index';
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
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

let vault: MemoryVault;

/**
 * An in-memory vault holding `files`, with `routes` answering the other
 * channels. `vault:delete` removes the file or folder unless a route
 * overrides it.
 */
function installFiloStub(routes: Record<string, InvokeRoute>, files: Record<string, string> = {}): void {
  vault = installMemoryVault(files);
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    const handler = routes[channel];
    const result = handler ? await handler(...args) : await base(channel, ...args);
    if (channel === 'vault:delete' && (result as { success?: boolean } | null)?.success) {
      const rel = String(args[1]).replace(/^\/vault\//, '').toLowerCase();
      for (const key of [...vault.files.keys()]) {
        if (key === rel || key.startsWith(`${rel}/`)) vault.remove(key);
      }
    }
    return result;
  }) as typeof window.filo.invoke;
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
  'vault:delete': async () => ({ success: true }),
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

    // The drain wrote the edit before the delete (the undo snapshot has it).
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

  it('the cancel button returns false without invoking vault:delete', async () => {
    let deleteCalls = 0;
    installFiloStub({
      ...ROUTES,
      'vault:delete': async () => { deleteCalls++; return { success: true }; },
    }, FILES);
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
    expect(deleteCalls).toBe(0);
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
