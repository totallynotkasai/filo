import { describe, it, expect } from 'vitest';
import {
  detectType,
  valueForRow,
  isRepresentable,
} from '@renderer/lib/utils/propertyRowTypes';

/**
 * 1.2 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — the Properties popup classified
 * any `YYYY-MM-DD…` string as a `date` row and `valueForRow` sliced it to its
 * first 10 chars, so a datetime frontmatter value (`created: 2025-01-15T10:30:00Z`)
 * lost its time + timezone on the next write. The fix: only a PURE `YYYY-MM-DD`
 * value is a `date`; a datetime stays `text` and round-trips verbatim.
 */
describe('propertyRowTypes.detectType — date vs datetime (1.2)', () => {
  it('classifies a pure YYYY-MM-DD value as date', () => {
    expect(detectType('due', '2025-01-15')).toBe('date');
  });

  it('does NOT classify a datetime (T / time / timezone) as date', () => {
    expect(detectType('created', '2025-01-15T10:30:00Z')).toBe('text');
    expect(detectType('created', '2025-01-15T10:30:00')).toBe('text');
    expect(detectType('created', '2025-01-15T10:30:00+09:00')).toBe('text');
  });

  it('keeps the existing non-date classifications', () => {
    expect(detectType('tags', ['a', 'b'])).toBe('tag');
    expect(detectType('status', 'blocked')).toBe('status');
    expect(detectType('done', true)).toBe('boolean');
    expect(detectType('count', 3)).toBe('number');
    expect(detectType('items', ['x'])).toBe('list');
    expect(detectType('note', 'hello')).toBe('text');
  });
});

describe('propertyRowTypes.valueForRow — datetime round-trips unchanged (1.2)', () => {
  it('a full datetime value is preserved verbatim (not sliced to 10 chars)', () => {
    const value = '2025-01-15T10:30:00Z';
    const type = detectType('created', value);
    expect(type).toBe('text');
    expect(valueForRow(value, type)).toBe(value);
  });

  it('a pure date value still coerces to YYYY-MM-DD for the date input', () => {
    expect(valueForRow('2025-01-15', 'date')).toBe('2025-01-15');
  });
});

/**
 * Audit-10 B1 — the popup coerced every value through `String()` for the typed
 * rows, so a nested object became `"[object Object]"` and a numeric/boolean
 * array became strings. On ANY popup edit + save those corrupted, UNTOUCHED keys
 * entered the write delta and overwrote good data. The `raw` row holds such
 * values verbatim (read-only), so they round-trip and stay out of the delta.
 */
describe('propertyRowTypes.isRepresentable (B1)', () => {
  it('primitives and null are representable', () => {
    expect(isRepresentable('x')).toBe(true);
    expect(isRepresentable(3)).toBe(true);
    expect(isRepresentable(true)).toBe(true);
    expect(isRepresentable(null)).toBe(true);
  });

  it('a string-only array (incl. empty) is representable', () => {
    expect(isRepresentable(['a', 'b'])).toBe(true);
    expect(isRepresentable([])).toBe(true);
  });

  it('a numeric / boolean / mixed array is NOT representable', () => {
    expect(isRepresentable([2024, 2025])).toBe(false);
    expect(isRepresentable([true, false])).toBe(false);
    expect(isRepresentable(['a', 1])).toBe(false);
  });

  it('a nested object (or array of objects) is NOT representable', () => {
    expect(isRepresentable({ lat: 1 })).toBe(false);
    expect(isRepresentable([{ a: 1 }])).toBe(false);
  });
});

describe('propertyRowTypes.detectType — raw classification (B1)', () => {
  it('classifies a nested object as raw', () => {
    expect(detectType('coordinates', { lat: 1, lng: 2 })).toBe('raw');
  });

  it('classifies a numeric array as raw (NOT list)', () => {
    expect(detectType('years', [2024, 2025])).toBe('raw');
  });

  it('classifies a boolean array as raw', () => {
    expect(detectType('flags', [true, false])).toBe('raw');
  });

  it('a non-string-only tags array is raw, not tag', () => {
    expect(detectType('tags', [1, 2])).toBe('raw');
  });

  it('a string-only tags array is still tag', () => {
    expect(detectType('tags', ['a', 'b'])).toBe('tag');
  });

  it('a string list is still list', () => {
    expect(detectType('items', ['x', 'y'])).toBe('list');
  });
});

describe('propertyRowTypes.valueForRow — raw round-trips verbatim (B1)', () => {
  it('a nested object is returned untouched (no String() coercion)', () => {
    const value = { lat: 5, lng: 6 };
    expect(valueForRow(value, 'raw')).toBe(value); // same reference, untouched
    expect(valueForRow(value, 'raw')).toEqual({ lat: 5, lng: 6 });
  });

  it('a numeric array is returned untouched (numbers, not stringified)', () => {
    expect(valueForRow([2024, 2025], 'raw')).toEqual([2024, 2025]);
  });

  it('regression baseline: the OLD text path String()-coerces an object', () => {
    // Documents WHY `raw` exists — the default branch is lossy for objects.
    expect(valueForRow({ lat: 1 }, 'text')).toBe('[object Object]');
  });
});
