import { describe, it, expect } from 'vitest';
import { sectionIdForPlacementIndex } from '@renderer/lib/tasklist/sectionMath';
import type { TaskListSection } from '@renderer/schema/index';

function s(id: string, position: number, title = id): TaskListSection {
  return { id, title, position, collapsed: false };
}

describe('sectionIdForPlacementIndex', () => {
  it('returns null when there are no persisted sections', () => {
    expect(sectionIdForPlacementIndex([], 0)).toBeNull();
    expect(sectionIdForPlacementIndex([], 99)).toBeNull();
  });

  it('returns null for indices before the first section (leading bucket)', () => {
    const sections = [s('A', 2)];
    expect(sectionIdForPlacementIndex(sections, 0)).toBeNull();
    expect(sectionIdForPlacementIndex(sections, 1)).toBeNull();
  });

  it('returns the section id at its starting position', () => {
    const sections = [s('A', 0), s('B', 3)];
    expect(sectionIdForPlacementIndex(sections, 0)).toBe('A');
    expect(sectionIdForPlacementIndex(sections, 3)).toBe('B');
  });

  it('returns the section id for indices inside its half-open range', () => {
    const sections = [s('A', 0), s('B', 3), s('C', 6)];
    expect(sectionIdForPlacementIndex(sections, 0)).toBe('A');
    expect(sectionIdForPlacementIndex(sections, 1)).toBe('A');
    expect(sectionIdForPlacementIndex(sections, 2)).toBe('A');
    expect(sectionIdForPlacementIndex(sections, 3)).toBe('B');
    expect(sectionIdForPlacementIndex(sections, 4)).toBe('B');
    expect(sectionIdForPlacementIndex(sections, 5)).toBe('B');
    expect(sectionIdForPlacementIndex(sections, 6)).toBe('C');
    expect(sectionIdForPlacementIndex(sections, 99)).toBe('C');
  });

  it('handles sections passed in non-sorted order (sorts internally)', () => {
    const sections = [s('C', 6), s('A', 0), s('B', 3)];
    expect(sectionIdForPlacementIndex(sections, 4)).toBe('B');
    expect(sectionIdForPlacementIndex(sections, 7)).toBe('C');
  });

  it('returns null when index is negative (no section starts at < 0)', () => {
    const sections = [s('A', 0)];
    expect(sectionIdForPlacementIndex(sections, -1)).toBeNull();
  });

  it('handles a single section starting at 0', () => {
    const sections = [s('Only', 0)];
    expect(sectionIdForPlacementIndex(sections, 0)).toBe('Only');
    expect(sectionIdForPlacementIndex(sections, 10)).toBe('Only');
  });
});
