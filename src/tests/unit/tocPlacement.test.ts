import { describe, it, expect } from 'vitest';
import { tocDefaultBounds, tocFitsBeside, TOC_DEFAULTS } from '@renderer/lib/tasklist/tocPlacement';

/**
 * The Task List's Table of Contents first opens beside the list column when
 * there is room, so it doesn't cover the tasks or the progress count.
 */
describe('tocDefaultBounds', () => {
  it('sits beside the list column, narrowed to fit, rather than over it', () => {
    // The live run: a 1384px window, the list column ending at 1090.
    const b = tocDefaultBounds(1384, 1090);
    expect(b.x).toBeGreaterThanOrEqual(1090 + TOC_DEFAULTS.gap);
    expect(b.x + b.width).toBeLessThanOrEqual(1384 - TOC_DEFAULTS.rightMargin);
    expect(b.width).toBeGreaterThanOrEqual(TOC_DEFAULTS.minWidth);
  });

  it('keeps the full width in the corner when the column is well clear of it', () => {
    expect(tocDefaultBounds(1920, 1300)).toEqual({ x: 1920 - 80 - 220, y: 100, width: 220, height: 320 });
  });

  it('falls back to the corner when there is no room beside the list, or no list', () => {
    const corner = { x: 1000 - 80 - 220, y: 100, width: 220, height: 320 };
    expect(tocDefaultBounds(1000, 900)).toEqual(corner);
    expect(tocDefaultBounds(1000, null)).toEqual(corner);
  });
});

describe('tocFitsBeside (the panel opens folded where it would cover the list)', () => {
  it('is true where the panel sits beside the list or in a clear corner', () => {
    expect(tocFitsBeside(1384, 1090)).toBe(true);
    expect(tocFitsBeside(1920, 1300)).toBe(true);
    expect(tocFitsBeside(1000, null)).toBe(true);
  });

  it('is false where its first place is over the list (a 1,280 px window)', () => {
    // The list column, 800 px wide, centred in a 1,280 px workspace, ends at 1,064.
    expect(tocFitsBeside(1280, 1064)).toBe(false);
    expect(tocFitsBeside(1000, 900)).toBe(false);
  });
});
