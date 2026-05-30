import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { themeStore } from '@renderer/stores/theme.svelte';
import {
  resetThemeManager,
  type ThemeFile,
} from '@renderer/lib/themes/themeManager';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase R4 — `themeStore.applyById` must NEVER throw. A malformed
 * theme falls back to built-in 'light' and resolves to `{ ok: false }`
 * so the caller (openVault commit, settings panel, etc.) can surface
 * the error without leaving DOM state half-applied.
 */

describe('themeStore.applyById — non-throwing contract', () => {
  beforeEach(() => {
    restoreFiloDefault();
    resetThemeManager();
    document.documentElement.removeAttribute('data-theme');
    themeStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    resetThemeManager();
    document.documentElement.removeAttribute('data-theme');
    themeStore.clear();
  });

  it('returns { ok: true } when applying a valid built-in theme', async () => {
    const result = await themeStore.applyById('/vault', 'dark');
    expect(result.ok).toBe(true);
    expect(themeStore.active).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('returns { ok: false } AND falls back to light when theme:load IPC throws', async () => {
    installFiloMock({
      'theme:load': async () => {
        throw new Error('EACCES themes/foo.json');
      },
    });

    const result = await themeStore.applyById('/vault', 'foo');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EACCES/);
    // Fallback rescue: DOM is on a valid theme.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('returns { ok: false } when the custom theme has an unknown base', async () => {
    const badTheme: ThemeFile = {
      id: 'broken',
      name: 'Broken',
      base: 'nonsense' as 'dark',
      variables: {},
    };
    installFiloMock({
      'theme:load': async () => badTheme,
    });

    const result = await themeStore.applyById('/vault', 'broken');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown base/);
    // Rescue applied — DOM ended on built-in light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('returns { ok: false } when the theme file is missing on disk', async () => {
    installFiloMock({
      'theme:load': async () => null,
    });

    const result = await themeStore.applyById('/vault', 'gone');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies a valid custom theme and reports success', async () => {
    const goodTheme: ThemeFile = {
      id: 'aurora',
      name: 'Aurora',
      base: 'dark',
      variables: { '--ui-bg': '#001122' },
    };
    installFiloMock({
      'theme:load': async () => goodTheme,
    });

    const result = await themeStore.applyById('/vault', 'aurora');
    expect(result.ok).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('#001122');
    // The base built-in cascade is set so unset vars fall back.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(themeStore.activeFileId).toBe('aurora');
  });
});

describe('themeStore.commitFromCandidate', () => {
  beforeEach(() => {
    restoreFiloDefault();
    resetThemeManager();
    document.documentElement.removeAttribute('data-theme');
    themeStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    resetThemeManager();
    document.documentElement.removeAttribute('data-theme');
    themeStore.clear();
  });

  it('installs the pre-loaded cache and applies a built-in active theme synchronously', () => {
    const result = themeStore.commitFromCandidate({
      availableIds: ['aurora'],
      themeCache: {
        aurora: { id: 'aurora', name: 'Aurora', base: 'dark', variables: {} },
      },
      activeId: 'blueprint',
      activeFile: null,
    });

    expect(result.ok).toBe(true);
    expect(themeStore.available).toEqual(['aurora']);
    expect(themeStore.cache.aurora).toBeDefined();
    expect(document.documentElement.getAttribute('data-theme')).toBe('blueprint');
  });

  it('installs cache and applies a custom active theme without an IPC roundtrip', () => {
    const file: ThemeFile = {
      id: 'aurora',
      name: 'Aurora',
      base: 'dark',
      variables: { '--ui-bg': '#abc123' },
    };
    const result = themeStore.commitFromCandidate({
      availableIds: ['aurora'],
      themeCache: { aurora: file },
      activeId: 'aurora',
      activeFile: file,
    });

    expect(result.ok).toBe(true);
    expect(themeStore.activeFileId).toBe('aurora');
    expect(document.documentElement.style.getPropertyValue('--ui-bg').trim()).toBe('#abc123');
  });

  it('returns { ok: false } AND falls back to light when activeFile has an unknown base', () => {
    const bad: ThemeFile = {
      id: 'broken',
      name: 'Broken',
      base: 'nonsense' as 'dark',
      variables: {},
    };
    const result = themeStore.commitFromCandidate({
      availableIds: ['broken'],
      themeCache: { broken: bad },
      activeId: 'broken',
      activeFile: bad,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown base/);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('returns { ok: false } when activeFile is null for a custom id', () => {
    const result = themeStore.commitFromCandidate({
      availableIds: [],
      themeCache: {},
      activeId: 'missing-custom',
      activeFile: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
