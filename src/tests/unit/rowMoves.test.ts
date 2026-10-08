import { describe, it, expect } from 'vitest';
import { indentParentFor, movedOrder, type DrawnRow } from '@renderer/lib/tasklist/rowMoves';

/**
 * Alt+Up / Alt+Down and Tab on a Task List row follow the rows as drawn and
 * the row's level (E-03, E-04 and decision D2): one press moves a task one
 * place on screen, and Tab indents one level, under the row above at its level.
 */

/** Rows from "A", "  A1" (two spaces a level), "#B" (a row that heads a group). */
function rows(...spec: string[]): DrawnRow[] {
  return spec.map((s) => {
    const depth = (s.length - s.trimStart().length) / 2;
    const name = s.trim();
    return { id: name.replace(/^#/, ''), depth, opensGroup: name.startsWith('#') };
  });
}

describe('movedOrder', () => {
  it('moves a task past the one above it, with its subtasks, in one press', () => {
    expect(movedOrder(rows('A', 'B', '  B1', 'C'), 'C', -1)).toEqual(['A', 'C', 'B', 'B1']);
    expect(movedOrder(rows('A', 'B', '  B1', 'C'), 'B', -1)).toEqual(['B', 'B1', 'A', 'C']);
  });

  it('moves a task past the one below it and that one\'s subtasks', () => {
    expect(movedOrder(rows('A', 'B', '  B1', 'C'), 'A', 1)).toEqual(['B', 'B1', 'A', 'C']);
  });

  it('moves a subtask only among its parent\'s subtasks', () => {
    const r = rows('A', '  A1', '  A2', 'B');
    expect(movedOrder(r, 'A2', -1)).toEqual(['A', 'A2', 'A1', 'B']);
    expect(movedOrder(r, 'A1', -1)).toBeNull();
    expect(movedOrder(r, 'A2', 1)).toBeNull();
  });

  it('stays inside its group under a Group By', () => {
    const r = rows('#A', 'B', '#C', 'D');
    expect(movedOrder(r, 'C', -1)).toBeNull();
    expect(movedOrder(r, 'B', 1)).toBeNull();
    expect(movedOrder(r, 'D', -1)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('does nothing at the ends, or for a row not drawn', () => {
    expect(movedOrder(rows('A', 'B'), 'A', -1)).toBeNull();
    expect(movedOrder(rows('A', 'B'), 'B', 1)).toBeNull();
    expect(movedOrder(rows('A', 'B'), 'Z', 1)).toBeNull();
  });
});

describe('indentParentFor', () => {
  it('indents one level, under the row above at the same level (not under its subtask)', () => {
    expect(indentParentFor(rows('A', '  A1', 'B'), 'B')).toBe('A');
    expect(indentParentFor(rows('A', '  A1', '    A1a', 'B'), 'B')).toBe('A');
    expect(indentParentFor(rows('A', '  A1', '  A2'), 'A2')).toBe('A1');
  });

  it('has no row to indent under for the first row at its level', () => {
    expect(indentParentFor(rows('A', 'B'), 'A')).toBeNull();
    expect(indentParentFor(rows('A', '  A1'), 'A1')).toBeNull();
    expect(indentParentFor(rows('A', '#B'), 'B')).toBeNull();
  });
});
