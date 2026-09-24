import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import {
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { DocumentBoard } from '@renderer/schema/index';

/**
 * Sprint B / B4: `vaultStore.delete` on a folder must unload any
 * `documentStore` entries whose backing `.md` lived under the deleted
 * path AND close any Document Board tab pointing at one of those files,
 * even when the Document Board's own `.board.json` lives outside the
 * deleted tree.
 *
 * Before the cleanup, deleting `Notes/2026/` while a Document Board at
 * `Boards/Daily.board.json` showed `Notes/2026/foo.md` left the tab open
 * and the `DocumentState` in memory, so a future hydrate would adopt the
 * stale body instead of finding the file genuinely missing.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeRoute>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
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
 * Phase C / C.1 — vaultStore.delete now routes confirmation through
 * `uiStore.openConfirm` instead of the OS-native `dialog:confirm` IPC.
 * `autoConfirm()` polls until the modal config is present, then fires
 * its `onConfirm` so the test body proceeds without a real user click.
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

describe('vaultStore.delete (folder) — Sprint B / B4 documentStore cleanup', () => {
  beforeEach(() => {
    uninstallFiloStub();
    uiStore.closeConfirm();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
    tabStore.closeAll();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    cancelAllPendingWrites();
    uninstallFiloStub();
    uiStore.closeConfirm();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
    tabStore.closeAll();
    vaultStore.setPath('');
  });

  it('unloads documentStore entries for .md files under the deleted folder', async () => {
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: 'stale body',
      htmlContent: '<p>stale</p>',
      richText: [],
    });
    // Sibling document outside the deleted folder — must be preserved.
    documentStore.loadDocument({
      docId: 'doc-bar',
      filename: 'Other/bar.md',
      title: 'bar',
      body: 'kept',
      htmlContent: '<p>kept</p>',
      richText: [],
    });

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(documentStore.getDocument('doc-foo')).toBeUndefined();
    expect(documentStore.getDocument('doc-bar')).toBeDefined();
  });

  it('bails before the in-memory cascade when the vault swaps during the post-delete flush (Audit-10 M2)', async () => {
    // The existing identity bail covers the `ensureAllLoaded` await; M2 adds a
    // second bail after the `flushAllDirty` await (the suspension point right
    // before the in-memory cascade + doc-unload). We simulate a vault swap that
    // lands during THAT flush: the disk delete already succeeded against the old
    // vault, so the op must report success and skip the cross-vault cascade —
    // leaving the documentStore entry for the deleted path untouched (it belongs
    // to the outgoing vault, which the swap is tearing down).
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: 'stale body',
      htmlContent: '<p>stale</p>',
      richText: [],
    });

    // Bump the vault generation during the FIRST flushAllDirty that runs AFTER
    // ensureAllLoaded (i.e. the line-871 flush, not the drain's flush before it),
    // so the swap lands at exactly the window the new bail guards.
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

      // Disk delete succeeded → reported as success.
      expect(ok).toBe(true);
      // The swap fired during the flush, so the bail skipped the in-memory
      // cascade + doc-unload: the outgoing vault's docStore entry is untouched.
      expect(swapped).toBe(true);
      expect(documentStore.getDocument('doc-foo')).toBeDefined();
    } finally {
      ensureSpy.mockRestore();
      flushSpy.mockRestore();
      __resetVaultIdentityForTests();
    }
  });

  it('bails before the in-memory cascade when the vault swaps during the tags-drop flush (Audit-12 L4)', async () => {
    // L4 adds two more bails AFTER the M2 flushAllDirty bail: one after the
    // `fileTagsStore.flushPendingSave()` await (before the B4 filePath-clear
    // loop) and one after the `Promise.allSettled` await (before the doc-unload
    // loop). We swap the vault during the tags-drop flush — the window the first
    // new bail protects — and assert the B4 loop (cache mutation) AND the
    // doc-unload loop were both skipped, leaving the outgoing vault's state
    // untouched. Bite: remove both L4 bails → the board's filePath is cleared
    // and doc-foo is unloaded against the swapped-in vault.
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => ({ success: true }),
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: 'stale body',
      htmlContent: '<p>stale</p>',
      richText: [],
    });
    // A Document Board OUTSIDE the deleted tree whose filePath points at the
    // deleted .md → the B4 loop would clear its filePath (the guard-1 window).
    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });

    // Swap during the single awaited fileTagsStore.flushPendingSave().
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

      expect(ok).toBe(true); // disk delete landed → success
      expect(swapped).toBe(true);
      // guard-1: the B4 filePath-clear loop was skipped — board untouched.
      expect((boardCacheStore.cache.daily?.board as { filePath?: string }).filePath).toBe(
        'Notes/2026/foo.md',
      );
      // guards: the doc-unload loop was skipped — outgoing vault's doc untouched.
      expect(documentStore.getDocument('doc-foo')).toBeDefined();
    } finally {
      flushSpy.mockRestore();
      __resetVaultIdentityForTests();
    }
  });

  it('closes Document Board tabs whose filePath points at a .md under the deleted folder, even when the .board.json lives outside the tree', async () => {
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: '',
      htmlContent: '',
      richText: [],
    });

    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });
    tabStore.open('daily', 'Daily', 'document', '');

    expect(tabStore.tabs.some((t) => t.boardId === 'daily')).toBe(true);

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(tabStore.tabs.some((t) => t.boardId === 'daily')).toBe(false);
    expect(documentStore.getDocument('doc-foo')).toBeUndefined();
  });

  it('exact-file delete unloads only the matching docId and leaves siblings intact', async () => {
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: '',
      htmlContent: '',
      richText: [],
    });
    documentStore.loadDocument({
      docId: 'doc-foo-sibling',
      filename: 'Notes/2026/bar.md',
      title: 'bar',
      body: '',
      htmlContent: '',
      richText: [],
    });

    const pending = vaultStore.delete('/vault/Notes/2026/foo.md');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    expect(documentStore.getDocument('doc-foo')).toBeUndefined();
    expect(documentStore.getDocument('doc-foo-sibling')).toBeDefined();
  });

  it('Phase C / C.1 — cancel button returns false without invoking vault:delete', async () => {
    let deleteCalls = 0;
    installFiloStub({
      'vault:delete': async () => { deleteCalls++; return { success: true }; },
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
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
  });

  /**
   * Polish phase 4.1 (2026-05-25) — when a folder delete removes the
   * .md that a Document Board's `filePath` points at, the cached board
   * entry must have its filePath cleared and the cleared value must
   * be flushed to disk BEFORE the cleanup wipes the cache. Otherwise
   * the .board.json on disk retains the dangling path; reopening
   * the board crashes the editor on the missing pointer.
   */
  it('clears the Document Board filePath and persists the cleared value to disk', async () => {
    const boardSavePayloads: Array<{ relPath: string; filePath: string }> = [];
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
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
    });

    documentStore.loadDocument({
      docId: 'doc-foo',
      filename: 'Notes/2026/foo.md',
      title: 'foo',
      body: '',
      htmlContent: '',
      richText: [],
    });

    // Document Board lives OUTSIDE the deleted folder but its filePath
    // points to a note INSIDE.
    const fixture = makeDocumentBoardFixture('Boards/Daily.board.json', 'Notes/2026/foo.md');
    boardCacheStore.hydrate({ daily: fixture }, { daily: 'Boards/Daily.board.json' });

    const pending = vaultStore.delete('/vault/Notes/2026');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    // The Document Board's `.board.json` on disk was rewritten with
    // filePath cleared. If the cleanup had wiped the cache before the
    // flush ran, the write would have been a no-op and this assertion
    // would fail.
    const dailyWrites = boardSavePayloads.filter(
      (w) => w.relPath === 'Boards/Daily.board.json',
    );
    expect(dailyWrites.length).toBeGreaterThanOrEqual(1);
    // At least one of the writes carried the cleared filePath.
    expect(dailyWrites.some((w) => w.filePath === '')).toBe(true);
  });
});
