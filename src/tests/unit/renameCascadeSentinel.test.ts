/**
 * Sprint 35.3 — rename-cascade recovery sentinel.
 *
 * Verifies the read/write/clear/mark-failed contracts on
 * `.filo/rename-cascade-pending.json`, plus the mutex-serialised behaviour
 * that prevents concurrent appends from losing entries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readPendingRenameCascades,
  writePendingRenameCascade,
  clearPendingRenameCascade,
  markRenameCascadeFlushFailed,
  __resetRenameCascadeSentinelForTests,
} from '@renderer/lib/vault/renameCascadeSentinel';

const SENTINEL_PATH = '.filo/rename-cascade-pending.json';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installStub(routes: Record<string, InvokeHandler>): void {
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

function buildFsStub(): {
  routes: Record<string, InvokeHandler>;
  diskContent: { value: string | null };
  getContent: () => string | null;
} {
  // diskContent stays as a closure-shared object so handlers can mutate it
  // while the test asserts against the same reference.
  const diskContent: { value: string | null } = { value: null };
  const routes: Record<string, InvokeHandler> = {
    'vault:read-file-text': () => {
      if (diskContent.value === null) {
        return { success: false, code: 'ENOENT' };
      }
      return { success: true, content: diskContent.value };
    },
    'vault:write-file-text': (_vaultRoot: unknown, _path: unknown, content: unknown) => {
      diskContent.value = String(content);
      return { success: true };
    },
    'vault:delete': () => {
      diskContent.value = null;
      return { success: true };
    },
  };
  return { routes, diskContent, getContent: () => diskContent.value };
}

describe('renameCascadeSentinel (Sprint 35.3)', () => {
  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:00Z'));
  });
  afterEach(() => {
    __resetRenameCascadeSentinelForTests();
    vi.useRealTimers();
  });

  it('returns empty result when no sentinel exists', async () => {
    installStub({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
    });
    const res = await readPendingRenameCascades('/vault');
    expect(res.entries).toBeUndefined();
    expect(res.unreadable).toBeUndefined();
  });

  it('write→read round-trip preserves payload', async () => {
    const { routes, getContent } = buildFsStub();
    installStub(routes);

    const id = await writePendingRenameCascade('/vault', {
      oldPath: 'Notes/old.md',
      newPath: 'Notes/new.md',
      affectedBoardIds: ['boardA', 'boardB'],
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const written = JSON.parse(getContent() ?? '{}') as { entries: unknown[] };
    expect(written.entries).toHaveLength(1);

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries).toHaveLength(1);
    expect(res.entries![0]).toMatchObject({
      id,
      oldPath: 'Notes/old.md',
      newPath: 'Notes/new.md',
      affectedBoardIds: ['boardA', 'boardB'],
    });
    expect(typeof res.entries![0].timestamp).toBe('number');
  });

  it('appends multiple entries without losing previous ones', async () => {
    const { routes } = buildFsStub();
    installStub(routes);

    await writePendingRenameCascade('/vault', {
      oldPath: 'a',
      newPath: 'a2',
      affectedBoardIds: ['b1'],
    });
    await writePendingRenameCascade('/vault', {
      oldPath: 'b',
      newPath: 'b2',
      affectedBoardIds: ['b2'],
    });

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries).toHaveLength(2);
    expect(res.entries!.map((e) => e.oldPath).sort()).toEqual(['a', 'b']);
  });

  it('clearPendingRenameCascade removes the targeted entry only', async () => {
    const { routes } = buildFsStub();
    installStub(routes);

    const id1 = await writePendingRenameCascade('/vault', {
      oldPath: 'a',
      newPath: 'a2',
      affectedBoardIds: ['b1'],
    });
    await writePendingRenameCascade('/vault', {
      oldPath: 'b',
      newPath: 'b2',
      affectedBoardIds: ['b2'],
    });

    await clearPendingRenameCascade('/vault', id1);

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries).toHaveLength(1);
    expect(res.entries![0].oldPath).toBe('b');
  });

  it('clearPendingRenameCascade deletes the file when no entries remain', async () => {
    const { routes, getContent } = buildFsStub();
    installStub(routes);

    const id = await writePendingRenameCascade('/vault', {
      oldPath: 'a',
      newPath: 'a2',
      affectedBoardIds: ['b1'],
    });

    expect(getContent()).not.toBeNull();
    await clearPendingRenameCascade('/vault', id);
    expect(getContent()).toBeNull();
  });

  it('markRenameCascadeFlushFailed annotates the failed board IDs in place', async () => {
    const { routes } = buildFsStub();
    installStub(routes);

    const id = await writePendingRenameCascade('/vault', {
      oldPath: 'a',
      newPath: 'a2',
      affectedBoardIds: ['b1', 'b2', 'b3'],
    });

    await markRenameCascadeFlushFailed('/vault', id, ['b2']);

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries![0].failedBoardIds).toEqual(['b2']);
    expect(res.entries![0].affectedBoardIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('E5 — round-trips the tagsAffected sink flag', async () => {
    const { routes } = buildFsStub();
    installStub(routes);

    await writePendingRenameCascade('/vault', {
      oldPath: 'Notes/old.md',
      newPath: 'Notes/new.md',
      affectedBoardIds: ['boardA'],
      tagsAffected: true,
    });

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries![0].tagsAffected).toBe(true);
  });

  it('E5 — defaults tagsAffected to false for a board-only (pre-E5) sentinel', async () => {
    // A sentinel written by an older build has no `tagsAffected` field; the
    // reader must treat it as false so its recovery skips the tag re-assert.
    installStub({
      'vault:read-file-text': () => ({
        success: true,
        content: JSON.stringify({
          entries: [
            {
              id: 'legacy1',
              timestamp: 1,
              oldPath: 'a',
              newPath: 'a2',
              affectedBoardIds: ['b1'],
            },
          ],
        }),
      }),
    });

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries![0].tagsAffected).toBe(false);
  });

  it('returns unreadable when the file content is invalid JSON', async () => {
    installStub({
      'vault:read-file-text': () => ({ success: true, content: '{ broken' }),
    });
    const res = await readPendingRenameCascades('/vault');
    expect(res.unreadable).toBe(true);
  });

  it('returns unreadable when entries field is missing', async () => {
    installStub({
      'vault:read-file-text': () => ({ success: true, content: JSON.stringify({ foo: 'bar' }) }),
    });
    const res = await readPendingRenameCascades('/vault');
    expect(res.unreadable).toBe(true);
  });

  it('concurrent appends do not lose entries (mutex serialisation)', async () => {
    const { routes } = buildFsStub();
    installStub(routes);

    // Fire 5 concurrent appends; the mutex must serialise them so all 5
    // land in the final file. Without the mutex, the read-modify-write
    // race would collapse them to 1.
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(writePendingRenameCascade('/vault', {
        oldPath: `o${i}`,
        newPath: `n${i}`,
        affectedBoardIds: [`b${i}`],
      }));
    }
    await Promise.all(promises);

    const res = await readPendingRenameCascades('/vault');
    expect(res.entries).toHaveLength(5);
    const paths = res.entries!.map((e) => e.oldPath).sort();
    expect(paths).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
  });
});
