import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  withDrainedWrites,
  __resetDrainGuardForTests,
} from '@renderer/lib/vault/vaultOperations';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
import { noteStore } from '@renderer/stores/notes.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  checkRecovery,
  markDirty,
  stashRecoveryStatusBeforeCommit,
  __resetRecoveryStashForTests,
  __resetDirtyRecoveryDedupeForTests,
  __getLaunchIdForTests,
} from '@renderer/lib/vault/dirtyFlagRecovery';
import { currentVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import {
  writePendingRenameCascade,
  __resetRenameCascadeSentinelForTests,
} from '@renderer/lib/vault/renameCascadeSentinel';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-17 Phase 3 — lifecycle, vault-swap, and recovery correctness.
 *
 *  3.1 A failed FIRST vault open left the main registry armed at the failed
 *      path (init-config only rolls back when initVaultConfig itself throws),
 *      and the failure-path `vault:close` fired only `if (outgoingVaultPath)`
 *      — null on a first open — so every OTHER vault failed init-config's
 *      "different vault already active" guard until restart.
 *  3.2 Open-time repair writes REPLACE a genuine prior-crash `.filo/.dirty.a1b2c3d4e5f6`
 *      payload (beginWrite → refreshSentinel → markDirty) before the recovery
 *      sequencer reads it; the Audit-16 3.3 self-write suppression then hid
 *      the crash entirely. Fix: the candidate phase reads + stashes the
 *      sentinel PRE-COMMIT and `checkRecovery` consumes the stash.
 *  3.3 Esc/X/backdrop on the Recovery modal bypassed `acknowledgeRecovery`,
 *      parking the recovery sequencer forever (steps 2–4 never ran). Fix:
 *      dismiss-is-acknowledge via the Modal's `beforeClose` in AppShell.
 *  3.4 `withDrainedWrites` treated CONCURRENT siblings as nested: a sibling
 *      arriving while the drain was in flight (parked up to ~60 s behind a
 *      board drift prompt) ran its disk-shape op with NO drain. Fix: siblings
 *      queue on the in-flight drain's promise.
 *  3.5 `vault:watch` re-armed the registry + started a watcher after two
 *      awaits with no re-assert — a `vault:close` / rapid swap completing
 *      inside the window was silently reversed. Fix: registry epoch captured
 *      before the awaits, re-checked after each.
 *  3.6 An external rename whose pre-cascade drain failed returned with no
 *      cascade AND no sentinel — the rename was never re-synthesised and
 *      `pruneOrphanFileTags` dropped the old path's vault-local attachment
 *      tags permanently. Fix: lay the rename-cascade sentinel before the
 *      early return.
 *  3.7 `writePendingRenameCascade` clobbered an UNREADABLE sentinel with a
 *      fresh single-entry file (`existing.entries ?? []`). Fix: refuse +
 *      preserve + throw.
 *  3.8 Recovery snapshots discarded the folder (`basename(rel)`): same-ms
 *      same-basename collisions kept one copy, and the per-basename pruner
 *      conflated unrelated same-named files across folders. Fix: flatten the
 *      rel path into the snapshot filename and key the prune on it.
 */

// ── Main-side harness for 3.5 (mirrors vaultWatchRequiresActiveVault.test.ts) ──

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      ipcHandlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
}));

const { registerVaultHandlers, stopActiveWatcher } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { snapshotForRecovery, listRecoverySnapshots } = await import(
  '../../main/services/recoverySnapshot'
);

function dismissAllToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

// ── 3.2 — pre-commit sentinel stash ──────────────────────────────────

