import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';

/**
 * Phase 1.4 regression: `syncTile` previously wrote through the
 * mkdir-p-style `vault:write-file-text` channel. If the user deleted the
 * backing file from the OS and then clicked "Sync this tile", the IPC
 * silently recreated the file. The fix routes through
 * `vault:write-existing-file-text`, which returns
 * `{ success: false, code: 'ENOENT', … }` so `assertIpcOk` throws an
 * `IpcEnvelopeError`, which `syncTile` catches and surfaces as a
 * `{ wrote: false, skippedReason: 'file-missing' }` result.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeKanbanFixtureWithTextTile(): V7BoardFileData {
  const def: TileDefinition = {
    id: 't1',
    type: 'text',
    filePath: 'note.md',
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    createdAt: 0,
    updatedAt: 0,
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
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [{ tileId: 't1' }] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: def },
    connections: {},
    frames: [],
  };
}

describe('boardCacheStore.syncTile — deleted backing file', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('returns skippedReason file-missing when the IPC reports ENOENT', async () => {
    const writeCalls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloStub({
      'vault:read-file-text': async () => ({ success: true, content: '# Stale disk content\n' }),
      'vault:write-existing-file-text': async (...args) => {
        writeCalls.push({ channel: 'vault:write-existing-file-text', args });
        return { success: false, code: 'ENOENT', error: 'file no longer exists' };
      },
      'vault:write-file-text': async (...args) => {
        writeCalls.push({ channel: 'vault:write-file-text', args });
        return { success: true };
      },
      'board:save': async () => ({ success: true }),
    });

    boardCacheStore.hydrate(
      { kb: makeKanbanFixtureWithTextTile() },
      { kb: 'tasks.board.json' },
    );

    documentStore.loadDocument({
      filename: 'note.md',
      title: 'Note',
      body: 'Local body that should NOT resurrect the deleted file.',
      htmlContent: '',
      richText: [],
    });

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(result.skippedReason).toBe('file-missing');
    // The `.filo/.dirty` sentinel write is expected (it routes through
    // `vault:write-file-text` because mkdir -p of `.filo/` is required).
    // We only care that the BACKING FILE was not resurrected.
    const resurrectionCall = writeCalls.find(
      (c) => c.channel === 'vault:write-file-text' && c.args[1] === 'note.md',
    );
    expect(resurrectionCall).toBeUndefined();
    expect(writeCalls.some(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'note.md',
    )).toBe(true);
  });

  it('returns wrote:true when the write succeeds', async () => {
    installFiloStub({
      'vault:read-file-text': async () => ({ success: true, content: '' }),
      'vault:write-existing-file-text': async () => ({ success: true, path: '/vault/note.md' }),
      'board:save': async () => ({ success: true }),
    });

    boardCacheStore.hydrate(
      { kb: makeKanbanFixtureWithTextTile() },
      { kb: 'tasks.board.json' },
    );

    documentStore.loadDocument({
      filename: 'note.md',
      title: 'Note',
      body: 'New body content',
      htmlContent: '',
      richText: [],
    });

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(true);
    expect(result.skippedReason).toBeUndefined();
  });
});
