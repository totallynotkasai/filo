/**
 * Phase 14 (Sprint D / C1+C2) regression guard.
 *
 * The main-process IPC handlers (`board:save`, `config:save`,
 * `vault:write-file-text`) catch their own errors and return `{ ok: false }`
 * or `{ success: false }` envelopes instead of letting the promise reject.
 * Before Phase 14 the renderer just awaited the invoke result and ignored
 * the envelope — disk-full / EPERM / EACCES failures were silently logged
 * to console while the save indicator flashed "Saved".
 *
 * These tests assert that:
 *   1. `assertIpcOk` throws on `{ ok: false }` / `{ success: false }`
 *      payloads and passes everything else through.
 *   2. `writeBoardFile` rethrows when `board:save` resolves to
 *      `{ ok: false, error }`.
 *   3. `writeConfigs` rethrows when `config:save` resolves to
 *      `{ ok: false, error }`.
 *   4. `writeFrontmatter` rejects (so `flushAllPendingFrontmatterWrites`
 *      via `Promise.all` rejects too) when `vault:write-file-text`
 *      resolves to `{ success: false, error }`. Without the C2 fix this
 *      flow swallowed the error inside the outer catch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertIpcOk, IpcEnvelopeError } from '@renderer/lib/utils/ipcEnvelope';
import {
  writeBoardFile,
  writeConfigs,
  setWriteErrorListener,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
  type WriteStateInfo,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import {
  flushAllPendingFrontmatterWrites,
  scheduleFrontmatterWrite,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

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

  const emptyBoard: V7BoardFileData = {
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
    } as unknown as V7BoardFileData['board'],
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

  it('surfaces failures on config:save { ok: false } (A1.1)', async () => {
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

    // A1.1: writeConfigs returns the failed list rather than throwing so the
    // honest save-success aggregate can include config target failures.
    const res = await writeConfigs('/vault', settings, 'light', workspace);
    expect(res.failed).toEqual(['defaults.json']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'config', path: 'defaults.json' });
  });
});

describe('flushAllPendingFrontmatterWrites — envelope failure', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    setWriteErrorListener(null);
    setWriteStateListener(null);
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    setWriteErrorListener(null);
    setWriteStateListener(null);
  });

  it('rejects when vault:write-file-text returns { success: false, error }', async () => {
    // vaultStore.path is a getter — set it for this test, then leave the
    // default restored by afterEach.
    vaultStore.setPath('/vault');

    installFiloMock({
      'vault:file-exists': () => true,
      // Phase 31 A4.2 — frontmatter writer now calls
      // `vault:write-existing-file-text` (ENOENT-short-circuits instead
      // of resurrecting a deleted file). Mock that channel here.
      'vault:write-existing-file-text': () => ({ success: false, code: 'EPERM', error: 'disk full' }),
    });

    // Seed a document so writeFrontmatter has frontmatter to assemble.
    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'Notes/foo.md',
      title: 'Foo',
      body: 'hello',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-1', { id: 'doc-1', title: 'Foo' });

    scheduleFrontmatterWrite('Notes/foo.md', 'doc-1');

    // Capture the writeError surface for the assertion below.
    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    // Phase 31 A1.3 — flush returns `{ failed }` so the Ctrl+S aggregate
    // can surface "Save failed" without the writer's individual error
    // hiding (Phase 14) the rest of the flush. Each failed path is
    // accounted for via endWrite(failure) → failed-set membership AND in
    // the returned array.
    const res = await flushAllPendingFrontmatterWrites();
    expect(res.failed).toEqual(['Notes/foo.md']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'component', path: 'Notes/foo.md' });
  });

  it('write-state listener observes the failed path in failed count', async () => {
    vaultStore.setPath('/vault');

    installFiloMock({
      'vault:file-exists': () => true,
      // A4.2 — same channel migration as above.
      'vault:write-existing-file-text': () => ({ success: false, error: 'EPERM' }),
    });

    documentStore.loadDocument({
      docId: 'doc-2',
      filename: 'Notes/bar.md',
      title: 'Bar',
      body: 'world',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-2', { id: 'doc-2' });

    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    scheduleFrontmatterWrite('Notes/bar.md', 'doc-2');
    const res = await flushAllPendingFrontmatterWrites();
    expect(res.failed).toEqual(['Notes/bar.md']);

    // Final state: nothing inflight, exactly one failed path.
    // Phase C / C.10 — WriteStateInfo also carries `failedPaths`; pin
    // only the counter shape.
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });
  });
});
