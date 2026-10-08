/**
 * A tile or card the user just made opens its title for typing once its
 * header mounts, and only then: a request not taken soon is dropped, and a
 * board's single-letter keys act only while focus is inside the board.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { editTitleWhenShown, newTitleEditEnded, takeTitleEdit } from '@renderer/lib/boards/newTileTitle';
import { focusIsInBoard } from '@renderer/lib/utils/boardFocus';
import { registerKanbanShortcuts } from '@renderer/lib/kanban/kanbanShortcuts';
import { initKeyboardShortcuts, _resetForTests } from '@renderer/core/hotkeys';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('newTileTitle', () => {
  it('a request is taken once, by its own tile', () => {
    editTitleWhenShown('tile-a');
    expect(takeTitleEdit('tile-b')).toBe(false);
    expect(takeTitleEdit('tile-a')).toBe(true);
    expect(takeTitleEdit('tile-a')).toBe(false);
  });

  it('a request its tile does not take within two seconds is dropped', () => {
    vi.useFakeTimers();
    editTitleWhenShown('offscreen');
    vi.advanceTimersByTime(2500);
    expect(takeTitleEdit('offscreen')).toBe(false);
  });

  it('tells the caller once the edit its header opened ends', () => {
    const done = vi.fn();
    editTitleWhenShown('card', done);
    expect(takeTitleEdit('card')).toBe(true);
    expect(done).not.toHaveBeenCalled();
    newTitleEditEnded('card');
    expect(done).toHaveBeenCalledTimes(1);
    newTitleEditEnded('card');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('tells the caller at once when no header takes the request in time', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    editTitleWhenShown('collapsed', done);
    vi.advanceTimersByTime(2100);
    expect(done).toHaveBeenCalledTimes(1);
    expect(takeTitleEdit('collapsed')).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('focusIsInBoard', () => {
  function board(): { root: HTMLElement; tile: HTMLButtonElement; outside: HTMLButtonElement } {
    const root = document.createElement('div');
    root.tabIndex = 0;
    const tile = document.createElement('button');
    root.appendChild(tile);
    const outside = document.createElement('button');
    document.body.append(root, outside);
    return { root, tile, outside };
  }

  it('is true for the board itself and anything inside it', () => {
    const b = board();
    b.root.focus();
    expect(focusIsInBoard(b.root)).toBe(true);
    b.tile.focus();
    expect(focusIsInBoard(b.root)).toBe(true);
  });

  it('is false for focus elsewhere, on the page, or with no board', () => {
    const b = board();
    b.outside.focus();
    expect(focusIsInBoard(b.root)).toBe(false);
    b.outside.blur();
    expect(document.activeElement).toBe(document.body);
    expect(focusIsInBoard(b.root)).toBe(false);
    expect(focusIsInBoard(null)).toBe(false);
  });
});

describe('Kanban shortcuts', () => {
  it('bare N and Shift+N act only with focus in the board; Ctrl+N for the active pane anywhere', () => {
    _resetForTests();
    initKeyboardShortcuts();
    const root = document.createElement('div');
    root.tabIndex = 0;
    const elsewhere = document.createElement('button');
    document.body.append(root, elsewhere);
    const fired: string[] = [];
    const off = registerKanbanShortcuts({
      isActivePane: () => true,
      boardRoot: () => root,
      addCard: () => fired.push('card'),
      addColumn: () => fired.push('column'),
    });
    const press = (init: KeyboardEventInit): void => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    };
    try {
      elsewhere.focus();
      press({ key: 'n' });
      press({ key: 'N', shiftKey: true });
      expect(fired).toEqual([]);
      press({ key: 'n', ctrlKey: true });
      expect(fired).toEqual(['card']);

      root.focus();
      press({ key: 'n' });
      press({ key: 'N', shiftKey: true });
      expect(fired).toEqual(['card', 'card', 'column']);
    } finally {
      off();
      _resetForTests();
    }
  });
});
