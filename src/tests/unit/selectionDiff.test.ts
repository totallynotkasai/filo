import { describe, it, expect } from 'vitest';
import { createSelectionScope } from '../../renderer/stores/selection.svelte';

/**
 * Sprint B / B4 — `selectMultiple` is the hot path for marquee selection;
 * thousands of pointermoves per drag run through it. The diff-based update
 * (additions + removals only) must remain behaviourally identical to the
 * previous clear-and-readd implementation while reducing reactive churn.
 */
describe('selectionScope.selectMultiple — diff-based update (Sprint B / B4)', () => {
  it('selects the given ids when starting empty', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a', 'b', 'c']);
    expect([...scope.selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('removes ids no longer in the next set', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a', 'b', 'c']);
    scope.selectMultiple(['b', 'c']);
    expect([...scope.selectedIds].sort()).toEqual(['b', 'c']);
  });

  it('adds new ids appearing in the next set', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a']);
    scope.selectMultiple(['a', 'b', 'c']);
    expect([...scope.selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles full replacement (no overlap)', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a', 'b']);
    scope.selectMultiple(['c', 'd']);
    expect([...scope.selectedIds].sort()).toEqual(['c', 'd']);
  });

  it('handles clearing with empty array', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a', 'b']);
    scope.selectMultiple([]);
    expect([...scope.selectedIds]).toEqual([]);
  });

  it('is idempotent when the same set is passed twice', () => {
    const scope = createSelectionScope();
    scope.selectMultiple(['a', 'b', 'c']);
    scope.selectMultiple(['a', 'b', 'c']);
    expect([...scope.selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('completes a 10k-element symmetric-difference update quickly', () => {
    const scope = createSelectionScope();
    const a = Array.from({ length: 10000 }, (_, i) => `id_${i}`);
    const b = Array.from({ length: 10000 }, (_, i) => `id_${i + 5000}`); // 50% overlap
    scope.selectMultiple(a);
    const start = performance.now();
    scope.selectMultiple(b);
    const elapsed = performance.now() - start;
    expect(scope.selectedIds.size).toBe(10000);
    expect(elapsed).toBeLessThan(200); // generous: jsdom is slow
  });
});
