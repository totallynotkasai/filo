/**
 * A `.filo/tags.json` update from another machine that lands
 * inside the self-write window was dropped (main suppresses the watcher event;
 * the reconciler returned on `isRecentSelfWrite`), and the next local tag save
 * blindly wrote the in-memory registry over it — B's registrations lost
 * silently, and the 30 s reconcile then saw disk == memory.
 *
 * Fix: (1) the debounced save re-reads tags.json and 3-way merges when disk
 * moved off the merge base; (2) inside the self-write window the reconciler
 * drops an event only when disk equals what we last saved (a real echo).
 *
 * Bite: drop the pre-write `tags:load` merge in `scheduleSave` → the first
 * case writes {a, c} (b lost). Drop the echo compare in the reconciler (restore
 * the bare `isRecentSelfWrite` return) → the foreign-in-window case goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchExternalChange, _resetRegistryForTests } from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
  markRecentSelfWrite,
} from '@renderer/lib/boards/writeStateTracking';
import type { TagsFile } from '@renderer/schema/tagsFile';

const TAGS_REL = '.filo/tags.json';

const tagsFile = (fileTags: Record<string, string[]>): TagsFile => ({ version: 1, tags: {}, fileTags });

let disk: string | null;
let saved: TagsFile[];
let onLoad: (() => void) | null;

function installRoutes(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') {
        onLoad?.();
        return disk;
      }
      if (channel === 'tags:save') {
        const json = String(args[1]);
        saved.push(JSON.parse(json) as TagsFile);
        disk = json;
        return undefined;
      }
      return { success: true };
    },
    on: () => () => {},
    send: () => {},
  };
}

describe('tags.json merge on write', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault-A');
    beginVaultGeneration('/vault-A');
    __clearRecentSelfWritesForTests();
    saved = [];
    onLoad = null;
    const base = tagsFile({ 'a.png': ['x'] });
    disk = JSON.stringify(base);
    fileTagsStore.commitFromCandidate('/vault-A', JSON.parse(disk) as TagsFile);
    installRoutes();
  });

  afterEach(async () => {
    onLoad = null;
    await fileTagsStore.flush().catch(() => {});
    vi.restoreAllMocks();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it("a local save merges another machine's update instead of overwriting it", async () => {
    // Machine B's tags.json lands (its watcher event was suppressed / dropped).
    disk = JSON.stringify(tagsFile({ 'a.png': ['x'], 'b.png': ['y'] }));
    fileTagsStore.setFileTags('c.png', ['z']);
    await fileTagsStore.flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].fileTags).toEqual({ 'a.png': ['x'], 'b.png': ['y'], 'c.png': ['z'] });
    expect(fileTagsStore.file.fileTags['b.png']).toEqual(['y']);
  });

  it('a same-key conflict resolves to the local value', async () => {
    disk = JSON.stringify(tagsFile({ 'a.png': ['theirs'] }));
    fileTagsStore.setFileTags('a.png', ['ours']);
    await fileTagsStore.flush();
    expect(saved[0].fileTags['a.png']).toEqual(['ours']);
  });

  it('disk unchanged since the last save → one plain save of memory', async () => {
    fileTagsStore.setFileTags('c.png', ['z']);
    await fileTagsStore.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(fileTagsStore.file);
    expect(saved[0].fileTags).toEqual({ 'a.png': ['x'], 'c.png': ['z'] });
  });

  it('an absent tags.json is written as-is, not treated as "every tag deleted"', async () => {
    disk = null;
    fileTagsStore.setFileTags('c.png', ['z']);
    await fileTagsStore.flush();
    expect(saved[0].fileTags).toEqual({ 'a.png': ['x'], 'c.png': ['z'] });
  });

  it('a corrupt disk copy is never overwritten', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    disk = '{ not json';
    fileTagsStore.setFileTags('c.png', ['z']);
    await fileTagsStore.flush().catch(() => {});
    expect(saved).toHaveLength(0);
    expect(disk).toBe('{ not json');
  });

  it('a vault swap during the pre-write read → no write', async () => {
    onLoad = () => {
      vaultStore.setPath('/vault-B');
      beginVaultGeneration('/vault-B');
    };
    fileTagsStore.setFileTags('c.png', ['z']);
    await fileTagsStore.flush();
    expect(saved).toHaveLength(0);
  });

  it('an echo inside the self-write window is dropped with no toast', async () => {
    const toastSpy = vi.spyOn(uiStore, 'pushToast');
    markRecentSelfWrite(TAGS_REL);
    await dispatchExternalChange({ kind: 'config-tags', filename: TAGS_REL, eventType: 'change' });
    expect(toastSpy).not.toHaveBeenCalled();
    expect(fileTagsStore.file.fileTags).toEqual({ 'a.png': ['x'] });
  });

  it("another machine's change inside the self-write window is applied", async () => {
    // A pending local add that hasn't flushed yet: memory ≠ disk, disk ≠ base.
    fileTagsStore.setFileTags('c.png', ['z']);
    markRecentSelfWrite(TAGS_REL);
    disk = JSON.stringify(tagsFile({ 'a.png': ['x'], 'b.png': ['y'] }));
    await dispatchExternalChange({ kind: 'config-tags', filename: TAGS_REL, eventType: 'change' });

    expect(fileTagsStore.file.fileTags).toEqual({ 'a.png': ['x'], 'b.png': ['y'], 'c.png': ['z'] });
    await fileTagsStore.flush();
    expect(saved.at(-1)?.fileTags).toEqual({ 'a.png': ['x'], 'b.png': ['y'], 'c.png': ['z'] });
  });
});
