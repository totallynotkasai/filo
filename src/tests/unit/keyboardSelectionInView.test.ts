import { describe, it, expect, vi, afterEach } from 'vitest';
import { revealOffset } from '@renderer/lib/canvas/revealRect';
import { cardPosition, neighbourCard, revealCard, type KanbanNavColumns } from '@renderer/lib/kanban/kanbanKeyboardNav';
import { buildCardContextMenu } from '@renderer/lib/kanban/kanbanContextMenus';

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

  it('scrolls the card it lands on into view, to the nearest edge', () => {
    const root = document.createElement('div');
    const card = document.createElement('div');
    card.dataset.tileId = 'x';
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    root.appendChild(card);
    document.body.appendChild(root);
    revealCard(root, 'x');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(() => revealCard(root, 'missing')).not.toThrow();
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
