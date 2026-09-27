import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import {
  trackComponentWrite,
  hasFailedWrites,
  isPathPending,
  noteAdditionalPendingPath,
  dropPendingPath,
  markRecentSelfWrite,
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import {
  dispatchExternalChange,
  _resetRegistryForTests,
} from '@renderer/lib/vault/externalChangeRegistry';
import {
  registerExternalChangeReconcilers,
  _resetRegistrationGuardForTests,
} from '@renderer/stores/vaultExternalReconcilers';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, ProjectSettings } from '@renderer/schema/index';
import type { WorkspaceState } from '@renderer/schema/index';
import type { WorkspaceLayout } from '@renderer/stores/workspace.svelte';
import {
  recordPreservedEmergencyFile,
  listPreservedEmergencyFiles,
  clearPreservedEmergencyFilesForTarget,
  __resetEmergencyFilesForTests,
} from '../../main/services/emergencyFileRegistry';
import { atomicWriteFile } from '../../main/vault/filenameUtils';
import { writeQuitFailureBreadcrumb } from '../../main/services/quitFailureBreadcrumb';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-16 Phase 4 — write-tracking & recovery honesty.
 *
 * 4.1 / 4.2 — the per-path write generations were minted `(get(key) ?? 0) + 1`,
 * but the Audit-14 1.5/1.6 boundedness fix PRUNES the entry on a still-newest
 * success, so a later write re-minted gen 1 and could COLLIDE with the
 * generation an older timed-out write's late-success heal still held:
 * A(timeout, gen 1) / B(success, prune) / C(re-mint gen 1, fails) /
 * A lands late → generations match → A's heal erases C's legitimate failed
 * mark — clean save indicator, wiped `.filo/.dirty`, no recovery prompt while
 * C's payload never reached disk. Both maps now mint from one
 * session-monotonic counter (`mintWriteGeneration`).
 *
 * 4.4 — `cancel(key)` only consulted `pending`, so a PARKED fire (a debounce
 * fire deferred behind an in-flight write) survived a board delete: it
 * resumed after the `board:delete` IPC, hit the missing-source branch, and
 * planted a false "couldn't save" error + a permanent failed mark.
 *
 * 4.5 — a config delete-then-recreate-with-same-content blip (OneDrive/AV
 * placeholder hydration) fell through to the drift check with the STALE
 * pre-delete baseline → guaranteed abort + `lastWrittenConfigs.delete` and
 * NO rebase → every later write to that target re-aborted for the session.
 *
 * 4.6 — `emergencyFileRegistry` never pruned on a later successful write to
 * the same destination → phantom "Filo preserved emergency files" breadcrumb.
 *
 * 4.7 — the scheduler's success path pruned only the PRIMARY failureId from
 * the `failures` Set; per-target partial-failure ids (config bundle) leaked
 * until reset().
 *
 * 4.8 — the board reconciler's self-write divergence tiebreak (Audit-15 P2.4)
 * trusted the stat compare even while a NEWER self-write was queued/in flight,
 * so write N's watcher echo landing mid-N+1 read as "diverged" → spurious
 * external-edit prompt during normal rapid editing.
 */

// ── 4.1 — scheduler-level generation collision ────────────────────────

describe('Audit-16 4.1 — a pruned-then-reminted generation cannot heal across writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it("A(timeout)/B(success)/C(timeout): A's late landing must not erase C's failed mark", async () => {
    const deferreds: Array<() => void> = [];
    let mode: 'defer' | 'resolve' = 'defer';
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-4.1',
      debounceMs: 5,
      writeTimeoutMs: 40,
      // Board/config/misc shape — IPC directly, full sentinel mode, no
      // trackComponentWrite, so the timeout-branch heal is the only healer.
      performWrite: () => {
        if (mode === 'resolve') return Promise.resolve();
        return new Promise<void>((res) => { deferreds.push(res); });
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // Write A — fires, exceeds writeTimeoutMs, marked failed; its underlying
    // promise (deferreds[0]) keeps running.
    scheduler.schedule('k', () => ({ path: 'P.md' }));
    expect((await scheduler.flushAll()).failed).toContain('P.md');
    expect(hasFailedWrites()).toBe(true);

    // Write B — succeeds: clears A's failed mark AND prunes the path's
    // generation entry (Audit-14 1.6 boundedness).
    mode = 'resolve';
    scheduler.schedule('k', () => ({ path: 'P.md' }));
    expect((await scheduler.flushAll()).failed).toEqual([]);
    expect(hasFailedWrites()).toBe(false);
    expect(scheduler.__writeGenSizeForTests()).toBe(0);

    // Write C — fires after the prune (pre-fix: re-mints A's generation),
    // times out: a fresh, legitimate failed mark.
    mode = 'defer';
    scheduler.schedule('k', () => ({ path: 'P.md' }));
    expect((await scheduler.flushAll()).failed).toContain('P.md');
    expect(hasFailedWrites()).toBe(true);

    // A's IPC finally lands. Pre-fix its heal generation COLLIDED with C's
    // re-minted one and cleared C's mark — save indicator clean, sentinel
    // wiped, quit proceeds, C's payload never on disk, no recovery prompt.
    expect(deferreds.length).toBe(2); // A and C
    deferreds[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(hasFailedWrites()).toBe(true);
  });

  it("positive control (Audit-12 M2): with no interim writes, A's late landing still heals", async () => {
    let release!: () => void;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-4.1-control',
      debounceMs: 5,
      writeTimeoutMs: 40,
      performWrite: () => new Promise<void>((res) => { release = res; }),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    scheduler.schedule('k', () => ({ path: 'Q.md' }));
    expect((await scheduler.flushAll()).failed).toContain('Q.md');
    expect(hasFailedWrites()).toBe(true);

    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(hasFailedWrites()).toBe(false);
  });
});

