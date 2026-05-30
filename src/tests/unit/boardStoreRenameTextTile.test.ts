import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  registerMarkdownFlusher,
  __resetMarkdownFlushersForTests,
} from '@renderer/lib/boards/markdownWriteRegistry';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile, Tile } from '@renderer/schema/index';

/**
 * Regression: editing a text tile's title in the inline TileHeader editor
 * used to update only the board JSON cache, leaving the backing .md file
 * orphaned at the old name. The downstream "Delete file too" path then fired
 * `vault:delete` on a non-existent path, producing the "Failed to delete:
 * ENOENT" log we shipped to the user.
 *
 * `boardStore.renameTextTileBackingFile` fixes the desync by routing the
 * rename through `vaultStore.rename` (which itself triggers the existing
 * file-ref-integrity + documentStore cascade) before mirroring the new
 * title/titleHtml onto the live tile.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;
type InvokeRecord = { channel: string; args: unknown[] };

function installFiloStub(routes: Record<string, InvokeRoute>): InvokeRecord[] {
  const calls: InvokeRecord[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
  return calls;
}

function makeMindMapFixture(): V7BoardFileData {
  return {
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
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        title: 'New Tile 2',
        style: {} as never,
        tags: [],
        contentId: 'doc-1',
        content: '',
        createdAt: 0,
        updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function makeTextTile(
  overrides: Partial<TextTile> & Pick<TextTile, 'id' | 'title'>,
): Tile {
  return {
    id: overrides.id,
    boardId: 'mm',
    type: 'text',
    title: overrides.title,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '#000',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    contentId: overrides.contentId ?? 'doc-1',
    content: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Tile;
}

function setupActiveBoardWithTile(tile: Tile): void {
  const fixture = makeMindMapFixture();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);
}

describe('boardStore.renameTextTileBackingFile', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetMarkdownFlushersForTests();
    // Toast spy keeps the test output clean and lets us assert refusals.
    vi.spyOn(uiStore, 'toast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetMarkdownFlushersForTests();
  });

  it('happy path — renames .md file and mirrors title onto the live tile', async () => {
    const calls = installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'New Tile 2' }));

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(true);
    expect(boardStore.tiles.t1.title).toBe('Foo');
    const rename = calls.find((c) => c.channel === 'vault:rename');
    expect(rename).toBeDefined();
    // Phase 25 L6 — vault:rename now takes (vaultRoot, oldPath, newPath).
    expect(rename!.args[0]).toBe('/vault');
    expect(rename!.args[1]).toBe('/vault/New Tile 2.md');
    expect(rename!.args[2]).toBe('/vault/Foo.md');
  });

  it('non-text tile returns false and does not invoke any IPC', async () => {
    const calls = installFiloStub({});
    // Hydrate the board, then swap the tile for a link tile so the type
    // check fails the rename path immediately.
    const linkTile = {
      id: 't1', boardId: 'mm', type: 'link', title: 'L',
      position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      style: {} as never, tags: [], locked: false, faded: false,
      url: 'https://x', createdAt: 0, updatedAt: 0,
    } as unknown as Tile;
    setupActiveBoardWithTile(linkTile);

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Other', undefined);

    expect(ok.success).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('title unchanged is a no-op (no rename IPC)', async () => {
    const calls = installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'Foo' }));

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(true);
    expect(calls.find((c) => c.channel === 'vault:rename')).toBeUndefined();
  });

  it('disk collision refuses the rename with a toast', async () => {
    const calls = installFiloStub({
      'vault:file-exists': async () => true, // target exists on disk
      'vault:rename': async () => ({ success: true }),
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'New Tile 2' }));

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(false);
    expect(boardStore.tiles.t1.title).toBe('New Tile 2');
    expect(calls.find((c) => c.channel === 'vault:rename')).toBeUndefined();
    expect(uiStore.toast).toHaveBeenCalledWith(
      expect.stringContaining("'Foo.md' already exists"),
      'warning',
      expect.any(Number),
    );
  });

  it('documentStore collision (different docId holds new name) refuses the rename', async () => {
    const calls = installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => ({ success: true }),
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'New Tile 2', contentId: 'doc-1' }));
    // Another document already lives at the target name.
    documentStore.loadDocument({
      docId: 'doc-foreign',
      filename: 'Foo.md',
      title: 'Foo',
      body: '',
      htmlContent: '',
      richText: [],
    });

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(false);
    expect(calls.find((c) => c.channel === 'vault:rename')).toBeUndefined();
    documentStore.unloadDocument('doc-foreign');
  });

  it('explicit filePath in a subfolder renames inside that folder', async () => {
    const calls = installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
    setupActiveBoardWithTile(
      makeTextTile({
        id: 't1',
        title: 'Old',
        filePath: 'Notes/Old.md',
      } as Partial<TextTile> & Pick<TextTile, 'id' | 'title'>),
    );

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Renamed', undefined);

    expect(ok.success).toBe(true);
    const rename = calls.find((c) => c.channel === 'vault:rename');
    expect(rename).toBeDefined();
    // Phase 25 L6 — vault:rename now takes (vaultRoot, oldPath, newPath).
    expect(rename!.args[0]).toBe('/vault');
    expect(rename!.args[1]).toBe('/vault/Notes/Old.md');
    expect(rename!.args[2]).toBe('/vault/Notes/Renamed.md');
  });

  it('flushes the per-tile markdown writer before invoking vault:rename', async () => {
    const order: string[] = [];
    installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => {
        order.push('rename');
        return { success: true };
      },
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
    registerMarkdownFlusher('text-tile:t1', async () => {
      order.push('flush');
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'New Tile 2' }));

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(true);
    // Flushing happens once via `vaultStore.rename`'s `flushAllMarkdownWriters`
    // (Phase 8.2). The redundant per-tile flush that previously fired here was
    // removed once vaultStore.rename took over draining.
    const flushIndex = order.indexOf('flush');
    const renameIndex = order.indexOf('rename');
    expect(flushIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(flushIndex);
  });

  it('IPC rename failure surfaces a toast and leaves the live title intact', async () => {
    installFiloStub({
      'vault:file-exists': async () => false,
      'vault:rename': async () => ({ success: false }),
    });
    setupActiveBoardWithTile(makeTextTile({ id: 't1', title: 'New Tile 2' }));

    const ok = await boardStore.renameTextTileBackingFile('t1', 'Foo', undefined);

    expect(ok.success).toBe(false);
    expect(boardStore.tiles.t1.title).toBe('New Tile 2');
    expect(uiStore.toast).toHaveBeenCalledWith(
      'Failed to rename file', 'error', expect.any(Number),
    );
  });
});
