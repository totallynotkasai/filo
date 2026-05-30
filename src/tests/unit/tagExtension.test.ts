import { describe, it, expect } from 'vitest';
import { isHexColorToken } from '../../renderer/lib/editor/tagExtension';

describe('tagExtension — isHexColorToken (Sprint B / B2)', () => {
  it('rejects 3-digit hex colors', () => {
    expect(isHexColorToken('#fff')).toBe(true);
    expect(isHexColorToken('#abc')).toBe(true);
    expect(isHexColorToken('#FFF')).toBe(true);
    expect(isHexColorToken('#000')).toBe(true);
  });

  it('rejects 6-digit hex colors', () => {
    expect(isHexColorToken('#abcdef')).toBe(true);
    expect(isHexColorToken('#FFFFFF')).toBe(true);
    expect(isHexColorToken('#123456')).toBe(true);
  });

  it('rejects 8-digit hex colors (with alpha)', () => {
    expect(isHexColorToken('#abcdef12')).toBe(true);
    expect(isHexColorToken('#FFFFFFFF')).toBe(true);
  });

  it('accepts normal tags as not hex', () => {
    expect(isHexColorToken('#tag')).toBe(false);
    expect(isHexColorToken('#todo')).toBe(false);
    expect(isHexColorToken('#meeting')).toBe(false);
  });

  it('accepts ambiguous-length tokens as not hex', () => {
    // 4 chars — not a valid hex color length
    expect(isHexColorToken('#abcd')).toBe(false);
    // 5 chars
    expect(isHexColorToken('#abcde')).toBe(false);
    // 7 chars
    expect(isHexColorToken('#abcdef0')).toBe(false);
  });

  it('accepts tags containing non-hex characters', () => {
    // Contains 'g'
    expect(isHexColorToken('#defg')).toBe(false);
    // Contains digits-plus-non-hex letter
    expect(isHexColorToken('#1z3')).toBe(false);
  });

  it('returns false for tokens without leading #', () => {
    expect(isHexColorToken('abc')).toBe(false);
    expect(isHexColorToken('fff')).toBe(false);
  });
});
