import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cascadeTagToBoardSettings,
  iterateInlineTiles,
  pushTagRewriteFailureToast,
} from '@renderer/stores/fileTagsCascade.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, Project } from '@renderer/schema/index';

/**
 * Audit-14 7.7 — focused DIRECT-unit coverage of the exports in
 * `fileTagsCascade.svelte.ts`. The existing `fileTagsCascade.test.ts` exercises
 * these transitively through `fileTagsStore.renameTagEverywhere` /
 * `removeTagEverywhere`; this isolates the three functions the plan named so a
 * regression in one can't be masked by the surrounding sweep.
 */

function makeKanbanWithViews(boardId: string, filterTags: string[]): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        savedViews: [{ id: 'sv1', name: 'View A', sortBy: 'manual', filterTags: [...filterTags], filterProp: null }],
        lastView: { sortBy: 'manual', filterTags: [...filterTags], filterProp: null },
      },
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function viewTags(boardId: string): { saved: string[]; last: string[] } {
  const s = (boardCacheStore.cache[boardId]?.board.settings ?? {}) as {
    savedViews?: Array<{ filterTags?: string[] }>;
    lastView?: { filterTags?: string[] };
  };
  return { saved: s.savedViews?.[0]?.filterTags ?? [], last: s.lastView?.filterTags ?? [] };
}

describe('fileTagsCascade.cascadeTagToBoardSettings (direct)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vi.restoreAllMocks();
  });

  it('rewrites the tag in savedViews + lastView and marks the board dirty (rename)', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWithViews('kb', ['oldtag', 'keep']) }, { kb: 'k.board.json' });
    const dirtySpy = vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});

    cascadeTagToBoardSettings('oldtag', 'newtag');

    const { saved, last } = viewTags('kb');
    expect(saved).toContain('newtag');
    expect(saved).not.toContain('oldtag');
    expect(saved).toContain('keep');
    expect(last).toContain('newtag');
    expect(last).not.toContain('oldtag');
    expect(dirtySpy).toHaveBeenCalledWith('kb');
  });

  it('removes the tag from both slots when newName is null (delete)', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWithViews('kb', ['oldtag', 'keep']) }, { kb: 'k.board.json' });
    vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});

    cascadeTagToBoardSettings('oldtag', null);

    const { saved, last } = viewTags('kb');
    expect(saved).toEqual(['keep']);
    expect(last).toEqual(['keep']);
  });

  it('does not mark a board dirty when no view carries the tag (no-op)', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWithViews('kb', ['unrelated']) }, { kb: 'k.board.json' });
    const dirtySpy = vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});

    cascadeTagToBoardSettings('oldtag', 'newtag');

    expect(dirtySpy).not.toHaveBeenCalled();
  });
});

describe('fileTagsCascade.iterateInlineTiles (direct)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('yields every inline tile across every board in the project', () => {
    // `iterateInlineTiles` reads `vaultStore.project` (a getter); stub it.
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({
      boards: [
        { id: 'b1', name: 'B', type: 'mindmap', emoji: '', inlineTiles: { i1: { id: 'i1', tags: ['x'] } } },
        { id: 'b2', name: 'B2', type: 'mindmap', emoji: '', inlineTiles: { i2: { id: 'i2' } } },
      ],
    } as unknown as Project);

    const ids = [...iterateInlineTiles()].map((t) => t.id);
    expect(ids).toEqual(['i1', 'i2']);
  });

  it('yields nothing when there is no project', () => {
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(null);
    expect([...iterateInlineTiles()]).toEqual([]);
  });
});

describe('fileTagsCascade.pushTagRewriteFailureToast (direct)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces a count-bearing error toast with a working Retry action', () => {
    const pushSpy = vi.spyOn(uiStore, 'pushToast').mockImplementation(() => '' as never);
    let retried = false;

    pushTagRewriteFailureToast({
      verb: 'Tag rename',
      failedCount: 2,
      attempted: 5,
      retry: () => {
        retried = true;
      },
    });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const arg = pushSpy.mock.calls[0][0] as {
      text: string;
      type: string;
      actions?: Array<{ label: string; handler: () => void | Promise<void> }>;
    };
    expect(arg.type).toBe('error');
    expect(arg.text).toContain('2 of 5');
    expect(arg.actions?.[0].label).toBe('Retry failed files');
    void arg.actions?.[0].handler();
    expect(retried).toBe(true);
  });
});
