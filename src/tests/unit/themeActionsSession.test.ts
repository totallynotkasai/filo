/**
 * Theme actions outside the editor:
 *  - "System colours only" repaints as soon as it is toggled (on: the active
 *    theme's chrome over the boards' theme; off: the theme the vault opens
 *    with);
 *  - each theme card shows that theme's own colours;
 *  - the active theme deleted by another program falls back to Light with a
 *    notice saying why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { themeStore } from '@renderer/stores/theme.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetThemeManagerForTests, type ThemeFile } from '@renderer/lib/themes/themeManager';
import { setSystemColoursOnly, themePreview } from '@renderer/lib/themes/themeActions';
import { dispatchExternalChange, _resetRegistryForTests } from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { Project } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const root = document.documentElement;

function sunset(accent = '#ff6600'): ThemeFile {
  return {
    id: 'sunset',
    name: 'Sunset',
    base: 'dark',
    variables: { '--ui-bg': '#201010', '--toolbar-bg': '#402020', '--accent-primary': accent, '--text-secondary': '#c0a0a0' },
  };
}

beforeEach(() => {
  installFiloMock(() => null);
  __resetThemeManagerForTests();
  root.removeAttribute('data-theme');
  themeStore.clear();
  vaultStore.setPath('/vault');
});

afterEach(() => {
  vi.restoreAllMocks();
  vaultStore.setPath('');
  __resetThemeManagerForTests();
  themeStore.clear();
  restoreFiloDefault();
});

describe('setSystemColoursOnly', () => {
  it('repaints at once when turned on, and goes back to the saved theme when turned off', async () => {
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({ theme: 'dark' } as Project);
    await themeStore.applyById('/vault', 'dark');

    await setSystemColoursOnly(true);
    expect(themeStore.systemOnly).toBe(true);
    // The boards keep the theme they had; chrome is painted inline.
    expect(themeStore.boardTheme).toBe('dark');

    // A pick while it is on re-skins the chrome only.
    await themeStore.applyById('/vault', 'retro');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(themeStore.activeFileId).toBe('retro');

    await setSystemColoursOnly(false);
    expect(themeStore.systemOnly).toBe(false);
    expect(themeStore.boardTheme).toBeNull();
    expect(themeStore.activeFileId).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('themePreview', () => {
  it('a custom theme\'s card shows its own colours', async () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset(), other: { ...sunset('#0066ff'), id: 'other' } });
    expect(themePreview('sunset')).toEqual({ background: '#201010', bar: '#402020', accent: '#ff6600', text: '#c0a0a0' });
    expect(themePreview('other')?.accent).toBe('#0066ff');
  });
});

describe('the active theme deleted outside Filo', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    beginVaultGeneration('/vault');
  });

  it('falls back to Light and says so', async () => {
    themeStore.commitFromCandidate({ availableIds: ['sunset'], themeCache: { sunset: sunset() }, activeId: 'sunset', activeFile: sunset() });
    expect(themeStore.activeFileId).toBe('sunset');
    const toast = vi.spyOn(uiStore, 'toast');
    // The folder listing no longer has the file, and loading it finds nothing.
    installFiloMock((channel: string) => (channel === 'theme:list' ? [] : null));

    await dispatchExternalChange({ kind: 'config-theme', filename: '.filo/themes/sunset.json', eventType: 'rename' });

    expect(root.getAttribute('data-theme')).toBe('light');
    expect(toast).toHaveBeenCalledWith('The theme "Sunset" was deleted outside Filo, so Filo switched to Light.', 'warning', 7000);
  });

  it('an edit of the active theme re-applies it with no notice', async () => {
    themeStore.commitFromCandidate({ availableIds: ['sunset'], themeCache: { sunset: sunset() }, activeId: 'sunset', activeFile: sunset() });
    const toast = vi.spyOn(uiStore, 'toast');
    installFiloMock((channel: string) => {
      if (channel === 'theme:list') return ['sunset.json'];
      if (channel === 'theme:load') return sunset('#00aa00');
      return null;
    });

    await dispatchExternalChange({ kind: 'config-theme', filename: '.filo/themes/sunset.json', eventType: 'change' });

    expect(root.style.getPropertyValue('--accent-primary')).toBe('#00aa00');
    expect(toast).not.toHaveBeenCalled();
  });
});
