import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, Connection } from '@renderer/schema/index';

/**
 * Phase 10.4 — CascadeDeleteCommand. When an external file is deleted (OS
 * Explorer, git checkout, sidebar delete), every dependent tile across every
 * board has to go. This command snapshots them so undo restores placements
 * even on inactive boards. The backing file is gone — we don't restore
 * content, just the placement; the broken-ref badge surfaces the missing
 * file.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMap(id: string, tileId: string, filePath: string): V7BoardFileData {
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
        title: 'T',
        contentId: `doc_${tileId}`,
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId: id,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
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

describe('CascadeDeleteCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    // Intentionally leave vaultStore.path empty so `persistAddTile`'s
    // text-tile file-exists branch is skipped — that branch awaits IPC
    // (`vault:file-exists`, `vault:write-file-text`, `vault:read-tree`) and
    // the empty stub here would leave it spinning in tests. The cache-level
    // assertions below don't depend on the file ever existing.
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute removes from cache; undo restores per-board', async () => {
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    expect(tile).toBeDefined();

    const byBoard: Record<string, Tile[]> = { a: [tile] };
    const cmd = new CascadeDeleteCommand(byBoard, []);
    cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeUndefined();

    cmd.undo();
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
    boardStore.setBoard(a.board, tilesA, {}, []);

    const tilesB = boardCacheStore.getFullTilesForBoard('b');
    const byBoard: Record<string, Tile[]> = {
      a: [tilesA.t_a],
      b: [tilesB.t_b],
    };
    const cmd = new CascadeDeleteCommand(byBoard, []);
    cmd.execute();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeUndefined();
    expect(boardCacheStore.cache.b.tileDefs.t_b).toBeUndefined();

    cmd.undo();
    await flushAsync();
    // Active board: tile is back in runtime + cache.
    expect(boardStore.getTile('t_a')).toBeDefined();
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeDefined();
    // Inactive board: tile back in cache only (runtime is the OTHER board's).
    expect(boardCacheStore.cache.b.tileDefs.t_b).toBeDefined();
  });

  it('snapshots tiles and connections (caller mutation does not leak in)', () => {
    const a = makeMindMap('a', 't_a', 'A.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

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
    cmd.execute();
    // Only the original tile was removed.
    expect(boardStore.getTile('t_a')).toBeUndefined();
  });

  it('undo bails with a toast when the vault has changed since execute', async () => {
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    // Capture a non-empty vaultRoot at construction time so the guard has
    // something to compare against.
    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], {}, '/old/vault');
    cmd.execute();
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
    expect(uiStore.toasts.some((t) => t.text.includes('vault has changed'))).toBe(true);
  });

  it('Phase B / B.2 — undo does NOT seed an empty .md when the snapshot is missing', async () => {
    // Repro: an external tool deletes Notes.md. The "Mark broken refs" toast
    // calls `cascadeDeleteByVaultPath(rel)` with NO snapshots (the file is
    // already gone — we couldn't capture its body). The user then hits Ctrl+Z.
    //
    // Pre-fix: `persistAddTile` would see `vault:file-exists` return false and
    // write an empty `.md` at the deleted path — silently replacing the user's
    // missing file with a blank document.
    //
    // Post-fix: `CascadeDeleteCommand.undo()` passes `skipEmptySeed: true` to
    // `boardStore.addTile` / `boardCacheStore.persistAddTile`. The placement
    // comes back but no file write fires.

    // Track every IPC call so we can assert vault:write-file-text was NOT
    // invoked. file-exists returns false (file truly gone), refreshTree
    // returns harmlessly.
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
    // The vaultRoot guard in undo() compares vaultStore.path against the
    // captured root — pass the same value.
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], {}, '/v');
    cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();

    // Drain the no-snapshot bookkeeping so file-exists has been queried.
    invocations.length = 0;
    await cmd.undo();
    await flushAsync();

    // Placement must come back …
    expect(boardStore.getTile('t_a')).toBeDefined();
    // … but no write IPC fired against the cascaded path.
    const wroteFile = invocations.some((c) =>
      c.channel === 'vault:write-file-text' && c.args[1] === 'Notes.md',
    );
    expect(wroteFile).toBe(false);
  });

  it('Phase B / B.2 — undo restores the snapshot body when one was captured', async () => {
    // Counter-check: with a snapshot in `fileSnapshots`, the file IS restored.
    // (The snapshot-restore loop in undo runs BEFORE the placement loop, so
    // even with `skipEmptySeed: true` the body still lands on disk.)
    const writes: Array<{ rel: string; content: string }> = [];
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:file-exists') return true; // snapshot wrote it
        if (channel === 'vault:write-file-text') {
          writes.push({ rel: String(args[1]), content: String(args[2]) });
          return { success: true };
        }
        if (channel === 'vault:read-tree') return { ok: true, tree: [] };
        return null;
      },
      on: () => () => {},
      send: () => {},
    };
    vaultStore.setPath('/v');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand(
      { a: [tile] },
      [],
      { 'Notes.md': '# Real content' },
      '/v',
    );
    cmd.execute();
    await cmd.undo();
    await flushAsync();

    expect(boardStore.getTile('t_a')).toBeDefined();
    // Exactly one write of the snapshot body for Notes.md (from the
    // snapshot-restore loop). No empty-seed write follows because (a) the
    // snapshot landed first and file-exists returns true, and (b) the
    // `skipEmptySeed` flag would skip it regardless.
    const notesWrites = writes.filter((w) => w.rel === 'Notes.md');
    expect(notesWrites.length).toBe(1);
    expect(notesWrites[0].content).toBe('# Real content');
  });

  it('Phase 1 / 1.3 — default-constructed cascade captures vaultStore.path at construction and refuses undo after swap', async () => {
    // Pre-fix regression: a caller that omitted the explicit `vaultRoot`
    // argument (`promptExternalAttachmentDeleted`, `promptClosedBoardFileMissing`)
    // anchored the command to the empty-string default. The guard
    // short-circuited on falsy `this.vaultRoot`, so an undo fired after
    // the user swapped vaults would still write the snapshot bodies
    // through `vault:write-file-text` against whatever vault was now open
    // — silently resurrecting files in the wrong tree.
    //
    // Post-fix: the constructor falls back to `vaultStore.path` when no
    // explicit root is supplied, anchoring the command to the active
    // vault. A later swap then trips the same mismatch guard the explicit
    // path already enabled, and undo bails with a warning toast.
    const writes: Array<{ rel: string }> = [];
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:file-exists') return true;
        if (channel === 'vault:write-file-text' || channel === 'vault:write-file-binary') {
          writes.push({ rel: String(args[1]) });
          return { success: true };
        }
        if (channel === 'vault:read-tree') return { ok: true, tree: [] };
        return null;
      },
      on: () => () => {},
      send: () => {},
    };
    // The construction-time vault anchor.
    vaultStore.setPath('/vault-A');

    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    // Default-construct: omit the vaultRoot arg, mirroring the legacy
    // call sites in vaultExternalChanges before they were updated to
    // thread the active path.
    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand(
      { a: [tile] },
      [],
      { 'Notes.md': '# Original body' },
    );
    cmd.execute();
    expect(boardStore.getTile('t_a')).toBeUndefined();

    // User swaps vaults — the cascade must NOT resurrect Notes.md on
    // the wrong vault now.
    vaultStore.setPath('/vault-B');
    writes.length = 0;
    const toastsBefore = uiStore.toasts.length;
    await cmd.undo();
    await flushAsync();

    // Body must NOT have been written.
    const wroteNotes = writes.some((w) => w.rel === 'Notes.md');
    expect(wroteNotes).toBe(false);
    // Tile must remain absent — undo refused to restore.
    expect(boardStore.getTile('t_a')).toBeUndefined();
    // Warning toast.
    expect(uiStore.toasts.length).toBeGreaterThan(toastsBefore);
    expect(
      uiStore.toasts.some((t) => t.text.includes('vault has changed')),
    ).toBe(true);
  });

  it('Phase 6 / 6.5 — execute bails with a toast when the vault has changed since construction', () => {
    // Same guard as undo() — a redo against a different vault would
    // target the wrong placements / files. The guard short-circuits and
    // the user sees a warning toast.
    const a = makeMindMap('a', 't_a', 'Notes.md');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const tile = tilesA.t_a;
    const cmd = new CascadeDeleteCommand({ a: [tile] }, [], {}, '/old/vault');

    // Swap the vault BEFORE the (redo) execute.
    vaultStore.setPath('/new/vault');
    const before = uiStore.toasts.length;

    cmd.execute();

    // Tile remains in the cache — execute refused to redo the delete.
    expect(boardCacheStore.cache.a.tileDefs.t_a).toBeDefined();
    expect(uiStore.toasts.length).toBeGreaterThan(before);
    expect(uiStore.toasts.some((t) => t.text.includes('vault has changed'))).toBe(true);
  });

  it('description includes tile count across boards', () => {
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
    expect(cmd.description).toBe('Cascade-delete 2 tile(s)');
  });
});
