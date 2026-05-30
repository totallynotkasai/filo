/**
 * Phase C / C.7 — sidebar "New Folder" auto-enters rename mode.
 *
 * The toolbar stashes the new folder's absolute path on
 * `uiStore.pendingSidebarRenameId`; the matching VaultFileItem
 * consumes the flag on mount, calls `startRename`, and clears it.
 *
 * Mounting the components in vitest fails preprocessing, so this
 * test verifies the contract at the uiStore level:
 *
 *   1. The pending-rename slot is initially null.
 *   2. setPendingSidebarRenameId stores the abs path.
 *   3. Consumers clear the slot via setPendingSidebarRenameId(null).
 *   4. Two consecutive "New Folder" clicks don't collide — setting
 *      a second path overwrites the first.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';

beforeEach(() => {
  uiStore.setPendingSidebarRenameId(null);
});

describe('uiStore.pendingSidebarRenameId (Phase C / C.7)', () => {
  it('defaults to null', () => {
    expect(uiStore.pendingSidebarRenameId).toBeNull();
  });

  it('store + clear round-trip works', () => {
    uiStore.setPendingSidebarRenameId('/vault/New Folder');
    expect(uiStore.pendingSidebarRenameId).toBe('/vault/New Folder');
    uiStore.setPendingSidebarRenameId(null);
    expect(uiStore.pendingSidebarRenameId).toBeNull();
  });

  it('overwrites on second set (two-click race is safe)', () => {
    uiStore.setPendingSidebarRenameId('/vault/A');
    uiStore.setPendingSidebarRenameId('/vault/B');
    expect(uiStore.pendingSidebarRenameId).toBe('/vault/B');
  });

  it('the consumer "matches and clears" loop terminates', () => {
    // VaultFileItem's $effect runs the equivalent of this loop. We
    // simulate it: on a match, clear then dispatch `startRename`.
    let started = 0;
    uiStore.setPendingSidebarRenameId('/vault/My Folder');
    function consumer(absPath: string) {
      if (uiStore.pendingSidebarRenameId === absPath) {
        uiStore.setPendingSidebarRenameId(null);
        started++;
      }
    }
    consumer('/vault/My Folder');
    // Re-running the effect (Svelte re-runs $effect on reactivity change)
    // must not re-fire startRename because the slot is now null.
    consumer('/vault/My Folder');
    consumer('/vault/My Folder');
    expect(started).toBe(1);
  });
});
