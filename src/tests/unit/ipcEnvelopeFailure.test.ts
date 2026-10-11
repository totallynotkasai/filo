/**
 * IPC envelope failure regression guard.
 *
 * The main-process IPC handlers (`board:save`, `config:save`,
 * `vault:write-file-text`) catch their own errors and return `{ ok: false }` or
 * `{ success: false }` envelopes instead of letting the promise reject.
 * Previously the renderer just awaited the invoke result and ignored the
 * envelope — disk-full / EPERM / EACCES failures were silently logged to
 * console while the save indicator flashed "Saved".
 *
 * These tests assert that:
 *   1. `assertIpcOk` throws on `{ ok: false }` / `{ success: false }`
 *      payloads and passes everything else through.
 *   2. `writeBoardFile` rethrows when `board:save` resolves to
 *      `{ ok: false, error }`.
 *   3. `writeConfigs` rethrows when `config:save` resolves to
 *      `{ ok: false, error }`.
 *   4. a note write whose `vault:write-existing-file-text` resolves to
 *      `{ success: false, error }` is reported: `noteStore.flushAll()` names
 *      the path in `failed` and the write-error listener sees it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertIpcOk, IpcEnvelopeError } from '@shared/ipcEnvelope';
import {
  writeBoardFile,
  writeConfigs,
  setWriteErrorListener,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
  type WriteStateInfo,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

describe('assertIpcOk', () => {
  it('passes through bare values (null, string, number, array)', () => {
    expect(assertIpcOk(null, 'foo')).toBe(null);
    expect(assertIpcOk('hello', 'foo')).toBe('hello');
    expect(assertIpcOk(42, 'foo')).toBe(42);
    expect(assertIpcOk([1, 2, 3], 'foo')).toEqual([1, 2, 3]);
  });

  it('passes through objects without ok/success fields', () => {
    expect(assertIpcOk({ data: 'x' }, 'foo')).toEqual({ data: 'x' });
  });

  it('passes through { ok: true } / { success: true }', () => {
    expect(assertIpcOk({ ok: true }, 'foo')).toEqual({ ok: true });
    expect(assertIpcOk({ success: true, path: '/v' }, 'foo')).toEqual({ success: true, path: '/v' });
  });

  it('throws IpcEnvelopeError on { ok: false }', () => {
    expect(() => assertIpcOk({ ok: false, error: 'EPERM' }, 'board:save'))
      .toThrow(IpcEnvelopeError);
  });

  it('throws IpcEnvelopeError on { success: false }', () => {
    expect(() => assertIpcOk({ success: false, error: 'ENOSPC' }, 'vault:write-file-text'))
      .toThrow(IpcEnvelopeError);
  });

  it('preserves the error string and code on the thrown error', () => {
    try {
      assertIpcOk({ success: false, code: 'EACCES', error: 'access denied' }, 'vault:write-file-text');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IpcEnvelopeError);
      const e = err as IpcEnvelopeError;
      expect(e.code).toBe('EACCES');
      expect(e.message).toBe('access denied');
      expect(e.channel).toBe('vault:write-file-text');
    }
  });

  it('falls back to a synthetic message when error string is missing', () => {
    expect(() => assertIpcOk({ ok: false }, 'board:save'))
      .toThrow(/board:save reported failure/);
  });
});

describe('writeBoardFile — envelope failure', () => {
  beforeEach(() => {
    restoreFiloDefault();
    setWriteErrorListener(null);
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    setWriteErrorListener(null);
    __resetDirtyTrackingForTests();
  });

  const emptyBoard: BoardFileData = {
    board: {
      id: 'b',
      type: 'mindmap',
      name: 'B',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as BoardFileData['board'],
    tileDefs: {},
    connections: {},
    frames: [],
  };

  it('rethrows when board:save returns { ok: false, error }', async () => {
    installFiloMock({
      'board:save': () => ({ ok: false, error: 'EPERM' }),
    });

    await expect(writeBoardFile('/vault', 'b.board.json', emptyBoard))
      .rejects.toThrow(/EPERM|board:save/);
  });

  it('routes the failure through the write-error listener', async () => {
    installFiloMock({
      'board:save': () => ({ ok: false, error: 'EACCES' }),
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    await expect(writeBoardFile('/vault', 'b.board.json', emptyBoard)).rejects.toThrow();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'board', path: 'b.board.json' });
  });
});

describe('writeConfigs — envelope failure', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    setWriteErrorListener(null);
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    setWriteErrorListener(null);
  });

  it('surfaces failures on config:save { ok: false }', async () => {
    installFiloMock({
      'config:save-workspace': () => ({ ok: true }),
      'config:save': (...args: unknown[]) => {
        const target = String(args[1]);
        if (target === 'defaults.json') return { ok: false, code: 'EACCES', error: 'access denied' };
        return { ok: true };
      },
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    const settings: ProjectSettings = {} as unknown as ProjectSettings;
    const workspace: WorkspaceState = { openTabs: [], activeTabId: null } as unknown as WorkspaceState;

    // writeConfigs returns the failed list rather than throwing so the
    // honest save-success aggregate can include config target failures.
    const res = await writeConfigs('/vault', settings, 'light', workspace);
    expect(res.failed).toEqual(['defaults.json']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'config', path: 'defaults.json' });
  });
});

describe('noteStore.flushAll — envelope failure', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    setWriteErrorListener(null);
    setWriteStateListener(null);
    vault = installMemoryVault({
      'Notes/foo.md': '---\ntitle: Foo\n---\nhello\n',
      'Notes/bar.md': '---\ntitle: Bar\n---\nworld\n',
    });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    setWriteErrorListener(null);
    setWriteStateListener(null);
  });

  it('reports the path failed when vault:write-existing-file-text returns { success: false, error }', async () => {
    vault.failNextWrite('Notes/foo.md', 'EPERM');
    noteStore.patchFrontmatter('Notes/foo.md', { set: { status: 'done' }, unset: [] });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    // Flush returns `{ failed }` so the Ctrl+S aggregate can surface "Save
    // failed" without one writer's error hiding the rest of the flush.
    const res = await noteStore.flushAll();
    expect(res.failed).toEqual(['Notes/foo.md']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'component', path: 'Notes/foo.md' });
    expect(vault.read('Notes/foo.md')).toBe('---\ntitle: Foo\n---\nhello\n');
  });

  it('write-state listener observes the failed path in failed count', async () => {
    vault.failNextWrite('Notes/bar.md', 'EPERM');
    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    noteStore.patchFrontmatter('Notes/bar.md', { set: { status: 'done' }, unset: [] });
    const res = await noteStore.flushAll();
    expect(res.failed).toEqual(['Notes/bar.md']);

    // Final state: nothing inflight, exactly one failed path.
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });
  });
});