// ── 4.2 — component-level generation collision (same class) ──────────

describe('Audit-16 4.2 — componentWriteGenByPath survives the prune/re-mint interleaving', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it("A(slow)/B(success, prunes)/C(fails): A's late success must not clear C's failure", async () => {
    let resolveA!: () => void;
    // Writer A — slow, will SUCCEED late (the wedge-then-land shape).
    const aPromise = trackComponentWrite(
      '/vault',
      'P.md',
      () => new Promise<void>((res) => { resolveA = res; }),
      { notifyOnError: false },
    );

    // Writer B — succeeds while A is in flight: clears + PRUNES the path's
    // generation entry (Audit-14 1.5/1.6).
    await trackComponentWrite('/vault', 'P.md', () => Promise.resolve(), {
      notifyOnError: false,
    });

    // Writer C — fires after the prune (pre-fix: re-mints A's generation)
    // and FAILS: a fresh, legitimate failed mark.
    await expect(
      trackComponentWrite('/vault', 'P.md', () => Promise.reject(new Error('boom')), {
        notifyOnError: false,
      }),
    ).rejects.toThrow();
    expect(hasFailedWrites()).toBe(true);

    // A lands late. Its endWrite(true) is generation-gated; pre-fix the
    // collision made it read "still newest" and erase C's mark.
    resolveA();
    await aPromise;
    expect(hasFailedWrites()).toBe(true);
  });
});

// ── 4.4 — cancel() reaches a parked fire ─────────────────────────────

describe('Audit-16 4.4 — cancel(key) neutralises a PARKED fire (board deleted mid-park)', () => {
  interface TArgs {
    vaultRoot: string;
    path: string;
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vi.useRealTimers();
  });

  /** Parks a second fire for `key` behind a controllable in-flight write A. */
  function buildParkedScheduler(getArgs: () => TArgs | null): {
    scheduler: ReturnType<typeof createScheduler<TArgs>>;
    writes: TArgs[];
    resolveA: () => void;
  } {
    vi.useFakeTimers();
    let resolveA!: () => void;
    const writes: TArgs[] = [];
    const scheduler = createScheduler<TArgs>({
      name: 'test-4.4',
      debounceMs: 100,
      performWrite: (a) => {
        writes.push(a);
        if (writes.length === 1) {
          return new Promise<void>((res) => { resolveA = res; });
        }
        return Promise.resolve();
      },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
      missingSourceMessage: () => 'Filo could not save this board.',
    });

    scheduler.schedule('k', getArgs);
    vi.advanceTimersByTime(150); // write A fires and stays in flight
    scheduler.schedule('k', getArgs);
    vi.advanceTimersByTime(150); // timer fires, sees A in flight → PARKS
    vi.useRealTimers();
    return { scheduler, writes, resolveA };
  }

  it('a cancelled parked fire neither fires nor surfaces missing-source nor marks failed', async () => {
    // Mirrors boardCacheStore.deleteBoard: cancelBoardWrite(boardId, path)
    // BEFORE the board:delete IPC, then removeBoardFromCache → getArgs null.
    let deleted = false;
    const args: TArgs = { vaultRoot: '/vault', path: 'a.board.json' };
    const { scheduler, writes, resolveA } = buildParkedScheduler(() =>
      deleted ? null : args,
    );

    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    scheduler.cancel('k', 'a.board.json'); // pre-fix: silently missed the parked fire
    deleted = true; // removeBoardFromCache landed; getArgs now misses

    resolveA(); // the prior in-flight write settles → the parked closure resumes
    await new Promise((r) => setTimeout(r, 20));

    expect(writes).toHaveLength(1); // the parked fire stayed dead
    expect(errors).toHaveLength(0); // no false "couldn't save"
    expect(hasFailedWrites()).toBe(false); // no permanent failed mark
    expect(isPathPending('a.board.json')).toBe(false); // sentinel fully balanced
  });

  it('positive control: without cancel, the parked fire lands after the drain', async () => {
    const args: TArgs = { vaultRoot: '/vault', path: 'a.board.json' };
    const { writes, resolveA } = buildParkedScheduler(() => args);

    resolveA();
    await new Promise((r) => setTimeout(r, 20));

    expect(writes).toHaveLength(2); // A + the parked fire
  });
});

