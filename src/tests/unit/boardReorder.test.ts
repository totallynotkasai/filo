/**
 * Board Browser keyboard reorder (Alt+ArrowUp / Alt+ArrowDown).
 *
 * `computeKeyboardReorder` is the pure core the component calls; testing it
 * directly (rather than the un-mountable Svelte component) locks the reorder
 * semantics: adjacent swap, edge no-ops, and search-filter-aware by-id swaps.
 */
import { describe, it, expect } from 'vitest';
import { computeKeyboardReorder } from '@renderer/lib/boards/boardReorder';

type B = { id: string; name: string };
const mk = (...ids: string[]): B[] => ids.map((id) => ({ id, name: id }));
const ids = (out: B[] | null): string[] | null => (out ? out.map((b) => b.id) : null);

describe('computeKeyboardReorder', () => {
  it('moves a board up by one (Alt+ArrowUp)', () => {
    const full = mk('a', 'b', 'c');
    expect(ids(computeKeyboardReorder(full, full, 'b', -1))).toEqual(['b', 'a', 'c']);
  });

  it('moves a board down by one (Alt+ArrowDown)', () => {
    const full = mk('a', 'b', 'c');
    expect(ids(computeKeyboardReorder(full, full, 'b', 1))).toEqual(['a', 'c', 'b']);
  });

  it('no-ops (null) at the top edge', () => {
    const full = mk('a', 'b', 'c');
    expect(computeKeyboardReorder(full, full, 'a', -1)).toBeNull();
  });

  it('no-ops (null) at the bottom edge', () => {
    const full = mk('a', 'b', 'c');
    expect(computeKeyboardReorder(full, full, 'c', 1)).toBeNull();
  });

  it('returns null when the focused board is not in the visible list', () => {
    const full = mk('a', 'b', 'c');
    const visible = mk('a', 'c'); // 'b' filtered out by search
    expect(computeKeyboardReorder(full, visible, 'b', -1)).toBeNull();
  });

  it('does not mutate the input array', () => {
    const full = mk('a', 'b', 'c');
    const before = full.map((b) => b.id);
    computeKeyboardReorder(full, full, 'b', 1);
    expect(full.map((b) => b.id)).toEqual(before);
  });

  it('with a search filter, swaps against the adjacent VISIBLE board in the full array', () => {
    // Full: a,b,c,d. Search hides b,c → visible [a,d]. Alt+ArrowDown on 'a'
    // swaps a<->d in the full list, leapfrogging the hidden boards — matching
    // the drag path's by-id semantics.
    const full = mk('a', 'b', 'c', 'd');
    const visible = mk('a', 'd');
    expect(ids(computeKeyboardReorder(full, visible, 'a', 1))).toEqual(['d', 'b', 'c', 'a']);
  });

  it('swaps adjacent boards when the visible list equals the full list', () => {
    const full = mk('a', 'b', 'c', 'd');
    expect(ids(computeKeyboardReorder(full, full, 'c', -1))).toEqual(['a', 'c', 'b', 'd']);
  });
});