describe('Audit-17 3.2 — pre-commit stash preserves the prior-crash sentinel payload', () => {
  /** Simulated `.filo/.dirty.a1b2c3d4e5f6` bytes on disk; markDirty replaces them. */
  let dirtyContent: string | null;

  beforeEach(() => {
    __resetRecoveryStashForTests();
    __resetDirtyRecoveryDedupeForTests();
    dirtyContent = null;
    installFiloMock({
      'vault:read-file-text': async (...args: unknown[]) => {
        const rel = String(args[1]);
        if (rel === '.filo/.dirty.a1b2c3d4e5f6') {
          if (dirtyContent === null) return { success: false, code: 'ENOENT', error: 'ENOENT' };
          return { success: true, content: dirtyContent };
        }
        return { success: false, code: 'ENOENT', error: 'ENOENT' };
      },
      'vault:write-file-text': async (...args: unknown[]) => {
        if (String(args[1]) === '.filo/.dirty.a1b2c3d4e5f6') dirtyContent = String(args[2]);
        return { success: true };
      },
    });
  });

  afterEach(() => {
    __resetRecoveryStashForTests();
    __resetDirtyRecoveryDedupeForTests();
    restoreFiloDefault();
  });

  it('an open-time repair write that replaces the sentinel cannot hide the prior crash', async () => {
    // A genuine prior-crash breadcrumb from a different session.
    dirtyContent = JSON.stringify({
      dirtyAt: 1111,
      pendingPaths: ['crash/Notes.md'],
      launchId: 'a-prior-session',
    });

    // Candidate phase: read + stash BEFORE the commit can schedule writes.
    await stashRecoveryStatusBeforeCommit('/vault');

    // Commit-time repair write: beginWrite → refreshSentinel → markDirty
    // REPLACES the on-disk sentinel with THIS session's pending set, stamped
    // with this launchId + the current generation.
    await markDirty('/vault', ['Repaired.board.json']);
    expect(dirtyContent).toContain('Repaired.board.json');

    // Sequencer step 1: consumes the stash — the crash payload survives.
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toEqual(['crash/Notes.md']);
  });

  it('control — WITHOUT a stash the live read is suppressed (the pre-fix loss shape)', async () => {
    // Same replace sequence, but no pre-commit stash: the live read sees a
    // sentinel stamped by THIS launch + generation and suppresses it.
    await markDirty('/vault', ['Repaired.board.json']);
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(false);
  });

  it('the stashed read skips the self-write suppression (same-path reopen breadcrumb prompts)', async () => {
    // A sentinel preserved by a Don't-Save swap-away earlier in THIS process:
    // pre-commit the generation has not been bumped yet, so it matches the
    // current launchId + generation — the suppression would wrongly hide it.
    dirtyContent = JSON.stringify({
      dirtyAt: 2222,
      pendingPaths: ['kept.md'],
      launchId: __getLaunchIdForTests(),
      vaultGeneration: currentVaultGeneration(),
    });

    await stashRecoveryStatusBeforeCommit('/vault');
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toEqual(['kept.md']);
  });

  it('a stash for a different vault root is discarded — the live read runs instead', async () => {
    dirtyContent = JSON.stringify({
      dirtyAt: 3333,
      pendingPaths: ['other.md'],
      launchId: 'a-prior-session',
    });
    await stashRecoveryStatusBeforeCommit('/vault-X');

    // The live read against /vault-Y sees no sentinel (ENOENT route below
    // only serves '/vault's content — any root gets the same bytes, so make
    // the disk clean first).
    dirtyContent = null;
    const status = await checkRecovery('/vault-Y');
    expect(status.needsRecovery).toBe(false);
  });
});

// ── 3.4 — concurrent withDrainedWrites siblings ───────────────────────

