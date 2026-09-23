import { describe, it, expect } from 'vitest';
import {
  type FrontmatterDelta,
  emptyFrontmatterDelta,
  isEmptyFrontmatterDelta,
  patchToFrontmatterDelta,
  diffToFrontmatterDelta,
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
    expect(applyFrontmatterDelta(base, emptyFrontmatterDelta())).toEqual(base);
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

describe('frontmatterDelta — diffToFrontmatterDelta (Properties popup)', () => {
  it('captures only the keys that changed between two full objects', () => {
    const before = { priority: 'high', status: 'todo', title: 'T' };
    const after = { priority: 'low', status: 'todo', title: 'T' };
    const delta = diffToFrontmatterDelta(before, after);
    expect(delta.set).toEqual({ priority: 'low' });
    expect(delta.unset).toEqual([]);
  });

  it('a removed/cleared row becomes an unset', () => {
    const delta = diffToFrontmatterDelta({ priority: 'high', note: 'x' }, { priority: 'high' });
    expect(delta.set).toEqual({});
    expect(delta.unset).toEqual(['note']);
  });

  it('a brand-new row becomes a set', () => {
    const delta = diffToFrontmatterDelta({ a: 1 }, { a: 1, b: 2 });
    expect(delta.set).toEqual({ b: 2 });
    expect(delta.unset).toEqual([]);
  });

  it('an external key in NEITHER snapshot is absent from the delta (preserved by the write)', () => {
    // The popup opened with {priority: high}; an external editor later added
    // `reviewed: true` to disk. The popup edits priority only; `reviewed` is in
    // neither before nor after, so it never enters the delta and the gateway
    // sources it from fresh disk.
    const before = { priority: 'high' };
    const after = { priority: 'low' };
    const delta = diffToFrontmatterDelta(before, after);
    expect(Object.keys(delta.set)).toEqual(['priority']);
    expect(delta.unset).toEqual([]);
    // Applying it to a disk object that carries the external key keeps it.
    expect(applyFrontmatterDelta({ priority: 'high', reviewed: true }, delta)).toEqual({
      priority: 'low',
      reviewed: true,
    });
  });

  it('an unchanged array (same order) produces no delta entry', () => {
    const delta = diffToFrontmatterDelta({ tags: ['a', 'b'] }, { tags: ['a', 'b'] });
    expect(isEmptyFrontmatterDelta(delta)).toBe(true);
  });

  it('a reordered array IS treated as a user edit', () => {
    const delta = diffToFrontmatterDelta({ tags: ['a', 'b'] }, { tags: ['b', 'a'] });
    expect(delta.set).toEqual({ tags: ['b', 'a'] });
  });

  it('a key empty in both snapshots is a no-op', () => {
    const delta = diffToFrontmatterDelta({ aliases: null }, { aliases: '' });
    expect(isEmptyFrontmatterDelta(delta)).toBe(true);
  });
});

describe('frontmatterDelta — isEmpty / empty', () => {
  it('emptyFrontmatterDelta is empty', () => {
    expect(isEmptyFrontmatterDelta(emptyFrontmatterDelta())).toBe(true);
  });
  it('any set or unset is non-empty', () => {
    expect(isEmptyFrontmatterDelta({ set: { a: 1 }, unset: [] })).toBe(false);
    expect(isEmptyFrontmatterDelta({ set: {}, unset: ['a'] })).toBe(false);
  });
});
