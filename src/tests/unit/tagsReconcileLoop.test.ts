/**
 * Audit-17 0.2 — the 6.4 reconcile walk puts `.filo/tags.json` in the 30 s
 * reconcile snapshot. A self-write's echo surfaces in that pass long after the
 * 1.5–5 s self-write TTL, so the renderer can no longer recognise it as its
 * own. Before the fix `reconcileTagsJsonChange` toasted unconditionally and
 * `applyExternalReload` re-saved unconditionally — an identical-bytes save
 * bumped mtime, the next pass diffed again, and the toast + load + merge + save
 * loop ran every 30 s for the rest of the session.
 *
 * Fix (two layers):
 *   1. content compare in the reconciler — `applyExternalReload` returns false
 *      when disk deep-equals the in-memory registry, and the reconciler skips
 *      the toast on false.
 *   2. drop the unconditional `scheduleSave()` — only re-arm a save when the
 *      merge diverged from the external disk copy.
 *
 * These tests drive a synthesized `config-tags` reconcile event through the
 * real registry and assert: a self-write echo raises NO toast and schedules NO
 * save; a genuine external diff still toasts + reloads (and, with no pending
 * local delta, still doesn't echo a save back — disk is already canonical).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  dispatchExternalChange,
  _resetRegistryForTests,
} from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import type { TagsFile } from '@renderer/schema/tagsFile';

const TAGS_REL = '.filo/tags.json';

let savedSnapshots: string[];

function installRoutes(routes: Record<string, (...args: unknown[]) => unknown>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => routes[channel]?.(...args),
    on: () => () => {},
    send: () => {},
  };
}

function installTagsRoutes(diskFile: TagsFile): void {
  savedSnapshots = [];
  installRoutes({
    'tags:load': () => JSON.stringify(diskFile),
    'tags:save': (_root: unknown, snapshot: unknown) => {
      savedSnapshots.push(String(snapshot));
      return { ok: true };
    },
  });
}

async function dispatchTagsChange(): Promise<void> {
  await dispatchExternalChange({
    kind: 'config-tags',
    filename: TAGS_REL,
    eventType: 'change',
  });
}

describe('Audit-17 0.2 — tags.json reconcile loop', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault-A');
    beginVaultGeneration('/vault-A');
    __clearRecentSelfWritesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('a self-write echo (disk === memory) raises NO toast and schedules NO save', async () => {
    const state: TagsFile = {
      version: 1,
      tags: { project: { color: '#f00' } },
      fileTags: { 'image.png': ['urgent'] },
    };
    // In-memory registry is exactly what is on disk (we just wrote it).
    fileTagsStore.commitFromCandidate('/vault-A', JSON.parse(JSON.stringify(state)) as TagsFile);
    installTagsRoutes(state);
    const toastSpy = vi.spyOn(uiStore, 'pushToast');

    await dispatchTagsChange();
    await fileTagsStore.flush();

    expect(toastSpy).not.toHaveBeenCalled();
    expect(savedSnapshots).toHaveLength(0);
  });

  it('a genuine external diff toasts + reloads (and does not echo a save back)', async () => {
    const memory: TagsFile = {
      version: 1,
      tags: { project: { color: '#f00' } },
      fileTags: {},
    };
    fileTagsStore.commitFromCandidate('/vault-A', JSON.parse(JSON.stringify(memory)) as TagsFile);

    // External tool added a registry tag; no pending local delta of ours.
    const disk: TagsFile = {
      version: 1,
      tags: { project: { color: '#f00' }, external: { color: '#0f0' } },
      fileTags: {},
    };
    installTagsRoutes(disk);
    const toastSpy = vi.spyOn(uiStore, 'pushToast');

    await dispatchTagsChange();
    await fileTagsStore.flush();

    // Toast fired and the external addition was absorbed into the registry.
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(fileTagsStore.file.tags).toHaveProperty('external');
    // No local delta → merged === disk → no echo save (layer 2).
    expect(savedSnapshots).toHaveLength(0);
  });
});
