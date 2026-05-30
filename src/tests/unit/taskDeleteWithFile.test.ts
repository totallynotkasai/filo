/**
 * Audit 5.7 — DeleteTaskCommand's opt-in backing-file delete.
 *
 * The default task delete is placement-only (the .md stays in the vault). When
 * the user explicitly picks "Delete task & file", the deleter pre-reads the
 * body and passes it as a snapshot so the command can OWN the disk delete and
 * restore the body on undo — mirroring Mind Map's DeleteTilesCommand.
 *
 * These tests pin the three contracts:
 *   1. with file options: execute() removes the placement AND deletes the .md.
 *   2. with file options: undo() restores the placement AND rewrites the body.
 *   3. without file options: neither execute() nor undo() touches the disk
 *      (the long-standing default — proves backward-compatibility).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTaskCommand } from '@renderer/commands/index';
import {
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskPlacement, TileDefinition } from '@renderer/schema/index';

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

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    title: 'Task',
    contentId: `doc-${id}`,
    content: '',
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    tags: [],
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

describe('Audit 5.7 — DeleteTaskCommand optional backing-file delete', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
  });

  it('with file options: execute removes the placement and deletes the .md', async () => {
    hydrateTaskBoard();
    const calls = installFiloStub({ 'vault:delete': async () => ({ success: true }) });

    const cmd = new DeleteTaskCommand('tl', 't1', {
      fileSnapshot: { rel: REL, content: 'body' },
      vaultRoot: '/vault',
    });
    await cmd.execute();
    await cmd.lastExecuteCompletion;

    expect(placementIds()).not.toContain('t1');
    // Exclude the `.filo/` sentinel deletes a write-drain may emit.
    const deletes = calls.filter(
      (c) => c.channel === 'vault:delete' && !((c.args[1] as string) ?? '').includes('.filo/'),
    );
    expect(deletes.length).toBe(1);
    expect(deletes[0].args[0]).toBe('/vault');
    expect(deletes[0].args[1]).toBe(`/vault/${REL}`);
  });

  it('with file options: undo restores the placement and rewrites the body', async () => {
    hydrateTaskBoard();
    const calls = installFiloStub({
      'vault:delete': async () => ({ success: true }),
      'vault:write-file-text': async () => ({ success: true }),
      'vault:file-exists': async () => true,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });

    const cmd = new DeleteTaskCommand('tl', 't1', {
      fileSnapshot: { rel: REL, content: 'restored body' },
      vaultRoot: '/vault',
    });
    await cmd.execute();
    await cmd.lastExecuteCompletion;
    expect(placementIds()).not.toContain('t1');

    await cmd.undo();
    await cmd.lastUndoCompletion;

    expect(placementIds()).toContain('t1');
    // Isolate the snapshot write from board-JSON / `.filo/.dirty` writes.
    const writes = calls.filter(
      (c) => c.channel === 'vault:write-file-text' && c.args[1] === REL,
    );
    expect(writes.length).toBe(1);
    expect(writes[0].args).toEqual(['/vault', REL, 'restored body']);
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

    // No user-file delete or write (sentinel `.filo/` traffic excluded).
    const fsCalls = calls.filter(
      (c) =>
        (c.channel === 'vault:delete' || c.channel === 'vault:write-file-text') &&
        !((c.args[1] as string) ?? '').includes('.filo/'),
    );
    expect(fsCalls.length).toBe(0);
  });
});
