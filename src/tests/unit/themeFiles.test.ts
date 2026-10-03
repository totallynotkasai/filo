import { describe, it, expect } from 'vitest';
import {
  buildThemeFile,
  cleanThemeVariables,
  copyName,
  freeThemeName,
  loadedTheme,
  parseImportedTheme,
  readThemeFile,
  themeIdFromName,
  themeNameProblem,
} from '@renderer/lib/themes/themeFiles';
import { applyCustomTheme, __resetThemeManagerForTests } from '@renderer/lib/themes/themeManager';

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

  it('drops a value that names no colour or shadow of its own, and a non-colour on a colour token', () => {
    const vars = cleanThemeVariables({
      '--ui-bg': 'currentColor',
      '--ui-surface': 'inherit',
      '--menu-bg': 'var(--ui-surface)',
      '--accent-primary': 'color-mix(in srgb, var(--accent-info) 20%, transparent)',
      '--text-primary': '12px',
      '--ui-border': 'transparent',
      '--ui-shadow': '0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08)',
      '--ui-shadow-lg': 'unset',
      '--toolbar-shadow': 'var(--ui-shadow)',
    });
    expect(vars).toEqual({
      '--ui-border': 'transparent',
      '--ui-shadow': '0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08)',
    });
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

/**
 * A theme may set only theme tokens. A theme file (imported, or synced into
 * `.filo/themes/`) that sets any other variable could put every dialog behind
 * the app (`--z-modal`) or change the user's settings.
 */
describe('theme files set only theme tokens', () => {
  const HOSTILE = {
    name: 'Hostile',
    base: 'dark',
    variables: { '--ui-bg': '#101010', '--z-modal': '-1', '--z-dropdown': '-1', '--tile-min-width': '1px' },
  };

  it('an import keeps the colours and drops the rest', () => {
    const result = parseImportedTheme(JSON.stringify(HOSTILE));
    expect(result.ok && result.variables).toEqual({ '--ui-bg': '#101010' });
  });

  it('a file read from .filo/themes/ goes through the same filter', () => {
    const read = readThemeFile('hostile', HOSTILE);
    expect(read.ok && read.file.variables).toEqual({ '--ui-bg': '#101010' });
  });

  it('applying a theme that still carries one never sets it, so the dialog stays on top', () => {
    const root = document.documentElement;
    __resetThemeManagerForTests();
    root.style.removeProperty('--z-modal');
    applyCustomTheme({ id: 'hostile', name: 'Hostile', base: 'dark', variables: HOSTILE.variables });
    expect(root.style.getPropertyValue('--z-modal')).toBe('');
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#101010');
    __resetThemeManagerForTests();
  });

  it('applying a theme never paints a value no token can hold, so the base theme\'s colour shows', () => {
    const root = document.documentElement;
    __resetThemeManagerForTests();
    applyCustomTheme({
      id: 'odd',
      name: 'Odd',
      base: 'dark',
      variables: { '--ui-bg': 'currentColor', '--text-primary': 'inherit', '--ui-border': '#123456' },
    });
    expect(root.style.getPropertyValue('--ui-bg')).toBe('');
    expect(root.style.getPropertyValue('--text-primary')).toBe('');
    expect(root.style.getPropertyValue('--ui-border')).toBe('#123456');
    __resetThemeManagerForTests();
  });
});

/** A theme file's `base` is cosmetic: a bad one falls back to Light, never refuses. */
describe('readThemeFile', () => {
  it('reads a theme, taking the id from the file name', () => {
    expect(readThemeFile('sea', { name: 'Sea', base: 'blueprint', variables: { '--ui-bg': '#001122' } })).toEqual({
      ok: true,
      file: { id: 'sea', name: 'Sea', base: 'blueprint', variables: { '--ui-bg': '#001122' } },
      problem: null,
    });
  });

  it('an unknown base becomes Light, with a note naming it', () => {
    const read = readThemeFile('odd', { name: 'Odd', base: 'solarized', variables: {} });
    expect(read.ok && read.file.base).toBe('light');
    expect(read.ok && read.problem).toMatch(/"Odd" is based on "solarized"/);
  });

  it('no base means dark, and no name means the id', () => {
    const read = readThemeFile('plain', { variables: {} });
    expect(read.ok && read.file).toEqual({ id: 'plain', name: 'plain', base: 'dark', variables: {} });
  });

  it('refuses a file that isn\'t a theme', () => {
    expect(readThemeFile('x', { colours: {} })).toEqual({ ok: false });
    expect(readThemeFile('x', 'text')).toEqual({ ok: false });
  });

  it('loadedTheme reads theme:load answers: missing, invalid JSON, or a file', () => {
    expect(loadedTheme('x', null)).toBeNull();
    expect(loadedTheme('x', { ok: false, code: 'invalid-json' })).toBe('invalid');
    expect(loadedTheme('x', { nope: true })).toBe('invalid');
    expect(loadedTheme('x', { name: 'X', variables: {} })).toEqual({
      file: { id: 'x', name: 'X', base: 'dark', variables: {} },
      problem: null,
    });
  });

  it('an import with an unknown base opens over Light too', () => {
    const result = parseImportedTheme(JSON.stringify({ name: 'Odd', base: 'solarized', variables: { '--ui-bg': '#000000' } }));
    expect(result.ok && result.base).toBe('light');
  });
});
