import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asSafeThemeValue } from '@shared/untrusted';
import { isThemeTokenValue } from '@renderer/lib/themes/themeValues';

/**
 * What a theme token may hold, as every caller asks it: the sanitiser first,
 * then `isThemeTokenValue`. Chromium reads `currentColor`, `inherit` and
 * `var()` as colours, but on `:root` they leave a token with no value or paint
 * it with the text colour, so a theme never holds one. Every case runs with
 * `CSS.supports` (the renderer, and jsdom) and without it (the fallback).
 */
function holds(token: string, raw: string): boolean {
  const safe = asSafeThemeValue(raw);
  return safe !== null && isThemeTokenValue(token, safe);
}

const COLOUR_TOKEN = '--ui-bg';
const SHADOW_TOKEN = '--ui-shadow';

const KEYWORDS = ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentColor', 'CURRENTCOLOR', 'Inherit'];

const BORROWED = [
  'var(--accent-primary)',
  'rgb(var(--accent-rgb))',
  'color-mix(in srgb, var(--accent-primary) 20%, transparent)',
  'env(safe-area-inset-top)',
  'attr(data-colour type(<color>))',
  'inherit(--accent-primary)',
];

describe.each([
  { name: 'with CSS.supports', removed: false },
  { name: 'without CSS.supports', removed: true },
])('a theme token\'s value ($name)', ({ removed }) => {
  beforeEach(() => {
    if (removed) vi.stubGlobal('CSS', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a colour token holds hex, keywords, rgb() and the other colour functions', () => {
    for (const value of ['#fff', '#1a2b3c80', 'transparent', 'rebeccapurple', 'rgba(0,0,0,0.5)', 'oklch(0.7 0.1 200)', 'color-mix(in srgb, red 20%, transparent)']) {
      expect(holds(COLOUR_TOKEN, value), value).toBe(true);
    }
  });

  it('no token holds a CSS-wide keyword or currentColor, in any case', () => {
    for (const value of KEYWORDS) {
      expect(holds(COLOUR_TOKEN, value), value).toBe(false);
      expect(holds(SHADOW_TOKEN, value), value).toBe(false);
    }
  });

  it('no token holds a value borrowed from elsewhere, var() inside a colour function included', () => {
    for (const value of BORROWED) {
      expect(holds(COLOUR_TOKEN, value), value).toBe(false);
      expect(holds(SHADOW_TOKEN, value), value).toBe(false);
    }
    expect(holds(SHADOW_TOKEN, '0 1px 2px var(--shadow-colour)')).toBe(false);
  });

  it('a colour token refuses a size or a shadow; a shadow token holds a shadow', () => {
    expect(holds(COLOUR_TOKEN, '12px')).toBe(false);
    expect(holds(COLOUR_TOKEN, '0 1px 2px rgba(0,0,0,0.2)')).toBe(false);
    for (const value of ['0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08)', 'inset 0 0 0 1px #000', 'none']) {
      expect(holds(SHADOW_TOKEN, value), value).toBe(true);
    }
  });
});