describe('Audit-17 3.4 — concurrent withDrainedWrites siblings queue behind the in-flight drain', () => {
  beforeEach(() => {
    __resetDrainGuardForTests();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    restoreFiloDefault();
    dismissAllToasts();
  });

  afterEach(() => {
    __resetDrainGuardForTests();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    restoreFiloDefault();
    dismissAllToasts();
    vi.useRealTimers();
  });

  it('a sibling arriving during a slow drain runs its op only after the drain resolves', async () => {
    const events: string[] = [];
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((res) => { releaseWrite = res; });

    installFiloMock({});
    // Park the drain: the misc flush awaits this gated write.
    scheduleMiscWrite('audit17-3.4-slow', () => ({
      vaultRoot: '/vault',
      path: '.filo/slow.json',
      write: async () => {
        events.push('drain-write:start');
        await writeGate;
        events.push('drain-write:end');
      },
    }));

    const first = withDrainedWrites(async () => {
      events.push('op1');
    });
    // Let the first call enter its drain (sets the guard + drainPromise).
    await Promise.resolve();
    const sibling = withDrainedWrites(async () => {
      events.push('op2');
    });

    // While the drain is parked, the sibling must NOT have run its op —
    // pre-fix it took the nested short-circuit and ran immediately.
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toContain('drain-write:start');
    expect(events).not.toContain('op2');

    releaseWrite();
    await Promise.all([first, sibling]);

    expect(events).toContain('op1');
    expect(events.indexOf('drain-write:end')).toBeLessThan(events.indexOf('op2'));
  });

  it('Audit-18 5.3 — a sibling SHARES a failed drain verdict instead of re-draining (no hang, no per-sibling re-drain)', async () => {
    const events: string[] = [];
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((res) => { releaseWrite = res; });

    installFiloMock({});
    scheduleMiscWrite('audit17-3.4-failing', () => ({
      vaultRoot: '/vault',
      path: '.filo/failing.json',
      write: async () => {
        await writeGate;
        throw new Error('simulated drain write failure');
      },
    }));

    const first = withDrainedWrites(async () => {
      events.push('op1');
    });
    await Promise.resolve();
    const sibling = withDrainedWrites(async () => {
      events.push('op2');
    });

    releaseWrite();
    // Audit-18 5.3 — the outer drain fails; the sibling now SHARES that verdict
    // and throws the same error rather than re-entering a fresh full drain (the
    // old `return withDrainedWrites(op)` ran one ~60 s drain per parked sibling
    // and re-toasted each time). Neither op runs — refusing a disk-shape op
    // behind a failed flush is the safe direction. (The proof of "no re-drain"
    // is the sibling REJECTING: a re-drain would find no pending misc write,
    // succeed vacuously, and run op2.)
    await expect(first).rejects.toThrow();
    await expect(sibling).rejects.toThrow();
    expect(events).not.toContain('op1');
    expect(events).not.toContain('op2');
  });
});

// ── 3.7 — unreadable rename-cascade sentinel is preserved ─────────────

describe('Audit-17 3.7 — writePendingRenameCascade refuses to clobber an unreadable sentinel', () => {
  const SENTINEL_REL = '.filo/rename-cascade-pending.a1b2c3d4e5f6.json';
  let sentinelWrites: string[];
  let sentinelContent: string | null;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRenameCascadeSentinelForTests();
    sentinelWrites = [];
    sentinelContent = null;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installFiloMock({
      'vault:read-file-text': async (...args: unknown[]) => {
        if (String(args[1]) === SENTINEL_REL && sentinelContent !== null) {
          return { success: true, content: sentinelContent };
        }
        return { success: false, code: 'ENOENT', error: 'ENOENT' };
      },
      'vault:write-file-text': async (...args: unknown[]) => {
        if (String(args[1]) === SENTINEL_REL) sentinelWrites.push(String(args[2]));
        return { success: true };
      },
    });
  });

  afterEach(() => {
    errSpy.mockRestore();
    __resetRenameCascadeSentinelForTests();
    restoreFiloDefault();
    dismissAllToasts();
  });

  it('rejects and leaves the torn sentinel bytes untouched', async () => {
    sentinelContent = '{ torn-mid-write';
    await expect(
      writePendingRenameCascade('/vault', {
        oldPath: 'a.md',
        newPath: 'b.md',
        affectedBoardIds: [],
      }),
    ).rejects.toThrow(/unreadable/);
    // No write fired — the breadcrumb (and any healthy entries a transient
    // read failure hid) survives for next-open recovery.
    expect(sentinelWrites).toHaveLength(0);
  });

  it('control — a parseable sentinel still appends (existing entries kept)', async () => {
    sentinelContent = JSON.stringify({
      entries: [{
        id: 'prior-entry',
        timestamp: 1,
        oldPath: 'x.md',
        newPath: 'y.md',
        affectedBoardIds: ['b1'],
      }],
    });
    const id = await writePendingRenameCascade('/vault', {
      oldPath: 'a.md',
      newPath: 'b.md',
      affectedBoardIds: [],
    });
    expect(sentinelWrites).toHaveLength(1);
    const written = JSON.parse(sentinelWrites[0] ?? '{}') as {
      entries: Array<{ id: string; oldPath: string }>;
    };
    expect(written.entries).toHaveLength(2);
    expect(written.entries[0]?.id).toBe('prior-entry');
    expect(written.entries[1]?.id).toBe(id);
  });
});

// ── 3.6 — drain failure during an external rename lays a breadcrumb ──

