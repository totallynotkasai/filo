import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests, onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile, Tile } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * "Delete associated files" is undoable because the files go to Filo's trash,
 * not away: execute removes the placements, then moves each file into
 * `.filo/trash`; undo moves the files back BEFORE the placements return, so a
 * re-added text tile finds its note on disk and never seeds an empty one over
 * it. The command keeps only trash ids, never a note body.
 */

type Hook = (channel: string, args: unknown[]) => Promise<void> | void;

interface Harness {
  vault: MemoryVault;
  /** Every invoke, in order. */
  calls: Array<{ channel: string; args: unknown[] }>;
  /** Runs before a call reaches the memory vault; await inside to hold it open. */
  setHook(hook: Hook | null): void;
}

/**
 * The memory vault, plus the sidebar tree read a restore refreshes and a call
 * log / hook for ordering assertions.
 */
function installVault(initial: Record<string, string>): Harness {
  const vault = installMemoryVault(initial);
  const filo = (window as unknown as { filo: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }).filo;
  const inner = filo.invoke;
  const calls: Harness['calls'] = [];
  let hook: Hook | null = null;
  filo.invoke = async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    await hook?.(channel, args);
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return inner(channel, ...args);
  };
  return { vault, calls, setHook: (h) => { hook = h; } };
}

