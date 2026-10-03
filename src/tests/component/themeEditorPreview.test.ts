/**
 * The theme editor paints each colour change at once, and an unsaved preview
 * never sticks: Cancel, or Settings closing with the editor open, paints the
 * active theme again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import ThemeEditor from '@renderer/components/settings/ThemeEditor.svelte';
import { themeStore } from '@renderer/stores/theme.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetThemeManagerForTests } from '@renderer/lib/themes/themeManager';
import type { ThemeEditorSession } from '@renderer/lib/themes/themeFiles';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';

const root = document.documentElement;
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

function valueInput(label: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label} value"]`);
  if (!input) throw new Error(`no ${label} value box`);
  return input;
}

async function frame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await settle();
}

beforeEach(async () => {
  installFiloMock(() => null);
  __resetThemeManagerForTests();
  themeStore.clear();
  vaultStore.setPath('/vault');
  closed = 0;
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

describe('ThemeEditor', () => {
  it('paints the draft as soon as it opens, and each change after', async () => {
    await mountEditor();
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#111111');

    const box = valueInput('App background');
    box.value = '#223344';
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await frame();
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#223344');
  });

  it('refuses a value that isn\'t a colour, and paints nothing for it', async () => {
    await mountEditor();
    const box = valueInput('App background');
    box.value = 'url(https://evil.example/x)';
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await frame();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#111111');
  });

  it('refuses a value that names no colour of its own (currentColor, inherit, var())', async () => {
    await mountEditor();
    const box = valueInput('App background');
    for (const value of ['currentColor', 'inherit', 'var(--accent-primary)']) {
      box.value = value;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await frame();
      expect(box.getAttribute('aria-invalid'), value).toBe('true');
      expect(root.style.getPropertyValue('--ui-bg'), value).toBe('#111111');
    }
  });

  it('Cancel paints the active theme again', async () => {
    await mountEditor();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.editor-actions button')]
      .find((b) => b.textContent?.trim() === 'Cancel');
    cancel?.click();
    await settle();
    expect(closed).toBe(1);
    expect(root.style.getPropertyValue('--ui-bg')).toBe('');
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('closing Settings with the editor open paints the active theme again', async () => {
    await mountEditor();
    expect(root.style.getPropertyValue('--ui-bg')).toBe('#111111');
    if (component) await unmount(component);
    component = null;
    await settle();
    expect(root.style.getPropertyValue('--ui-bg')).toBe('');
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});