describe('Audit-17 3.6 — external rename drain failure writes the rename-cascade sentinel', () => {
  const SENTINEL_REL = '.filo/rename-cascade-pending.a1b2c3d4e5f6.json';

  function ctxFor(): VaultContext {
    return {
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
      getRecoveryPendingPaths: () => [],
      setRecoveryPendingPaths: () => {},
      markMetaDirty: () => {},
      refreshTree: async () => {},
      clearSelection: () => {},
      clearActiveRootFolderIfMatches: () => {},
    };
  }

  beforeEach(() => {
    __resetDrainGuardForTests();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    __resetRenameCascadeSentinelForTests();
    dismissAllToasts();
  });

  afterEach(() => {
    __resetDrainGuardForTests();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    __resetRenameCascadeSentinelForTests();
    restoreFiloDefault();
    dismissAllToasts();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a failed pre-cascade drain still records old→new for next-open recovery', async () => {
    vaultStore.setPath('/vault');
    // The failing note write reports through reportError (console breadcrumb).
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sentinelWrites: string[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      // The armed editor write fails — that's the drain failure under test.
      if (channel === 'vault:write-existing-file-text') {
        return { success: false, error: 'EACCES: permission denied' };
      }
      if (channel === 'vault:read-file-text') {
        return { success: false, code: 'ENOENT', error: 'ENOENT' };
      }
      if (channel === 'vault:write-file-text') {
        if (String(args[1]) === SENTINEL_REL) sentinelWrites.push(String(args[2]));
        return { success: true };
      }
      if (channel === 'tags:load') return null;
      return { success: true };
    });

    // Queue a note write against the OLD path so the cascade's drain has
    // something to (fail to) flush.
    noteStore.patchFrontmatter('Old.md', { set: { status: 'pending edit' }, unset: [] });

    const slice = makeExternalChangesSlice(ctxFor());
    await slice.handleExternalRename('Old.md', 'New.md');

    // The cascade was skipped (drain failed), but the breadcrumb landed so
    // next-open recovery replays it — including the tags.json re-assert.
    expect(sentinelWrites).toHaveLength(1);
    const parsed = JSON.parse(sentinelWrites[0] ?? '{}') as {
      entries: Array<{ oldPath: string; newPath: string }>;
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      oldPath: 'Old.md',
      newPath: 'New.md',
    });
  });
});

// ── 3.5 — vault:watch TOCTOU epoch guard (main side) ─────────────────

describe('Audit-17 3.5 — vault:watch bails when the registry changes under its awaits', () => {
  type WatchResult = { success: boolean; code?: string; error?: string };
  let watchHandler: (...args: unknown[]) => Promise<WatchResult>;
  let vaultDir: string;
  let otherDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const w = ipcHandlers.get('vault:watch');
    if (!w) throw new Error('vault:watch handler not registered');
    watchHandler = w as (...args: unknown[]) => Promise<WatchResult>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-watch-epoch-'));
    otherDir = await fs.mkdtemp(join(tmpdir(), 'filo-watch-epoch-other-'));
    vaultRegistry.setCurrentVault(null);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await stopActiveWatcher();
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  function interceptStatOnce(onIntercept: () => void): { mockRestore(): void } {
    let intercepted = false;
    // Bind the real implementation BEFORE installing the spy — resolving it
    // lazily via `vi.importActual` inside the mock deadlocks under this
    // file's `vi.mock('electron')` module graph.
    const realStat = fs.stat.bind(fs);
    return vi.spyOn(fs, 'stat').mockImplementation(((async (p: unknown) => {
      if (!intercepted && typeof p === 'string' && p === vaultDir) {
        intercepted = true;
        // The registry mutation lands while the handler is parked on this
        // await — exactly the TOCTOU window 3.5 closes.
        onIntercept();
      }
      return realStat(p as never);
    }) as unknown) as typeof fs.stat);
  }

  it('a vault:close completing during the stat await is not reversed (registry stays closed)', async () => {
    vaultRegistry.setCurrentVault(vaultDir);
    const statSpy = interceptStatOnce(() => vaultRegistry.setCurrentVault(null));
    try {
      const res = await watchHandler({}, vaultDir);
      expect(res.success).toBe(false);
      // Pre-fix the handler unconditionally re-armed the registry here.
      expect(vaultRegistry.currentVaultPath).toBeNull();
    } finally {
      statSpy.mockRestore();
    }
  });

  it('a rapid swap-to-B completing during the stat await stays at B', async () => {
    vaultRegistry.setCurrentVault(vaultDir);
    const statSpy = interceptStatOnce(() => vaultRegistry.setCurrentVault(otherDir));
    try {
      const res = await watchHandler({}, vaultDir);
      expect(res.success).toBe(false);
      // The stale watch must not re-arm A over B's registration.
      const current = vaultRegistry.currentVaultPath ?? '';
      expect(current).toContain('filo-watch-epoch-other-');
    } finally {
      statSpy.mockRestore();
    }
  });

  it('control — an undisturbed watch still succeeds', async () => {
    vaultRegistry.setCurrentVault(vaultDir);
    const res = await watchHandler({}, vaultDir);
    expect(res.success).toBe(true);
  });
});

