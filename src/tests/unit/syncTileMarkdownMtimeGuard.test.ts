/**
 * Phase A.3 — `syncTileMarkdown` mtime guard.
 *
 * The manual sync path reads disk frontmatter, assembles `liveBody +
 * disk frontmatter`, and writes. An external editor writing to the same
 * file between the read and the write would be silently overwritten —
 * Filo's worst class of data loss because the user never sees a prompt.
 *
 * The fix stats the file before the read AND before the write. A
 * different mtime means an external edit landed in the gap; the user is
 * routed through a Reload / Keep-local prompt. Reload skips the write;
 * Keep-local proceeds with a confirmation toast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function makeKanbanFixtureWithTextTile(): V7BoardFileData {
  const def: TileDefinition = {
    id: 't1',
    type: 'text',
    title: 'Note',
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    file: 'note.md',
  } as TileDefinition;

  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId: 't1' }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: def },
    connections: {},
    frames: [],
  };
}

function seedBoardAndDoc(body: string): void {
  boardCacheStore.hydrate(
    { kb: makeKanbanFixtureWithTextTile() },
    { kb: 'tasks.board.json' },
  );
  documentStore.loadDocument({
    docId: 't1',
    filename: 'note.md',
    title: 'Note',
    body,
    htmlContent: '',
    richText: [],
  });
  documentStore.markDirty('t1');
}

describe('boardCacheStore.syncTile — mtime guard (Phase A.3)', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    restoreFiloDefault();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('unchanged mtime → write proceeds', async () => {
    const writeCalls: Array<{ args: unknown[] }> = [];
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1000, size: 100 }),
      'vault:read-file-text': () => ({
        success: true,
        content: '---\ntitle: Note\n---\nOld disk body',
      }),
      'vault:write-existing-file-text': (...args) => {
        writeCalls.push({ args });
        return { success: true };
      },
      'vault:file-exists': () => true,
      'board:save': () => ({ success: true }),
    });

    seedBoardAndDoc('Local body to write');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(writeCalls.length).toBe(1);
  });

  it('changed mtime → prompt fires; Reload skips write', async () => {
    const writeCalls: Array<{ args: unknown[] }> = [];
    let statCallCount = 0;
    installFiloMock({
      'vault:stat': () => {
        statCallCount++;
        // First stat (before-read): mtime 1000.
        // Second stat (before-write): mtime 2000 — external edit landed.
        return statCallCount === 1
          ? { success: true, mtimeMs: 1000, size: 100 }
          : { success: true, mtimeMs: 2000, size: 120 };
      },
      'vault:read-file-text': () => ({
        success: true,
        content: '---\ntitle: Note\n---\nDisk body',
      }),
      'vault:write-existing-file-text': (...args) => {
        writeCalls.push({ args });
        return { success: true };
      },
      'vault:file-exists': () => true,
      'board:save': () => ({ success: true }),
    });

    seedBoardAndDoc('Local body to write');

    // syncTile awaits the prompt's Promise — kick it off without await.
    const syncPromise = boardCacheStore.syncTile('t1');

    // Drain microtasks so syncTile's stat/read/stat chain runs and the
    // prompt's toast lands in uiStore.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const promptToast = uiStore.toasts.find((t) =>
      t.text.includes('modified externally between Filo'),
    );
    expect(promptToast).toBeDefined();
    expect(promptToast!.actions?.length).toBe(2);
    expect(promptToast!.actions?.[0].label).toBe('Reload');
    expect(promptToast!.actions?.[1].label).toBe('Keep local');

    // Invoke Reload — the action's handler resolves the prompt's Promise
    // with 'reload'. syncTile then returns wrote:false.
    uiStore.invokeToastAction(promptToast!.id, 0);

    const result = await syncPromise;
    expect(result.wrote).toBe(false);
    expect(result.skippedReason).toBe('external-edit-reload');
    expect(writeCalls.length).toBe(0);
  });

  it('changed mtime → Keep local writes and surfaces a confirmation toast', async () => {
    const writeCalls: Array<{ args: unknown[] }> = [];
    let statCallCount = 0;
    installFiloMock({
      'vault:stat': () => {
        statCallCount++;
        return statCallCount === 1
          ? { success: true, mtimeMs: 1000, size: 100 }
          : { success: true, mtimeMs: 2000, size: 120 };
      },
      'vault:read-file-text': () => ({
        success: true,
        content: '---\ntitle: Note\n---\nDisk body',
      }),
      'vault:write-existing-file-text': (...args) => {
        writeCalls.push({ args });
        return { success: true };
      },
      'vault:file-exists': () => true,
      'board:save': () => ({ success: true }),
    });

    seedBoardAndDoc('Local body to write');

    const syncPromise = boardCacheStore.syncTile('t1');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const promptToast = uiStore.toasts.find((t) =>
      t.text.includes('modified externally between Filo'),
    );
    expect(promptToast).toBeDefined();

    // Invoke Keep local — write proceeds, confirmation toast surfaces.
    uiStore.invokeToastAction(promptToast!.id, 1);

    const result = await syncPromise;
    expect(result.wrote).toBe(true);
    expect(writeCalls.length).toBe(1);

    const confirmToast = uiStore.toasts.find((t) =>
      t.text.includes('overwritten with local changes'),
    );
    expect(confirmToast).toBeDefined();
  });
});
