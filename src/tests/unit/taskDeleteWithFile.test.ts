/**
 * DeleteTaskCommand's opt-in backing-file delete.
 *
 * The default task delete is placement-only (the .md stays in the vault). When
 * the user explicitly picks "Delete task & file", the command moves the note
 * into Filo's trash and, on undo, moves it back before the placement returns —
 * mirroring Mind Map's DeleteTilesCommand. No note body is kept in memory.
 *
 * These tests pin the contracts:
 *   1. with file options: execute() removes the placement AND trashes the .md.
 *   2. with file options: undo() restores the .md (bytes intact) and then the
 *      placement; redo trashes it again.
 *   3. with file options: a failed trash move leaves the .md where it is.
 *   4. without file options: neither execute() nor undo() touches the disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTaskCommand } from '@renderer/commands/index';
import {
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests, onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskPlacement, TileDefinition } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

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

type Hook = (channel: string, args: unknown[]) => void;

interface Harness {
  vault: MemoryVault;
  calls: InvokeRecord[];
  setHook(hook: Hook | null): void;
}

/** The memory vault plus a call log, a hook, and the tree read a restore refreshes. */
function installVault(initial: Record<string, string>): Harness {
  const vault = installMemoryVault(initial);
  const filo = (window as unknown as { filo: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }).filo;
  const inner = filo.invoke;
  const calls: InvokeRecord[] = [];
  let hook: Hook | null = null;
  filo.invoke = async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    hook?.(channel, args);
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return inner(channel, ...args);
  };
  return { vault, calls, setHook: (h) => { hook = h; } };
}

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: REL,
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function hydrateTaskBoard(): void {
  const fixture: V7BoardFileData = {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [{ tileId: 't1', position: 0 }],
      sections: [],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: { t1: mkDef('t1') },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ tl: fixture }, { tl: 't.board.json' });
}

function placementIds(): string[] {
  const board = boardCacheStore.cache.tl?.board as TaskListBoard;
  return ((board?.tasks ?? []) as TaskPlacement[]).map((p) => p.tileId);
}

const REL = 'Tasks/Task.md';

describe('DeleteTaskCommand optional backing-file delete', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    // Runs the test-reset callbacks, which clear the active vault path the
    // note store restores into, so it goes before setPath.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    __resetErrorBusForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
  });

  it('with file options: execute removes the placement and moves the .md to the trash', async () => {
    hydrateTaskBoard();
    const h = installVault({ [REL]: 'body' });

    const cmd = new DeleteTaskCommand('tl', 't1', { filePath: REL, vaultRoot: '/vault' });
    await cmd.execute();
    await cmd.lastExecuteCompletion;

    expect(placementIds()).not.toContain('t1');
    const moves = h.calls.filter((c) => c.channel === 'vault:trash-move');
    expect(moves.map((c) => c.args)).toEqual([['/vault', REL]]);
    expect(h.vault.read(REL)).toBeUndefined();
    expect([...h.vault.trash.values()].map((t) => t.originalPath)).toEqual([REL]);
    // Nothing is deleted outright (`.filo/` sentinel clean-up aside).
    const deletes = h.calls.filter(
      (c) => c.channel === 'vault:delete' && !String(c.args[1] ?? '').includes('.filo/'),
    );
    expect(deletes).toEqual([]);
  });

  it('with file options: undo restores the .md from the trash before the placement, bytes intact', async () => {
    hydrateTaskBoard();
    const bytes = '---\ndone: false\n---\nrestored body\n';
    const h = installVault({ [REL]: bytes });

    const cmd = new DeleteTaskCommand('tl', 't1', { filePath: REL, vaultRoot: '/vault' });
    await cmd.execute();
    expect(placementIds()).not.toContain('t1');

    let placedAtRestore: boolean | null = null;
    h.setHook((channel) => {
      if (channel === 'vault:trash-restore') placedAtRestore = placementIds().includes('t1');
    });
    await cmd.undo();
    await cmd.lastUndoCompletion;

    expect(placedAtRestore).toBe(false);
    expect(placementIds()).toContain('t1');
    expect(h.vault.read(REL)).toBe(bytes);
    expect(h.vault.trash.size).toBe(0);
    // No seed or rewrite of the note: the file itself came back.
    expect(h.vault.writes.filter(([, rel]) => rel === REL)).toEqual([]);

    // Redo trashes it again.
    await cmd.execute();
    expect(placementIds()).not.toContain('t1');
    expect(h.vault.read(REL)).toBeUndefined();
    expect(h.vault.trash.size).toBe(1);
  });

  it('with file options: restored beside a newer note, redo trashes the restored copy, not the newer note', async () => {
    hydrateTaskBoard();
    const h = installVault({ [REL]: 'original\n' });
    const cmd = new DeleteTaskCommand('tl', 't1', { filePath: REL, vaultRoot: '/vault' });
    await cmd.execute();
    h.vault.writeExternally(REL, 'newcomer\n');

    await cmd.undo();
    const beside = REL.replace(/\.md$/, ' (restored).md');
    expect(h.vault.read(REL)).toBe('newcomer\n');
    expect(h.vault.read(beside)).toBe('original\n');

    await cmd.execute();
    expect(h.vault.read(REL)).toBe('newcomer\n');
    expect(h.vault.read(beside)).toBeUndefined();
    expect([...h.vault.trash.values()].map((t) => t.originalPath)).toEqual([beside]);
  });

  it('with file options: a failed trash move leaves the .md in place and reports it', async () => {
    hydrateTaskBoard();
    const h = installVault({ [REL]: 'kept' });
    h.vault.failNextTrashMove(REL, 'EBUSY');
    const errors: ReportedError[] = [];
    onError((e) => { errors.push(e); });

    const cmd = new DeleteTaskCommand('tl', 't1', { filePath: REL, vaultRoot: '/vault' });
    await cmd.execute();

    expect(placementIds()).not.toContain('t1');
    expect(h.vault.read(REL)).toBe('kept');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("Filo's trash");

    await cmd.undo();
    expect(placementIds()).toContain('t1');
    expect(h.vault.read(REL)).toBe('kept');
  });

  it('without file options: neither execute nor undo touches the filesystem', async () => {
    hydrateTaskBoard();
    const calls = installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async () => ({ success: true }),
    });

    const cmd = new DeleteTaskCommand('tl', 't1');
    await cmd.execute();
    await cmd.lastExecuteCompletion;
    expect(placementIds()).not.toContain('t1');

    await cmd.undo();
    await cmd.lastUndoCompletion;
    expect(placementIds()).toContain('t1');

    // No user-file delete, write or trash move (sentinel `.filo/` traffic excluded).
    const fsCalls = calls.filter(
      (c) =>
        (c.channel === 'vault:delete' || c.channel === 'vault:write-file-text' || c.channel.startsWith('vault:trash-')) &&
        !((c.args[1] as string) ?? '').includes('.filo/'),
    );
    expect(fsCalls.length).toBe(0);
  });
});
