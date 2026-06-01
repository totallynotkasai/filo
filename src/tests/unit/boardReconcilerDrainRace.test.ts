/**
 * 6.4.M18 — the board-JSON reconciler's silent reload must not clobber a local
 * edit that lands DURING the disk read.
 *
 * reconcileBoardJsonChange checks isPathPending BEFORE awaiting loadBoard, then
 * replaceCache()s the disk bytes. A user edit arriving during that async read
 * flips isPathPending true, but the pre-read check is stale by then, so the
 * silent replaceCache used to overwrite the just-made edit. reloadBoardFromDisk
 * now re-checks after the read (guardPending) and defers to the dirty-editor
 * prompt instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  dispatchExternalChange,
  _resetRegistryForTests,
} from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  registerPendingProbe,
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

const REL = 'k.board.json';

function makeBoard(name: string): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function boardName(): string {
  return (boardCacheStore.cache.kb!.board as KanbanBoard).name;
}

// Raw-route filo stub (mirrors boardLoader.test): handlers' return value IS the
// invoke result. `onBoardLoad` lets a test mutate pending state mid-read.
function installRoutes(routes: Record<string, (...args: unknown[]) => unknown>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => routes[channel]?.(...args),
    on: () => () => {},
    send: () => {},
  };
}

describe('board reconciler — silent reload guards a write that lands during the read (6.4.M18)', () => {
  let pendingDuringRead = false;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    pendingDuringRead = false;
    registerPendingProbe((p) => pendingDuringRead && p === REL);
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('does NOT clobber the cache when a write appears during loadBoard', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: REL });
    // hydrate marks the path a recent self-write (load echo); clear so the
    // reconciler runs.
    __clearRecentSelfWritesForTests();
    expect(boardName()).toBe('original');

    installRoutes({
      'board:load': () => {
        // A local edit lands during the async read → pending flips true.
        pendingDuringRead = true;
        return JSON.stringify(makeBoard('from-disk'));
      },
      'vault:stat': () => ({ ok: true, mtimeMs: 1, size: 1 }),
    });

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    // M18 — re-checks after the read, sees the pending write, defers to the
    // prompt rather than overwriting the user's edit.
    expect(boardName()).toBe('original');
  });

  it('applies the disk version silently when no write appears during the read', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: REL });
    __clearRecentSelfWritesForTests();

    installRoutes({
      'board:load': () => JSON.stringify(makeBoard('from-disk')), // pending stays false
      'vault:stat': () => ({ ok: true, mtimeMs: 1, size: 1 }),
    });

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    expect(boardName()).toBe('from-disk');
  });
});
