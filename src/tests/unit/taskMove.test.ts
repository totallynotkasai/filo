import { describe, it, expect } from 'vitest';
import { moveTaskBlock } from '@renderer/lib/tasks/taskMove';
import type { TaskPlacement, TaskListSection } from '@renderer/schema/index';

function p(id: string): TaskPlacement {
  return { tileId: id, position: 0 };
}

function s(id: string, position: number, title = id): TaskListSection {
  return { id, title, position, collapsed: false };
}

describe('moveTaskBlock', () => {
  it('moves a leaf task to the end of another section', () => {
    const placements = [p('a1'), p('a2'), p('b1'), p('b2')];
    const sections = [s('A', 0), s('B', 2)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'a1',
      descendantIds: [],
      targetSectionId: 'B',
      insertOffset: 2,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['a2', 'b1', 'b2', 'a1']);
    expect(result.sections.find((x) => x.id === 'A')?.position).toBe(0);
    expect(result.sections.find((x) => x.id === 'B')?.position).toBe(1);
  });

  it('moves a parent with its (contiguous) descendants together', () => {
    const placements = [p('a1'), p('a2'), p('a3'), p('b1')];
    const sections = [s('A', 0), s('B', 3)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'a1',
      descendantIds: ['a2', 'a3'],
      targetSectionId: 'B',
      insertOffset: 1,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['b1', 'a1', 'a2', 'a3']);
    expect(result.sections.find((x) => x.id === 'B')?.position).toBe(0);
  });

  it('moves a parent whose descendants are NON-contiguous', () => {
    const placements = [p('p'), p('x'), p('c1'), p('y'), p('c2'), p('z')];
    const sections = [s('Only', 0)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'p',
      descendantIds: ['c1', 'c2'],
      targetSectionId: 'Only',
      insertOffset: 999,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['x', 'y', 'z', 'p', 'c1', 'c2']);
  });

  it('moving inside the same section reorders without changing membership', () => {
    const placements = [p('a1'), p('a2'), p('a3'), p('b1')];
    const sections = [s('A', 0), s('B', 3)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'a3',
      descendantIds: [],
      targetSectionId: 'A',
      insertOffset: 0,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['a3', 'a1', 'a2', 'b1']);
    expect(result.sections.find((x) => x.id === 'A')?.position).toBe(0);
    expect(result.sections.find((x) => x.id === 'B')?.position).toBe(3);
  });

  it('appends to a section when insertOffset exceeds section size', () => {
    const placements = [p('a1'), p('b1')];
    const sections = [s('A', 0), s('B', 1)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'a1',
      descendantIds: [],
      targetSectionId: 'B',
      insertOffset: 99,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['b1', 'a1']);
    expect(result.sections.find((x) => x.id === 'A')?.position).toBe(0);
    expect(result.sections.find((x) => x.id === 'B')?.position).toBe(0);
  });

  it('drops into the leading bucket when targetSectionId is null', () => {
    const placements = [p('a1'), p('b1')];
    const sections = [s('B', 1)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'b1',
      descendantIds: [],
      targetSectionId: null,
      insertOffset: 0,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['b1', 'a1']);
    expect(result.sections.find((x) => x.id === 'B')?.position).toBe(2);
  });

  /**
   * Regression: cross-section multi-drag snap-back.
   *
   * Pre-fix, when a block moved from an EARLIER section into a LATER one and
   * dropped at the destination's start, the source section's adjusted
   * position (0) collapsed to match the destination's adjusted position (0),
   * and the shift logic then pushed the source section past the destination
   * — visually re-ordering the sections AND sweeping any "passenger" tile
   * (one that originally lived in the destination but wasn't part of the
   * block) out of its home and into the source. The user saw this as the
   * dropped tasks "snapping back" because the section partitioning was now
   * inconsistent with the placements array.
   *
   * Concretely: `d` started in `S2` and must stay in `S2` after the move.
   */
  it('does not orphan a passenger tile when block moves from earlier section into later one at offset 0', () => {
    const placements = [p('a'), p('b'), p('c'), p('d')];
    const sections = [s('S1', 0), s('S2', 3)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'a',
      descendantIds: ['b', 'c'],
      targetSectionId: 'S2',
      insertOffset: 0,
    });
    expect(result.placements.map((x) => x.tileId)).toEqual(['a', 'b', 'c', 'd']);
    // Section membership: a, b, c, AND d must all resolve to S2 after the
    // move. Sort the sections and walk them to verify partition assignment,
    // matching how the renderer derives each placement's section.
    const sorted = [...result.sections].sort((a, b) => a.position - b.position);
    const sectionFor = (idx: number) => {
      let last: string | null = null;
      for (const sec of sorted) {
        if (sec.position <= idx) last = sec.id;
        else break;
      }
      return last;
    };
    expect(sectionFor(0)).toBe('S2'); // a
    expect(sectionFor(1)).toBe('S2'); // b
    expect(sectionFor(2)).toBe('S2'); // c
    expect(sectionFor(3)).toBe('S2'); // d — the passenger that was being orphaned
  });

  it('is a no-op when draggedId is missing', () => {
    const placements = [p('a'), p('b')];
    const sections = [s('A', 0)];
    const result = moveTaskBlock({
      placements,
      sections,
      draggedId: 'missing',
      descendantIds: [],
      targetSectionId: 'A',
      insertOffset: 0,
    });
    expect(result.placements).toBe(placements);
    expect(result.sections).toBe(sections);
  });
});
