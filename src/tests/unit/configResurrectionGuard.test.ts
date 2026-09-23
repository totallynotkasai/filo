import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs, seedConfigSnapshots } from '@renderer/lib/boards/configWriteScheduler';
import {
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * Audit2 5.1 — externally-deleted `.filo/` config must NOT be resurrected by
 * the next debounced write. The pre-write `vault:stat` probe was already in
 * place for drift detection, but its catch swallowed ENOENT and fell through
 * to the `config:save` IPC, which `mkdir -p`'d the parent and re-created the
 * file. The guard now mirrors `writeBoardFile`'s ENOENT short-circuit:
 * when the file was previously known to exist (`baseline !== undefined`) and
 * the pre-write stat says it's gone, skip the target as a clean no-op.
 *
 * Fresh configs (no baseline) are still allowed to write — initial
 * `configOps.initVaultConfig` writes happen before any baseline is noted, so
 * the seed path is unaffected.
 */

const VAULT_ROOT = '/vault';

function makeSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
  return {
    general: {
      // Use a unique value per call so the payload differs from any
      // previously-cached `lastWrittenConfigs` entry and the write isn't
      // dedup-skipped.
      globalFont: `test-font-${Math.floor(performance.now() * 1000)}`,
    },
    mindmap: {},
    kanban: {},
    tasklist: {},
    document: {},
    ...overrides,
  } as ProjectSettings;
}

function makeWorkspace(): WorkspaceState {
  return { openTabs: [], activeTabId: '' };
}

describe('configWriteScheduler — ENOENT skip-on-resurrection (5.1)', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });

  it('skips a target whose pre-write stat reports ENOENT (does not resurrect)', async () => {
    // Seed a baseline for `.filo/defaults.json` so the writer takes the
    // drift-check branch. The actual values don't matter — only "baseline
    // exists" gates the stat probe.
    noteBaseline('.filo/defaults.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json') {
          // Simulate the file was deleted externally.
          return Promise.resolve({ ok: false, code: 'ENOENT', error: 'not found' });
        }
        // Other config files still exist.
        return Promise.resolve({ ok: true, mtimeMs: 2000, size: 99 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    // defaults.json must NOT have been written — the deleted file stays deleted.
    const defaultsSaveCalls = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaveCalls).toHaveLength(0);

    // The skip is a clean no-op, not a failure — `failed` does not include it.
    expect(result.failed).not.toContain('defaults.json');
  });

  it('still writes targets whose file is present (no over-blocking)', async () => {
    noteBaseline('.filo/defaults.json', 1000, 50);
    noteBaseline('.filo/app.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        // Both files still exist with their baseline mtime/size — no drift.
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    expect(result.failed).toEqual([]);
    // At least one config:save call landed (the test ran past the dedupe).
    expect(calls.some((c) => c.channel === 'config:save')).toBe(true);
  });

  it('still writes a fresh target with no baseline (initial seed unaffected)', async () => {
    // No noteBaseline calls — the baseline registry is empty, so the
    // pre-write stat probe is skipped entirely.
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      // If vault:stat IS called, surface the failure so the test fails
      // loudly rather than silently dropping the write.
      if (channel === 'vault:stat') {
        throw new Error('vault:stat should not be called when no baseline exists');
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    expect(result.failed).toEqual([]);
    expect(calls.some((c) => c.channel === 'config:save')).toBe(true);
  });
});

// 6.4.M12 — the ENOENT-skip respects an external delete, but it never updated
// `lastWrittenConfigs`. That dedup cache kept asserting the deleted payload was
// on disk, so once the in-memory payload returned to that value a legitimate
// re-write was silently dedup-suppressed — the file could never be
// re-established in-session. The skip now clears the target's dedup entry.
describe('configWriteScheduler — ENOENT skip clears dedup cache (6.4.M12)', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests(); // isolate lastWrittenConfigs from other tests
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  // defaults.json's payload is driven by mindmap/kanban/etc — NOT globalFont —
  // so it can be held stable across calls to exercise the dedup path.
  const settingsWith = (mindmap: Record<string, unknown>): ProjectSettings =>
    ({ general: { globalFont: 'fixed' }, mindmap, kanban: {}, tasklist: {}, document: {} } as ProjectSettings);

  it('re-writes a reverted payload after an ENOENT-skip (no permanent dedupe)', async () => {
    noteBaseline('.filo/defaults.json', 1000, 50);

    let statMode: 'ok' | 'enoent' = 'ok';
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json' && statMode === 'enoent') {
          return Promise.resolve({ ok: false, code: 'ENOENT', error: 'gone' });
        }
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    // 1. Prime: a successful write records payload P (mindmap {x:1}) as on disk.
    statMode = 'ok';
    await writeConfigs(VAULT_ROOT, settingsWith({ x: 1 }), 'light', makeWorkspace());

    // 2. External delete; a CHANGED payload arms a write → dedup miss → ENOENT-skip.
    statMode = 'enoent';
    await writeConfigs(VAULT_ROOT, settingsWith({ x: 2 }), 'light', makeWorkspace());

    // 3. File reappears (baseline matches → no drift); payload reverts to P.
    statMode = 'ok';
    calls.length = 0; // inspect only this call
    await writeConfigs(VAULT_ROOT, settingsWith({ x: 1 }), 'light', makeWorkspace());

    // Pre-fix the stale dedup entry (still == P) suppressed this write entirely.
    const defaultsSaves = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaves).toHaveLength(1);
  });
});

