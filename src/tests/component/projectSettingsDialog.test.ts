/**
 * The Settings dialog: tabs are labelled for assistive tech, the Apply /
 * Revert bar sits above the scrolling page and is enabled only when its tab
 * has changes, the bulk actions are at the end of the page, and a typed
 * number outside the schema's range is clamped in the field before it
 * reaches the copy. The rail names the build's version under the tabs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount, unmount } from 'svelte';
import ProjectSettings from '@renderer/components/modals/ProjectSettings.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { Project } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';

// Read from disk, not imported, so the check doesn't share the dialog's own import.
const packageVersion = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

function makeProject(): Project {
  return {
    version: 7,
    vaultPath: '/vault',
    name: 'Vault',
    theme: 'light',
    settings: ProjectSettingsSchema.parse({}),
    boards: [],
    connections: {},
    frames: [],
    tags: [],
    workspace: { openTabs: [], activeTabId: '' },
    createdAt: 0,
    updatedAt: 0,
  } as Project;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.settings-action-bar button')]
    .find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

let component: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
  installFiloMock((channel) => (channel === 'font:list-system' ? [] : null));
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('/vault');
  vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(makeProject());
  vi.spyOn(vaultStore, 'markMetaDirty').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ProjectSettings, { target });
  await settle();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  pendingSettingsStore.cancel();
  vaultStore.setPath('');
  vi.restoreAllMocks();
  restoreFiloDefault();
  document.body.innerHTML = '';
});

describe('Settings dialog', () => {
  it('labels each tab and its panel, and hides the save-mode chip', () => {
    const tab = document.getElementById('settings-tab-general');
    expect(tab?.getAttribute('aria-controls')).toBe('settings-tabpanel');
    expect(tab?.getAttribute('title')).toMatch(/save as you make them/);
    expect(tab?.querySelector('.settings-tab-save-mode')?.getAttribute('aria-hidden')).toBe('true');
    const panel = document.getElementById('settings-tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('settings-tab-general');
  });

  it("shows this build's version under the tabs, outside the tablist", () => {
    const version = document.querySelector('.settings-version');
    expect(version?.textContent).toBe(`Filo ${packageVersion}`);
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(version?.closest('[role="tablist"]')).toBeNull();
    expect(version?.previousElementSibling?.getAttribute('role')).toBe('tablist');
  });

  it('enables Apply / Revert only while Global Defaults has changes', async () => {
    document.getElementById('settings-tab-defaults')?.click();
    await settle();
    expect(document.getElementById('settings-tabpanel')?.getAttribute('aria-labelledby')).toBe('settings-tab-defaults');
    expect(button('Apply').disabled).toBe(true);
    expect(button('Revert').disabled).toBe(true);

    const width = document.getElementById('mm-border-width') as HTMLInputElement;
    width.value = '50';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(width.value).toBe('10');
    expect(pendingSettingsStore.pending?.mindmap.tile.borderWidth).toBe(10);
    expect(button('Apply').disabled).toBe(false);

    button('Revert').click();
    await settle();
    expect(button('Apply').disabled).toBe(true);
  });

  it('pins the action bar above the scrolling page and puts the bulk actions at its end', async () => {
    expect(document.querySelector('.settings-action-bar')).toBeNull();

    document.getElementById('settings-tab-defaults')?.click();
    await settle();
    const panel = document.getElementById('settings-tabpanel');
    const bar = panel?.querySelector('.settings-action-bar');
    const scroll = panel?.querySelector('.settings-scroll');
    expect(bar).not.toBeNull();
    expect(scroll).not.toBeNull();
    expect(scroll?.contains(bar ?? null)).toBe(false);
    // The bar comes before the page, so it reads first and stays on top.
    expect(bar?.nextElementSibling).toBe(scroll);
    expect(bar?.textContent).toContain('No changes');

    const zone = scroll?.querySelector('.danger-zone');
    expect(zone?.querySelector('h3')?.textContent).toBe('Danger zone');
    expect(zone?.previousElementSibling?.classList.contains('board-defaults')).toBe(true);
    const bulk = [...(zone?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim());
    expect(bulk).toEqual(['Apply Current Global Defaults to all Boards', 'Apply Theme Defaults to all Boards']);

    const width = document.getElementById('mm-border-width') as HTMLInputElement;
    width.value = '4';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(bar?.textContent).toContain('Unsaved changes');
  });

  it('opens each tab at the top of its page', async () => {
    document.getElementById('settings-tab-defaults')?.click();
    await settle();
    const first = document.querySelector<HTMLElement>('.settings-scroll');
    if (!first) throw new Error('no scroll area');
    first.scrollTop = 500;
    document.getElementById('settings-tab-general')?.click();
    await settle();
    const next = document.querySelector<HTMLElement>('.settings-scroll');
    expect(next).not.toBe(first);
    expect(next?.scrollTop).toBe(0);
  });

  it('puts a blank required number back to its last value', async () => {
    document.getElementById('settings-tab-defaults')?.click();
    await settle();
    const width = document.getElementById('mm-border-width') as HTMLInputElement;
    width.value = '';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(width.value).toBe('1');
    expect(pendingSettingsStore.hasGlobalChanges()).toBe(false);
  });
});
