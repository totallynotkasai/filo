/**
 * The Settings dialog: tabs are labelled for assistive tech, Apply / Cancel
 * are enabled only when their tab has changes, and a typed number outside
 * the schema's range is clamped in the field before it reaches the copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  const found = [...document.querySelectorAll<HTMLButtonElement>('.settings-footer button')]
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
    expect(tab?.getAttribute('title')).toMatch(/automatically/);
    expect(tab?.querySelector('.settings-tab-save-mode')?.getAttribute('aria-hidden')).toBe('true');
    const panel = document.getElementById('settings-tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('settings-tab-general');
  });

  it('enables Apply / Cancel only while Global Defaults has changes', async () => {
    document.getElementById('settings-tab-defaults')?.click();
    await settle();
    expect(document.getElementById('settings-tabpanel')?.getAttribute('aria-labelledby')).toBe('settings-tab-defaults');
    expect(button('Apply').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);

    const width = document.getElementById('mm-border-width') as HTMLInputElement;
    width.value = '50';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(width.value).toBe('10');
    expect(pendingSettingsStore.pending?.mindmap.tile.borderWidth).toBe(10);
    expect(button('Apply').disabled).toBe(false);

    button('Cancel').click();
    await settle();
    expect(button('Apply').disabled).toBe(true);
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
