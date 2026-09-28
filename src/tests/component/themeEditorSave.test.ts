/**
 * The theme editor's Save picks the theme the way a click on it would
 * (`selectTheme`: the Global Defaults colours prompt, the "System colours
 * only" rule), refuses while a colour box holds a non-colour, and unsaved
 * changes are asked about before Settings closes or the tab changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ selectTheme: vi.fn(async (_id: string) => true) }));
vi.mock('@renderer/lib/themes/themeActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/themes/themeActions')>()),
  selectTheme: h.selectTheme,
}));

import { mount, unmount } from 'svelte';
import ThemeEditor from '@renderer/components/settings/ThemeEditor.svelte';
import { themeStore } from '@renderer/stores/theme.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore, type ConfirmDialogConfig } from '@renderer/stores/ui.svelte';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { __resetThemeManagerForTests } from '@renderer/lib/themes/themeManager';
import { settleThemeEditor, themeEditorHasChanges } from '@renderer/lib/themes/themeEditorGuard';
import { confirmDiscardSettings } from '@renderer/lib/settings/confirmDiscardSettings';
import type { ThemeEditorSession } from '@renderer/lib/themes/themeFiles';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';

let component: ReturnType<typeof mount> | null = null;
let closed = 0;

function session(): ThemeEditorSession {
  return { mode: 'new', ownId: null, name: 'Draft', base: 'dark', variables: { '--ui-bg': '#111111' } };
}

async function mountEditor(): Promise<void> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ThemeEditor, { target, props: { session: session(), onclose: () => { closed++; } } });
  await settle();
}

function setValue(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label} value"]`);
  if (!input) throw new Error(`no ${label} value box`);
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.editor-actions button')]
    .find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no ${text} button`);
  return found;
}

beforeEach(async () => {
  installFiloMock(() => null);
  __resetThemeManagerForTests();
  themeStore.clear();
  vaultStore.setPath('/vault');
  closed = 0;
  h.selectTheme.mockClear();
  h.selectTheme.mockResolvedValue(true);
  await themeStore.applyById('/vault', 'light');
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = '';
  vaultStore.setPath('');
  __resetThemeManagerForTests();
  themeStore.clear();
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe('ThemeEditor Save', () => {
  it('saves, then picks the theme through selectTheme', async () => {
    const save = vi.spyOn(themeStore, 'saveTheme').mockResolvedValue('draft');
    await mountEditor();
    button('Save').click();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(h.selectTheme).toHaveBeenCalledWith('draft');
    expect(closed).toBe(1);
  });

  it('when the pick is cancelled, the saved theme isn\'t left painted as a preview', async () => {
    vi.spyOn(themeStore, 'saveTheme').mockResolvedValue('draft');
    h.selectTheme.mockResolvedValue(false);
    await mountEditor();
    expect(document.documentElement.style.getPropertyValue('--ui-bg')).toBe('#111111');
    button('Save').click();
    await settle();
    expect(document.documentElement.style.getPropertyValue('--ui-bg')).toBe('');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('refuses while a colour box holds a non-colour, naming it', async () => {
    const save = vi.spyOn(themeStore, 'saveTheme').mockResolvedValue('draft');
    await mountEditor();
    setValue('App background', '#12');
    await settle();
    button('Save').click();
    await settle();
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('#theme-editor-problem')?.textContent).toMatch(/"App background" isn't a colour/);
    expect(closed).toBe(0);
  });
});

describe('unsaved theme changes are asked about', () => {
  let confirm: ConfirmDialogConfig | null = null;
  beforeEach(() => {
    confirm = null;
    vi.spyOn(uiStore, 'openConfirm').mockImplementation((cfg) => { confirm = cfg; });
  });

  it('an untouched editor goes without asking', async () => {
    await mountEditor();
    expect(themeEditorHasChanges()).toBe(false);
    await expect(settleThemeEditor()).resolves.toBe(true);
    expect(confirm).toBeNull();
  });

  it('Keep editing keeps it; Discard lets it go', async () => {
    await mountEditor();
    setValue('App background', '#445566');
    await settle();
    expect(themeEditorHasChanges()).toBe(true);

    const kept = settleThemeEditor();
    confirm!.onCancel?.();
    await expect(kept).resolves.toBe(false);

    const discarded = settleThemeEditor();
    confirm!.secondaryAction!.onClick();
    await expect(discarded).resolves.toBe(true);
  });

  it('Save saves the theme before it goes', async () => {
    const save = vi.spyOn(themeStore, 'saveTheme').mockResolvedValue('draft');
    await mountEditor();
    setValue('App background', '#445566');
    await settle();
    const leaving = settleThemeEditor();
    confirm!.onConfirm(false);
    await expect(leaving).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('closing Settings (Escape, the close button) asks first', async () => {
    await mountEditor();
    setValue('App background', '#445566');
    await settle();
    const closing = confirmDiscardSettings(pendingSettingsStore, uiStore);
    await settle();
    expect(confirm?.title).toMatch(/Save changes to the theme/);
    confirm!.onCancel?.();
    await expect(closing).resolves.toBe(false);
  });
});
