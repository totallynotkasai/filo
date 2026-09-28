/**
 * The toolbar and tab bar colour settings sit over the active theme. With the
 * setting blank the bar is the theme's: a custom theme that colours its
 * toolbar or tab bar must keep that colour after the settings pass runs (it
 * runs after every theme paint), in "System colours only" too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyBuiltinTheme,
  applyCustomTheme,
  snapshotThemeVariables,
  __resetThemeManagerForTests,
  type ThemeFile,
} from '@renderer/lib/themes/themeManager';
import { applyBarColours } from '@renderer/lib/themes/chromeText';

const root = document.documentElement;

const RED_BARS: ThemeFile = {
  id: 'red-bars',
  name: 'Red bars',
  base: 'dark',
  variables: { '--toolbar-bg': '#cc0000', '--tabbar-bg': '#aa0000', '--ui-bg': '#101010' },
};

function reset(): void {
  __resetThemeManagerForTests();
  root.removeAttribute('data-theme');
  root.removeAttribute('style');
}

beforeEach(reset);
afterEach(reset);

describe('applyBarColours', () => {
  it('a custom theme with a red toolbar and tab bar paints them red when the settings are blank', () => {
    applyCustomTheme(RED_BARS);
    applyBarColours(root, '', '');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#cc0000');
    expect(root.style.getPropertyValue('--tabbar-bg')).toBe('#aa0000');
    // White reads best on that red, so the bars get white text.
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('#ffffff');
    expect(root.style.getPropertyValue('--tabbar-custom-fg')).toBe('#ffffff');
  });

  it('does the same with "System colours only" on', () => {
    applyCustomTheme(RED_BARS, { systemOnly: true });
    applyBarColours(root, '', '');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#cc0000');
    expect(root.style.getPropertyValue('--tabbar-bg')).toBe('#aa0000');
  });

  it('a user colour wins over the theme, and clearing it gives the bar back to the theme', () => {
    applyCustomTheme(RED_BARS);
    applyBarColours(root, '#ffff00', '');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#ffff00');
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('#000000');

    applyBarColours(root, '', '');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#cc0000');
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('#ffffff');
  });

  it('a new theme made while a user colour is set keeps the theme\'s own toolbar', () => {
    applyCustomTheme(RED_BARS);
    applyBarColours(root, '#ffff00', '');
    expect(snapshotThemeVariables()['--toolbar-bg']).toBe('#cc0000');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#ffff00');
  });

  it('a built-in theme\'s bars are left to its stylesheet, with its own text colours', () => {
    applyCustomTheme(RED_BARS);
    applyBuiltinTheme('light');
    applyBarColours(root, '', '');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('');
    expect(root.style.getPropertyValue('--tabbar-bg')).toBe('');
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('');
  });
});
