/**
 * General → Developer tools: a switch kept per machine by main (it decides
 * whether Ctrl+Shift+I / F12 open the tools), saved at once like "Open last
 * vault on launch", with an "Open developer tools" button while it is on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import ProjectSettings from '@renderer/components/modals/ProjectSettings.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
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

let calls: Array<[string, ...unknown[]]> = [];
let enabledInMain = false;
let saveRefused = false;
let component: ReturnType<typeof mount> | null = null;

function devToolsSwitch(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Developer tools"]');
  if (!found) throw new Error('no Developer tools switch');
  return found;
}

function openButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Open developer tools');
}

async function mountSettings(): Promise<void> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ProjectSettings, { target });
  await settle();
}

beforeEach(() => {
  calls = [];
  enabledInMain = false;
  saveRefused = false;
  installFiloMock((channel, ...args) => {
    calls.push([channel, ...args]);
    if (channel === 'font:list-system') return [];
    if (channel === 'app:get-dev-tools') return { enabled: enabledInMain };
    if (channel === 'app:set-dev-tools') {
      if (saveRefused) return { success: false, code: 'EACCES', error: 'EACCES' };
      enabledInMain = args[0] === true;
      return { success: true };
    }
    if (channel === 'app:open-dev-tools') return { success: true };
    return null;
  });
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('/vault');
  vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(makeProject());
  vi.spyOn(vaultStore, 'markMetaDirty').mockImplementation(() => {});
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
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

describe('Developer tools setting', () => {
  it('shows what main keeps: off, with no Open button', async () => {
    await mountSettings();
    expect(calls.some(([c]) => c === 'app:get-dev-tools')).toBe(true);
    expect(devToolsSwitch().getAttribute('aria-checked')).toBe('false');
    expect(openButton()).toBeUndefined();
  });

  it('turned on, is saved at once and offers to open them', async () => {
    await mountSettings();
    devToolsSwitch().click();
    await settle();
    expect(calls).toContainEqual(['app:set-dev-tools', true]);
    expect(devToolsSwitch().getAttribute('aria-checked')).toBe('true');

    openButton()?.click();
    await settle();
    expect(calls).toContainEqual(['app:open-dev-tools']);
  });

  it('opens on when main has it on, and turns off from there', async () => {
    enabledInMain = true;
    await mountSettings();
    expect(devToolsSwitch().getAttribute('aria-checked')).toBe('true');
    devToolsSwitch().click();
    await settle();
    expect(calls).toContainEqual(['app:set-dev-tools', false]);
    expect(openButton()).toBeUndefined();
  });

  it("goes back when the switch couldn't be saved, and says so", async () => {
    saveRefused = true;
    await mountSettings();
    devToolsSwitch().click();
    await settle();
    expect(devToolsSwitch().getAttribute('aria-checked')).toBe('false');
    expect(uiStore.toasts.at(-1)?.text).toBe("Couldn't save the Developer tools setting.");
  });
});
