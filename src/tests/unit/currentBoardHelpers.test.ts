/**
 * The Current Board settings panels' field helpers: a dotted path reads a
 * nested value (missing on any level reads as unset), and a select's
 * true / false / blank maps to an override or to "inherit".
 */
import { describe, it, expect } from 'vitest';
import { formatBoolean, parseBoolean, readPath } from '@renderer/lib/settings/currentBoardHelpers';

describe('readPath', () => {
  const settings = { defaults: { tile: { fontSize: 14, bold: false } }, snapToGrid: true };

  it('reads a nested value, falsy ones included', () => {
    expect(readPath(settings, 'defaults.tile.fontSize')).toBe(14);
    expect(readPath(settings, 'defaults.tile.bold')).toBe(false);
    expect(readPath(settings, 'snapToGrid')).toBe(true);
  });

  it('a missing level, or no settings at all, reads as unset', () => {
    expect(readPath(settings, 'defaults.frame.fontSize')).toBeUndefined();
    expect(readPath(settings, 'defaults.tile.fontSize.px')).toBeUndefined();
    expect(readPath(undefined, 'defaults.tile')).toBeUndefined();
    expect(readPath({ defaults: null }, 'defaults.tile')).toBeUndefined();
  });
});

describe('formatBoolean / parseBoolean', () => {
  it('round-trips an override', () => {
    expect(parseBoolean(formatBoolean(true))).toBe(true);
    expect(parseBoolean(formatBoolean(false))).toBe(false);
  });

  it('blank means inherit, both ways', () => {
    expect(formatBoolean(undefined)).toBe('');
    expect(formatBoolean('true')).toBe('');
    expect(parseBoolean('')).toBeUndefined();
    expect(parseBoolean('yes')).toBeUndefined();
  });
});
