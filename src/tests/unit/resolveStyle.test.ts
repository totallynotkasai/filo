import { describe, it, expect } from 'vitest';
import { resolveField, resolveStyle } from '@renderer/lib/styles/resolveStyle';

describe('resolveStyle cascade (Per-element > Board > Global)', () => {
  describe('resolveField', () => {
    it('returns the per-element value when set', () => {
      const v = resolveField(
        'headerColor',
        { headerColor: '#ff0000' },
        { headerColor: '#00ff00' },
        { headerColor: '#0000ff' },
      );
      expect(v).toBe('#ff0000');
    });

    it('falls through to the board layer when per-element is empty string', () => {
      const v = resolveField(
        'headerColor',
        { headerColor: '' },
        { headerColor: '#00ff00' },
        { headerColor: '#0000ff' },
      );
      expect(v).toBe('#00ff00');
    });

    it('falls through to the board layer when per-element is null', () => {
      const v = resolveField(
        'headerColor',
        { headerColor: null },
        { headerColor: '#00ff00' },
        { headerColor: '#0000ff' },
      );
      expect(v).toBe('#00ff00');
    });

    it('falls through to global when per-element AND board are unset', () => {
      const v = resolveField(
        'headerColor',
        { headerColor: '' },
        { headerColor: '' },
        { headerColor: '#0000ff' },
      );
      expect(v).toBe('#0000ff');
    });

    it('returns undefined when every layer is unset', () => {
      const v = resolveField('headerColor', {}, {}, {});
      expect(v).toBeUndefined();
    });

    it('treats undefined layers safely', () => {
      const v = resolveField('headerColor', undefined, null, { headerColor: '#abc' });
      expect(v).toBe('#abc');
    });

    it('treats `false` as a set value (not falsy-collapsed)', () => {
      const v = resolveField(
        'dynamicContrastText',
        { dynamicContrastText: false },
        { dynamicContrastText: true },
        { dynamicContrastText: true },
      );
      expect(v).toBe(false);
    });

    it('treats `0` as a set value (numeric 0 must not fall through)', () => {
      const v = resolveField(
        'borderWidth',
        { borderWidth: 0 },
        { borderWidth: 2 },
        { borderWidth: 4 },
      );
      expect(v).toBe(0);
    });
  });

  describe('resolveStyle', () => {
    it('unions keys across all three layers', () => {
      const out = resolveStyle(
        { headerColor: '#ff0000' },
        { bodyColor: '#00ff00' },
        { borderColor: '#0000ff', shape: 'rounded' },
      );
      expect(out).toEqual({
        headerColor: '#ff0000',
        bodyColor: '#00ff00',
        borderColor: '#0000ff',
        shape: 'rounded',
      });
    });

    it('omits keys that are unset in every layer', () => {
      const out = resolveStyle(
        { headerColor: '' },
        { headerColor: '' },
        { headerColor: '' },
      );
      expect(out).toEqual({});
    });

    it('per-element wins for shared keys', () => {
      const out = resolveStyle(
        { headerColor: '#ff0000', borderWidth: 3 },
        { headerColor: '#00ff00', borderWidth: 2 },
        { headerColor: '#0000ff', borderWidth: 1 },
      );
      expect(out.headerColor).toBe('#ff0000');
      expect(out.borderWidth).toBe(3);
    });

    it('null layers behave as no-ops', () => {
      const out = resolveStyle(null, null, { headerColor: '#abc' });
      expect(out).toEqual({ headerColor: '#abc' });
    });
  });
});
