import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { flushAllMisc } from '@renderer/lib/boards/boardSaver';
import type { FileTreeNode } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-4 DI-03 — `runPostCommitTasks` must not write the *outgoing* vault's
 * pruned tags into the *incoming* vault on a fast A→B swap.
 *
 * Mechanism (vault.svelte.ts): the post-open index rebuild's `.then` callback
 * prunes `.filo/tags.json` orphans via `flattenTreePaths(fileTree,
 * newVaultPath)`. If a second `openVault` commits vault B while A's rebuild is
 * still in flight, the A-callback resumes with the module `fileTree` already
 * pointing at B's tree but its captured `newVaultPath` still A's.
 * `flattenTreePaths(B-tree, A-path)` yields an empty set → every one of B's
 * `fileTags` entries is treated as an orphan and dropped → the scheduled save
 * (reading the live `activeVaultRoot` = B) writes the gutted tags into *B's*
 * `.filo/tags.json`. `assertActiveVault` cannot catch it: the target root is
 * legitimately B.
 *
 * The fix re-checks the vault identity after the rebuild and bails. This test
 * suspends A's rebuild on a controllable deferred, swaps to B, then releases
 * A — and asserts no `tags:save` ever fires for B.
 *
 * The tagged file is a media file: tags.json holds only media files' tags (a
 * note's tags live in its frontmatter, and `.md` keys are always pruned).
 */

interface TagsSaveCall {
  root: string;
  fileTags: Record<string, string[]>;
}

const TREES: Record<string, FileTreeNode[]> = {
  '/vault/A': [],
  '/vault/B': [{ name: 'photo.png', path: '/vault/B/photo.png', isDirectory: false }],
};

const TAGS_JSON: Record<string, string> = {
  '/vault/A': JSON.stringify({ version: 1, tags: {}, fileTags: {} }),
  // B carries a real file-tag whose path IS present in B's tree, so B's own
  // post-commit prune drops nothing — the only way an entry disappears is the
  // cross-vault contamination this test guards against.
  '/vault/B': JSON.stringify({
    version: 1,
    tags: { topic: { color: '#3a86ff', createdAt: 1 } },
    fileTags: { 'photo.png': ['topic'] },
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

/**
 * Parks ONLY the first index rebuild on `gate` so its post-open callback
 * resumes after the next open has committed; later rebuilds resolve at once.
 * Returns a getter for how many rebuilds have started.
 */
function parkFirstRebuild(gate: Promise<void>): () => number {
  let calls = 0;
  vi.spyOn(vaultIndexStore, 'rebuild').mockImplementation(async () => {
    calls += 1;
    if (calls === 1) await gate;
  });
  // The prune branch reads `fileTree`, never the index, so empty metadata is fine.
  vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([]);
  return () => calls;
}

describe('Audit-4 DI-03 — fast vault swap does not corrupt the new vault\'s tags.json', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('does not write the prior vault\'s pruned tags into the new vault', async () => {
    const tagsSaves: TagsSaveCall[] = [];
    const deferredA = makeDeferred();
    const rebuilds = parkFirstRebuild(deferredA.promise);

    installFiloMock(buildRoutes(tagsSaves));

    // Open A. Its runPostCommitTasks fires the rebuild, which suspends on the
    // deferred before reaching the prune.
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(rebuilds()).toBe(1); // A's rebuild is parked.

    // Swap to B. B commits (vaultPath = B, fileTagsStore = B's tags) and its
    // own post-open prune drops nothing (photo.png is present in B's tree).
    expect(await vaultStore.openVault('/vault/B')).toBe(true);
    await tick();
    expect(vaultStore.path).toBe('/vault/B');

    // Release A's parked rebuild. Its callback resumes against the live module
    // state (vaultPath = B) but with its captured newVaultPath = A.
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
      expect(s.fileTags['photo.png']).toEqual(['topic']);
    }
  });
});

/**
 * Audit-8 H2(b) — the post-commit prune guard must use the GENERATION-aware
 * `isStillSameVault`, not a `vaultPath !== newVaultPath` string compare. The
 * A→B test above passes under BOTH (the path string differs), but a
 * close→reopen of the SAME path is a new vault generation with an identical
 * path string, which only the generation token distinguishes.
 *
 * Setup: the first open of `/vault/A` sees an EMPTY tree and parks its rebuild
 * on a deferred. The vault is then reopened at the SAME path with photo.png
 * present (its own prune drops nothing). Releasing the parked first rebuild,
 * the outgoing session must not prune the reopened session's tags.
 */
describe('Audit-8 H2(b) — close→reopen same path bails via the generation guard', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('does not let the outgoing session prune the reopened same-path vault\'s tags', async () => {
    const tagsSaves: TagsSaveCall[] = [];
    const deferredFirst = makeDeferred();
    const rebuilds = parkFirstRebuild(deferredFirst.promise);

    // The SAME path is opened twice; the tree it reports flips between opens.
    let aTree: FileTreeNode[] = [];
    const mediaTagJson = JSON.stringify({
      version: 1,
      tags: { topic: { color: '#3a86ff', createdAt: 1 } },
      fileTags: { 'photo.png': ['topic'] },
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
      'tags:load': async () => mediaTagJson,
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

    // First open: empty tree. Its rebuild parks.
    aTree = [];
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(rebuilds()).toBe(1);

    // Reopen the SAME path with photo.png present — a NEW generation, identical
    // path string. Its own prune drops nothing (photo.png is in the tree).
    aTree = [{ name: 'photo.png', path: '/vault/A/photo.png', isDirectory: false }];
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    await tick();
    expect(vaultStore.path).toBe('/vault/A');

    // Release the parked first rebuild. Its captured newVaultPath ('/vault/A')
    // MATCHES the live path, so only the generation check can catch the swap.
    deferredFirst.resolve();
    await tick();
    await flushAllMisc();
    await tick();

    // No save fires that drops the reopened session's photo.png tag.
    const gutting = tagsSaves.filter(
      (s) => s.root === '/vault/A' && !s.fileTags['photo.png'],
    );
    expect(gutting).toEqual([]);
  });
});
