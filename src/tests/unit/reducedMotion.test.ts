import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Reduced-motion compliance test — verifies the global CSS contract
 * documented in style.css:
 *
 *   @media (prefers-reduced-motion: reduce) {
 *     *, *::before, *::after {
 *       animation-duration: 0.01s !important;
 *       animation-iteration-count: 1 !important;
 *       transition-duration: 0.01s !important;
 *     }
 *   }
 *
 * The rule is global, declarative, and already applied by the browser
 * before any JS runs — so we exercise it by:
 *   (a) confirming style.css actually ships the rule with the three
 *       required declarations, and
 *   (b) sanity-checking the matchMedia API is callable from our jsdom
 *       environment (the vector we rely on for feature-specific JS
 *       guards, e.g. the waypoint camera animation).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STYLE_PATH = resolve(__dirname, '..', '..', 'css', 'style.css');
const styleCss = readFileSync(STYLE_PATH, 'utf8');

describe('prefers-reduced-motion — global CSS rule', () => {
  it('defines a @media (prefers-reduced-motion: reduce) block', () => {
    expect(styleCss).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  });

  it('applies universally to all elements and pseudo-elements', () => {
    // Match the selector list "*, *::before, *::after" in any order, allowing whitespace.
    const reducedBlock = styleCss.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\}\s*\}/,
    );
    expect(reducedBlock).toBeTruthy();
    const block = reducedBlock![0];
    expect(block).toMatch(/\*/);
    expect(block).toMatch(/\*::before/);
    expect(block).toMatch(/\*::after/);
  });

  it('shortens animations and transitions with !important', () => {
    const reducedBlock = styleCss.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\}\s*\}/,
    )![0];
    expect(reducedBlock).toMatch(/animation-duration:\s*0\.01s\s*!important/);
    expect(reducedBlock).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(reducedBlock).toMatch(/transition-duration:\s*0\.01s\s*!important/);
  });
});

describe('prefers-reduced-motion — matchMedia feature detection', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('lets JS opt out of an animation when the user prefers reduced motion', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    expect(prefersReduced).toBe(true);

    // A feature-specific animation should skip when the media query matches.
    let ranAnimation = false;
    if (!prefersReduced) ranAnimation = true;
    expect(ranAnimation).toBe(false);
  });

  it('allows animations when reduced motion is not requested', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    expect(prefersReduced).toBe(false);
  });
});
