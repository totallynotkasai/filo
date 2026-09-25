/**
 * Audit-6 H3 / H4 / L27 — external-edit reconcilers must re-check vault
 * identity after their async disk read.
 *
 * Each per-kind reconciler captures the active vault path, awaits a disk read
 * (`tags:load` / `board:load` / theme refresh), then mutates a store. A vault
 * swap interleaving on that await would apply the OUTGOING vault's data to the
 * NEW vault. The worst case is the tags reconciler: `applyExternalReload`
 * unconditionally `scheduleSave`s, so vault A's tag registry would be persisted
 * into vault B's `.filo/tags.json` on disk.
 *
 * These tests simulate a swap landing DURING the read (the mocked IPC route /
 * store method bumps the vault generation) and assert the reconciler bails
 * before mutating — and, as a control, that it DOES apply when no swap occurs.
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
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { themeStore } from '@renderer/stores/theme.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

function installRoutes(routes: Record<string, (...args: unknown[]) => unknown>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => routes[channel]?.(...args),
    on: () => () => {},
    send: () => {},
  };
}

function makeBoard(name: string): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('Audit-6 H3/H4/L27 — reconciler vault-identity guard', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault-A');
    beginVaultGeneration('/vault-A');
    boardCacheStore.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  // ── H4 — board reconciler ──

  it('board: a swap during board:load is NOT injected into the new vault cache', async () => {
    const REL = 'k.board.json';
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: REL });
    __clearRecentSelfWritesForTests();

    installRoutes({
      'board:load': () => {
        // Vault swaps to B while we're reading A's board JSON.
        beginVaultGeneration('/vault-B');
        return makeBoard('from-vault-A-disk');
      },
      'vault:stat': () => ({ ok: true, mtimeMs: 1, size: 1 }),
    });

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    // The outgoing vault's board JSON was NOT merged into the (new) cache.
    expect((boardCacheStore.cache.kb!.board as KanbanBoard).name).toBe('original');
  });

  it('board: applies the disk version when no swap occurs (control)', async () => {
    const REL = 'k.board.json';
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: REL });
    __clearRecentSelfWritesForTests();

    installRoutes({
      'board:load': () => makeBoard('from-disk'),
      'vault:stat': () => ({ ok: true, mtimeMs: 1, size: 1 }),
    });

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    expect((boardCacheStore.cache.kb!.board as KanbanBoard).name).toBe('from-disk');
  });

  // ── H3 — tags reconciler (worst case: persists to disk) ──

  it('tags: a swap during tags:load does NOT apply A’s registry to B', async () => {
    const applySpy = vi.spyOn(fileTagsStore, 'applyExternalReload');
    installRoutes({
      'tags:load': () => {
        beginVaultGeneration('/vault-B');
        return JSON.stringify({ version: 1, tags: {}, fileTags: {} });
      },
    });

    await dispatchExternalChange({
      kind: 'config-tags',
      filename: '.filo/tags.json',
      eventType: 'change',
    });

    // Guard bailed before applyExternalReload → no cross-vault scheduleSave.
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('tags: applies the reload when no swap occurs (control)', async () => {
    const applySpy = vi.spyOn(fileTagsStore, 'applyExternalReload');
    installRoutes({
      'tags:load': () => JSON.stringify({ version: 1, tags: {}, fileTags: {} }),
      'tags:save': () => ({ ok: true }),
    });

    await dispatchExternalChange({
      kind: 'config-tags',
      filename: '.filo/tags.json',
      eventType: 'change',
    });

    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  // ── L27 — theme reconciler (visual only) ──

  it('theme: a swap during refreshAvailable does NOT re-apply the outgoing theme', async () => {
    vi.spyOn(themeStore, 'refreshAvailable').mockImplementation(async () => {
      beginVaultGeneration('/vault-B');
    });
    // Make the changed file look like the active theme so applyById would fire
    // if the guard were absent.
    Object.defineProperty(themeStore, 'activeFileId', {
      get: () => 'dark',
      configurable: true,
    });
    const applySpy = vi.spyOn(themeStore, 'applyById').mockResolvedValue(undefined);

    await dispatchExternalChange({
      kind: 'config-theme',
      filename: '.filo/themes/dark.json',
      eventType: 'change',
    });

    expect(applySpy).not.toHaveBeenCalled();
  });
});