// ── 3.8 — recovery snapshot path flattening (main side, real fs) ─────

describe('Audit-17 3.8 — recovery snapshots flatten the rel path into the filename', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-flat-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('two same-basename files snapshotted in the same ms are both preserved', async () => {
    await fs.mkdir(join(vaultRoot, 'a'), { recursive: true });
    await fs.mkdir(join(vaultRoot, 'b'), { recursive: true });
    await fs.writeFile(join(vaultRoot, 'a', 'Notes.md'), 'content-A', 'utf-8');
    await fs.writeFile(join(vaultRoot, 'b', 'Notes.md'), 'content-B', 'utf-8');

    // Pin the clock so both snapshots land in the SAME timestamp subdir —
    // the pre-fix `basename(rel)` dest made the second silently win.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00.123Z'));
    const destA = await snapshotForRecovery(vaultRoot, 'a/Notes.md');
    const destB = await snapshotForRecovery(vaultRoot, 'b/Notes.md');
    vi.useRealTimers();

    expect(destA).not.toBe(destB);
    expect(await fs.readFile(destA, 'utf-8')).toBe('content-A');
    expect(await fs.readFile(destB, 'utf-8')).toBe('content-B');
  });

  it('pruning 20+ snapshots of folderB/Notes.md leaves folderA/Notes.md untouched', async () => {
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });

    // One preserved copy of the UNRELATED folderA file…
    const aSubdir = join(recoveryRoot, '2026-01-01T00-00-00.000');
    await fs.mkdir(aSubdir, { recursive: true });
    const aSnapshot = join(aSubdir, 'folderA__Notes.md');
    await fs.writeFile(aSnapshot, 'precious-A', 'utf-8');
    const aMtime = new Date(2026, 0, 1, 0, 0, 0);
    await fs.utimes(aSnapshot, aMtime, aMtime);

    // …plus 25 historical snapshots of folderB's same-named file (all newer,
    // so under the pre-fix shared-basename prune the A copy is the OLDEST
    // match and is deterministically evicted).
    for (let i = 0; i < 25; i++) {
      const subdir = join(recoveryRoot, `2026-02-01T00-00-${String(i).padStart(2, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, 'folderB__Notes.md');
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2026, 1, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
    }

    await fs.mkdir(join(vaultRoot, 'folderB'), { recursive: true });
    await fs.writeFile(join(vaultRoot, 'folderB', 'Notes.md'), 'fresh-B', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'folderB/Notes.md');

    // folderB pruned to its own 20-copy cap; folderA untouched.
    await expect(fs.readFile(aSnapshot, 'utf-8')).resolves.toBe('precious-A');
    let bCount = 0;
    for (const dir of await fs.readdir(recoveryRoot)) {
      try {
        await fs.access(join(recoveryRoot, dir, 'folderB__Notes.md'));
        bCount += 1;
      } catch {
        // Not in this subdir.
      }
    }
    expect(bCount).toBe(20);
    // ~80 real-fs ops (mkdir/write/utimes/readdir + the prune): well under a
    // second alone, but it overran the 5s default under the full parallel
    // suite. Budget for contention, not for a slow implementation.
  }, 20_000);

  it('sentinel snapshots stay filtered from the listing under flattened names', async () => {
    const subdir = join(vaultRoot, '.filo', 'recovery', '2026-03-01T00-00-00.000');
    await fs.mkdir(subdir, { recursive: true });
    // A flattened sentinel snapshot, a bare-basename one, and a genuine
    // user-file snapshot.
    await fs.writeFile(join(subdir, '.filo__.dirty.aaaaaaaaaaaa'), '{}', 'utf-8');
    await fs.writeFile(join(subdir, '.dirty.aaaaaaaaaaaa'), '{}', 'utf-8');
    await fs.writeFile(join(subdir, 'folderA__Notes.md'), 'user bytes', 'utf-8');

    const listed = await listRecoverySnapshots(vaultRoot);
    expect(listed.map((s) => s.basename)).toEqual(['folderA__Notes.md']);
  });
});

// ── 3.3 — dismiss-is-acknowledge wiring pin ──────────────────────────

describe('Audit-17 3.3 — every Recovery modal close path un-parks the sequencer', () => {
  it('AppShell wires beforeClose → bypassRecoveryModalClose on the recovery-files Modal', async () => {
    const src = await fs.readFile(
      join(process.cwd(), 'src/renderer/components/layout/AppShell.svelte'),
      'utf-8',
    );
    const idx = src.indexOf('id="recovery-files"');
    expect(idx).toBeGreaterThan(-1);
    // The Esc / X / backdrop close paths all route through Modal's
    // `beforeClose`; without this hook they bypass the recovery sequencer
    // resolver and it parks forever (steps 2–4 never run). Audit-18 4.1
    // NARROWED A17-3.3: a bypassed close un-parks the sequencer via
    // `bypassRecoveryModalClose()` (which preserves the `.filo/.dirty.a1b2c3d4e5f6`
    // sentinel) rather than `acknowledgeRecovery()` (which destroys it) —
    // only the explicit Dismiss button acknowledges.
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/beforeClose=/);
    expect(block).toMatch(/bypassRecoveryModalClose\(\)/);
    // And must NOT acknowledge (destroy the breadcrumb) on a bypassed close.
    expect(block).not.toMatch(/acknowledgeRecovery\(\)/);
  });
});

// ── 3.1 — failed FIRST open releases the registry (kept last: drives the
//          full vaultStore.openVault transaction) ─────────────────────

describe('Audit-17 3.1 — a failed FIRST open does not lock out other vaults', () => {
  const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

  interface RegistryState { current: string | null; }

  function buildRoutes(registry: RegistryState, readTreeFails: (root: string) => boolean) {
    return {
      'dialog:choice': async () => 1, // "Cancel" if asked: nothing is unsaved, so no leave dialog appears.
      'vault:close': async () => {
        registry.current = null;
        return { success: true };
      },
      'vault:init-config': async (root: unknown) => {
        const path = typeof root === 'string' ? root : '';
        if (registry.current && registry.current !== path) {
          return {
            ok: false,
            error:
              'A different vault is already active — close it before initialising a new one',
          };
        }
        registry.current = path;
        return { ok: true };
      },
      'config:load-all': async () => ({}),
      'board:list': async () => [],
      'vault:read-tree': async (root: unknown) => {
        const path = typeof root === 'string' ? root : '';
        if (readTreeFails(path)) {
          return { ok: false, code: 'EIO', error: 'read-tree boom' };
        }
        return { ok: true, tree: [] };
      },
      'theme:list': async () => [],
      'theme:load': async () => null,
      'tags:load': async () => VALID_TAGS_JSON,
      'vault:stat': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
      'vault:watch': async () => ({ success: true }),
      'vault:read-file-text': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
      'recovery:list': async () => [],
    };
  }

  beforeEach(() => {
    restoreFiloDefault();
    dismissAllToasts();
  });

  afterEach(() => {
    restoreFiloDefault();
    dismissAllToasts();
  });

  it('after a first open fails post-init-config, a DIFFERENT vault still opens', async () => {
    const registry: RegistryState = { current: null };
    // Only vault A's tree read fails — its init-config succeeds first, so
    // the registry is armed at A when the candidate load throws.
    installFiloMock(buildRoutes(registry, (root) => root === '/vault/A'));

    const okA = await vaultStore.openVault('/vault/A');
    expect(okA).toBe(false);
    // THE discriminator: pre-fix there is no failure-path `vault:close` on a
    // first open (no outgoing vault), so the registry stayed armed at
    // '/vault/A' and the B open below failed its init-config.
    expect(registry.current).toBeNull();

    const okB = await vaultStore.openVault('/vault/B');
    expect(okB).toBe(true);
    expect(vaultStore.path).toBe('/vault/B');
    expect(registry.current).toBe('/vault/B');

    // Let B's fire-and-forget post-commit tasks (watcher start, recovery
    // sequencer sentinel reads) settle while the routed mock is still
    // installed, so they don't spray stderr against the torn-down default.
    await new Promise((res) => setTimeout(res, 25));
  });
});
