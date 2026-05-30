import { describe, it, expect } from 'vitest';
import { isAppNavigation } from '../../main/utils/navigationGuard';

/**
 * M4 (2026-05-28) — `isAppNavigation` is the predicate behind main.ts's
 * `will-navigate` guard. A renderer-triggered top-level navigation outside
 * the app's own document must be blocked (returns false → caller
 * preventDefaults); same-document navigations (dev HMR reloads, the packaged
 * index.html) are allowed.
 */
describe('isAppNavigation (M4 navigation guard)', () => {
  describe('dev server (http origin)', () => {
    const appUrl = 'http://localhost:5173/';

    it('allows a same-origin navigation (HMR reload)', () => {
      expect(isAppNavigation('http://localhost:5173/', appUrl)).toBe(true);
      expect(isAppNavigation('http://localhost:5173/index.html', appUrl)).toBe(true);
    });

    it('blocks navigation to a different origin', () => {
      expect(isAppNavigation('https://evil.example.com/', appUrl)).toBe(false);
      expect(isAppNavigation('http://localhost:9999/', appUrl)).toBe(false);
      expect(isAppNavigation('https://localhost:5173/', appUrl)).toBe(false); // scheme differs
    });
  });

  describe('packaged build (file:// origin)', () => {
    const appUrl = 'file:///C:/app/resources/renderer/index.html';

    it('allows a navigation to the same packaged document', () => {
      expect(isAppNavigation('file:///C:/app/resources/renderer/index.html', appUrl)).toBe(true);
    });

    it('blocks navigation to a different file path', () => {
      expect(isAppNavigation('file:///C:/Windows/System32/secret.txt', appUrl)).toBe(false);
      expect(isAppNavigation('file:///C:/app/resources/renderer/other.html', appUrl)).toBe(false);
    });

    it('blocks navigation to a remote origin', () => {
      expect(isAppNavigation('https://evil.example.com/', appUrl)).toBe(false);
    });
  });

  it('fails closed on a malformed target URL', () => {
    expect(isAppNavigation('not a url', 'http://localhost:5173/')).toBe(false);
    expect(isAppNavigation('', 'http://localhost:5173/')).toBe(false);
  });
});
