import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isCssColour } from '@renderer/lib/utils/color';

/**
 * `isCssColour` asks the browser's own parser (`CSS.supports('color', …)`)
 * where there is one, and falls back to its own patterns where there is none.
 * The renderer and jsdom both have one, so the fallback runs only with
 * `CSS.supports` removed. Every case runs both ways; with `CSS.supports`, each
 * expected answer is also what Electron's Chromium gives, so jsdom answering
 * otherwise fails here.
 */

const COLOURS = [
  '#fff', '#FFF', '#1a2b3c', '#1a2b3c80', ' red ',
  'red', 'transparent', 'currentColor', 'rebeccapurple', 'inherit',
  'rgb(255, 0, 0)', 'rgba(0,0,0,0.5)', 'rgb(255 0 0 / 50%)',
  'hsl(0, 100%, 50%)', 'hsla(0, 100%, 50%, 0.5)', 'hwb(0 0% 0%)',
  'lab(50% 40 59)', 'lch(50% 80 30)', 'oklab(0.6 0.1 0.1)', 'oklch(0.7 0.1 200)',
  'color(srgb 1 0 0)', 'color-mix(in srgb, red, blue)',
];

const NOT_COLOURS = [
  '', '   ', '#12', '#ggg', '#1234567', 'rgb(1,2)',
  'url(https://evil.example/x)', '1rem', 'red blue',
];

/** A colour to the browser's parser, which the fallback's patterns don't read. */
const COLOUR_ONLY_TO_THE_PARSER = ['var(--accent-primary)'];

/** Not a colour to the browser's parser, which the fallback's patterns let through. */
const COLOUR_ONLY_TO_THE_FALLBACK = ['notacolour', 'hsl(nonsense)'];

describe.each([
  { name: 'with CSS.supports', removed: false },
  { name: 'without CSS.supports', removed: true },
])('isCssColour ($name)', ({ removed }) => {
  beforeEach(() => {
    if (removed) vi.stubGlobal('CSS', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs where CSS.supports is there exactly when the mode says', () => {
    expect(typeof CSS !== 'undefined' && typeof CSS.supports === 'function').toBe(!removed);
  });

  it('accepts hex, keywords, rgb() and the other colour functions', () => {
    for (const value of COLOURS) expect(isCssColour(value), value).toBe(true);
  });

  it('refuses short or long hex, bad channels, URLs, lengths and two words', () => {
    for (const value of NOT_COLOURS) expect(isCssColour(value), value).toBe(false);
  });

  it('accepts var() only where the browser parser reads it', () => {
    for (const value of COLOUR_ONLY_TO_THE_PARSER) expect(isCssColour(value), value).toBe(!removed);
  });

  it('lets an unknown word or a bad colour function through only in the fallback', () => {
    for (const value of COLOUR_ONLY_TO_THE_FALLBACK) expect(isCssColour(value), value).toBe(removed);
  });
});