function makeMindMapFixture(tiles: Record<string, TextTile>): BoardFileData {
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
    tileDefs: tiles as unknown as BoardFileData['tileDefs'],
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
    filePath: `${title}.md`,
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

const userCalls = (h: Harness, channel: string): Array<{ channel: string; args: unknown[] }> =>
  h.calls.filter((c) => c.channel === channel && !String(c.args[1] ?? '').includes('.filo/'));

describe('DeleteTilesCommand — files go to the trash and come back on undo', () => {
  let errors: ReportedError[];
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    noteStore.__resetForTests();
    // A restore refreshes the index; a later test must not see it.
    vaultIndexStore.clear();
    // After the tracking reset, which clears the active vault path the note
    // writer resolves its root from.
    vaultStore.setPath('/vault');
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    errors = [];
    onError((e) => { errors.push(e); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
  });

  it('execute removes placements, then moves each file to the trash by its vault-relative path', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'hello world' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    const done = cmd.execute();

    // Placement removal stays synchronous — observable before awaiting.
    expect(boardStore.getTile('t1')).toBeUndefined();
    await done;
    await cmd.lastExecuteCompletion;

    const moves = userCalls(h, 'vault:trash-move');
    expect(moves.map((c) => c.args)).toEqual([['/vault', 'Foo.md']]);
    expect(h.vault.read('Foo.md')).toBeUndefined();
    expect([...h.vault.trash.values()].map((t) => t.originalPath)).toEqual(['Foo.md']);
    // Nothing is deleted outright.
    expect(userCalls(h, 'vault:delete')).toEqual([]);
  });

  it('undo restores the file from the trash before the tile comes back, and the bytes round-trip', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const bytes = '---\ntitle: Foo\n---\nhello world\r\n';
    const h = installVault({ 'Foo.md': bytes });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    expect(h.vault.read('Foo.md')).toBeUndefined();

    let tileBackAtRestore: boolean | null = null;
    h.setHook((channel) => {
      if (channel === 'vault:trash-restore') tileBackAtRestore = boardStore.getTile('t1') !== undefined;
    });
    await cmd.undo();
    await cmd.lastUndoCompletion;

    expect(tileBackAtRestore).toBe(false);
    expect(boardStore.getTile('t1')).toBeDefined();
    const restores = userCalls(h, 'vault:trash-restore');
    expect(restores.length).toBe(1);
    expect(restores[0].args[0]).toBe('/vault');
    expect(h.vault.read('Foo.md')).toBe(bytes);
    expect(h.vault.trash.size).toBe(0);
    // The re-added tile found its note: no empty seed, no body rewrite.
    expect(h.vault.writes.filter(([, rel]) => rel === 'Foo.md')).toEqual([]);
  });

  it('multi-tile undo restores every file and every tile', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'A'), makeTextTile('t2', 'B'), makeTextTile('t3', 'C')]);
    const h = installVault({ 'A.md': 'a-body', 'B.md': 'b-body', 'C.md': 'c-body' });

    const cmd = new DeleteTilesCommand(['t1', 't2', 't3'], {
      vaultRoot: '/vault',
      filePaths: ['A.md', 'B.md', 'C.md'],
    });
    await cmd.execute();
    for (const id of ['t1', 't2', 't3']) expect(boardStore.getTile(id)).toBeUndefined();
    expect(userCalls(h, 'vault:trash-move').map((c) => c.args[1])).toEqual(['A.md', 'B.md', 'C.md']);
    expect(h.vault.trash.size).toBe(3);

    await cmd.undo();

    for (const id of ['t1', 't2', 't3']) expect(boardStore.getTile(id)).toBeDefined();
    expect(h.vault.read('A.md')).toBe('a-body');
    expect(h.vault.read('B.md')).toBe('b-body');
    expect(h.vault.read('C.md')).toBe('c-body');
    expect(h.vault.trash.size).toBe(0);
  });

  it('redo moves the file to the trash again', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    await cmd.undo();
    expect(h.vault.read('Foo.md')).toBe('body');

    await cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();
    expect(h.vault.read('Foo.md')).toBeUndefined();
    expect(userCalls(h, 'vault:trash-move').length).toBe(2);
    expect([...h.vault.trash.values()].map((t) => t.originalPath)).toEqual(['Foo.md']);

    // And a second undo still brings the same bytes back.
    await cmd.undo();
    expect(h.vault.read('Foo.md')).toBe('body');
    expect(boardStore.getTile('t1')).toBeDefined();
  });

  it('a failed trash move leaves the file where it is and reports the error', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'kept' });
    h.vault.failNextTrashMove('Foo.md', 'EBUSY');

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();

    expect(h.vault.read('Foo.md')).toBe('kept');
    expect(h.vault.trash.size).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("Filo's trash");
    expect(errors[0].message).toContain('Foo.md');

    // Undo has nothing to restore; the tile simply comes back over the kept file.
    await cmd.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
    expect(userCalls(h, 'vault:trash-restore')).toEqual([]);
    expect(h.vault.read('Foo.md')).toBe('kept');
  });

  it('a restore that fails still brings the tile back and reports the error', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    // Emptied from the trash meanwhile, and nothing at the old path.
    h.vault.trash.clear();

    await cmd.undo();

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(errors.some((e) => (e.message ?? '').includes("Couldn't restore \"Foo.md\""))).toBe(true);
  });

  it('an item restored from Settings → Trash meanwhile counts as restored', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    h.vault.trash.clear();
    h.vault.writeExternally('Foo.md', 'body');

    await cmd.undo();

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(errors).toEqual([]);
    expect(h.vault.read('Foo.md')).toBe('body');
  });

  it('a file restored beside a new one at its old path re-targets the tile', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'original' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    // Another note took the name while the original sat in the trash.
    h.vault.writeExternally('Foo.md', 'newcomer');

    await cmd.undo();

    expect(h.vault.read('Foo.md')).toBe('newcomer');
    expect(h.vault.read('Foo (restored).md')).toBe('original');
    const tile = boardStore.getTile('t1') as TextTile | undefined;
    expect(tile?.filePath).toBe('Foo (restored).md');

    // Redo trashes the restored copy, never the newer file that has the old name.
    await cmd.execute();
    expect(h.vault.read('Foo.md')).toBe('newcomer');
    expect(h.vault.read('Foo (restored).md')).toBeUndefined();
    expect([...h.vault.trash.values()].map((t) => t.originalPath)).toEqual(['Foo (restored).md']);
  });

  it('placement-only delete never touches the disk and undoes synchronously', () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const cmd = new DeleteTilesCommand(['t1']);
    void cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();

    void cmd.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
    expect(userCalls(h, 'vault:trash-move')).toEqual([]);
    expect(userCalls(h, 'vault:trash-restore')).toEqual([]);
    expect(h.vault.read('Foo.md')).toBe('body');
    // No "missing files" toast: nothing was deleted.
    const toasts = (uiStore.toast as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(toasts.find((c) => String(c[0]).includes('missing'))).toBeUndefined();
  });

  it('empty filePaths with a vaultRoot is placement-only too', () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: [] });
    void cmd.execute();
    void cmd.undo();

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(userCalls(h, 'vault:trash-move')).toEqual([]);
  });

  it('filePaths are copied — mutating the input array after construction does not leak', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'foo', 'Bar.md': 'bar' });

    const paths = ['Foo.md'];
    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: paths });
    paths.push('Bar.md');

    await cmd.execute();

    expect(userCalls(h, 'vault:trash-move').map((c) => c.args[1])).toEqual(['Foo.md']);
    expect(h.vault.read('Bar.md')).toBe('bar');
  });

  it('awaited undo() finishes the restore before restoring placements', async () => {
    setupActiveBoardWithTiles([makeTextTile('t1', 'Restored')]);
    const h = installVault({ 'Restored.md': 'preserved body' });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Restored.md'] });
    await cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();

    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    h.setHook(async (channel, args) => {
      if (channel === 'vault:trash-restore') {
        order.push('restore:start');
        await held;
        order.push('restore:end');
      }
      if (channel === 'vault:file-exists' && args[1] === 'Restored.md') order.push('file-exists:probe');
    });

    const undoPromise = cmd.undo();
    for (let i = 0; i < 20 && order.length === 0; i++) await new Promise((r) => setTimeout(r, 0));

    // The tile must NOT be back yet — the placements wait for the restore.
    expect(order).toEqual(['restore:start']);
    expect(boardStore.getTile('t1')).toBeUndefined();

    release();
    await undoPromise;

    expect(boardStore.getTile('t1')).toBeDefined();
    expect(h.vault.read('Restored.md')).toBe('preserved body');
    const probeIdx = order.indexOf('file-exists:probe');
    if (probeIdx >= 0) expect(order.indexOf('restore:end')).toBeLessThan(probeIdx);
  });

  it('redo serialises behind a pending undo restore (no IPC interleaving)', async () => {
    // A rapid Ctrl+Z → Ctrl+Y must not move the file to the trash while the
    // undo's restore is still in flight: the restore would then bring back a
    // file the redo meant to remove.
    setupActiveBoardWithTiles([makeTextTile('t1', 'Foo')]);
    const h = installVault({ 'Foo.md': 'body' });

    const log: string[] = [];
    let release: (() => void) | null = null;
    h.setHook(async (channel, args) => {
      if (channel === 'vault:trash-move' && args[1] === 'Foo.md') log.push('move');
      if (channel === 'vault:trash-restore') {
        log.push('restore:start');
        await new Promise<void>((res) => { release = res; });
        log.push('restore:end');
      }
    });

    const cmd = new DeleteTilesCommand(['t1'], { vaultRoot: '/vault', filePaths: ['Foo.md'] });
    await cmd.execute();
    void cmd.undo();
    for (let i = 0; i < 20 && release === null; i++) await new Promise((r) => setTimeout(r, 0));

    // Redo before the undo settles.
    void cmd.execute();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(log).toEqual(['move', 'restore:start']);

    release!();
    await cmd.lastExecuteCompletion;
    expect(log).toEqual(['move', 'restore:start', 'restore:end', 'move']);
    expect(h.vault.read('Foo.md')).toBeUndefined();
    expect(h.vault.trash.size).toBe(1);
  });
});
