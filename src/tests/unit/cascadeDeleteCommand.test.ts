import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { cancelAllPendingWrites, resetWriteTracking, type BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, Connection } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { seedBoard } from '../helpers/seedBoard';

/**
 * CascadeDeleteCommand. When a vault file is deleted (OS Explorer, git
 * checkout, sidebar delete), every dependent tile across every board has to
 * go. This command snapshots them so undo restores placements even on
 * inactive boards. When the delete moved the file into Filo's trash, undo
 * moves it back first; otherwise only the placement returns and the
 * broken-ref badge surfaces the missing file.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMap(id: string, tileId: string, filePath: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
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

/**
 * Drains pending Promises so the async tail of `persistAddTile` (vault
 * file-exists probe, vaultIndex refresh, then the cache mutation) has
 * a chance to complete before assertions.
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** Every channel the memory vault was asked for since the last `installBoardVault`. */
let channels: string[] = [];

/**
 * The memory vault plus a `board:save` that succeeds: the trash IPCs drain the
 * board writer first, and a failed `.board.json` save would refuse the move.
 */
function installBoardVault(files: Record<string, string>, root: string): MemoryVault {
  const vault = installMemoryVault(files, root);
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  channels = [];
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    channels.push(channel);
    if (channel === 'board:save') return { success: true };
    return base(channel, ...args);
  }) as typeof window.filo.invoke;
  return vault;
}

/** Moves `rel` into the memory vault's trash, as the delete that built the command did. */
async function trashInVault(vault: MemoryVault, rel: string): Promise<{ rel: string; trashId: string }> {
  const result = (await window.filo.invoke('vault:trash-move', vault.root, rel)) as { success: boolean; trashId: string };
  expect(result.success).toBe(true);
  return { rel, trashId: result.trashId };
}

