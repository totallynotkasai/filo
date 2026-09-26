import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyBuiltinTheme,
  applyCustomTheme,
  __resetThemeManagerForTests,
  listBuiltinThemes,
  type ThemeFile,
} from '@renderer/lib/themes/themeManager';

describe('themeManager', () => {
  beforeEach(() => {
    // Wipe any previously applied custom-theme variables and reset the
    // data-theme attribute so each test starts from a clean slate.
    __resetThemeManagerForTests();
    document.documentElement.removeAttribute('data-theme');
  });

  describe('listBuiltinThemes', () => {
    it('exposes the five canonical built-in themes', () => {
      expect(listBuiltinThemes()).toEqual([
        'light',
        'dark',
        'blueprint',
        'retro',
        'nature',
      ]);
    });
  });

  describe('applyBuiltinTheme', () => {
    it('sets data-theme on <html>', () => {
      applyBuiltinTheme('blueprint');
      expect(document.documentElement.getAttribute('data-theme')).toBe('blueprint');
    });

    it('throws on an unknown built-in theme name', () => {
      expect(() =>
        applyBuiltinTheme('not-a-theme' as Parameters<typeof applyBuiltinTheme>[0]),
      ).toThrow();
    });

    it('clears any inline custom-theme variables that were previously applied', () => {
      const custom: ThemeFile = {
        id: 'test',
        name: 'Test',
        base: 'dark',
        variables: { '--ui-bg': '#ff00ff', '--accent-primary': '#00ffff' },
      };
      applyCustomTheme(custom);
      expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('#ff00ff');

      applyBuiltinTheme('light');
      expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('');
      expect(document.documentElement.style.getPropertyValue('--accent-primary').trim()).toBe('');
    });
  });

  describe('applyCustomTheme', () => {
    it('writes each variable inline on :root', () => {
      const theme: ThemeFile = {
        id: 'sunset',
        name: 'Sunset',
        base: 'dark',
        variables: {
          '--ui-bg': '#ff6600',
          '--text-primary': '#ffffff',
        },
      };
      applyCustomTheme(theme);
      expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('#ff6600');
      expect(document.documentElement.style.getPropertyValue('--text-primary').trim()).toBe('#ffffff');
    });

    it('sets the base data-theme so unset variables fall back to the built-in cascade', () => {
      const theme: ThemeFile = {
        id: 'sunset',
        name: 'Sunset',
        base: 'light',
        variables: { '--ui-bg': '#ff6600' },
      };
      applyCustomTheme(theme);
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('defaults base to dark when omitted', () => {
      applyCustomTheme({
        id: 't',
        name: 'T',
        variables: { '--ui-bg': '#000' },
      });
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('rejects entries that do not look like CSS custom properties', () => {
      applyCustomTheme({
        id: 't',
        name: 'T',
        variables: {
          '--legit': '#abc',
          'not-a-var': 'leaked',
        },
      });
      expect(document.documentElement.style.getPropertyValue('--legit').trim()).toBe('#abc');
      // Should not have set anything for the bogus key.
      expect(document.documentElement.style.getPropertyValue('not-a-var').trim()).toBe('');
    });

    it('clears stale custom variables when switching between custom themes', () => {
      applyCustomTheme({
        id: 'a',
        name: 'A',
        variables: { '--accent-primary': '#aaaaaa', '--ui-bg': '#bbbbbb' },
      });
      applyCustomTheme({
        id: 'b',
        name: 'B',
        variables: { '--ui-bg': '#cccccc' },
      });
      expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('#cccccc');
      // The accent from theme A must NOT leak into theme B.
      expect(document.documentElement.style.getPropertyValue('--accent-primary').trim()).toBe('');
    });

    it('throws if the base is not a known built-in theme', () => {
      expect(() =>
        applyCustomTheme({
          id: 't',
          name: 'T',
          base: 'martian' as ThemeFile['base'],
          variables: {},
        }),
      ).toThrow();
    });
  });

});
