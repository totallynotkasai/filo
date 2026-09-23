import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard, loadAllBoards } from '@renderer/lib/boards/boardLoader';
import { boardLoadRetryToast } from '@renderer/lib/boards/boardLoadRetryPrompt';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 ERR-4 (renderer half) — a transiently unreadable board used to map
 * to "not-found" and vanish for the session. It now carries a typed kind, is
 * not snapshotted, and gets a sticky notice whose Retry adopts the board into
 * the running session.
 */

const board = {
  version: 7,
  board: {
    id: 'b1', type: 'mindmap', name: 'Plan', emoji: '', createdAt: 0, updatedAt: 0,
    settings: {}, placements: {}, inlineTiles: {}, waypoints: [],
  },
  tileDefs: {},
  connections: {},
  frames: [],
};

describe('board load — transient failures are retryable (Audit-19 ERR-4)', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    boardCacheStore.hydrate({}, {});
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    boardCacheStore.hydrate({}, {});
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  it('LOCKED → error kind "locked" with an honest message (bite: was "not-found")', async () => {
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: false, code: 'LOCKED', error: 'EBUSY' }),
    });
    const res = await loadBoard('/vault', 'Plan.board.json');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('locked');
    expect(res.message).toMatch(/locked by another program/);
  });

  it('OFFLINE → "offline"; ENOENT → "not-found"', async () => {
    installFiloMock({ 'board:load': () => ({ success: false, code: 'OFFLINE', error: 'EIO' }) });
    expect(await loadBoard('/vault', 'A.board.json')).toMatchObject({ ok: false, error: 'offline' });
    installFiloMock({ 'board:load': () => ({ success: false, code: 'ENOENT', error: 'gone' }) });
    expect(await loadBoard('/vault', 'A.board.json')).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('loadAllBoards records a locked board without the generic error toast', async () => {
    installFiloMock({
      'board:list': () => ['Plan.board.json'],
      'board:load': () => ({ success: false, code: 'LOCKED', error: 'EBUSY' }),
    });
    const res = await loadAllBoards('/vault');
    expect(res.failedBoards).toEqual([
      expect.objectContaining({ path: 'Plan.board.json', errorKind: 'locked' }),
    ]);
    expect(uiStore.toasts.some((t) => /couldn't load Plan/.test(t.text))).toBe(false);
  });

  it('the Retry notice adopts the board once the lock clears (no vault reopen)', async () => {
    beginVaultGeneration('/vault');
    let locked = true;
    const calls: string[] = [];
    installFiloMock((channel: string) => {
      calls.push(channel);
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 1 };
      if (channel === 'board:load') {
        return locked ? { success: false, code: 'LOCKED', error: 'EBUSY' } : { success: true, data: board };
      }
      return { success: true, ok: true };
    });
    const spec = boardLoadRetryToast('/vault', 'Plan.board.json', '"Plan.board.json" is locked.');
    expect(spec.sticky).toBe(true);
    expect(calls).not.toContain('recovery:snapshot');

    // Still locked → the notice comes back (with Retry) instead of vanishing.
    await spec.actions[0].handler();
    expect(boardCacheStore.paths.b1).toBeUndefined();
    expect(uiStore.toasts.some((t) => t.dedupeKey === 'board-load:Plan.board.json')).toBe(true);

    locked = false;
    await spec.actions[0].handler();
    expect(boardCacheStore.paths.b1).toBe('Plan.board.json');
    expect(boardCacheStore.cache.b1?.board.name).toBe('Plan');
  });
});
