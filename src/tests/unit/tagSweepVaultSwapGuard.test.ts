/**
 * The vault-wide tag rename/remove sweep must NOT apply the outgoing vault's
 * tag operation to a vault swapped-in mid-flight.
 *
 * The bug: `runTagRewriteSweep` read the LIVE `vaultStore.path` and the sweep is
 * long-running. A vault swap during it (or its survive-a-swap retry toast, whose
 * closure re-read the live path at click time) made the sweep walk the NEW vault's
 * files and the in-memory commit mutate the NEW vault's boards — main-side
 * `assertActiveVault` ACCEPTS the writes because they target the active vault.
 *
 * The fix threads a CAPTURED root into the sweep (writes anchored to the outgoing
 * root → main-side rejected) and `isStillSameVault`-guards every in-memory commit.
 * Here we inject a swap (bump the vault generation + repoint `vaultStore.path`)
 * during the pre-sweep `ensureAllLoaded` await, then assert: (a) every `.md` write
 * still targets the CAPTURED root, never the new vault, and (b) the in-memory
 * registry commit is skipped (the tag stays at its old name).
 *
 * Bite-verify: drop the `identity.path` thread → writes target `/vault-B`; drop
 * the commit guard → the registry renames under the new vault.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { emptyTagsFile as newTagsFile } from '@renderer/lib/vault/tagsStorage';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { cancelAllPendingWrites, __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { KanbanBoard } from '@renderer/schema/index';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

function emptyTagsFile(): string {
  return JSON.stringify({ version: 1, tags: {}, fileTags: {} });
}

function taggedKanbanFixture() {
  return {
    board: {
      id: 'k1',
      type: 'kanban',
      name: 'Backlog',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1', type: 'text', title: 'A',
        style: {} as never, tags: ['urgent', 'work'],
        createdAt: 0, updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function seedVaultIndexWithTaggedFile(path: string, tag: string): void {
  const metadata: FileMetadata = {
    path,
    title: path.replace(/\.md$/i, ''),
    tags: [tag],
    frontmatter: { tags: [tag] },
    content: 'body',
    lastModified: 0,
    rawFrontmatter: `tags: [${tag}]`,
  };
  vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([metadata]);
  vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
}

describe('vault-wide tag rename/remove swap guard', () => {
  beforeEach(async () => {
    __resetVaultIdentityForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault'); // establish vault A identity
    fileTagsStore.reset();

    installFiloMock({
      'tags:load': async () => emptyTagsFile(),
      'tags:save': async () => null,
      'board:save': async () => null,
      'vault:read-file-text': async () => ({ success: true, content: '---\ntags: [urgent]\n---\nbody\n' }),
      'vault:write-existing-file-text': async () => ({ success: true }),
      'vault:write-file-text': async () => ({ success: true }),
      'vault:file-exists': async () => true,
      'vault:stat': async () => ({ success: true, mtimeMs: 1, size: 20 }),
    });

    fileTagsStore.commitFromCandidate('/vault', newTagsFile());
  });

  afterEach(() => {
    cancelAllPendingWrites();
    vi.restoreAllMocks();
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
  });

  it('renameTagEverywhere: a swap mid-flight keeps writes on the captured root and skips the commit', async () => {
    const kb = taggedKanbanFixture();
    boardCacheStore.hydrate({ k1: kb }, { k1: 'Backlog.board.json' });
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(
      { boards: [kb.board] } as unknown as ReturnType<typeof vaultStore.getProject>,
    );
    fileTagsStore.addTagToFile('Tasks/A.md', 'urgent');
    seedVaultIndexWithTaggedFile('Tasks/A.md', 'urgent');

    // Record the vaultRoot every `.md` write targets.
    const writeRoots: string[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return emptyTagsFile();
      if (channel === 'vault:read-file-text') return { success: true, content: '---\ntags: [urgent]\n---\nbody\n' };
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        writeRoots.push(String(args[0]));
        return { success: true };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 20 };
      return { success: true };
    });

    // Inject the swap during the pre-sweep `ensureAllLoaded` await: bump the
    // generation AND repoint the live path to the NEW vault. The captured identity
    // (taken at the top of renameTagEverywhere) still names `/vault`.
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockImplementation(async () => {
      beginVaultGeneration('/vault-B');
      vaultStore.setPath('/vault-B');
      return [];
    });

    await fileTagsStore.renameTagEverywhere('urgent', 'important');

    // (a) No write targets the NEW vault: the planned notes are not written
    // after the swap, and the recovery sentinel stays on the captured root.
    expect(writeRoots).not.toContain('/vault-B');
    expect(writeRoots.every((r) => r === '/vault')).toBe(true);

    // (b) The in-memory commit was skipped: the registry stays at the OLD name.
    expect(fileTagsStore.file.tags.urgent).toBeDefined();
    expect(fileTagsStore.file.tags.important).toBeUndefined();
    // The tile def on the (now-inactive) vault A board was NOT rewritten either.
    const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
    expect(def.tags).toContain('urgent');
    expect(def.tags).not.toContain('important');
  });

  it('removeTagEverywhere: a swap mid-flight keeps writes on the captured root and skips the commit', async () => {
    const kb = taggedKanbanFixture();
    boardCacheStore.hydrate({ k1: kb }, { k1: 'Backlog.board.json' });
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(
      { boards: [kb.board] } as unknown as ReturnType<typeof vaultStore.getProject>,
    );
    fileTagsStore.addTagToFile('Tasks/A.md', 'urgent');
    seedVaultIndexWithTaggedFile('Tasks/A.md', 'urgent');

    const writeRoots: string[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return emptyTagsFile();
      if (channel === 'vault:read-file-text') return { success: true, content: '---\ntags: [urgent]\n---\nbody\n' };
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        writeRoots.push(String(args[0]));
        return { success: true };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 20 };
      return { success: true };
    });

    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockImplementation(async () => {
      beginVaultGeneration('/vault-B');
      vaultStore.setPath('/vault-B');
      return [];
    });

    await fileTagsStore.removeTagEverywhere('urgent');

    expect(writeRoots).not.toContain('/vault-B');
    expect(writeRoots.every((r) => r === '/vault')).toBe(true);
    // Commit skipped — the tag def survives on the (now-inactive) vault A registry.
    expect(fileTagsStore.file.tags.urgent).toBeDefined();
    const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
    expect(def.tags).toContain('urgent');
  });
});
