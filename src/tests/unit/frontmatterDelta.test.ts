import { describe, it, expect } from 'vitest';
import {
  type FrontmatterDelta,
  isEmptyFrontmatterDelta,
  patchToFrontmatterDelta,
  applyFrontmatterDelta,
  mergeFrontmatterDelta,
} from '@renderer/lib/vault/frontmatterDelta';

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — pure delta primitives that
 * make "never drop an untouched key" structural. The gateway applies these to a
 * FRESH disk read at write time, so the seam tests below pin the contract the
 * write path relies on.
 */

describe('frontmatterDelta — patchToFrontmatterDelta', () => {
  it('routes concrete values to set and empty/null/undefined to unset (mergeFrontmatter rule)', () => {
    const delta = patchToFrontmatterDelta({
      priority: 'high',
      count: 0,
      flag: false,
      cleared: '',
      nulled: null,
      undef: undefined,
    });
    expect(delta.set).toEqual({ priority: 'high', count: 0, flag: false });
    expect(delta.unset.sort()).toEqual(['cleared', 'nulled', 'undef']);
  });

  it('treats 0 and false as real values, NOT clears', () => {
    const delta = patchToFrontmatterDelta({ completed: false, n: 0 });
    expect(delta.set).toEqual({ completed: false, n: 0 });
    expect(delta.unset).toEqual([]);
  });
});

describe('frontmatterDelta — applyFrontmatterDelta', () => {
  it('preserves untouched keys and only changes delta keys', () => {
    const base = { a: 1, b: 2, external: 'kept' };
    const next = applyFrontmatterDelta(base, { set: { b: 99 }, unset: [] });
    expect(next).toEqual({ a: 1, b: 99, external: 'kept' });
    // base is not mutated
    expect(base).toEqual({ a: 1, b: 2, external: 'kept' });
  });

  it('removes unset keys, keeps the rest', () => {
    const next = applyFrontmatterDelta(
      { a: 1, b: 2, external: 'kept' },
      { set: {}, unset: ['a'] },
    );
    expect(next).toEqual({ b: 2, external: 'kept' });
  });

  it('an empty delta is a no-op identity (preserves disk FM verbatim)', () => {
    const base = { a: 1, comment: 'x' };
    expect(applyFrontmatterDelta(base, { set: {}, unset: [] })).toEqual(base);
  });
});

describe('frontmatterDelta — mergeFrontmatterDelta (coalesced edits)', () => {
  it('b overrides a for the same key', () => {
    const a: FrontmatterDelta = { set: { p: 'low' }, unset: [] };
    const b: FrontmatterDelta = { set: { p: 'high' }, unset: [] };
    expect(mergeFrontmatterDelta(a, b)).toEqual({ set: { p: 'high' }, unset: [] });
  });

  it('a later unset removes an earlier set (no key in both)', () => {
    const merged = mergeFrontmatterDelta({ set: { p: 'high' }, unset: [] }, { set: {}, unset: ['p'] });
    expect(merged.set).toEqual({});
    expect(merged.unset).toEqual(['p']);
  });

  it('a later set revives an earlier unset', () => {
    const merged = mergeFrontmatterDelta({ set: {}, unset: ['p'] }, { set: { p: 'high' }, unset: [] });
    expect(merged.set).toEqual({ p: 'high' });
    expect(merged.unset).toEqual([]);
  });

  it('accumulates disjoint keys', () => {
    const merged = mergeFrontmatterDelta(
      { set: { a: 1 }, unset: ['x'] },
      { set: { b: 2 }, unset: ['y'] },
    );
    expect(merged.set).toEqual({ a: 1, b: 2 });
    expect(merged.unset.sort()).toEqual(['x', 'y']);
  });

  it('end-to-end: applying the merged delta equals applying b after a', () => {
    const base = { a: 1, b: 2, keep: 'me' };
    const d1: FrontmatterDelta = { set: { a: 10 }, unset: ['b'] };
    const d2: FrontmatterDelta = { set: { b: 20, c: 30 }, unset: [] };
    const sequential = applyFrontmatterDelta(applyFrontmatterDelta(base, d1), d2);
    const merged = applyFrontmatterDelta(base, mergeFrontmatterDelta(d1, d2));
    expect(merged).toEqual(sequential);
    expect(merged).toEqual({ a: 10, b: 20, c: 30, keep: 'me' });
  });
});

describe('frontmatterDelta — isEmpty / empty', () => {
  it('a delta with no set and no unset is empty', () => {
    expect(isEmptyFrontmatterDelta({ set: {}, unset: [] })).toBe(true);
  });
  it('any set or unset is non-empty', () => {
    expect(isEmptyFrontmatterDelta({ set: { a: 1 }, unset: [] })).toBe(false);
    expect(isEmptyFrontmatterDelta({ set: {}, unset: ['a'] })).toBe(false);
  });
});
