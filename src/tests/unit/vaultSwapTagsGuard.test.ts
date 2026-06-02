import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { flushAllMisc } from '@renderer/lib/boards/boardSaver';
import type { FileTreeNode } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-4 DI-03 — `runPostCommitTasks` must not write the *outgoing* vault's
 * pruned tags into the *incoming* vault on a fast A→B swap.
 *
 * Mechanism (vault.svelte.ts): the post-open index rebuild's `.then` callback
 * `await`s `applyFrontmatterToBackedTilesBatch` (which yields via
 * `queueMicrotask`) and then prunes `.filo/tags.json` orphans via
 * `flattenTreePaths(fileTree, newVaultPath)`. If a second `openVault` commits
 * vault B during that await, the suspended A-callback resumes with the module
 * `fileTree` already pointing at B's tree but its captured `newVaultPath` still
 * A's. `flattenTreePaths(B-tree, A-path)` yields an empty set → every one of
 * B's `fileTags` entries is treated as an orphan and dropped → the scheduled
 * save (reading the live `activeVaultRoot` = B) writes the gutted tags into
 * *B's* `.filo/tags.json`. `assertActiveVault` cannot catch it: the target
 * root is legitimately B.
 *
 * The fix re-checks `vaultPath === newVaultPath` after the await and bails.
 * This test suspends A's reconcile on a controllable deferred, swaps to B,
 * then releases A — and asserts no `tags:save` ever fires for B.
 *
 * 🔍 Watch it fail first: revert the guard in `runPostCommitTasks` and this
 * test records a `tags:save('/vault/B', …)` whose `fileTags` is empty.
 */

interface TagsSaveCall {
  root: string;
  fileTags: Record<string, string[]>;
}

const TREES: Record<string, FileTreeNode[]> = {
  '/vault/A': [],
  '/vault/B': [{ name: 'note.md', path: '/vault/B/note.md', isDirectory: false }],
};

const TAGS_JSON: Record<string, string> = {
  '/vault/A': JSON.stringify({ version: 1, tags: {}, fileTags: {} }),
  // B carries a real file-tag whose path IS present in B's tree, so B's own
  // post-commit prune drops nothing — the only way an entry disappears is the
  // cross-vault contamination this test guards against.
  '/vault/B': JSON.stringify({
    version: 1,
    tags: { topic: { color: '#3a86ff', createdAt: 1 } },
    fileTags: { 'note.md': ['topic'] },
  }),
};

function buildRoutes(tagsSaves: TagsSaveCall[]) {
  const rootArg = (root: unknown): string => (typeof root === 'string' ? root : '');
  return {
    'dialog:choice': async () => 1, // "Don't Save" — skip the flush prompt.
    'vault:close': async () => ({ success: true }),
    'vault:init-config': async () => ({ ok: true }),
    'config:load-all': async () => ({}),
    'board:list': async () => [],
    'vault:read-tree': async (root: unknown) => ({
      ok: true,
      tree: TREES[rootArg(root)] ?? [],
    }),
    'theme:list': async () => [],
    'theme:load': async () => null,
    'tags:load': async (root: unknown) =>
      TAGS_JSON[rootArg(root)] ?? JSON.stringify({ version: 1, tags: {}, fileTags: {} }),
    // Recovery-sentinel readers fired fire-and-forget by runPostCommitTasks.
    'vault:read-file-text': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
    // The IPC under test: a cross-vault prune lands here writing B's gutted tags.
    'tags:save': async (root: unknown, snapshot: unknown) => {
      const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : {};
      tagsSaves.push({ root: rootArg(root), fileTags: parsed.fileTags ?? {} });
      return undefined;
    },
  };
}

/** Drains pending microtasks + the current macrotask turn. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Audit-4 DI-03 — fast vault swap does not corrupt the new vault\'s tags.json', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('does not write the prior vault\'s pruned tags into the new vault', async () => {
    const tagsSaves: TagsSaveCall[] = [];

    // Keep the index rebuild instant + inert so callback ordering is governed
    // solely by the applyFrontmatter deferred below (the prune branch reads
    // `fileTree`/`candidate.tree`, never the index, so empty metadata is fine).
    vi.spyOn(vaultIndexStore, 'rebuild').mockResolvedValue(undefined);
    vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([]);

    // Suspend ONLY the first reconcile (vault A's) on a deferred so it resumes
    // after B has committed. B's reconcile (2nd call) resolves immediately.
    const deferredA = makeDeferred();
    let calls = 0;
    vi.spyOn(boardCacheStore, 'applyFrontmatterToBackedTilesBatch').mockImplementation(
      async () => {
        calls += 1;
        if (calls === 1) await deferredA.promise;
      },
    );

    installFiloMock(buildRoutes(tagsSaves));

    // Open A. Its runPostCommitTasks fires the rebuild → reconcile, which
    // suspends on the deferred before reaching the prune.
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(calls).toBe(1); // A's reconcile is parked at the await.

    // Swap to B. B commits (vaultPath = B, fileTagsStore = B's tags) and its
    // own reconcile prunes nothing (note.md is present in B's tree).
    expect(await vaultStore.openVault('/vault/B')).toBe(true);
    await tick();
    expect(vaultStore.path).toBe('/vault/B');

    // Release A's parked reconcile. It resumes against the live module state
    // (vaultPath = B) but with its captured newVaultPath = A.
    deferredA.resolve();
    await tick();

    // Force any debounced tags write to fire.
    await flushAllMisc();
    await tick();

    // The fix bails before the prune, so no save targets B at all. Pre-fix,
    // a tags:save('/vault/B', { fileTags: {} }) lands here.
    const bSaves = tagsSaves.filter((s) => s.root === '/vault/B');
    expect(bSaves).toEqual([]);

    // Belt-and-braces: B's on-the-record tag membership is never gutted.
    for (const s of bSaves) {
      expect(s.fileTags['note.md']).toEqual(['topic']);
    }
  });
});
