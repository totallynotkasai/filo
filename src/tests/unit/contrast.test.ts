import { describe, it, expect } from 'vitest';
import {
  parseHex,
  rgbToHex,
  isValidHex,
  rgbToHsl,
  hslToRgb,
  relativeLuminance,
  contrastRatio,
  getDynamicContrastText,
  resolveBackgroundColor,
  contrastShade,
} from '@renderer/lib/utils/color';

describe('Hex parsing', () => {
  it('parses #rrggbb', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
  });

  it('parses #rgb shorthand by doubling each digit', () => {
    expect(parseHex('#f80')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('handles missing hash', () => {
    expect(parseHex('ff8000')).toEqual({ r: 255, g: 128, b: 0 });
  });

  it('returns null on invalid input', () => {
    expect(parseHex('nope')).toBeNull();
    expect(parseHex('#zzzzzz')).toBeNull();
    expect(parseHex('#1234')).toBeNull();
  });

  it('round-trips rgb → hex → rgb', () => {
    const rgb = { r: 17, g: 34, b: 51 };
    expect(parseHex(rgbToHex(rgb))).toEqual(rgb);
  });

  it('isValidHex matches both forms', () => {
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('#aabbcc')).toBe(true);
    expect(isValidHex('aabbcc')).toBe(false);
    expect(isValidHex('#abcdez')).toBe(false);
  });
});

describe('HSL conversion', () => {
  it('round-trips primary colours', () => {
    for (const rgb of [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 128, g: 128, b: 128 },
    ]) {
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it('places red at hue 0', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 }).h).toBeCloseTo(0, 1);
  });

  it('places green at hue 120', () => {
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBeCloseTo(120, 1);
  });
});

describe('WCAG 2.1 relative luminance + contrast', () => {
  it('black has luminance 0', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('white has luminance 1', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('mid grey lands near 0.21 (sRGB linearisation)', () => {
    // #808080 is the canonical mid grey; its WCAG luminance is well-known
    // to be ~0.2159.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });

  it('contrast ratio between black and white is 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('contrast ratio of identical colours is 1', () => {
    expect(contrastRatio('#abcdef', '#abcdef')).toBeCloseTo(1, 5);
  });

  it('AA-passing accent: blueprint accent #54b0f8 vs dark bg #1a3550 ≥ 4.5? No (cosmetic example)', () => {
    // Sanity: just verify the helper returns a finite ratio in expected
    // range for arbitrary theme colours.
    const r = contrastRatio('#54b0f8', '#1a3550');
    expect(r).toBeGreaterThan(1);
    expect(r).toBeLessThan(21);
  });
});

describe('getDynamicContrastText', () => {
  it('chooses white text on a near-black background', () => {
    expect(getDynamicContrastText('#000000')).toBe('#ffffff');
    expect(getDynamicContrastText('#222222')).toBe('#ffffff');
  });

  it('chooses black text on a near-white background', () => {
    expect(getDynamicContrastText('#ffffff')).toBe('#000000');
    expect(getDynamicContrastText('#eeeeee')).toBe('#000000');
  });

  it('flips at the 0.179 luminance crossover', () => {
    // mid grey ~0.2159 → above threshold → black text
    expect(getDynamicContrastText('#808080')).toBe('#000000');
    // dark navy luminance well below 0.179 → white text
    expect(getDynamicContrastText('#1a3550')).toBe('#ffffff');
  });

  it('falls back to white text when given garbage (luminance 0)', () => {
    expect(getDynamicContrastText('not a colour')).toBe('#ffffff');
  });
});

describe('resolveBackgroundColor', () => {
  it('returns the explicit hex when valid', () => {
    expect(resolveBackgroundColor('#abcdef', '--anything')).toBe('#abcdef');
  });

  it('returns the supplied fallback when the explicit value is invalid AND no DOM lookup matches', () => {
    expect(resolveBackgroundColor('', '--definitely-undefined-var', '#123456')).toBe('#123456');
  });

  it('uses the default fallback grey when no explicit override and no CSS var resolves', () => {
    expect(resolveBackgroundColor('', '--definitely-undefined-var')).toBe('#888888');
  });
});

describe('contrastShade', () => {
  it('darkens a light colour and lightens a dark one, keeping the hue', () => {
    const light = contrastShade('#f0f0f4');
    const dark = contrastShade('#232338');
    expect(relativeLuminance(light)).toBeLessThan(relativeLuminance('#f0f0f4'));
    expect(relativeLuminance(dark)).toBeGreaterThan(relativeLuminance('#232338'));
    expect(Math.round(rgbToHsl(parseHex(dark)!).h)).toBe(Math.round(rgbToHsl(parseHex('#232338')!).h));
  });

  it('stays close to the original, so the surface reads as part of it', () => {
    expect(contrastRatio(contrastShade('#1f3f64'), '#1f3f64')).toBeLessThan(1.5);
  });

  it('pairs with a stroke that reads on it for every built-in canvas colour', () => {
    for (const bg of ['#232338', '#f0f0f4', '#1f3f64', '#463c30', '#364e30']) {
      const fill = contrastShade(bg);
      expect(contrastRatio(getDynamicContrastText(fill), fill)).toBeGreaterThan(4.5);
    }
  });

  it('falls back when the input is not a hex colour', () => {
    expect(contrastShade('var(--x)', 0.06, '#000000')).toBe(rgbToHex(hslToRgb({ h: 0, s: 0, l: 0.06 })));
  });
});
