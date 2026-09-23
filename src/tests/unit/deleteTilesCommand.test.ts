import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import {
  setWriteErrorListener,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
} from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile, Tile } from '@renderer/schema/index';

/**
 * P0-18 — "Delete associated files" path is now undoable. The dialog reads
 * each backing .md before construction and passes the snapshot to the
 * Command; execute() removes placements then deletes files; undo() writes
 * the snapshot back first so the placement re-resolves against real content.
 *
 * Two failure surfaces matter for the user trust contract:
 *   1. write failure on undo → tiles still restored, toast fires, the failed
 *      path is recorded in writeStateTracking's failedVaultPaths.
 *   2. no-snapshot delete (old path, deleteFiles=false) still emits the
 *      "restored tiles reference missing files" toast — that detection
 *      stays for out-of-band file deletion.
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

function makeMindMapFixture(tiles: Record<string, TextTile>): V7BoardFileData {
  const placements: Record<string, unknown> = {};
  for (const id of Object.keys(tiles)) {
    placements[id] = { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false };
  }
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: tiles as unknown as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

function makeTextTile(id: string, title: string): TextTile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '#000',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    contentId: `doc-${id}`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function setupActiveBoardWithTiles(tiles: Tile[]): void {
  const map: Record<string, TextTile> = {};
  for (const t of tiles) map[t.id] = t as unknown as TextTile;
  const fixture = makeMindMapFixture(map);
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board, map as unknown as Record<string, Tile>, {}, []);
}

describe('DeleteTilesCommand — snapshot/restore (P0-18)', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    setWriteErrorListener(null);
    setWriteStateListener(null);
  });

  it('execute removes placements and invokes vault:delete for every snapshot path', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    const calls = installFiloStub({ 'vault:delete': async () => ({ success: true }) });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'hello world' }],
    });

    cmd.execute();

    // Placement removal stays synchronous — observable before awaiting.
    expect(boardStore.getTile('t1')).toBeUndefined();
    // Phase 3 / 3.2 — IPC dispatch is queued behind prior in-flight work.
    await cmd.lastExecuteCompletion;
    // Phase R2 — `deleteVaultPath` drains pending writers before the
    // IPC, which can trigger `markClean` to delete `.filo/.dirty.a1b2c3d4e5f6` as a
    // side effect of the drain. Filter sentinel deletes out so we count
    // only user-file deletes for the assertion.
    const deletes = calls.filter(
      (c) => c.channel === 'vault:delete' && !((c.args[1] as string) ?? '').includes('.filo/'),
    );
    expect(deletes.length).toBe(1);
    // Phase 25 L6 — vault:delete now takes (vaultRoot, itemPath).
    expect(deletes[0].args[0]).toBe('/vault');
    expect(deletes[0].args[1]).toBe('/vault/Foo.md');
  });

  it('undo restores the tile and writes the snapshot back to disk', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    // Track which paths have been "written" so vault:file-exists can simulate
    // post-snapshot disk state. Without this, persistAddTile's empty-seed
    // path would fire on top of our snapshot write and double-count.
    const writtenPaths = new Set<string>();
    const calls = installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async (vaultRoot, relPath) => {
        writtenPaths.add(relPath as string);
        return { success: true, path: `${vaultRoot}/${relPath}` };
      },
      'vault:file-exists': async (_vaultRoot, relPath) =>
        writtenPaths.has(relPath as string),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'hello world' }],
    });
    cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();

    cmd.undo();
    await cmd.lastUndoCompletion;

    expect(boardStore.getTile('t1')).toBeDefined();
    // Filter out the `.filo/.dirty.a1b2c3d4e5f6` sentinel writes that the
    // writeStateTracking pipeline emits as a side-effect.
    const writes = calls.filter(
      (c) => c.channel === 'vault:write-file-text' && c.args[1] !== '.filo/.dirty.a1b2c3d4e5f6',
    );
    expect(writes.length).toBe(1);
    expect(writes[0].args).toEqual(['/vault', 'Foo.md', 'hello world']);
  });

  it('multi-tile undo restores all tiles and writes all snapshots', async () => {
    setupActiveBoardWithTiles([
      makeTextTile('t1', 'A'),
      makeTextTile('t2', 'B'),
      makeTextTile('t3', 'C'),
    ]);
    const writtenPaths = new Set<string>();
    const calls = installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async (_vaultRoot, relPath) => {
        writtenPaths.add(relPath as string);
        return { success: true };
      },
      'vault:file-exists': async (_vaultRoot, relPath) =>
        writtenPaths.has(relPath as string),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1', 't2', 't3'], {
      vaultRoot: '/vault',
      fileSnapshots: [
        { rel: 'A.md', content: 'a-body' },
        { rel: 'B.md', content: 'b-body' },
        { rel: 'C.md', content: 'c-body' },
      ],
    });

    cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();
    expect(boardStore.getTile('t2')).toBeUndefined();
    expect(boardStore.getTile('t3')).toBeUndefined();

    cmd.undo();
    await cmd.lastUndoCompletion;

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(boardStore.getTile('t2')).toBeDefined();
    expect(boardStore.getTile('t3')).toBeDefined();
    const writes = calls.filter(
      (c) => c.channel === 'vault:write-file-text' && c.args[1] !== '.filo/.dirty.a1b2c3d4e5f6',
    );
    expect(writes.length).toBe(3);
    const payloads = writes.map((w) => ({ rel: w.args[1], content: w.args[2] }));
    expect(payloads).toEqual([
      { rel: 'A.md', content: 'a-body' },
      { rel: 'B.md', content: 'b-body' },
      { rel: 'C.md', content: 'c-body' },
    ]);
  });

  it('undo write failure surfaces a toast and records the path in failedVaultPaths', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': (_vaultRoot, relPath) => {
        // Only fail for the actual snapshot write; let the sentinel write
        // (`.filo/.dirty.a1b2c3d4e5f6`) succeed so it doesn't get incorrectly counted as
        // a tracked failure.
        if (relPath === '.filo/.dirty.a1b2c3d4e5f6') return { success: true };
        return { success: false, error: 'disk full' };
      },
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    // Track the max `failed` value the listener observes — the listener
    // fires multiple times (beginWrite=0, endWrite=1) and we care about
    // the peak, not the most recent.
    let maxFailed = 0;
    setWriteStateListener((info) => {
      if (info.failed > maxFailed) maxFailed = info.failed;
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'hello' }],
    });
    cmd.execute();
    cmd.undo();
    await cmd.lastUndoCompletion;

    // Tile still restored even though write failed
    expect(boardStore.getTile('t1')).toBeDefined();
    // Error toast fired
    expect(uiStore.toast).toHaveBeenCalledWith(
      expect.stringContaining('Tile restored but file content could not be recovered'),
      'error',
      expect.any(Number),
    );
    // failedVaultPaths picked up the path via trackComponentWrite
    expect(maxFailed).toBeGreaterThanOrEqual(1);
  });

  it('write-error listener is notified on undo write failure', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': (_vaultRoot, relPath) => {
        if (relPath === '.filo/.dirty.a1b2c3d4e5f6') return { success: true };
        return { success: false, error: 'EACCES' };
      },
      // Audit-19 BL-1 — the re-added tile's empty seed now goes through the
      // create-exclusive channel; let it land so only the RESTORE failure reports.
      'vault:create-file-text': async () => ({ success: true }),
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const errors: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => { errors.push(info); });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'hello' }],
    });
    cmd.execute();
    cmd.undo();
    await cmd.lastUndoCompletion;

    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('Foo.md');
  });

  it('no snapshot path keeps the legacy missing-file toast for out-of-band deletes', () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    installFiloStub({
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1']);
    cmd.execute();

    // tile cleared
    expect(boardStore.getTile('t1')).toBeUndefined();
    // Snapshot path-aware: with no snapshots provided, the legacy detection
    // still runs. The vaultIndex is empty, so 'Foo.md' will be reported.
    cmd.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
    expect(uiStore.toast).toHaveBeenCalledWith(
      expect.stringContaining('restored tile(s) reference missing files'),
      'warning',
      expect.any(Number),
    );
  });

  it('snapshot path suppresses the legacy missing-file toast', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    const writtenPaths = new Set<string>();
    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async (_vaultRoot, relPath) => {
        writtenPaths.add(relPath as string);
        return { success: true };
      },
      'vault:file-exists': async (_vaultRoot, relPath) =>
        writtenPaths.has(relPath as string),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'restored' }],
    });
    cmd.execute();
    cmd.undo();
    await cmd.lastUndoCompletion;

    // No "missing files" toast — the snapshot restored the body, the legacy
    // detection is conditional on fileSnapshots being empty.
    const calls = (uiStore.toast as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const missingFileToast = calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('restored tile(s) reference missing files'),
    );
    expect(missingFileToast).toBeUndefined();
  });

  it('empty fileSnapshots with vaultRoot still skips legacy missing-file toast guard', () => {
    // Defensive: a caller could pass `fileSnapshots: []` with a vaultRoot
    // (means "snapshot path but nothing to restore"). The legacy toast
    // should still fire for missing refs because no file body was restored.
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    installFiloStub({
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [],
    });
    cmd.execute();
    cmd.undo();

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(uiStore.toast).toHaveBeenCalledWith(
      expect.stringContaining('restored tile(s) reference missing files'),
      'warning',
      expect.any(Number),
    );
  });

  it('snapshots are copied — mutating the input array after construction does not leak', async () => {
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);
    const calls = installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async () => ({ success: true }),
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const snaps = [{ rel: 'Foo.md', content: 'frozen' }];
    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: snaps,
    });
    // Mutate after construction
    snaps[0].content = 'leaked';
    snaps.push({ rel: 'Bar.md', content: 'extra' });

    cmd.execute();
    // Phase 3 / 3.2 — IPC dispatch is queued; await before asserting IPC calls.
    await cmd.lastExecuteCompletion;
    // Execute should only DELETE, not WRITE. The sentinel writes (path
    // `.filo/.dirty.a1b2c3d4e5f6`) emitted by the write-tracking pipeline are unrelated
    // to the command's intended writes — exclude those.
    const writePayload = calls.find(
      (c) => c.channel === 'vault:write-file-text' && c.args[1] !== '.filo/.dirty.a1b2c3d4e5f6',
    );
    expect(writePayload).toBeUndefined();
    // Phase R2 — same `.filo/` sentinel-delete filter as the basic
    // execute test; the drain inside `deleteVaultPath` can cleanup
    // `.filo/.dirty.a1b2c3d4e5f6` after the board flush.
    const deletes = calls.filter(
      (c) => c.channel === 'vault:delete' && !((c.args[1] as string) ?? '').includes('.filo/'),
    );
    // Original snapshot list had only Foo.md; Bar.md leaked in after copy
    expect(deletes.length).toBe(1);
    // Phase 25 L6 — vault:delete now takes (vaultRoot, itemPath).
    expect(deletes[0].args[0]).toBe('/vault');
    expect(deletes[0].args[1]).toBe('/vault/Foo.md');
  });

  it('awaited undo() writes the snapshot to disk before restoring placements (polish 2.1)', async () => {
    // Polish phase 2.1 — `undo()` was previously sync and assigned the
    // `undoWithSnapshot` Promise to `lastUndoCompletion` without awaiting
    // it. So `await cmd.undo()` returned immediately and the snapshot
    // write raced the placement restore — persistAddTile's empty-seed
    // branch could fire AHEAD of the actual snapshot write and clobber
    // the recovered content with an empty file.
    //
    // With the fix, awaiting `cmd.undo()` blocks until the snapshot
    // write fully settles, so by the time the placement re-enters the
    // store, `vault:file-exists` returns true and persistAddTile skips
    // the empty-seed entirely.
    const tile = makeTextTile('t1', 'Restored');
    setupActiveBoardWithTiles([tile]);

    // Track the order of (write, file-exists) probes. persistAddTile
    // probes vault:file-exists when boardStore.addTile fires during
    // restorePlacements; the write must land before that probe.
    const order: string[] = [];
    let resolveWrite: (() => void) | null = null;
    const writePromise = new Promise<void>((res) => { resolveWrite = res; });

    installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async (_vaultRoot, relPath) => {
        if (relPath === 'Restored.md') {
          order.push('write:start');
          await writePromise;
          order.push('write:end');
        }
        return { success: true };
      },
      'vault:file-exists': async (_vaultRoot, relPath) => {
        if (relPath === 'Restored.md') order.push('file-exists:probe');
        // Returning true after the snapshot write lets persistAddTile skip
        // the empty-seed branch — matches the post-write reality.
        return order.includes('write:end');
      },
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Restored.md', content: 'preserved body' }],
    });
    await cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();

    // Kick off undo but don't await yet — give the write a chance to begin.
    const undoPromise = cmd.undo();
    // Let the write handler enter and queue on writePromise.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The tile must NOT be back yet — restorePlacements is gated behind
    // the snapshot write completing.
    expect(order).toEqual(['write:start']);
    expect(boardStore.getTile('t1')).toBeUndefined();

    // Resolve the write; undo's awaited inner promise unblocks and the
    // placement restore runs.
    resolveWrite!();
    await undoPromise;

    // Now the tile is back AND the file-exists probe fired AFTER write:end.
    expect(boardStore.getTile('t1')).toBeDefined();
    const writeEndIdx = order.indexOf('write:end');
    const probeIdx = order.indexOf('file-exists:probe');
    if (probeIdx >= 0) {
      expect(writeEndIdx).toBeLessThan(probeIdx);
    }
  });

  it('redo serialises behind a pending undo snapshot write (no IPC interleaving)', async () => {
    // Phase 3 / 3.2 — A rapid Ctrl+Z → Ctrl+Y could otherwise issue
    // `vault:delete` while the undo's `vault:write-file-text` is still
    // in flight on the same path. The expected order is:
    //   1. execute → vault:delete
    //   2. undo → vault:write-file-text (snapshot restore)
    //   3. redo → MUST wait for #2 to settle, then vault:delete again
    // Without serialisation, #3 could fire before #2 resolves and the
    // snapshot write would resurrect the file the redo just deleted.
    const tile = makeTextTile('t1', 'Foo');
    setupActiveBoardWithTiles([tile]);

    // Track when each IPC was called and resolved — but only for the
    // snapshot path. Sentinel writes (.filo/.dirty) and board-file writes
    // also hit `vault:write-file-text` via trackComponentWrite; ignoring
    // them keeps the assertion focused on the race we care about.
    const log: string[] = [];
    let resolveWrite: (() => void) | null = null;
    installFiloStub({
      'vault:delete': async (_vaultRoot, absPath) => {
        if (typeof absPath === 'string' && absPath.endsWith('Foo.md')) {
          log.push('delete:start');
          await Promise.resolve();
          log.push('delete:end');
        }
        return { success: true };
      },
      // Snapshot write blocks until externally resolved so we can observe
      // whether redo waits. Other write targets resolve immediately.
      'vault:write-file-text': (_vaultRoot, relPath) => {
        if (relPath !== 'Foo.md') return Promise.resolve({ success: true });
        log.push('write:start');
        return new Promise((res) => {
          resolveWrite = () => {
            log.push('write:end');
            res({ success: true });
          };
        });
      },
      'vault:file-exists': async () => false,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTilesCommand(['t1'], {
      vaultRoot: '/vault',
      fileSnapshots: [{ rel: 'Foo.md', content: 'body' }],
    });

    cmd.execute();
    await cmd.lastExecuteCompletion;
    cmd.undo();
    // Don't await undo's completion yet — the write is intentionally
    // blocked so we can race a redo against it.
    // Give the microtask a chance to enter the write handler.
    await Promise.resolve();
    await Promise.resolve();

    // Now invoke execute() again (simulates a redo before undo settles).
    void cmd.execute();
    // Yield a few microtasks so any unblocked work could race ahead.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The redo's delete must NOT have started while the write is pending.
    expect(log).toEqual(['delete:start', 'delete:end', 'write:start']);

    // Resolve the write; redo's delete should now follow.
    resolveWrite!();
    await cmd.lastExecuteCompletion;
    expect(log).toContain('write:end');
    // After write resolves, the queued redo delete fires.
    expect(log.indexOf('write:end')).toBeLessThan(log.lastIndexOf('delete:start'));
  });
});
