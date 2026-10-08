import { describe, it, expect, vi, afterEach } from 'vitest';
import { revealOffset } from '@renderer/lib/canvas/revealRect';
import { cardPosition, cardsOnScreen, focusCard, neighbourCard, type KanbanNavColumns } from '@renderer/lib/kanban/kanbanKeyboardNav';
import { buildCardContextMenu, cardMenuPoint } from '@renderer/lib/kanban/kanbanContextMenus';

/**
 * Keyboard selection is brought into view (E-18): the arrow keys selected a
 * Mind Map tile or a Kanban card off screen and left the view where it was.
 * And one card can be moved to another column without a drag.
 */

const VIEW = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 };

describe('revealOffset: how far the Mind Map view moves to show a tile', () => {
  it('leaves the view alone for a tile already in it', () => {
    expect(revealOffset(VIEW, { x: 100, y: 100, width: 200, height: 100 })).toEqual({ dx: 0, dy: 0 });
  });

  it('moves just enough, with a margin, for a tile off any edge', () => {
    expect(revealOffset(VIEW, { x: 1200, y: 100, width: 200, height: 100 })).toEqual({ dx: 440, dy: 0 });
    expect(revealOffset(VIEW, { x: -300, y: 100, width: 200, height: 100 })).toEqual({ dx: -340, dy: 0 });
    expect(revealOffset(VIEW, { x: 100, y: 700, width: 200, height: 100 })).toEqual({ dx: 0, dy: 240 });
    expect(revealOffset(VIEW, { x: 100, y: -500, width: 200, height: 100 })).toEqual({ dx: 0, dy: -540 });
  });

  it('lines a tile bigger than the view up with its top-left edge', () => {
    expect(revealOffset(VIEW, { x: 500, y: 100, width: 2000, height: 100 })).toEqual({ dx: 460, dy: 0 });
  });
});

describe('Kanban arrow keys', () => {
  const cards: Record<string, string[]> = { todo: ['a', 'b', 'c'], doing: [], done: ['x'] };
  const cols: KanbanNavColumns = { ids: ['todo', 'doing', 'done'], cardsIn: (id) => cards[id] ?? [] };

  it('Up and Down move within a column and stop at its ends', () => {
    expect(neighbourCard(cols, { columnId: 'todo', rowIdx: 1 }, 'ArrowDown')).toBe('c');
    expect(neighbourCard(cols, { columnId: 'todo', rowIdx: 1 }, 'ArrowUp')).toBe('a');
    expect(neighbourCard(cols, { columnId: 'todo', rowIdx: 2 }, 'ArrowDown')).toBeNull();
  });

  it('Left and Right skip an empty column and keep the row where they can', () => {
    expect(neighbourCard(cols, { columnId: 'todo', rowIdx: 2 }, 'ArrowRight')).toBe('x');
    expect(neighbourCard(cols, { columnId: 'done', rowIdx: 0 }, 'ArrowLeft')).toBe('a');
    expect(neighbourCard(cols, { columnId: 'done', rowIdx: 0 }, 'ArrowRight')).toBeNull();
  });

  it('finds the card\'s column and row as drawn', () => {
    expect(cardPosition(cols, 'c')).toEqual({ columnId: 'todo', rowIdx: 2 });
    expect(cardPosition(cols, 'gone')).toBeNull();
  });

  afterEach(() => { document.body.innerHTML = ''; });

  it('focuses the card it lands on and scrolls it into view, to the nearest edge', () => {
    const root = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'tile-drop-zone';
    card.dataset.tileId = 'x';
    card.tabIndex = -1;
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    root.appendChild(card);
    document.body.appendChild(root);
    focusCard(root, 'x');
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(() => focusCard(root, 'missing')).not.toThrow();
  });
});

describe('the cards on screen (E-02: a collapsed column draws none)', () => {
  const shown: Record<string, string[]> = { todo: ['a'], doing: ['h1', 'h2'], done: ['g'] };
  const columns = [{ id: 'todo' }, { id: 'doing', collapsed: true }, { id: 'done' }];

  it('leave a collapsed column\'s cards out of the order a Shift-click range takes', () => {
    const cards = cardsOnScreen(columns, (id) => shown[id] ?? []);
    expect(cards.flat).toEqual(['a', 'g']);
    expect(cards.ids).toEqual(['todo', 'doing', 'done']);
    expect(cards.cardsIn('doing')).toEqual([]);
  });

  it('let ArrowRight and ArrowLeft skip the collapsed column', () => {
    const cards = cardsOnScreen(columns, (id) => shown[id] ?? []);
    expect(neighbourCard(cards, { columnId: 'todo', rowIdx: 0 }, 'ArrowRight')).toBe('g');
    expect(neighbourCard(cards, { columnId: 'done', rowIdx: 0 }, 'ArrowLeft')).toBe('a');
    expect(cardPosition(cards, 'h1')).toBeNull();
  });
});

describe('a single card\'s menu: Move to column', () => {
  it('lists the other columns after Remove, and moves the card', () => {
    const onMoveTo = vi.fn();
    const items = buildCardContextMenu({
      onStyle: vi.fn(), onRemove: vi.fn(),
      moveTargets: [{ id: 'doing', title: 'Doing' }, { id: 'done', title: 'Done' }],
      onMoveTo,
    });
    expect(items.filter((i) => !i.divider).map((i) => i.label)).toEqual(['Style…', 'Remove from board', 'Move to column', 'Doing', 'Done']);
    items.find((i) => i.label === 'Done')?.action?.();
    expect(onMoveTo).toHaveBeenCalledWith('done');
  });

  it('has no move items on a board with one column', () => {
    const items = buildCardContextMenu({ onStyle: vi.fn(), onRemove: vi.fn(), moveTargets: [], onMoveTo: vi.fn() });
    expect(items.some((i) => i.label === 'Move to column')).toBe(false);
  });
});

describe('cardMenuPoint: where a card\'s menu opens (E-06)', () => {
  const card = { getBoundingClientRect: () => ({ left: 100, top: 200, right: 400, bottom: 300, width: 300, height: 100 }) } as unknown as Element;

  it('at the pointer for a right-click on the card', () => {
    expect(cardMenuPoint(new MouseEvent('contextmenu', { clientX: 250, clientY: 260 }), card)).toEqual({ x: 250, y: 260 });
  });

  it('inside the card for the menu key, whose point may be off the card', () => {
    expect(cardMenuPoint(new MouseEvent('contextmenu', { clientX: 0, clientY: 0 }), card)).toEqual({ x: 124, y: 224 });
    expect(cardMenuPoint(new MouseEvent('contextmenu', { clientX: 100, clientY: 300 }), card)).toEqual({ x: 124, y: 224 });
  });
});
