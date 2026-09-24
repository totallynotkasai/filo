/**
 * UpdateTitleCommand on the ACTIVE mind-map board.
 *
 * The cache-only (Kanban) round trip is pinned in updateTitleCommand.test.ts.
 * This file pins the live-board side and the undo-safety guarantees:
 *  - the live tile's `titleHtml` follows execute / undo / redo, while its
 *    title is read from the note (the board def never gains a `title`);
 *  - a tile that owns its title edits it on the live board;
 *  - a title edit is a frontmatter-only write, so an open editor's dirty flag
 *    (the pending BODY write) is neither set nor cleared by execute / undo:
 *    setting it would flush a possibly stale body over the file, clearing it
 *    would drop the user's unsaved body edit;
 *  - the command targets the tile's home board's undo stack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { UpdateTitleCommand } from '@renderer/commands/index';
import {
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/** Mutable-disk mock: reads return the current file; writes mutate it; renames are recorded. */
function installDisk(initial: string): { get: () => string; renames: unknown[][] } {
  let disk = initial;
  const renames: unknown[][] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    if (channel === 'vault:read-file-text') return { success: true, content: disk, mtimeMs: 1, size: disk.length };
    if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: disk.length };
    if (channel === 'vault:write-existing-file-text') {
      disk = args[2] as string;
      return { success: true };
    }
    if (channel === 'vault:rename') {
      renames.push(args);
      return { success: true };
    }
    return undefined;
  });
  return { get: () => disk, renames };
}

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

function mindMapFixture(): V7BoardFileData {
  return {
    version: 8,
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        t1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
        l1: { x: 300, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: { id: 't1', type: 'text', filePath: 'Idea.md', style: STYLE, createdAt: 0, updatedAt: 0 },
      l1: {
        id: 'l1',
        type: 'link',
        title: 'Old link',
        tags: [],
        url: 'https://example.com',
        style: STYLE,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

function activate(): void {
  const fixture = mindMapFixture();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board);
}

function noteTitleEdit(oldTitleHtml?: string, newTitleHtml?: string): UpdateTitleCommand {
  return new UpdateTitleCommand({
    tileId: 't1',
    boardId: 'mm',
    notePath: 'Idea.md',
    oldTitle: 'Idea',
    newTitle: 'Better idea',
    oldTitleHtml,
    newTitleHtml,
  });
}

describe('UpdateTitleCommand — active mind-map board', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    resetFrontmatterScheduler();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    documentStore.clear();
    activate();
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    resetFrontmatterScheduler();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    documentStore.clear();
  });

  it('titleHtml round-trips on the live tile through execute / undo / redo; the file is never renamed', async () => {
    const original = '---\ntitle: Idea\n---\nBody\n';
    const disk = installDisk(original);
    const cmd = noteTitleEdit('<p>Idea <strong>bold</strong></p>', '<p>Better idea</p>');

    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    expect(boardStore.getTile('t1')?.titleHtml).toBe('<p>Better idea</p>');
    expect(disk.get()).toBe('---\ntitle: Better idea\n---\nBody\n');
    expect((boardCacheStore.cache.mm.tileDefs.t1 as Record<string, unknown>).title).toBeUndefined();

    await cmd.undo();
    await flushAllPendingFrontmatterWrites();
    expect(boardStore.getTile('t1')?.titleHtml).toBe('<p>Idea <strong>bold</strong></p>');
    expect(disk.get()).toBe(original);

    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    expect(boardStore.getTile('t1')?.titleHtml).toBe('<p>Better idea</p>');
    expect(disk.get()).toBe('---\ntitle: Better idea\n---\nBody\n');
    expect(disk.renames).toEqual([]);
  });

  it('a tile that owns its title edits it on the live board and never touches disk', async () => {
    const disk = installDisk('');
    const cmd = new UpdateTitleCommand({
      tileId: 'l1',
      boardId: 'mm',
      notePath: null,
      oldTitle: 'Old link',
      newTitle: 'New link',
      oldTitleHtml: undefined,
      newTitleHtml: undefined,
    });

    await cmd.execute();
    expect(boardStore.getTile('l1')?.title).toBe('New link');
    await cmd.undo();
    expect(boardStore.getTile('l1')?.title).toBe('Old link');
    expect(disk.get()).toBe('');
    expect(disk.renames).toEqual([]);
  });

  it("a clean open editor stays clean through execute and undo (the body isn't re-written)", async () => {
    installDisk('---\ntitle: Idea\n---\nBody\n');
    documentStore.loadDocument({
      filename: 'Idea.md',
      title: 'Idea',
      body: 'Body',
      htmlContent: '',
      richText: [],
    });
    expect(documentStore.getDocument('Idea.md')?.isDirty).toBe(false);
    const cmd = noteTitleEdit();

    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    expect(documentStore.getDocument('Idea.md')?.isDirty).toBe(false);

    await cmd.undo();
    await flushAllPendingFrontmatterWrites();
    expect(documentStore.getDocument('Idea.md')?.isDirty).toBe(false);
  });

  it('an already-dirty open editor keeps its pending body edit through undo', async () => {
    installDisk('---\ntitle: Idea\n---\nBody\n');
    documentStore.loadDocument({
      filename: 'Idea.md',
      title: 'Idea',
      body: 'Body',
      htmlContent: '',
      richText: [],
    });
    const cmd = noteTitleEdit();
    await cmd.execute();
    await flushAllPendingFrontmatterWrites();

    // An editor marks its unsaved body under its own writer id.
    documentStore.markDirty('Idea.md', 'document-editor:pane-1');
    await cmd.undo();
    await flushAllPendingFrontmatterWrites();
    expect(documentStore.getDocument('Idea.md')?.isDirty).toBe(true);
  });

  it("targets the tile's home board and describes the new title", () => {
    installDisk('');
    const cmd = noteTitleEdit();
    expect(cmd.targetBoardId).toBe('mm');
    expect(cmd.description).toBe('Rename to "Better idea"');
  });
});
