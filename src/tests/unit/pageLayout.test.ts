import { describe, it, expect } from 'vitest';
import { layoutPages, sameBreaks, type LaidOutBlock, type PageGeometry } from '@renderer/lib/editor/pageLayout';

// A page 1000 tall with 100 bands: text from 100 to 900, the next page's from 1124.
const geometry: PageGeometry = { pageHeight: 1000, gap: 24, padTop: 100, padBottom: 100 };

/** Blocks `height` tall, one under the other from `start`, each its own target. */
function stack(start: number, heights: number[]): LaidOutBlock[] {
  let top = start;
  return heights.map((h, i) => {
    const block = { top, bottom: top + h, target: i === 0 ? null : i * 10 };
    top += h;
    return block;
  });
}

describe('layoutPages', () => {
  it('keeps a note that fits on one page', () => {
    const layout = layoutPages(stack(100, [200, 200, 300]), geometry);
    expect(layout.breaks).toEqual([]);
    expect(layout.pages).toEqual([{ top: 0, height: 1000 }]);
  });

  it('starts the block that would cross the bottom band on the next page', () => {
    // 100..500, 500..800, 800..1000: the third crosses 900.
    const layout = layoutPages(stack(100, [400, 300, 200]), geometry);
    expect(layout.pages).toEqual([{ top: 0, height: 1000 }, { top: 1024, height: 1000 }]);
    // Moved from 800 to the second page's text top, 1124.
    expect(layout.breaks).toEqual([{ target: 20, shift: 324 }]);
  });

  it('lets a block end exactly on the band', () => {
    const layout = layoutPages(stack(100, [400, 400]), geometry);
    expect(layout.breaks).toEqual([]);
  });

  it('carries each break into the blocks after it', () => {
    // Eight 300-tall blocks: two to a page (100..700 holds two, a third would reach 1000).
    const layout = layoutPages(stack(100, Array<number>(8).fill(300)), geometry);
    expect(layout.pages).toHaveLength(4);
    expect(layout.breaks.map((b) => b.target)).toEqual([20, 40, 60]);
    // Every break moves its block from the end of the pair above to a text top.
    for (const b of layout.breaks) expect(b.shift).toBe(424);
  });

  it('stretches the page for a block taller than a page’s text area', () => {
    const layout = layoutPages(stack(100, [200, 1500, 100]), geometry);
    // The tall block isn't moved; its page grows to hold it, the next block starts a page.
    expect(layout.pages[0]).toEqual({ top: 0, height: 1900 });
    expect(layout.breaks).toEqual([{ target: 20, shift: 1900 + 24 + 100 - 1800 }]);
  });

  it('stretches the page for a block nothing can move', () => {
    const layout = layoutPages([{ top: 700, bottom: 1000, target: null }], geometry);
    expect(layout.breaks).toEqual([]);
    expect(layout.pages).toEqual([{ top: 0, height: 1100 }]);
  });

  it('moves a block lying in the bottom band or past the page', () => {
    const blocks: LaidOutBlock[] = [
      { top: 100, bottom: 880, target: null },
      { top: 920, bottom: 960, target: 10 },
    ];
    expect(layoutPages(blocks, geometry).breaks).toEqual([{ target: 10, shift: 1124 - 920 }]);
  });

  it('keeps every block inside a page’s text area', () => {
    const heights = [37, 120, 18, 640, 300, 22, 22, 22, 500, 90, 410, 60, 700, 33];
    const blocks = stack(100, heights);
    const layout = layoutPages(blocks, geometry);
    let shift = 0;
    const byTarget = new Map(layout.breaks.map((b) => [b.target, b.shift]));
    for (const block of blocks) {
      shift += (block.target !== null && byTarget.get(block.target)) || 0;
      const top = block.top + shift;
      const bottom = block.bottom + shift;
      const page = layout.pages.find((p) => top >= p.top && top < p.top + p.height)!;
      expect(page).toBeDefined();
      expect(top).toBeGreaterThanOrEqual(page.top + geometry.padTop - 0.5);
      expect(bottom).toBeLessThanOrEqual(page.top + page.height - geometry.padBottom + 0.5);
    }
  });

  it('gives up on breaking a page with no room for text', () => {
    const layout = layoutPages(stack(10, [50, 50, 50]), { pageHeight: 100, gap: 10, padTop: 40, padBottom: 40 });
    expect(layout.breaks).toEqual([]);
    expect(layout.pages).toHaveLength(1);
  });
});

describe('sameBreaks', () => {
  it('ignores differences under half a pixel', () => {
    expect(sameBreaks([{ target: 4, shift: 100 }], [{ target: 4, shift: 100.3 }])).toBe(true);
    expect(sameBreaks([{ target: 4, shift: 100 }], [{ target: 4, shift: 101 }])).toBe(false);
    expect(sameBreaks([{ target: 4, shift: 100 }], [{ target: 5, shift: 100 }])).toBe(false);
    expect(sameBreaks([], [{ target: 5, shift: 100 }])).toBe(false);
  });
});
