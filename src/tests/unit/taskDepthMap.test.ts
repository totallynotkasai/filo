import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildTaskDepths, getTaskDepth, type RowLike } from '@renderer/lib/tasklist/blockMove';

/** Rows with random parents: none, another row, a missing id, or a cycle. */
const rowsArb = fc.integer({ min: 0, max: 40 }).chain((n) =>
  fc.array(fc.oneof(fc.constant(-1), fc.integer({ min: 0, max: Math.max(0, n - 1) }), fc.constant(999)), { minLength: n, maxLength: n })
    .map((parents): RowLike[] => parents.map((p, i) => ({
      tile: { id: `t${i}` },
      parent: p === -1 ? '' : p === 999 ? 'gone' : `t${p}`,
    }))),
);

describe('buildTaskDepths', () => {
  it('gives every row the depth getTaskDepth gives it', () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const map = buildTaskDepths(rows);
        expect(map.size).toBe(new Set(rows.map((r) => r.tile.id)).size);
        for (const r of rows) expect(map.get(r.tile.id)).toBe(getTaskDepth(rows, r.tile.id));
      }),
      { numRuns: 300, seed: 20260929 },
    );
  });

  it('reads a chain, and a cycle as unbounded', () => {
    const rows: RowLike[] = [
      { tile: { id: 'a' }, parent: '' },
      { tile: { id: 'b' }, parent: 'a' },
      { tile: { id: 'c' }, parent: 'b' },
      { tile: { id: 'x' }, parent: 'y' },
      { tile: { id: 'y' }, parent: 'x' },
    ];
    const map = buildTaskDepths(rows);
    expect([map.get('a'), map.get('b'), map.get('c')]).toEqual([0, 1, 2]);
    expect(map.get('x')).toBe(Infinity);
  });
});
