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

/**
 * Audit-8 H2(b) — the post-commit prune guard must use the GENERATION-aware
 * `isStillSameVault`, not the pre-fix `vaultPath !== newVaultPath` string
 * compare. The A→B test above passes under BOTH (the path string differs), but
 * a close→reopen of the SAME path is a new vault generation with an identical
 * path string: the old check saw `'/vault/A' !== '/vault/A'` → false → did NOT
 * bail, so the outgoing session's parked reconcile pruned the freshly-reopened
 * session's tags. The generation token distinguishes the two sessions.
 *
 * Setup: the first open of `/vault/A` sees an EMPTY tree (so its captured
 * `candidate.tree` lacks note.md) and parks its reconcile on a deferred. The
 * vault is then reopened at the SAME path with note.md present (its own
 * reconcile prunes nothing). Releasing the parked first reconcile, the pre-fix
 * path-only guard would let it run `flattenTreePaths([], '/vault/A')` = ∅ and
 * gut the reopened session's note.md tag.
 *
 * 🔍 Watch it fail first: revert the guard to `if (vaultPath !== newVaultPath)`
 * and a `tags:save('/vault/A', { fileTags: {} })` lands here.
 */
describe('Audit-8 H2(b) — close→reopen same path bails via the generation guard', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('does not let the outgoing session prune the reopened same-path vault\'s tags', async () => {
    const tagsSaves: TagsSaveCall[] = [];

    vi.spyOn(vaultIndexStore, 'rebuild').mockResolvedValue(undefined);
    vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([]);

    // Suspend ONLY the first open's reconcile so it resumes after the reopen.
    const deferredFirst = makeDeferred();
    let calls = 0;
    vi.spyOn(boardCacheStore, 'applyFrontmatterToBackedTilesBatch').mockImplementation(
      async () => {
        calls += 1;
        if (calls === 1) await deferredFirst.promise;
      },
    );

    // The SAME path is opened twice; the tree it reports flips between opens so
    // the parked first reconcile's captured tree (∅) differs from the reopen's.
    let aTree: FileTreeNode[] = [];
    const noteTagJson = JSON.stringify({
      version: 1,
      tags: { topic: { color: '#3a86ff', createdAt: 1 } },
      fileTags: { 'note.md': ['topic'] },
    });
    installFiloMock({
      'dialog:choice': async () => 1, // "Don't Save" — skip the flush prompt.
      'vault:close': async () => ({ success: true }),
      'vault:init-config': async () => ({ ok: true }),
      'config:load-all': async () => ({}),
      'board:list': async () => [],
      'vault:read-tree': async () => ({ ok: true, tree: aTree }),
      'theme:list': async () => [],
      'theme:load': async () => null,
      'tags:load': async () => noteTagJson,
      'vault:read-file-text': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
      'tags:save': async (root: unknown, snapshot: unknown) => {
        const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : {};
        tagsSaves.push({
          root: typeof root === 'string' ? root : '',
          fileTags: parsed.fileTags ?? {},
        });
        return undefined;
      },
    });

    // First open: empty tree → captured candidate.tree = []. Reconcile parks.
    aTree = [];
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(calls).toBe(1);

    // Reopen the SAME path with note.md present — a NEW generation, identical
    // path string. Its own reconcile prunes nothing (note.md is in the tree).
    aTree = [{ name: 'note.md', path: '/vault/A/note.md', isDirectory: false }];
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(vaultStore.path).toBe('/vault/A');

    // Release the parked first reconcile. Its captured newVaultPath ('/vault/A')
    // MATCHES the live path, so only the generation check can catch the swap.
    deferredFirst.resolve();
    await tick();
    await flushAllMisc();
    await tick();

    // The generation guard bails before the stale prune, so no gutting save
    // fires. Pre-fix (path-only) a `tags:save('/vault/A', { fileTags: {} })`
    // — missing note.md — lands here.
    const gutting = tagsSaves.filter(
      (s) => s.root === '/vault/A' && !s.fileTags['note.md'],
    );
    expect(gutting).toEqual([]);
  });
});
