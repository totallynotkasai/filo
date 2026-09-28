/**
 * The watcher's 30 s scan can report a board save of Filo's own long after the
 * self-write window. While the file still holds what Filo last wrote or read
 * (its stat equals the drift baseline) the board reconciler does nothing: no
 * "changed outside Filo" prompt (whose Reload dropped the edits armed in the
 * debounce), and no silent reload. A real change still prompts or reloads.
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
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  noteAdditionalPendingPath,
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

const REL = 'k.board.json';

function makeBoard(marker: string): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'k',
      emoji: marker,
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

function marker(): string {
  return (boardCacheStore.cache.kb!.board as KanbanBoard).emoji ?? '';
}

function driftPrompt(): boolean {
  return uiStore.toasts.some((t) => t.text.includes('was changed outside Filo'));
}

let loads = 0;

function installRoutes(stat: { mtimeMs: number; size: number }): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string) => {
      if (channel === 'vault:stat') return { success: true, ...stat };
      if (channel === 'board:load') {
        loads++;
        return makeBoard('from-disk');
      }
      return null;
    },
    on: () => () => {},
    send: () => {},
  };
}

describe('board reconciler: a scan reporting the file Filo last saved', () => {
  beforeEach(() => {
    loads = 0;
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeBoard('mine') }, { kb: REL });
    // Long past the self-write window.
    __clearRecentSelfWritesForTests();
    noteBaseline(REL, 1000, 500);
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    // Not silent: an open drift prompt resolves, so the next case can ask again.
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('with an edit armed: no prompt, and the edit stays', async () => {
    installRoutes({ mtimeMs: 1000, size: 500 });
    noteAdditionalPendingPath(undefined, REL);
    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });
    expect(driftPrompt()).toBe(false);
    expect(loads).toBe(0);
    expect(marker()).toBe('mine');
  });

  it('with nothing armed: no silent reload', async () => {
    installRoutes({ mtimeMs: 1000, size: 500 });
    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });
    expect(loads).toBe(0);
    expect(marker()).toBe('mine');
  });

  it('a real change with an edit armed still asks', async () => {
    installRoutes({ mtimeMs: 2000, size: 640 });
    noteAdditionalPendingPath(undefined, REL);
    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });
    expect(driftPrompt()).toBe(true);
  });

  it('a real change with nothing armed still reloads', async () => {
    installRoutes({ mtimeMs: 2000, size: 640 });
    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });
    expect(marker()).toBe('from-disk');
  });
});
