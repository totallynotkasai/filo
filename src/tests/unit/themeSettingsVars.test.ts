import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyBuiltinTheme,
  applyCustomTheme,
  snapshotThemeVariables,
  THEME_VAR_NAMES,
  SYSTEM_VAR_NAMES,
  __resetThemeManagerForTests,
  type ThemeFile,
} from '@renderer/lib/themes/themeManager';
import { SETTINGS_VAR_NAMES } from '@renderer/lib/themes/themeTokens';

/**
 * A theme holds colours only. The user's font, size and scales are settings
 * that App.svelte writes onto `:root`; a theme that carried them overrode
 * the settings, and the next switch cleared them back to the stylesheet's
 * (13px Arial Rounded while Settings still showed the user's values).
 */
const root = document.documentElement;

beforeEach(() => {
  __resetThemeManagerForTests();
  root.removeAttribute('data-theme');
  root.removeAttribute('style');
});
afterEach(() => {
  __resetThemeManagerForTests();
  root.removeAttribute('style');
});

describe('theme variables vs settings', () => {
  it('no theme variable is a setting', () => {
    for (const name of SETTINGS_VAR_NAMES) expect(THEME_VAR_NAMES).not.toContain(name);
  });

  it('the system-only set includes the warning banner and save status colours', () => {
    expect(SYSTEM_VAR_NAMES).toEqual(expect.arrayContaining(['--ui-warn-bg', '--ui-warn-text', '--toolbar-save-ok']));
    expect(SYSTEM_VAR_NAMES).not.toContain('--canvas-bg');
  });

  it('an old theme file carrying the font size doesn\'t override the setting, and a switch keeps it', () => {
    root.style.setProperty('--font-size-base', '17px');
    root.style.setProperty('--ui-toolbar-scale', '1.4');
    const old: ThemeFile = {
      id: 'old',
      name: 'Old',
      base: 'dark',
      variables: { '--ui-bg': '#101010', '--font-size-base': '13px', '--ui-toolbar-scale': '1' },
    };
    applyCustomTheme(old);
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#101010');
    expect(root.style.getPropertyValue('--font-size-base')).toBe('17px');
    expect(root.style.getPropertyValue('--ui-toolbar-scale')).toBe('1.4');

    applyBuiltinTheme('light');
    expect(root.style.getPropertyValue('--font-size-base')).toBe('17px');
    expect(root.style.getPropertyValue('--ui-toolbar-scale')).toBe('1.4');
  });
});

describe('snapshotThemeVariables', () => {
  it('captures the applied theme\'s colours and none of the settings', () => {
    root.style.setProperty('--font-size-base', '17px');
    applyCustomTheme({ id: 't', name: 'T', base: 'dark', variables: { '--ui-bg': '#123456', '--accent-primary': '#abcdef' } });
    const snap = snapshotThemeVariables();
    expect(snap['--ui-bg']).toBe('#123456');
    expect(snap['--accent-primary']).toBe('#abcdef');
    expect(snap['--font-size-base']).toBeUndefined();
  });

  it('reads the toolbar colour from under the user\'s toolbar colour setting, and leaves the setting in place', () => {
    applyCustomTheme({ id: 't', name: 'T', base: 'dark', variables: { '--ui-bg': '#123456' } });
    // App.svelte's write of general.toolbarColor, after the theme painted.
    root.style.setProperty('--toolbar-bg', '#ff00ff');
    const snap = snapshotThemeVariables();
    expect(snap['--toolbar-bg']).not.toBe('#ff00ff');
    expect(root.style.getPropertyValue('--toolbar-bg')).toBe('#ff00ff');
  });
});
