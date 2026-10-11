import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { Project } from '@renderer/schema/index';

/**
 * Pins the visible-state contract for `applyGlobal()` on the
 * `kanban.backgroundPattern` selector.
 *
 * The suspicion was that the project-settings pattern selector "doesn't
 * change anything" because the apply path might not propagate to
 * `vaultStore.project.settings`. The fix candidate was to clone
 * `project.settings` instead of mutating it — the existing code already
 * deep-clones the pending tree before assigning to `project.settings`,
 * so this test pins the visible contract: after Apply, reading the new
 * value through the store returns the expected value.
 */

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

describe('pendingSettings.applyGlobal — kanban.backgroundPattern visible after Apply', () => {
  let project: Project;

  beforeEach(() => {
    vaultStore.setPath('/vault');
    project = makeProject();
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
  });
  afterEach(() => {
    vaultStore.setPath('');
    pendingSettingsStore.cancelGlobal();
    pendingSettingsStore.cancelBoard();
    vi.restoreAllMocks();
  });

  it('updates kanban.backgroundPattern through the project getter after Apply', () => {
    // Default from the schema is 'none' for non-canvas boards.
    expect(project.settings.kanban.backgroundPattern).toBe('none');

    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');
    expect(pendingSettingsStore.pending?.kanban?.backgroundPattern).toBe('dots');

    pendingSettingsStore.applyGlobal();

    expect(project.settings.kanban.backgroundPattern).toBe('dots');
    expect(pendingSettingsStore.pending).toBeNull();
  });

  it('writes a fresh top-level reference into project.settings so $derived consumers see it', () => {
    const beforeRef = project.settings;
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('mindmap.backgroundPattern', 'dots');
    pendingSettingsStore.applyGlobal();

    const afterRef = project.settings;
    expect(afterRef).not.toBe(beforeRef);
    expect(afterRef.mindmap.backgroundPattern).toBe('dots');
  });
});
