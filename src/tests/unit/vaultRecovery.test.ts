import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeRecoverySlice } from '@renderer/stores/vaultRecovery';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import {
  beginWrite,
  endWrite,
  markPathFailed,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';

/**
 * Phase 2.3 — the `.filo/.dirty` sentinel must survive a Recovery-modal
 * close that wasn't an explicit acknowledgement. Only `acknowledgeRecovery`
 * (the Dismiss button) is allowed to clear the on-disk sentinel; closing
 * via Esc / X / backdrop must leave it so the next vault open re-surfaces
 * the modal.
 *
 * `clearRecoveryPendingPaths` is the in-memory-only path used internally
 * for cleanup and must not touch disk.
 */
describe('vaultRecovery slice', () => {
  let writes: Array<{ channel: string; args: unknown[] }>;
  let recoveryPaths: string[];
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeRecoverySlice>;

  beforeEach(() => {
    writes = [];
    recoveryPaths = ['Notes.md', 'plans/q3.md'];
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      return { success: true };
    });
    ctx = {
      getVaultPath: () => '/vault',
      setVaultPath: () => {},
      getFileTree: () => [],
      setFileTree: () => {},
      getSearchQuery: () => '',
      setSearchQuery: () => {},
      getIsLoading: () => false,
      setIsLoading: () => {},
      getExpandedFolders: () => new Set(),
      setExpandedFolders: () => {},
      getSelectedPaths: () => new Set(),
      setSelectedPaths: () => {},
      getProject: () => null,
      setProject: () => {},
      getRecoveryPendingPaths: () => recoveryPaths,
      setRecoveryPendingPaths: (next) => { recoveryPaths = next; },
      // Phase 3 / 3.3 — recovery sequencer hook; no-op in unit tests.
      resolveRecoveryDismissed: () => {},
      markMetaDirty: () => {},
      refreshTree: async () => {},
      clearSelection: () => {},
      clearActiveRootFolderIfMatches: () => {},
    };
    slice = makeRecoverySlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
  });

  it('clearRecoveryPendingPaths empties the in-memory list WITHOUT touching disk', () => {
    slice.clearRecoveryPendingPaths();
    expect(recoveryPaths).toEqual([]);
    // Phase 25 L6 — vault:delete now takes (vaultRoot, itemPath); sentinel
    // path lives in args[1].
    const sentinelDelete = writes.find(
      (w) => w.channel === 'vault:delete' && String(w.args[1]).includes('.dirty'),
    );
    expect(sentinelDelete).toBeUndefined();
  });

  it('acknowledgeRecovery clears the on-disk sentinel via vault:delete', async () => {
    await slice.acknowledgeRecovery();
    expect(recoveryPaths).toEqual([]);
    // Phase 25 L6 — vault:delete now takes (vaultRoot, itemPath); sentinel
    // path lives in args[1].
    const sentinelDelete = writes.find(
      (w) => w.channel === 'vault:delete' && String(w.args[1]).endsWith('.filo/.dirty'),
    );
    expect(sentinelDelete).toBeDefined();
  });

  it('acknowledgeRecovery is a no-op when no vault is open (defensive guard)', async () => {
    const noVaultCtx: VaultContext = { ...ctx, getVaultPath: () => '' };
    const noVaultSlice = makeRecoverySlice(noVaultCtx);
    await noVaultSlice.acknowledgeRecovery();
    const sentinelDelete = writes.find((w) => w.channel === 'vault:delete');
    expect(sentinelDelete).toBeUndefined();
  });

  // Audit-14 1.2 — acknowledgeRecovery must gate the sentinel clear on the write
  // tracker being idle. Dismissing the modal while a write is still pending must
  // NOT wipe the breadcrumb for that genuinely-unflushed file.
  it('does NOT clear the sentinel while a write is in flight, but clears once idle (1.2)', async () => {
    __resetDirtyTrackingForTests();
    // Simulate an in-flight write for the active vault.
    beginWrite('/vault', 'Notes.md');
    writes.length = 0;

    await slice.acknowledgeRecovery();
    // No markClean while a write is pending — the breadcrumb survives.
    expect(writes.find((w) => w.channel === 'vault:delete')).toBeUndefined();

    // Drain the write → idle. A fresh acknowledge now clears the sentinel.
    endWrite('/vault', 'Notes.md', true);
    writes.length = 0;
    await slice.acknowledgeRecovery();
    expect(
      writes.find(
        (w) => w.channel === 'vault:delete' && String(w.args[1]).endsWith('.filo/.dirty'),
      ),
    ).toBeDefined();
    __resetDirtyTrackingForTests();
  });

  it('re-marks the sentinel with remaining failed paths instead of clearing (1.2)', async () => {
    __resetDirtyTrackingForTests();
    // A failed write keeps the tracker non-idle even with no in-flight count.
    // (Paths are stored case-folded as `VaultPath`, so use a lowercase path.)
    markPathFailed('/vault', 'notes/x.md');
    writes.length = 0;

    await slice.acknowledgeRecovery();
    // Not cleared — re-marked dirty with the still-failed path.
    expect(writes.find((w) => w.channel === 'vault:delete')).toBeUndefined();
    const dirty = writes.find(
      (w) => w.channel === 'vault:write-file-text' && String(w.args[1]).endsWith('.filo/.dirty'),
    );
    expect(dirty).toBeDefined();
    const body = JSON.parse(dirty?.args[2] as string);
    expect(body.pendingPaths).toContain('notes/x.md');
    __resetDirtyTrackingForTests();
  });
});
