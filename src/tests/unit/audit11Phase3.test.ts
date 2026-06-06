import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  dropPendingDelta,
  cancelFrontmatterWrite,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import {
  cancelAllMarkdownWrites,
  flushAllMarkdownWriters,
} from '@renderer/lib/vault/markdownFileWriter';
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
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-11 Phase 3 — external-edit (EER-1) + vault-swap MED guards
 * (VS-1 / VS-2 / FILO-UR-2).
 *
 * EER-1: a field edit arms a Phase-4 frontmatter delta. If the user then chooses
 * "Reload" on an external-change prompt (discarding their local edit), the still-
 * armed delta would re-apply to fresh disk via the reload's flush and silently
 * revert the external edit. `dropPendingDelta` (and `cancelFrontmatterWrite`,
 * which now delegates to it) drops the delta + cancels the timer.
 *
 * VS-1/VS-2/FILO-UR-2: rename-cascade recovery, fileTags tag writers, and the
 * Properties command read the active vault path, await disk I/O, then mutate
 * renderer state. A vault swap on that await must bail (`isStillSameVault`)
 * before applying the outgoing vault's data to the new vault.
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

describe('Audit-11 EER-1 — a discarded field delta does not re-clobber after Reload', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    resetFrontmatterScheduler();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    captured = [];
    vaultStore.setPath('/vault');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    resetFrontmatterScheduler();
    cancelAllMarkdownWrites();
    documentStore.clear();
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

  it('control: an armed delta DOES write on flush (proves the re-clobber vector exists)', async () => {
    installDisk('---\ncompleted: false\nstatus: blocked\n---\nbody\n');
    scheduleFrontmatterWrite('Note.md', null, patchToFrontmatterDelta({ priority: 'high' }));
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWriteContent(captured)).toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );
    expect(lastWriteContent(captured)).toContain('priority: high');
    expect(lastWriteContent(captured)).toContain('status: blocked'); // untouched key preserved
  });

  it('open-editor leg: dropPendingDelta discards it — flush writes nothing', async () => {
    installDisk('---\ncompleted: false\nstatus: blocked\n---\nbody\n');
    scheduleFrontmatterWrite('Note.md', null, patchToFrontmatterDelta({ priority: 'high' }));
    // The reload-discard call sites drop the delta BEFORE applyReloadFromDisk.
    dropPendingDelta('Note.md');
    await flushAllPendingFrontmatterWrites();
    await flushAllPendingFrontmatterWrites();
    expect(writesIn(captured)).not.toContain('Note.md');
  });

  it('closed-card F4 leg: cancelFrontmatterWrite drops the delta too', async () => {
    installDisk('---\ncompleted: false\n---\nbody\n');
    scheduleFrontmatterWrite('Card.md', null, patchToFrontmatterDelta({ priority: 'high' }));
    cancelFrontmatterWrite('Card.md');
    await flushAllPendingFrontmatterWrites();
    await flushAllPendingFrontmatterWrites();
    expect(writesIn(captured)).not.toContain('Card.md');
  });

  it('drop is path-scoped: a delta for a DIFFERENT path still flushes', async () => {
    installDisk('---\ncompleted: false\n---\nbody\n');
    scheduleFrontmatterWrite('Discarded.md', null, patchToFrontmatterDelta({ priority: 'high' }));
    scheduleFrontmatterWrite('Kept.md', null, patchToFrontmatterDelta({ priority: 'low' }));
    dropPendingDelta('Discarded.md');
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(writesIn(captured)).toContain('Kept.md');
      },
      { timeout: 1000, interval: 20 },
    );
    expect(writesIn(captured)).not.toContain('Discarded.md');
  });
});

describe('Audit-11 VS-1 — repairRenameCascade bails on a vault swap', () => {
  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    documentStore.clear();
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
    documentStore.clear();
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
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue(undefined);
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
        tagsAffected: false,
      },
    ];
    const result = await repairRenameCascade(entries, '/vaultA', 'Retry', captured);

    expect(result).toBeNull();
    expect(renameSpy).not.toHaveBeenCalled(); // bailed after ensureAllLoaded
    expect(flushSpy).not.toHaveBeenCalled();
  });
});

describe('Audit-11 VS-2 — fileTags tag writers bail on a vault swap', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    captured = [];
    vaultStore.setPath('/vaultA');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  it('a swap during the tag-write read skips applyChanges (new vault not re-indexed)', async () => {
    const applySpy = vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
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
    // The write IPC still fires (it's main-gated in prod); poll for it, then let
    // the post-write continuation run. The bail must skip the index re-apply.
    await vi.waitFor(() => expect(writesIn(captured)).toContain('Note.md'), { timeout: 1000, interval: 20 });
    await Promise.resolve();
    await Promise.resolve();

    expect(applySpy).not.toHaveBeenCalled();
  });

  it('control: with no swap, the tag write re-indexes the path', async () => {
    const applySpy = vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 5, size: 25 };
      if (channel === 'vault:stat') return { success: true, mtimeMs: 6, size: 26 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      if (channel === 'vault:file-exists') return true;
      if (channel === 'tags:load') return null;
      return { success: true };
    });

    // Distinct path/tag from the swap test above — the fileTagsStore singleton
    // carries in-memory tag membership across tests, so reusing them would make
    // `_applyAddTagToPath` early-return "already present" with no write.
    fileTagsStore._applyAddTagToPath('Control.md', 'ctrltag');
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledWith(['Control.md']), { timeout: 1000, interval: 20 });
  });
});

describe('Audit-11 FILO-UR-2 — UpdatePropertiesCommand bails on a vault swap', () => {
  let captured: Captured[];

  const before: PropertiesSnapshot = { kind: 'frontmatter', relPath: 'Prop.md', docId: 'docP', fm: { priority: 'low' } };
  const after: PropertiesSnapshot = { kind: 'frontmatter', relPath: 'Prop.md', docId: 'docP', fm: { priority: 'high' } };

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    captured = [];
    vaultStore.setPath('/vaultA');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    vaultStore.setPath('');
    __resetVaultIdentityForTests();
    vi.restoreAllMocks();
  });

  it('a swap during the hydrate read aborts the write AND the FM cache seed', async () => {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        vaultStore.setPath('/vaultB'); // swap lands during the hydrate read
        return { success: true, content: '---\npriority: low\nstatus: blocked\n---\nbody\n', mtimeMs: 5, size: 40 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 40 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });

    const cmd = new UpdatePropertiesCommand(before, after, 'board1');
    await cmd.execute();
    await flushAllMarkdownWriters();

    // The captured-vaultRoot write never ran, and the new vault's doc cache was
    // NOT seeded with vaultA's disk frontmatter.
    expect(writesIn(captured)).not.toContain('Prop.md');
    expect(documentStore.getFrontmatter('docP')).toBeUndefined();
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
    await vi.waitFor(() => expect(writesIn(captured)).toContain('Prop.md'), { timeout: 1000, interval: 20 });
    expect(lastWriteContent(captured)).toContain('priority: high');
    expect(lastWriteContent(captured)).toContain('status: blocked'); // untouched external key preserved
  });
});