describe('CascadeDeleteCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    // Intentionally leave vaultStore.path empty so `persistAddTile`'s
    // text-tile file-exists branch is skipped — that branch awaits IPC
    // and the empty stub here would leave it spinning in tests. The
    // cache-level assertions below don't depend on the file ever existing.
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    // A board write left armed or failed by one test must not make the next
    // test's trash move refuse to run (the move drains the board writer).
    cancelAllPendingWrites();
    resetWriteTracking();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    // A board write left armed or failed by one test must not make the next
    // test's trash move refuse to run (the move drains the board writer).
    cancelAllPendingWrites();
    resetWriteTracking();
  });

  it('execute removes from cache; undo restores per-board', async () => {
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    expect(tile).toBeDefined();

    const byBoard: Record<string, Tile[]> = { a: [tile] };
    const cmd = new CascadeDeleteCommand(byBoard, []);
    await cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeUndefined();

    await cmd.undo();
    await flushAsync();
    expect(boardStore.getTile('t_a')).toBeDefined();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeDefined();
  });

  it('restores tiles on inactive boards via the cache (not the active runtime)', async () => {
    const a = makeMindMap('a', 't_a', 'A.md');
    const b = makeMindMap('b', 't_b', 'B.md');
    boardCacheStore.hydrate(
      { a, b },
      { a: 'a.board.json', b: 'b.board.json' },
    );
    // a is active; b is inactive.
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const tilesB = boardCacheStore.getFullTilesForBoard('b');
    const byBoard: Record<string, Tile[]> = {
      a: [tilesA.t_a],
      b: [tilesB.t_b],
    };
    const cmd = new CascadeDeleteCommand(byBoard, []);
    await cmd.execute();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeUndefined();
    expect(boardCacheStore.cache.b.tileDefs.t_b).toBeUndefined();

    await cmd.undo();
    await flushAsync();
    // Active board: tile is back in runtime + cache.
    expect(boardStore.getTile('t_a')).toBeDefined();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeDefined();
    // Inactive board: tile back in cache only (runtime is the OTHER board's).
    expect(boardCacheStore.cache.b.tileDefs.t_b).toBeDefined();
  });

  it('snapshots tiles and connections (caller mutation does not leak in)', async () => {
    const a = makeMindMap('a', 't_a', 'A.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const tile = { ...tilesA.t_a };
    const conn: Connection = {
      id: 'c1',
      boardId: 'a',
      fromTileId: 't_a',
      toTileId: 't_a',
      style: { pathColor: '', pathSize: 2, pathType: 'curved', pathStyle: 'solid', arrowType: 'none', arrowColor: '', arrowSize: 10 },
      bubbles: {},
      labels: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Connection;
    const byBoard: Record<string, Tile[]> = { a: [tile] };
    const cmd = new CascadeDeleteCommand(byBoard, [conn]);
    // Mutating after construction must not affect the snapshot.
    tile.title = 'mutated';
    byBoard.a.push({ ...tile, id: 'extra' });
    await cmd.execute();
    // Only the original tile was removed.
    expect(boardStore.getTile('t_a')).toBeUndefined();
  });

  it('undo bails with a toast when the vault has changed since execute', async () => {
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    // Capture a non-empty vaultRoot at construction time so the guard has
    // something to compare against.
    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], { vaultRoot: '/old/vault' });
    await cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();

    // Swap the vault.
    vaultStore.setPath('/new/vault');
    const before = uiStore.toasts.length;

    await cmd.undo();
    await flushAsync();

    // Tile must remain absent — undo refused to restore.
    expect(boardStore.getTile('t_a')).toBeUndefined();
    // A warning toast appeared.
    expect(uiStore.toasts.length).toBeGreaterThan(before);
    expect(uiStore.toasts.some((t) => t.text.includes('Cannot undo the delete: the vault has changed'))).toBe(true);
  });

  it('undo does NOT seed an empty .md when nothing was trashed', async () => {
    // An external tool deleted Notes.md; "remove the tiles" runs the cascade
    // with nothing in Filo's trash. Ctrl+Z must bring the placement back
    // without writing a blank note over the missing path.
    const invocations: Array<{ channel: string; args: unknown[] }> = [];
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        invocations.push({ channel, args });
        if (channel === 'vault:file-exists') return false;
        if (channel === 'vault:read-tree') return { ok: true, tree: [] };
        return null;
      },
      on: () => () => {},
      send: () => {},
    };
    // Non-empty vault path so the text-tile branch in persistAddTile runs.
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], { vaultRoot: '/v' });
    await cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();

    invocations.length = 0;
    await cmd.undo();
    await flushAsync();

    // Placement must come back …
    expect(boardStore.getTile('t_a')).toBeDefined();
    // … but no write IPC fired against the cascaded path, and no trash
    // restore was attempted.
    const wroteFile = invocations.some((c) =>
      (c.channel === 'vault:write-file-text' || c.channel === 'vault:create-file-text')
      && c.args[1] === 'Notes.md',
    );
    expect(wroteFile).toBe(false);
    expect(invocations.some((c) => c.channel === 'vault:trash-restore')).toBe(false);
  });

  it('undo moves the trashed note back before its placement, byte-for-byte and without a write', async () => {
    const vault = installBoardVault({ 'Notes.md': '---\ntitle: Notes\n---\n# Real content\n' }, '/v');
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const trashed = await trashInVault(vault, 'Notes.md');
    const cmd = new CascadeDeleteCommand({ a: [tilesA.t_a] }, [], { vaultRoot: '/v', trashed });
    await cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();
    expect(vault.read('Notes.md')).toBeUndefined();

    await cmd.undo();
    await flushAsync();

    expect(boardStore.getTile('t_a')).toBeDefined();
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\n# Real content\n');
    expect(vault.trash.size).toBe(0);
    // A rename out of the trash, never a rewrite of the body.
    expect(vault.writes.filter(([, rel]) => rel === 'Notes.md')).toEqual([]);
  });

  it('redo after undo moves the note to the trash again; a second undo brings it back', async () => {
    const vault = installBoardVault({ 'Notes.md': 'body\n' }, '/v');
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const trashed = await trashInVault(vault, 'Notes.md');
    const cmd = new CascadeDeleteCommand({ a: [tilesA.t_a] }, [], { vaultRoot: '/v', trashed });
    await cmd.execute();
    await cmd.undo();
    await flushAsync();
    expect(vault.read('Notes.md')).toBe('body\n');

    await cmd.execute();
    expect(vault.read('Notes.md')).toBeUndefined();
    expect(vault.trash.size).toBe(1);
    expect(boardStore.getTile('t_a')).toBeUndefined();

    await cmd.undo();
    await flushAsync();
    expect(vault.read('Notes.md')).toBe('body\n');
    expect(vault.trash.size).toBe(0);
    expect(boardStore.getTile('t_a')).toBeDefined();
  });

  it('restored beside a newer file: the tile follows the copy, and redo trashes the copy, not the newer file', async () => {
    const vault = installBoardVault({ 'Notes.md': 'original\n' }, '/v');
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const trashed = await trashInVault(vault, 'Notes.md');
    const cmd = new CascadeDeleteCommand({ a: [tilesA.t_a] }, [], { vaultRoot: '/v', trashed });
    await cmd.execute();
    vault.writeExternally('Notes.md', 'newcomer\n');

    await cmd.undo();
    await flushAsync();
    expect(vault.read('Notes.md')).toBe('newcomer\n');
    expect(vault.read('Notes (restored).md')).toBe('original\n');
    expect((boardStore.getTile('t_a') as { filePath?: string } | undefined)?.filePath).toBe('Notes (restored).md');

    await cmd.execute();
    expect(vault.read('Notes.md')).toBe('newcomer\n');
    expect(vault.read('Notes (restored).md')).toBeUndefined();
    expect([...vault.trash.values()].map((t) => t.originalPath)).toEqual(['Notes (restored).md']);
  });

  it('default-constructed cascade anchors to vaultStore.path and leaves the trash alone after a swap', async () => {
    // A caller that omits `vaultRoot` must still be anchored to the open
    // vault, or an undo after a swap would move the item back into (and
    // placements onto) whatever vault is open now.
    const vault = installBoardVault({ 'Notes.md': '# Original body' }, '/vault-A');
    vaultStore.setPath('/vault-A');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const trashed = await trashInVault(vault, 'Notes.md');
    const cmd = new CascadeDeleteCommand({ a: [tilesA.t_a] }, [], { trashed });
    await cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();

    // User swaps vaults — the cascade must NOT restore anything now.
    vaultStore.setPath('/vault-B');
    const toastsBefore = uiStore.toasts.length;
    await cmd.undo();
    await flushAsync();

    expect(vault.trash.size).toBe(1);
    expect(vault.read('Notes.md')).toBeUndefined();
    expect(channels.includes('vault:trash-restore')).toBe(false);
    expect(boardStore.getTile('t_a')).toBeUndefined();
    expect(uiStore.toasts.length).toBeGreaterThan(toastsBefore);
    expect(uiStore.toasts.some((t) => t.text.includes('vault has changed'))).toBe(true);
  });

  it('execute (redo) bails with a toast when the vault has changed since construction', async () => {
    // Same guard as undo() — a redo against a different vault would
    // target the wrong placements / files.
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    seedBoard(boardStore, a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], { vaultRoot: '/old/vault' });

    // Swap the vault BEFORE the (redo) execute.
    vaultStore.setPath('/new/vault');
    const before = uiStore.toasts.length;

    await cmd.execute();

    // Tile remains in the cache — execute refused to redo the delete.
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeDefined();
    expect(uiStore.toasts.length).toBeGreaterThan(before);
    expect(uiStore.toasts.some((t) => t.text.includes('Cannot redo the delete: the vault has changed'))).toBe(true);
  });

  it('description includes tile count across boards, or names the trashed path', () => {
    const a = makeMindMap('a', 't_a', 'A.md');
    const b = makeMindMap('b', 't_b', 'B.md');
    boardCacheStore.hydrate(
      { a, b },
      { a: 'a.board.json', b: 'b.board.json' },
    );
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    const tilesB = boardCacheStore.getFullTilesForBoard('b');
    const cmd = new CascadeDeleteCommand(
      { a: [tilesA.t_a], b: [tilesB.t_b] },
      [],
    );
    expect(cmd.description).toBe('Delete 2 tiles');
    const named = new CascadeDeleteCommand({}, [], { trashed: { rel: 'A.md', trashId: 'x' } });
    expect(named.description).toBe('Delete "A.md"');
  });
});
