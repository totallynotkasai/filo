/**
 * A board's file is written only when something in it changes
 * (KNOWN_LIMITATIONS #29):
 * - a step that changes only notes (a ticked task, a card field, a note
 *   tile's plain title) arms no write of its board, whether it runs, is
 *   undone, redone or pushed as done; a batch arms one only when a child
 *   changes the board;
 * - a Kanban board or Task List with no saved view counts the view it shows
 *   with none as saved, so showing it writes nothing until the user changes
 *   the sort or a filter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { historyStore } from '@renderer/stores/history.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { BatchCommand, UpdateTitleCommand } from '@renderer/commands/index';
import { boardHasUnsavedWrite, cancelAllPendingBoardWrites } from '@renderer/lib/boards/boardWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { flushLastViewForBoard, KANBAN_DEFAULT_VIEW, TASK_LIST_DEFAULT_VIEW } from '@renderer/lib/boards/lastViewFlush';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { fakeCommand } from '../helpers/fakeCommand';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function board(id: string, type: 'kanban' | 'tasklist', settings: Record<string, unknown> = {}): BoardFileData {
  return {
    board: { id, type, name: id, emoji: '', createdAt: 0, updatedAt: 0, settings, columns: [], tasks: [], sections: [] },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

const noteOnly = (description: string) =>
  fakeCommand({ description, targetBoardId: 'kb', execute() {}, undo() {}, changesBoardFile: () => false });
const boardStep = (description: string) =>
  fakeCommand({ description, targetBoardId: 'kb', execute() {}, undo() {} });

beforeEach(() => {
  installFiloMock(() => ({ success: true, ok: true }));
  __resetDirtyTrackingForTests();
  historyStore.clear();
  boardCacheStore.clear();
  boardCacheStore.hydrate({ kb: board('kb', 'kanban'), tl: board('tl', 'tasklist') }, { kb: 'K.board.json', tl: 'T.board.json' });
  historyStore.setActiveBoard('kb');
});

afterEach(() => {
  cancelAllPendingBoardWrites();
  historyStore.clear();
  boardCacheStore.clear();
  __resetDirtyTrackingForTests();
  restoreFiloDefault();
});

describe('a note-only step arms no write of its board', () => {
  it('run, undone, redone or pushed as done', async () => {
    await historyStore.execute(noteOnly('tick'));
    expect(boardHasUnsavedWrite('kb')).toBe(false);
    await historyStore.undo();
    expect(boardHasUnsavedWrite('kb')).toBe(false);
    await historyStore.redo();
    expect(boardHasUnsavedWrite('kb')).toBe(false);
    historyStore.pushWithoutExecute(noteOnly('field'));
    historyStore.pushWithoutExecuteOnBoard(noteOnly('field'), 'kb');
    expect(boardHasUnsavedWrite('kb')).toBe(false);
  });

  it('a step that changes the board still arms its write', async () => {
    await historyStore.execute(boardStep('move'));
    expect(boardHasUnsavedWrite('kb')).toBe(true);
  });

  it('a batch arms one only when a child changes the board', async () => {
    await historyStore.execute(new BatchCommand('two fields', [noteOnly('a'), noteOnly('b')], 'kb'));
    expect(boardHasUnsavedWrite('kb')).toBe(false);
    await historyStore.execute(new BatchCommand('field and move', [noteOnly('a'), boardStep('b')], 'kb'));
    expect(boardHasUnsavedWrite('kb')).toBe(true);
  });

  it("a note tile's title edit that keeps its formatting changes nothing on the board", () => {
    const plain = new UpdateTitleCommand({
      tileId: 't1', boardId: 'kb', notePath: 'Card.md',
      oldTitle: 'Old', newTitle: 'New', oldTitleHtml: undefined, newTitleHtml: undefined,
    });
    expect(plain.changesBoardFile()).toBe(false);
  });
});

describe('a board with no saved view', () => {
  it('Kanban: the default view counts as saved; another sort is written', () => {
    expect(flushLastViewForBoard('kb', { ...KANBAN_DEFAULT_VIEW, filterTags: [] })).toBe(false);
    expect(boardHasUnsavedWrite('kb')).toBe(false);
    expect(flushLastViewForBoard('kb', { ...KANBAN_DEFAULT_VIEW, sortBy: 'title' })).toBe(true);
    expect(boardHasUnsavedWrite('kb')).toBe(true);
  });

  it('Task List: the same', () => {
    expect(flushLastViewForBoard('tl', { ...TASK_LIST_DEFAULT_VIEW, filterTags: [] })).toBe(false);
    expect(boardHasUnsavedWrite('tl')).toBe(false);
    expect(flushLastViewForBoard('tl', { ...TASK_LIST_DEFAULT_VIEW, showCompleted: false })).toBe(true);
  });

  it('a board whose saved view differs from the default is written back to the default', () => {
    boardCacheStore.hydrate({ kb: board('kb', 'kanban', { lastView: { sortBy: 'title', filterTags: [], filterProp: null } }) }, { kb: 'K.board.json' });
    expect(flushLastViewForBoard('kb', { ...KANBAN_DEFAULT_VIEW, filterTags: [] })).toBe(true);
  });
});
