import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { themeStore } from '@renderer/stores/theme.svelte';
import { __resetThemeManagerForTests, type ThemeFile } from '@renderer/lib/themes/themeManager';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * The theme catalogue follows the files: a theme another program changed is
 * read again (the cache used to keep the first copy for the session), and one
 * deleted elsewhere leaves the cache. "System colours only" keeps boards on
 * their theme only once a theme was painted that way.
 */
const theme = (id: string, bg: string): ThemeFile => ({ id, name: id, base: 'dark', variables: { '--ui-bg': bg } });

beforeEach(() => {
  restoreFiloDefault();
  __resetThemeManagerForTests();
  themeStore.clear();
});
afterEach(() => {
  restoreFiloDefault();
  __resetThemeManagerForTests();
  themeStore.clear();
});

describe('themeStore.refreshAvailable', () => {
  it('reads a changed theme again when asked, and keeps the others cached', async () => {
    const disk: Record<string, ThemeFile> = { sea: theme('sea', '#000011'), sky: theme('sky', '#000022') };
    const loads: string[] = [];
    installFiloMock({
      'theme:list': async () => Object.keys(disk).map((id) => `${id}.json`),
      'theme:load': async (_root: unknown, id: unknown) => {
        loads.push(String(id));
        return disk[String(id)] ?? null;
      },
    });
    await themeStore.refreshAvailable('/vault');
    expect(themeStore.cache.sea?.variables['--ui-bg']).toBe('#000011');

    disk.sea = theme('sea', '#ff0000');
    loads.length = 0;
    await themeStore.refreshAvailable('/vault', ['sea']);
    expect(loads).toEqual(['sea']);
    expect(themeStore.cache.sea?.variables['--ui-bg']).toBe('#ff0000');
    expect(themeStore.cache.sky?.variables['--ui-bg']).toBe('#000022');
  });

  it('drops a theme whose file is gone', async () => {
    const disk: Record<string, ThemeFile> = { sea: theme('sea', '#000011') };
    installFiloMock({
      'theme:list': async () => Object.keys(disk).map((id) => `${id}.json`),
      'theme:load': async (_root: unknown, id: unknown) => disk[String(id)] ?? null,
    });
    await themeStore.refreshAvailable('/vault');
    delete disk.sea;
    await themeStore.refreshAvailable('/vault');
    expect(themeStore.available).toEqual([]);
    expect(themeStore.cache.sea).toBeUndefined();
  });
});

describe('themeStore.boardTheme', () => {
  it('is set only once a theme was painted with "System colours only" on, and cleared by a full paint', async () => {
    await themeStore.applyById('/vault', 'light');
    themeStore.setSystemOnly(true);
    expect(themeStore.boardTheme).toBeNull();

    await themeStore.applyById('/vault', 'dark');
    expect(themeStore.boardTheme).toBe('light');

    themeStore.setSystemOnly(false);
    await themeStore.applyById('/vault', 'retro');
    expect(themeStore.boardTheme).toBeNull();
  });

  it('a preview paints the whole app', async () => {
    themeStore.setSystemOnly(true);
    await themeStore.applyById('/vault', 'dark');
    themeStore.preview(theme('draft', '#010101'));
    expect(themeStore.boardTheme).toBeNull();
  });
});
