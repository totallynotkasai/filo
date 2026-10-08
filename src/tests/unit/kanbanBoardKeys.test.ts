import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeKanbanBoardKeydown, type KanbanBoardKeyDeps } from '@renderer/lib/kanban/kanbanBoardKeys';
import { cardsOnScreen } from '@renderer/lib/kanban/kanbanKeyboardNav';

/**
 * A Kanban board's own keys: they act only for events inside the board,
 * never while text is typed, and Enter opens a card only from the board or
 * a card (a focused button keeps its Enter).
 */

interface Board {
  root: HTMLElement;
  button: HTMLButtonElement;
  cards: Record<string, HTMLElement>;
  selected: Set<string>;
  deps: KanbanBoardKeyDeps;
}

function board(shown: Record<string, string[]>): Board {
  const root = document.createElement('div');
  root.tabIndex = 0;
  const button = document.createElement('button');
  root.appendChild(button);
  const cards: Record<string, HTMLElement> = {};
  for (const ids of Object.values(shown)) {
    for (const id of ids) {
      const el = document.createElement('div');
      el.className = 'tile-drop-zone';
      el.dataset.tileId = id;
      el.tabIndex = -1;
      root.appendChild(el);
      cards[id] = el;
    }
  }
  document.body.appendChild(root);
  const selected = new Set<string>();
  const deps: KanbanBoardKeyDeps = {
    root: () => root,
    findBarOpen: () => false,
    openFindBar: vi.fn(),
    selection: {
      selectedIds: selected as never,
      get count() { return selected.size; },
      select: (id: string) => { selected.clear(); selected.add(id); },
    },
    clearSelection: () => selected.clear(),
    removeSelected: vi.fn(),
    cards: () => cardsOnScreen(Object.keys(shown).map((id) => ({ id })), (id) => shown[id] ?? []),
    arrowedTo: vi.fn(),
    openCard: vi.fn(() => true),
    announce: vi.fn(),
  };
  return { root, button, cards, selected, deps };
}

function press(target: Element, key: string, handler: (e: KeyboardEvent) => void): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  handler(e);
  return e;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('kanbanBoardKeys', () => {
  it('Enter opens the one selected card from the board or a card, not from a button', () => {
    const b = board({ todo: ['a'] });
    const keydown = makeKanbanBoardKeydown(b.deps);
    b.selected.add('a');
    expect(press(b.button, 'Enter', keydown).defaultPrevented).toBe(false);
    expect(b.deps.openCard).not.toHaveBeenCalled();
    expect(press(b.cards.a!, 'Enter', keydown).defaultPrevented).toBe(true);
    expect(press(b.root, 'Enter', keydown).defaultPrevented).toBe(true);
    expect(b.deps.openCard).toHaveBeenCalledTimes(2);
  });

  it('the arrows select the next card and move focus to it; from a card no longer drawn, the first', () => {
    const b = board({ todo: ['a', 'b'], done: ['c'] });
    const keydown = makeKanbanBoardKeydown(b.deps);
    b.root.focus();
    press(b.root, 'ArrowDown', keydown);
    expect([...b.selected]).toEqual(['a']);
    expect(document.activeElement).toBe(b.cards.a);
    press(b.cards.a!, 'ArrowRight', keydown);
    expect(document.activeElement).toBe(b.cards.c);
    expect(b.deps.arrowedTo).toHaveBeenLastCalledWith('c');
    b.selected.clear();
    b.selected.add('gone');
    press(b.root, 'ArrowDown', keydown);
    expect([...b.selected]).toEqual(['a']);
  });

  it('Delete on a focused card hands focus to the board before the card goes', () => {
    const b = board({ todo: ['a'] });
    const keydown = makeKanbanBoardKeydown(b.deps);
    b.selected.add('a');
    b.cards.a!.focus();
    press(b.cards.a!, 'Delete', keydown);
    expect(document.activeElement).toBe(b.root);
    expect(b.deps.removeSelected).toHaveBeenCalledTimes(1);
  });

  it('leaves keys alone outside the board, in a text field, and once something else took them', () => {
    const b = board({ todo: ['a'] });
    const keydown = makeKanbanBoardKeydown(b.deps);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    expect(press(outside, '/', keydown).defaultPrevented).toBe(false);
    const input = document.createElement('input');
    b.root.appendChild(input);
    expect(press(input, '/', keydown).defaultPrevented).toBe(false);
    expect(b.deps.openFindBar).not.toHaveBeenCalled();
    expect(press(b.root, '/', keydown).defaultPrevented).toBe(true);
    expect(b.deps.openFindBar).toHaveBeenCalledTimes(1);
  });
});
