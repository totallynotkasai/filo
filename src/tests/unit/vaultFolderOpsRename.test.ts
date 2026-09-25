import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, ImageTile, Tile } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `vaultStore.rename` must
 *
 *   1. land every queued note write BEFORE issuing the `vault:rename` IPC,
 *      so an edit queued against the OLD path reaches disk before the file
 *      moves — otherwise the write either races the atomic rename (Windows
 *      EBUSY) or resurrects the old file after the rename completes; a
 *      queued write that fails blocks the rename;
 *   2. keep an open note's model on the renamed file, so later edits land
 *      at the new path; and
 *   3. apply the in-memory `boardStore.propagateRename` cascade BEFORE
 *      the IPC, then REVERT the cascade if the IPC fails — so the cache
 *      never lingers in a half-renamed state pointing at a file that
 *      doesn't exist on disk.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;
type InvokeRecord = { channel: string; args: unknown[]; orderIndex: number };

let vault: MemoryVault;

/**
 * An in-memory vault (the note writer's channels) with `routes` answering
 * the other channels. Every call is recorded in order.
 */
function installFiloStub(
  routes: Record<string, InvokeRoute>,
  files: Record<string, string> = {},
): InvokeRecord[] {
  vault = installMemoryVault(files);
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  const calls: InvokeRecord[] = [];
  let counter = 0;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args, orderIndex: counter++ });
    const handler = routes[channel];
    if (handler) return handler(...args);
    return base(channel, ...args);
  }) as typeof window.filo.invoke;
  return calls;
}

/** `vault:rename` for the in-memory vault: moves one file. */
function moveFile(_root: unknown, oldAbs: unknown, newAbs: unknown): { success: true } {
  const from = String(oldAbs).replace(/^\/vault\//, '');
  const to = String(newAbs).replace(/^\/vault\//, '');
  const text = vault.read(from);
  if (text !== undefined) {
    vault.remove(from);
    vault.writeExternally(to, text);
  }
  return { success: true };
}

function makeImageBoardFixture(srcPath: string): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'MM',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        i1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      i1: {
        id: 'i1',
        type: 'image',
        title: 'Photo',
        src: srcPath,
        style: {} as never,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function makeImageRuntimeTile(srcPath: string): Tile {
  return {
    id: 'i1',
    boardId: 'mm',
    type: 'image',
    title: 'Photo',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '#000',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    src: srcPath,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ImageTile as Tile;
}

describe('vaultStore.rename — transactional flow', () => {
  beforeEach(() => {
    restoreFiloDefault();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  it('lands queued note writes BEFORE the vault:rename IPC fires', async () => {
    const calls = installFiloStub(
      {
        'vault:rename': moveFile,
        'vault:read-tree': async () => ({ ok: true, tree: [] }),
        'board:save': async () => null,
        'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
      },
      { 'a.md': '---\ntitle: A\n---\nBody\n' },
    );
    noteStore.patchFrontmatter('a.md', { set: { status: 'edited' }, unset: [] });

    const result = await vaultStore.rename('/vault/a.md', '/vault/b.md');

    expect(result.success).toBe(true);
    const writeIdx = calls.find((c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'a.md')?.orderIndex ?? -1;
    const renameIdx = calls.find((c) => c.channel === 'vault:rename')?.orderIndex ?? -1;
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(writeIdx);
    expect(vault.read('a.md')).toBeUndefined();
    expect(vault.read('b.md')).toBe('---\ntitle: A\nstatus: edited\n---\nBody\n');
  });

  it('an open note follows the rename: its next edit lands on the new file', async () => {
    installFiloStub(
      {
        'vault:rename': moveFile,
        'vault:read-tree': async () => ({ ok: true, tree: [] }),
        'board:save': async () => null,
        'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
      },
      { 'a.md': '---\ntitle: A\n---\nBody\n' },
    );
    const m = noteStore.acquire('a.md', 'editor');
    await m.loaded;

    const result = await vaultStore.rename('/vault/a.md', '/vault/b.md');
    expect(result.success).toBe(true);
    expect(noteStore.get('b.md')).toBe(m);

    noteStore.setBody('b.md', 'After rename\n', 'editor');
    await noteStore.flushAll();
    expect(vault.read('b.md')).toBe('---\ntitle: A\n---\nAfter rename\n');
    expect(vault.read('a.md')).toBeUndefined();
  });

  it('on IPC failure, reverts the in-memory propagateRename cascade', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: false, code: 'EACCES' }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    boardStore.setBoard(fixture.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(false);
    expect(result.code).toBe('EACCES');
    // Cache must be back to the old path — the cascade was reverted.
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(oldRel);
  });

  it('on IPC success, the propagateRename cascade lands in the cache (forward direction)', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    const newRel = 'renamed.jpg';
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    boardStore.setBoard(fixture.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(true);
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(newRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(newRel);
  });

  it('multi-board cascade revert: every touched board is rolled back, not just the active one', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: false, code: 'EACCES' }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    // Two boards both referencing the same image — only the first is active,
    // but the cascade mutates both. An inverse-only revert
    // could leave the inactive board half-mutated when the inverse threw;
    // the snapshot-based revert restores every entry unconditionally.
    const fixtureA: BoardFileData = makeImageBoardFixture(oldRel);
    const fixtureB: BoardFileData = makeImageBoardFixture(oldRel);
    (fixtureB.board as { id: string }).id = 'mm-b';
    (fixtureB.tileDefs.i1 as { id: string }).id = 'i1-b';
    fixtureB.tileDefs['i1-b'] = fixtureB.tileDefs.i1 as never;
    delete (fixtureB.tileDefs as Record<string, unknown>).i1;
    (fixtureB.board as MindMapBoard).placements = {
      'i1-b': { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
    } as never;

    boardCacheStore.hydrate(
      { mm: fixtureA, 'mm-b': fixtureB },
      { mm: 'a.board.json', 'mm-b': 'b.board.json' },
    );
    // Active board is `mm`. `mm-b` is in the cache but not the active runtime.
    boardStore.setBoard(fixtureA.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(false);
    // Active board cache + runtime restored.
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(oldRel);
    // Inactive board's cache also restored — the snapshot revert covers
    // every board the forward cascade touched.
    expect((boardStore.cache['mm-b'].tileDefs['i1-b'] as { src?: string }).src).toBe(oldRel);
  });

  it('a queued note write that fails blocks the rename and surfaces an IO_ERROR', async () => {
    // `vaultStore.rename` wraps the cascade in `withDrainedWrites`. A failed
    // note write makes the drain throw `PendingWritesFailedError` BEFORE the
    // IPC issues; the rename returns `{ success: false, code: 'IO_ERROR' }`
    // so the sidebar caller doesn't optimistically remove the source row.
    // Proceeding would leave the edit on neither the OLD nor the NEW path.
    const calls = installFiloStub(
      {
        'vault:rename': moveFile,
        'vault:read-tree': async () => ({ ok: true, tree: [] }),
        'board:save': async () => null,
        'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
      },
      { 'a.md': '---\ntitle: A\n---\nBody\n' },
    );
    vault.failNextWrite('a.md', 'EACCES');
    noteStore.patchFrontmatter('a.md', { set: { status: 'edited' }, unset: [] });

    const result = await vaultStore.rename('/vault/a.md', '/vault/b.md');

    // Drain failure short-circuits the rename — the IPC is never issued.
    expect(result.success).toBe(false);
    expect(result.code).toBe('IO_ERROR');
    expect(calls.find((c) => c.channel === 'vault:rename')).toBeUndefined();
    expect(vault.read('a.md')).toBe('---\ntitle: A\n---\nBody\n');
  });
});