// ── 4.5 — config benign-reappear rebases the baseline ────────────────

describe('Audit-16 4.5 — a same-content delete+recreate blip does not wedge the config target', () => {
  const ROOT = '/vault';

  function makeSettings(fontSize: number): ProjectSettings {
    return { general: { globalFontSize: fontSize } } as unknown as ProjectSettings;
  }
  const workspace = { openTabs: [], activeTabId: null } as unknown as WorkspaceState;
  const layout = undefined as unknown as WorkspaceLayout | undefined;

  beforeEach(() => {
    __resetDirtyTrackingForTests(); // runs configWriteScheduler's test reset callback
    __resetBaselinesForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });

  it('the armed write lands after the blip, and the NEXT write lands too', async () => {
    const saved: Record<string, string[]> = {};
    let appStatCalls = 0;
    const statFor = (rel: string): unknown => {
      if (rel !== '.filo/app.json') return { ok: true, mtimeMs: 1, size: 10 };
      appStatCalls += 1;
      // Seeding write: no baseline yet → no pre-stat; call 1 is its post-stat.
      if (appStatCalls === 1) return { ok: true, mtimeMs: 1, size: 10 };
      // The blip: the armed write's pre-stat hits ENOENT…
      if (appStatCalls === 2) return { ok: false, code: 'ENOENT', error: 'unlinked' };
      // …the L24 re-stat sees the recreated file (NEW mtime/size)…
      if (appStatCalls === 3) return { ok: true, mtimeMs: 999, size: 55 };
      // …post-write + later stats settle on the rewritten file.
      return { ok: true, mtimeMs: 1000, size: 56 };
    };
    installFiloMock({
      'vault:stat': (_root: unknown, rel: unknown) => statFor(String(rel)),
      'config:save': (_root: unknown, target: unknown, payload: unknown) => {
        (saved[String(target)] ??= []).push(String(payload));
        return { ok: true };
      },
      'config:save-workspace': () => ({ ok: true }),
      // The recreate holds OUR last-written bytes (parsed back from the
      // recorded save payload) — the provably-benign sync-client blip.
      'config:load': (_root: unknown, file: unknown) => {
        const target = String(file);
        const payloads = saved[target];
        return payloads ? JSON.parse(payloads[payloads.length - 1]!) : null;
      },
    });

    // Seed: a first successful write populates lastWrittenConfigs + baselines.
    const seed = await writeConfigs(ROOT, makeSettings(13), 'light', workspace, layout);
    expect(seed.failed).toEqual([]);
    expect(saved['app.json']).toHaveLength(1);

    // The armed write fires across the unlink+recreate blip. Pre-fix: the
    // benign branch fell through to the drift check with the STALE baseline →
    // abort + lastWrittenConfigs.delete → failed: ['app.json'].
    const second = await writeConfigs(ROOT, makeSettings(14), 'light', workspace, layout);
    expect(second.failed).toEqual([]);
    expect(saved['app.json']).toHaveLength(2);

    // The wedge was the SESSION: pre-fix every later write re-aborted against
    // the stale baseline. Assert the next write lands cleanly too.
    const third = await writeConfigs(ROOT, makeSettings(15), 'light', workspace, layout);
    expect(third.failed).toEqual([]);
    expect(saved['app.json']).toHaveLength(3);
  });
});

// ── 4.6 — emergency-file registry prunes on a later success ──────────

