import { describe, it, expect } from 'vitest';
import { fmValueEqual } from '@renderer/commands/frontmatterInverse';

/**
 * L8 (Audit-7) — `fmValueEqual` decides whether an external edit changed a
 * frontmatter field out from under an undo/redo. The old `JSON.stringify(a) ===
 * JSON.stringify(b)` comparison was order-sensitive, so an external tool that
 * merely REORDERED an object's keys or an array's items (e.g. an alphabetiser)
 * read as a conflict — the rebase then kept the external value and silently
 * skipped the user's undo for that field. These pin the order-independent
 * contract (and the emptyish / scalar baseline the fix must preserve).
 */
describe('fmValueEqual — emptyish + scalar baseline (unchanged by L8)', () => {
  it('treats absent / empty-string / null / undefined as equal', () => {
    expect(fmValueEqual(undefined, '')).toBe(true);
    expect(fmValueEqual(null, undefined)).toBe(true);
    expect(fmValueEqual('', null)).toBe(true);
  });
  it('separates emptyish from a present value', () => {
    expect(fmValueEqual('', 'x')).toBe(false);
    expect(fmValueEqual(null, 0)).toBe(false);
  });
  it('compares scalars by identity', () => {
    expect(fmValueEqual('a', 'a')).toBe(true);
    expect(fmValueEqual(3, 3)).toBe(true);
    expect(fmValueEqual(true, false)).toBe(false);
    expect(fmValueEqual('a', 'b')).toBe(false);
  });
});

describe('fmValueEqual — L8 order-independent objects', () => {
  it('object key order does not matter', () => {
    expect(fmValueEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it('nested object key order does not matter', () => {
    expect(fmValueEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });
  it('a real object difference is still a conflict', () => {
    expect(fmValueEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(fmValueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false); // extra key
    expect(fmValueEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false); // missing key
  });
});

describe('fmValueEqual — L8 order-independent arrays (multiset)', () => {
  it('a reordered array is equal (the alphabetiser case)', () => {
    expect(fmValueEqual(['x', 'y'], ['y', 'x'])).toBe(true);
    expect(fmValueEqual(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });
  it('a reordered array of objects is equal', () => {
    expect(fmValueEqual([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }])).toBe(true);
  });
  it('duplicates still matter (multiset, not set)', () => {
    expect(fmValueEqual(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(false);
    expect(fmValueEqual(['a', 'a'], ['a'])).toBe(false); // length differs
  });
  it('a genuine element change is still a conflict', () => {
    expect(fmValueEqual(['x', 'y'], ['x', 'z'])).toBe(false);
  });
  it('an array is never equal to a non-array', () => {
    expect(fmValueEqual(['x'], { 0: 'x' })).toBe(false);
    expect(fmValueEqual(['x'], 'x')).toBe(false);
  });
});