// L24 (Audit-6) — a OneDrive/AV/sync client can momentarily unlink-then-recreate
// a `.filo/` config. The pre-write ENOENT now re-stats ONCE: if the file is back,
// the armed write proceeds (no silent data loss); if it's still gone, the
// deletion is respected (5.1 behaviour preserved).
describe('configWriteScheduler — L24 re-stat disambiguates a transient unlink', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  it('writes the target when the re-stat finds the file back (blip resolved)', async () => {
    noteBaseline('.filo/defaults.json', 1000, 50);
    let defaultsStatCount = 0;
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json') {
          defaultsStatCount++;
          // First stat: transient ENOENT. Re-stat (and post-write stat): back.
          if (defaultsStatCount === 1) {
            return Promise.resolve({ ok: false, code: 'ENOENT', error: 'transient' });
          }
          return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
        }
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(VAULT_ROOT, makeSettings(), 'light', makeWorkspace());

    const defaultsSaves = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaves).toHaveLength(1); // the blip resolved → write proceeds
    expect(result.failed).not.toContain('defaults.json');
  });

  it('still skips when the re-stat ALSO reports ENOENT (a real delete)', async () => {
    noteBaseline('.filo/defaults.json', 1000, 50);
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json') {
          return Promise.resolve({ ok: false, code: 'ENOENT', error: 'gone' });
        }
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(VAULT_ROOT, makeSettings(), 'light', makeWorkspace());

    const defaultsSaves = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaves).toHaveLength(0); // still gone → deletion respected
    expect(result.failed).not.toContain('defaults.json');
  });
});

// Audit-7 L11 — a delete+recreate is an external mutation the mtime+size drift
// check can be blind to: a same-size, same-second recreate reads as "no drift",
// so a FOREIGN recreate would be silently clobbered. On the reappear branch the
// writer now reads the reappeared CONTENT and aborts if it differs from what
// Filo last wrote/seeded — while a benign same-content blip (L24) still
// proceeds (and an unverifiable / never-seeded target falls through unchanged).
describe('configWriteScheduler — L11 foreign delete+recreate not clobbered', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  // defaults.json is driven by mindmap/etc; globalFont is held fixed so
  // app.json / appearance.json dedupe out and only defaults.json exercises
  // the reappear path.
  const settingsWith = (mindmap: Record<string, unknown>): ProjectSettings =>
    ({ general: { globalFont: 'fixed' }, mindmap, kanban: {}, tasklist: {}, document: {} } as ProjectSettings);

  // Builds the catchall mock: defaults.json's first stat ENOENTs then reappears
  // with the SAME baseline mtime+size (the L11 blind spot); `config:load`
  // returns whatever object the test supplies for the reappeared file.
  function mockWith(reappearedDefaults: unknown, calls: Array<{ channel: string; args: unknown[] }>) {
    let defaultsStatCount = 0;
    return (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json') {
          defaultsStatCount++;
          if (defaultsStatCount === 1) {
            return Promise.resolve({ ok: false, code: 'ENOENT', error: 'transient' });
          }
          return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
        }
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:load') {
        return Promise.resolve(reappearedDefaults);
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    };
  }

  it('aborts the write when the reappeared file has foreign content (same mtime+size)', async () => {
    // Prime last-written + dedupe as if Filo wrote defaults {x:1}.
    seedConfigSnapshots(settingsWith({ x: 1 }), 'light', makeWorkspace());
    noteBaseline('.filo/defaults.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    // The reappeared file holds FOREIGN content, not {x:1}.
    installFiloMock(mockWith(
      { mindmap: { x: 999, foreign: true }, kanban: {}, tasklist: {}, document: {} },
      calls,
    ));

    // Arm a CHANGED payload {x:2} so it isn't dedup-skipped.
    const result = await writeConfigs(VAULT_ROOT, settingsWith({ x: 2 }), 'light', makeWorkspace());

    // defaults.json must NOT have been written — the foreign recreate stands.
    const defaultsSaves = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaves).toHaveLength(0);
    expect(result.failed).toContain('defaults.json');
  });

  it('proceeds when the reappeared file matches our last write (benign blip)', async () => {
    seedConfigSnapshots(settingsWith({ x: 1 }), 'light', makeWorkspace());
    noteBaseline('.filo/defaults.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    // The reappeared file is exactly what we last wrote ({x:1}).
    installFiloMock(mockWith(
      { mindmap: { x: 1 }, kanban: {}, tasklist: {}, document: {} },
      calls,
    ));

    const result = await writeConfigs(VAULT_ROOT, settingsWith({ x: 2 }), 'light', makeWorkspace());

    const defaultsSaves = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaves).toHaveLength(1);
    expect(result.failed).not.toContain('defaults.json');
  });
});
