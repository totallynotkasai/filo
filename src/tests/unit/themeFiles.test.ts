import { describe, it, expect } from 'vitest';
import {
  buildThemeFile,
  cleanThemeVariables,
  copyName,
  freeThemeName,
  parseImportedTheme,
  themeIdFromName,
  themeNameProblem,
} from '@renderer/lib/themes/themeFiles';

/**
 * A custom theme's id is its file name. A built-in's name or id would hide
 * the file behind the built-in in the picker, and another theme's id would
 * overwrite it, so both are refused.
 */
describe('themeNameProblem', () => {
  it('refuses the built-in names and ids, however they are spelt', () => {
    for (const name of ['Light', 'light', 'Light Mode', 'LIGHT-MODE', 'dark', 'Dark Mode', 'Blueprint', 'retro', 'Nature']) {
      expect(themeNameProblem(name, []), name).toMatch(/built-in theme/);
    }
  });

  it('refuses another custom theme\'s id, but a theme may keep its own', () => {
    expect(themeNameProblem('Sunset', ['sunset'])).toMatch(/already has this name/);
    expect(themeNameProblem('SUNSET!', ['sunset'])).toMatch(/already has this name/);
    expect(themeNameProblem('Sunset', ['sunset'], 'sunset')).toBeNull();
  });

  it('refuses a blank or over-long name', () => {
    expect(themeNameProblem('   ', [])).toMatch(/name/);
    expect(themeNameProblem('x'.repeat(61), [])).toMatch(/under 60/);
  });

  it('accepts anything else', () => {
    expect(themeNameProblem('Lighthouse', [])).toBeNull();
    expect(themeNameProblem('Dark Forest', [])).toBeNull();
  });
});

describe('free names', () => {
  it('numbers a taken name', () => {
    expect(freeThemeName('My theme', [])).toBe('My theme');
    expect(freeThemeName('My theme', ['my-theme'])).toBe('My theme 2');
    expect(freeThemeName('My theme', ['my-theme', 'my-theme-2'])).toBe('My theme 3');
  });

  it('names a copy, and a copy of a built-in is never refused', () => {
    expect(copyName('Sunset', ['sunset'])).toBe('Sunset copy');
    expect(copyName('Sunset', ['sunset', 'sunset-copy'])).toBe('Sunset copy 2');
    expect(themeNameProblem(copyName('Light Mode', []), [])).toBeNull();
  });
});

describe('theme variables', () => {
  it('keeps colours, drops unsafe values, non-variables and the user\'s settings', () => {
    const vars = cleanThemeVariables({
      '--ui-bg': '#101010',
      '--accent-primary': 'rgba(1, 2, 3, 0.5)',
      '--canvas-bg': 'url(https://evil.example/p)',
      '--font-size-base': '20px',
      '--ui-toolbar-scale': '2',
      color: 'red',
      '--tile-border': 42,
    });
    expect(vars).toEqual({ '--ui-bg': '#101010', '--accent-primary': 'rgba(1, 2, 3, 0.5)' });
  });

  it('a saved theme file takes its id from its name', () => {
    const file = buildThemeFile('  Dark Forest ', 'dark', { '--ui-bg': '#000000', '--font-system': 'Comic Sans' });
    expect(file).toEqual({ id: 'dark-forest', name: 'Dark Forest', base: 'dark', variables: { '--ui-bg': '#000000' } });
    expect(themeIdFromName('!!!')).toBe('theme');
  });
});

describe('parseImportedTheme', () => {
  it('reads a Filo theme file', () => {
    const result = parseImportedTheme(JSON.stringify({ id: 'x', name: 'Ocean', base: 'blueprint', variables: { '--ui-bg': '#001122' } }));
    expect(result).toEqual({ ok: true, name: 'Ocean', base: 'blueprint', variables: { '--ui-bg': '#001122' } });
  });

  it('defaults an unknown or missing base to dark', () => {
    const result = parseImportedTheme(JSON.stringify({ name: 'Ocean', variables: { '--ui-bg': '#001122' } }));
    expect(result.ok && result.base).toBe('dark');
  });

  it('says why a file is refused', () => {
    expect(parseImportedTheme('{nope')).toEqual({ ok: false, message: expect.stringMatching(/valid JSON/) });
    expect(parseImportedTheme('{"variables":{}}')).toEqual({ ok: false, message: expect.stringMatching(/not a Filo theme/) });
    expect(parseImportedTheme('{"name":"X","variables":{"--ui-bg":"url(x)"}}')).toEqual({
      ok: false,
      message: expect.stringMatching(/no colours/),
    });
  });
});
