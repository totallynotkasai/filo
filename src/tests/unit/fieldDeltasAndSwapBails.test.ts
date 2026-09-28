import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetRenameCascadeSentinelForTests, type RenameCascadeEntry } from '@renderer/lib/vault/renameCascadeSentinel';
import { repairRenameCascade } from '@renderer/lib/vault/renameCascadeRepair';
import {
  captureVaultIdentity,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { UpdatePropertiesCommand, type PropertiesSnapshot } from '@renderer/commands/propertiesCommands';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Queued field deltas + vault-swap guards.
 *
 * A field edit queues a frontmatter delta that lands on a fresh read of the
 * file, keeping every key it doesn't name. An in-app delete drops what was
 * queued for that note only.
 *
 * Rename-cascade recovery, fileTags tag writers, and the Properties command
 * read the active vault path, await disk I/O, then mutate renderer state. A
 * vault swap on that await must bail (`isStillSameVault`) before applying the
 * outgoing vault's data to the new vault.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function writesIn(captured: Captured[]): string[] {
  return captured.filter((c) => c.channel === 'vault:write-existing-file-text').map((c) => String(c.args[1]));
}
function lastWriteContent(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') return captured[i].args[2] as string;
  }
  return undefined;
}

describe('queued field deltas', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    captured = [];
    vaultStore.setPath('/vault');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content, mtimeMs: 5, size: content.length };
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:file-exists') return true;
      return { success: true };
    });
  }

  it('a queued delta writes on flush and keeps the untouched keys', async () => {
    installDisk('---\ncompleted: false\nstatus: blocked\n---\nbody\n');
    noteStore.patchFrontmatter('Note.md', patchToFrontmatterDelta({ priority: 'high' }));
    await noteStore.flushAll();
    expect(lastWriteContent(captured)).toContain('priority: high');
    expect(lastWriteContent(captured)).toContain('status: blocked'); // untouched key preserved
  });

  it('an in-app delete drops the queued delta for that path only', async () => {
    installDisk('---\ncompleted: false\n---\nbody\n');
    noteStore.patchFrontmatter('Discarded.md', patchToFrontmatterDelta({ priority: 'high' }));
    noteStore.patchFrontmatter('Kept.md', patchToFrontmatterDelta({ priority: 'low' }));
    noteStore.forgetDeleted('Discarded.md');
    const result = await noteStore.flushAll();
    expect(result.failed).toEqual([]);
    expect(writesIn(captured)).toContain('Kept.md');
    expect(writesIn(captured)).not.toContain('Discarded.md');
  });
});

describe('repairRenameCascade bails on a vault swap', () => {
  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (channel === 'tags:load') return null;
      return { success: true };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetRenameCascadeSentinelForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  it('returns null and skips in-memory mutations when the vault swapped after capture', async () => {
    vaultStore.setPath('/vaultA');
    // Capture the identity the recovery sequencer threads (vaultA's generation).
    const captured = captureVaultIdentity();
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);
    const renameSpy = vi.spyOn(boardCacheStore, 'renameBoardPath').mockReturnValue(['b1']);
    const flushSpy = vi.spyOn(boardCacheStore, 'flushAllDirty').mockResolvedValue({ failed: [] });

    // Swap to a different vault — bumps the generation, so `captured` is stale.
    vaultStore.setPath('/vaultB');

    const entries: RenameCascadeEntry[] = [
      {
        id: 'e1',
        timestamp: 1,
        oldPath: 'b1.board.json',
        newPath: 'sub/b1.board.json',
        affectedBoardIds: ['b1'],
      },
    ];
    const result = await repairRenameCascade(entries, '/vaultA', 'Retry', captured);

    expect(result).toBeNull();
    expect(renameSpy).not.toHaveBeenCalled(); // bailed after ensureAllLoaded
    expect(flushSpy).not.toHaveBeenCalled();
  });
});

describe('fileTags tag writers bail on a vault swap', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    captured = [];
    vaultStore.setPath('/vaultA');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  it('a swap during the tag-write read writes nothing and leaves the new vault\'s index alone', async () => {
    const restoreSpy = vi.spyOn(vaultIndexStore, 'restoreMetadata');
    let reads = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        reads++;
        vaultStore.setPath('/vaultB'); // the swap lands during the awaited read
        return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 5, size: 25 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 6, size: 26 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:file-exists') return true;
      if (channel === 'tags:load') return null;
      return { success: true };
    });

    fileTagsStore._applyAddTagToPath('Note.md', 'urgent');
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 1000, interval: 20 });
    await new Promise((r) => setTimeout(r, 20));

    expect(writesIn(captured)).not.toContain('Note.md');
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('control: with no swap, the tag write lands and re-indexes the path', async () => {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 5, size: 25 };
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 25 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:file-exists') return true;
      if (channel === 'tags:load') return null;
      return { success: true };
    });

    // Distinct path/tag from the swap test above — the fileTagsStore singleton
    // carries in-memory tag membership across tests, so reusing them would make
    // `_applyAddTagToPath` early-return "already present" with no write.
    fileTagsStore._applyAddTagToPath('Control.md', 'ctrltag');
    await vi.waitFor(() => expect(writesIn(captured)).toContain('Control.md'), { timeout: 1000, interval: 20 });
    expect(lastWriteContent(captured)).toContain('ctrltag');
    await vi.waitFor(
      () => expect(vaultIndexStore.getMetadata('Control.md')?.frontmatter.tags).toContain('ctrltag'),
      { timeout: 1000, interval: 20 },
    );
  });
});

describe('UpdatePropertiesCommand bails on a vault swap', () => {
  let captured: Captured[];

  const before: PropertiesSnapshot = { kind: 'frontmatter', relPath: 'Prop.md', fm: { priority: 'low' } };
  const after: PropertiesSnapshot = { kind: 'frontmatter', relPath: 'Prop.md', fm: { priority: 'high' } };

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    captured = [];
    vaultStore.setPath('/vaultA');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  it('a swap during the read aborts the write and queues nothing for the new vault', async () => {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        vaultStore.setPath('/vaultB'); // swap lands during the read
        return { success: true, content: '---\npriority: low\nstatus: blocked\n---\nbody\n', mtimeMs: 5, size: 40 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 40 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });

    const cmd = new UpdatePropertiesCommand(before, after, 'board1');
    await cmd.execute();
    await noteStore.flushAll();

    // No write reached the new vault, and nothing of vaultA's edit is queued
    // or shown for the same-named note there.
    expect(writesIn(captured)).not.toContain('Prop.md');
    expect(noteStore.hasPendingWrites('Prop.md')).toBe(false);
    expect(noteStore.frontmatter('Prop.md').priority).toBeUndefined();
  });

  it('control: with no swap, the Properties edit lands on disk (priority + external key)', async () => {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content: '---\npriority: low\nstatus: blocked\n---\nbody\n', mtimeMs: 5, size: 40 };
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 40 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });

    const cmd = new UpdatePropertiesCommand(before, after, 'board1');
    await cmd.execute();
    await noteStore.flushAll();
    expect(writesIn(captured)).toContain('Prop.md');
    expect(lastWriteContent(captured)).toContain('priority: high');
    expect(lastWriteContent(captured)).toContain('status: blocked'); // untouched external key preserved
  });
});