describe('Audit-16 4.6 — a later successful write prunes the emergency-file registry', () => {
  let dir: string;

  beforeEach(async () => {
    __resetEmergencyFilesForTests();
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-emergency-'));
  });
  afterEach(async () => {
    __resetEmergencyFilesForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a successful atomicWriteFile drops entries for its target (others survive)', async () => {
    const target = join(dir, 'note.md');
    const other = join(dir, 'other.md');
    recordPreservedEmergencyFile({
      preservedPath: join(dir, 'note.md.abc123.tmp'),
      targetPath: target,
      code: 'ENOSPC',
    });
    recordPreservedEmergencyFile({
      preservedPath: join(dir, 'other.md.def456.tmp'),
      targetPath: other,
      code: 'EIO',
    });
    expect(listPreservedEmergencyFiles()).toHaveLength(2);

    // The retried write to the SAME destination succeeds.
    await atomicWriteFile(target, 'recovered content');

    const remaining = listPreservedEmergencyFiles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.targetPath).toBe(other);
    // The recovered bytes are really on disk.
    expect(await fs.readFile(target, 'utf-8')).toBe('recovered content');
  });

  it('the quit breadcrumb is a no-op once the registry is pruned', async () => {
    const target = join(dir, 'note.md');
    recordPreservedEmergencyFile({
      preservedPath: join(dir, 'note.md.abc123.tmp'),
      targetPath: target,
      code: 'ENOSPC',
    });
    await atomicWriteFile(target, 'recovered');

    await writeQuitFailureBreadcrumb(dir);
    await expect(fs.stat(join(dir, '.filo', 'quit-failure.json'))).rejects.toThrow();
  });

  it('the prune matches case-insensitively on Windows', () => {
    const target = join(dir, 'Note.md');
    recordPreservedEmergencyFile({
      preservedPath: join(dir, 'Note.md.abc123.tmp'),
      targetPath: target,
      code: 'EACCES',
    });
    const mangled = process.platform === 'win32' ? target.toUpperCase() : target;
    clearPreservedEmergencyFilesForTarget(mangled);
    expect(listPreservedEmergencyFiles()).toHaveLength(0);
  });
});

// ── 4.7 — per-target failure ids pruned on the key's later success ───

describe('Audit-16 4.7 — partial-failure ids are pruned by the same key\'s later success', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('a fire-and-forget bundle failure leaves ids; the next success clears them all', async () => {
    let failNext = true;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-4.7',
      debounceMs: 5,
      // Config-bundle shape: per-target ids under one primary failure id.
      performWrite: () =>
        Promise.resolve(failNext ? { failed: ['app.json', 'appearance.json'] } : undefined),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
      getFailureId: () => '.filo/',
    });

    // Fire-and-forget timer fire with a partial failure — nothing drains it.
    scheduler.schedule('config-bundle', () => ({ path: '.filo/' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(scheduler.__failuresSizeForTests()).toBe(2);

    // A later success for the SAME key. Pre-fix only the primary '.filo/'
    // id was pruned, so the two per-target ids leaked until reset().
    failNext = false;
    scheduler.schedule('config-bundle', () => ({ path: '.filo/' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(scheduler.__failuresSizeForTests()).toBe(0);
  });
});

// ── 4.8 — divergence tiebreak consults pending/in-flight writes ───────

describe('Audit-16 4.8 — a self-write echo diverging under a newer queued write is dropped', () => {
  const REL = 'k.board.json';

  function makeBoard(name: string): BoardFileData {
    return {
      board: {
        id: 'kb',
        type: 'kanban',
        name,
        // A loaded board's name is its file stem, so the version marker is the emoji.
        emoji: name,
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

  function boardName(): string {
    return (boardCacheStore.cache.kb!.board as KanbanBoard).emoji ?? '';
  }

  function warningToasts(): number {
    return uiStore.toasts.filter((t) => t.type === 'warning').length;
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
    registerExternalChangeReconcilers();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    boardCacheStore.hydrate({ kb: makeBoard('original') }, { kb: REL });
    __clearRecentSelfWritesForTests();
    // Write N's echo arrives inside the suppression window…
    markRecentSelfWrite(REL);
    // …with a baseline stamped after N, but write N+1's bytes already on
    // disk (newer stat) — the P2.4 tiebreak reads "diverged".
    noteBaseline(REL, 1, 10);
    installFiloMock({
      'vault:stat': () => ({ ok: true, success: true, mtimeMs: 2, size: 11 }),
      'board:load': () => ({ version: 8, ...makeBoard('from-disk') }),
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    _resetRegistryForTests();
    _resetRegistrationGuardForTests();
  });

  it('no drift prompt while write N+1 is still queued/in flight (rapid back-to-back saves)', async () => {
    // Write N+1 is armed/in flight for the same path (full-mode schedulers
    // hold the path in pendingVaultPaths from schedule until settle).
    noteAdditionalPendingPath('/vault', REL);

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    expect(warningToasts()).toBe(0); // pre-fix: spurious "modified externally" prompt
    expect(boardName()).toBe('original'); // and no reload either — the echo is ours
    dropPendingPath('/vault', REL);
  });

  it('positive control: with NO newer write pending, a diverged echo still reconciles', async () => {
    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    // Clean board + genuine divergence → the silent-reload branch applies disk.
    expect(boardName()).toBe('from-disk');
  });

  it('positive control: a genuinely external change with a pending write still prompts', async () => {
    // NOT a recent self-write — the suppression window does not apply.
    __clearRecentSelfWritesForTests();
    noteAdditionalPendingPath('/vault', REL);

    await dispatchExternalChange({ kind: 'board', filename: REL, eventType: 'change' });

    expect(warningToasts()).toBe(1); // the dirty-editor prompt is preserved
    dropPendingPath('/vault', REL);
  });
});
