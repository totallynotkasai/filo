/**
 * Phase 1 / 1.1 — Project Settings unsaved-changes guard.
 *
 * Two surfaces under test:
 *
 *  1. `pendingSettingsStore.hasUnsavedChanges()` — true iff the active
 *     session diverges from live store values.
 *  2. `confirmDiscardSettings(store, ui)` — the Modal `beforeClose` hook
 *     wiring. Returns `true` to allow the close, `false` to block it.
 *     When the user picks "Keep editing", the helper resolves `false`
 *     and the ProjectSettings modal mount-effect cleanup never fires —
 *     i.e. `pendingSettingsStore.cancel()` is never called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore, type ConfirmDialogConfig } from '@renderer/stores/ui.svelte';
import { confirmDiscardSettings } from '@renderer/lib/settings/confirmDiscardSettings';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { Project } from '@renderer/schema/index';

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

describe('pendingSettingsStore.hasUnsavedChanges', () => {
  let project: Project;

  beforeEach(() => {
    vaultStore.setPath('/vault');
    project = makeProject();
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
  });
  afterEach(() => {
    vaultStore.setPath('');
    pendingSettingsStore.cancel();
    vi.restoreAllMocks();
  });

  it('returns false when no session is active', () => {
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('returns false right after startGlobal when the pending clone matches live', () => {
    pendingSettingsStore.startGlobal();
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('returns true after a pending global edit diverges from live', () => {
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(true);
  });

  it('returns false again after the edit is applied', () => {
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');
    pendingSettingsStore.applyGlobal();
    // pending is now null AND live matches the previously-pending value.
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('returns false after cancelGlobal even though a divergent edit was made', () => {
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');
    pendingSettingsStore.cancelGlobal();
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });
});

describe('confirmDiscardSettings — close-guard contract', () => {
  let project: Project;
  let confirmConfig: ConfirmDialogConfig | null = null;

  beforeEach(() => {
    vaultStore.setPath('/vault');
    project = makeProject();
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
    confirmConfig = null;
    // Capture the config that the helper passes to openConfirm so the
    // test can simulate either button press without rendering UI.
    vi.spyOn(uiStore, 'openConfirm').mockImplementation((cfg) => {
      confirmConfig = cfg;
    });
  });
  afterEach(() => {
    vaultStore.setPath('');
    pendingSettingsStore.cancel();
    vi.restoreAllMocks();
  });

  it('resolves true without prompting when there are no unsaved changes', async () => {
    pendingSettingsStore.startGlobal();
    const ok = await confirmDiscardSettings(pendingSettingsStore, uiStore);
    expect(ok).toBe(true);
    expect(uiStore.openConfirm).not.toHaveBeenCalled();
  });

  it('prompts the user when an edit diverges from live, and resolves true on Discard', async () => {
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');
    const promise = confirmDiscardSettings(pendingSettingsStore, uiStore);
    expect(confirmConfig).not.toBeNull();
    // Simulate the user clicking the Discard button.
    confirmConfig!.onConfirm(false);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when the user picks Keep editing, so cancel() never runs', async () => {
    const cancelSpy = vi.spyOn(pendingSettingsStore, 'cancel');
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');

    const promise = confirmDiscardSettings(pendingSettingsStore, uiStore);
    expect(confirmConfig).not.toBeNull();
    // Simulate the user clicking "Keep editing".
    confirmConfig!.onCancel?.();
    await expect(promise).resolves.toBe(false);
    // Helper alone must not call cancel(); the caller (Modal) gates the
    // close on the returned bool, and the ProjectSettings $effect cleanup
    // only fires when the modal actually closes.
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
