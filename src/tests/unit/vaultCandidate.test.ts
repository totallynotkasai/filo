import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadVaultCandidate,
  loadAllConfigsWithRetry,
  isConfigLoadAllFailed,
} from '@renderer/lib/vault/vaultCandidate';
import {
  getBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { isBaselineUnverified } from '@renderer/lib/vault/fileBaselineRegistry';

/**
 * Phase R4 — `loadVaultCandidate` is the load-side of vault-open as a
 * transaction. These tests cover the acceptance criteria from
 * REFACTOR_PLAN_2026-05-26.md §R4:
 *
 *   1. Theme load throws → loadVaultCandidate throws.
 *   2. Tags hydration fails → loadVaultCandidate throws.
 *   3. Vault opens cleanly → returns a fully-populated candidate.
 *   4. Hand-edited theme with an unknown base → opens over Light, with a warning.
 *
 * Plus warning-buffering behaviour: corrupt config sentinels and
 * settings-slice fallbacks are queued into `candidate.warnings` for
 * the commit phase to surface, NOT fired during load (so a load that
 * fails never leaves stale toasts behind).
 */

type InvokeRoutes = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;

const VALID_TAGS_JSON = JSON.stringify({
  version: 1,
  tags: {},
  fileTags: {},
});

function happyPathRoutes(overrides: InvokeRoutes = {}): InvokeRoutes {
  return {
    'vault:init-config': async () => ({ ok: true }),
    'config:load-all': async () => ({}),
    'board:list': async () => [],
    'vault:read-tree': async () => ({ ok: true, tree: [] }),
    'theme:list': async () => [],
    'theme:load': async () => null,
    'tags:load': async () => VALID_TAGS_JSON,
    // 6.3.P3 — vault open now stats each of the four `.filo/` configs to
    // seed drift baselines. Fresh-vault default returns ENOENT for all
    // four so the loader's catch branch fires and no baselines are
    // seeded — matches the existing tests' "empty vault" assumption.
    // Individual tests can override to assert seeding behaviour.
    'vault:stat': async () => ({ success: false, code: 'ENOENT', error: 'not found' }),
    ...overrides,
  };
}

describe('loadVaultCandidate', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });

  it('returns a fully-populated candidate on the happy path', async () => {
    installFiloMock(happyPathRoutes());

    const candidate = await loadVaultCandidate('/vault');

    expect(candidate.path).toBe('/vault');
    expect(candidate.tree).toEqual([]);
    expect(candidate.boardCache).toEqual({});
    expect(candidate.boardPaths).toEqual({});
    expect(candidate.tagsFile.version).toBe(1);
    expect(candidate.tagsFile.tags).toEqual({});
    expect(candidate.themeCache).toEqual({});
    expect(candidate.availableThemeIds).toEqual([]);
    expect(candidate.activeThemeId).toBe('light');
    expect(candidate.activeThemeFile).toBeNull();
    expect(candidate.warnings).toEqual([]);
    expect(candidate.corruptionTargets).toEqual([]);
    expect(candidate.project.vaultPath).toBe('/vault');
    // ProjectSchema enum-validated; falls back to 'light' on parse.
    expect(candidate.project.theme).toBe('light');
  });

  it('L18: a PERSISTENT top-level config:load-all failure leaves every config unverified and warns once', async () => {
    // The handler tags a transient whole-`.filo/` read failure (locked dir /
    // EACCES on fs.stat) with `__loadAllFailed`. Memory then holds defaults, so
    // no file may be written blind: each is marked unverified (its first write
    // reads it again, and asks when it differs) rather than paused for the
    // session, and ONE low-key warning shows — not seven per-file toasts.
    //
    // Audit-7 L3 — the read is now retried with backoff before giving up, so a
    // PERSISTENT failure (mock fails every call) only reaches the pause path
    // after the retry schedule exhausts. Fake timers ride out the ~1.45s of
    // backoff so the test stays fast.
    vi.useFakeTimers();
    try {
      let calls = 0;
      installFiloMock(
        happyPathRoutes({
          'config:load-all': async () => {
            calls++;
            return {
              app: {}, appearance: {}, defaults: {}, hotkeys: {}, workspace: {}, viewports: {}, sidebarOrder: {},
              __loadAllFailed: 'EACCES: permission denied, stat .filo',
            };
          },
        }),
      );

      const promise = loadVaultCandidate('/vault');
      await vi.advanceTimersByTimeAsync(2000);
      const candidate = await promise;

      // Initial read + three backoff retries all failed.
      expect(calls).toBe(4);
      expect(candidate.corruptionTargets).toEqual([]);
      for (const rel of ['app.json', 'appearance.json', 'defaults.json', 'workspace.json', 'viewports.json', 'sidebar-order.json']) {
        expect(isBaselineUnverified(`.filo/${rel}`)).toBe(true);
      }
      expect(candidate.warnings).toHaveLength(1);
      expect(candidate.warnings[0].text).toMatch(/couldn't read your \.filo\/ settings/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('L3: a transient config:load-all failure that clears on retry loads cleanly (no pause)', async () => {
    // The OneDrive/AV lock cleared by the first retry — the REAL configs load,
    // so NO config target is paused and the "couldn't read settings" warning is
    // never buffered. This is the common case the L3 retry transparently fixes.
    vi.useFakeTimers();
    try {
      let calls = 0;
      installFiloMock(
        happyPathRoutes({
          'config:load-all': async () => {
            calls++;
            if (calls === 1) {
              return {
                app: {}, appearance: {}, defaults: {}, hotkeys: {}, workspace: {}, viewports: {}, sidebarOrder: {},
                __loadAllFailed: 'EBUSY: resource busy or locked',
              };
            }
            return {}; // readable on the first retry
          },
        }),
      );

      const promise = loadVaultCandidate('/vault');
      await vi.advanceTimersByTimeAsync(500); // ride out the first 150ms backoff
      const candidate = await promise;

      expect(calls).toBe(2);
      expect(candidate.corruptionTargets).toEqual([]);
      expect(
        candidate.warnings.some((w) => /couldn't read your \.filo\//i.test(w.text)),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when tags:load IPC throws — no graceful fallback', async () => {
    installFiloMock(
      happyPathRoutes({
        'tags:load': async () => {
          throw new Error('EACCES tags.json');
        },
      }),
    );

    await expect(loadVaultCandidate('/vault')).rejects.toThrow(/tags\.json/);
  });

  it('opens over Light, with a warning, when the active custom theme has an unknown base', async () => {
    const badThemeFile = {
      id: 'broken',
      name: 'Broken',
      base: 'nonsense',
      variables: {},
    };
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          appearance: { activeTheme: 'broken' },
        }),
        'theme:list': async () => ['broken'],
        'theme:load': async () => badThemeFile,
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.activeThemeFile?.base).toBe('light');
    expect(candidate.warnings.some((w) => /"nonsense", which isn't a built-in theme/.test(w.text))).toBe(true);
  });

  it('throws when the active custom theme file is missing AND theme:load IPC errors', async () => {
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          appearance: { activeTheme: 'missing' },
        }),
        // Empty list — no preload, so we hit the post-list theme:load fallback.
        'theme:list': async () => [],
        'theme:load': async () => {
          throw new Error('ENOENT themes/missing.json');
        },
      }),
    );

    await expect(loadVaultCandidate('/vault')).rejects.toThrow(/missing/);
  });

  it('survives a missing custom theme file with no preload — falls back to built-in', async () => {
    // The candidate phase resolves activeThemeFile = null and leaves the
    // commit phase to apply the built-in fallback. No throw.
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          appearance: { activeTheme: 'missing' },
        }),
        'theme:list': async () => [],
        'theme:load': async () => null,
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.activeThemeId).toBe('missing');
    expect(candidate.activeThemeFile).toBeNull();
  });

  it('throws when vault:read-tree returns an error envelope', async () => {
    installFiloMock(
      happyPathRoutes({
        'vault:read-tree': async () => ({ ok: false, code: 'EACCES', error: 'no access' }),
      }),
    );

    await expect(loadVaultCandidate('/vault')).rejects.toThrow(/vault:read-tree/);
  });

  it('throws when vault:init-config rejects', async () => {
    installFiloMock(
      happyPathRoutes({
        'vault:init-config': async () => ({ ok: false, error: 'not a directory' }),
      }),
    );

    await expect(loadVaultCandidate('/vault')).rejects.toBeDefined();
  });

  it('buffers corrupt-config sentinel into warnings + corruptionTargets', async () => {
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          app: { __corrupt: true, error: 'unexpected token at line 4' },
          appearance: {},
        }),
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.corruptionTargets).toContain('app.json');
    expect(candidate.warnings.some((w) => w.text.includes('app.json'))).toBe(true);
    expect(candidate.warnings.every((w) => w.duration === 0)).toBe(true);
  });

  it('buffers settings-slice fallback into warnings on parse failure', async () => {
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          defaults: {
            mindmap: 'not-an-object',
            kanban: { totallyBogus: () => 1 },
          },
        }),
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    // mindmap is a non-object → that slice takes its defaults, with a warning naming it.
    const sliceWarning = candidate.warnings.find((w) =>
      w.text.includes('.filo/defaults.json'),
    );
    expect(sliceWarning).toBeDefined();
    expect(sliceWarning?.text).toContain('mindmap');
    expect(sliceWarning?.type).toBe('warning');
    expect(candidate.salvagedSettings).toEqual(['defaults.json']);
  });

  it('preserves built-in active theme without IPC ping for theme:load', async () => {
    let themeLoadCalls = 0;
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({ appearance: { activeTheme: 'dark' } }),
        'theme:list': async () => [],
        'theme:load': async () => {
          themeLoadCalls += 1;
          return null;
        },
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.activeThemeId).toBe('dark');
    expect(candidate.activeThemeFile).toBeNull();
    // No `theme:load` IPC for built-in active theme.
    expect(themeLoadCalls).toBe(0);
  });

  it('preloads every custom theme listed in .filo/themes/', async () => {
    const themeA = {
      id: 'aurora',
      name: 'Aurora',
      base: 'dark',
      variables: { '--ui-bg': '#001' },
    };
    const themeB = {
      id: 'forest',
      name: 'Forest',
      base: 'nature',
      variables: { '--ui-bg': '#0a3' },
    };
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({ appearance: { activeTheme: 'aurora' } }),
        'theme:list': async () => ['aurora.json', 'forest.json'],
        'theme:load': async (_root, id) => (id === 'aurora' ? themeA : themeB),
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.availableThemeIds.sort()).toEqual(['aurora', 'forest']);
    expect(candidate.themeCache.aurora).toEqual(themeA);
    expect(candidate.themeCache.forest).toEqual(themeB);
    expect(candidate.activeThemeId).toBe('aurora');
    expect(candidate.activeThemeFile).toEqual(themeA);
  });

  it('drops a hand-edited sidebar-order entry that is not a string[]', async () => {
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          sidebarOrder: {
            '': ['a', 'b'],
            'bad-folder': ['valid', 42, 'wat'],
            'also-bad': 'not-an-array',
          },
        }),
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.manualOrder['']).toEqual(['a', 'b']);
    expect(candidate.manualOrder['bad-folder']).toBeUndefined();
    expect(candidate.manualOrder['also-bad']).toBeUndefined();
  });

  describe('config baseline seeding (6.3.P3)', () => {
    /**
     * The 5.1 ENOENT-skip guard inside `writeConfigs` is gated on
     * `baseline !== undefined`. Without an eager seed at vault open, the
     * first save after open lands in the "no baseline → drift check
     * skipped" branch — the same bug 5.1 claimed to fix, re-introduced on
     * the fresh-open path. These tests pin the eager-seed contract.
     */
    it('seeds drift baselines for each .filo/ config that exists on disk', async () => {
      const FAKE_MTIME = 1_700_000_000_000;
      installFiloMock(
        happyPathRoutes({
          'vault:stat': async (_root, relPath) => {
            // Mock all four configs as present with distinct stats.
            switch (relPath) {
              case '.filo/defaults.json':
                return { success: true, mtimeMs: FAKE_MTIME + 1, size: 100 };
              case '.filo/app.json':
                return { success: true, mtimeMs: FAKE_MTIME + 2, size: 200 };
              case '.filo/appearance.json':
                return { success: true, mtimeMs: FAKE_MTIME + 3, size: 300 };
              case '.filo/workspace.json':
                return { success: true, mtimeMs: FAKE_MTIME + 4, size: 400 };
              default:
                return { success: false, code: 'ENOENT', error: 'not found' };
            }
          },
        }),
      );

      const candidate = await loadVaultCandidate('/vault');

      expect(candidate.seededConfigBaselinePaths.sort()).toEqual([
        '.filo/app.json',
        '.filo/appearance.json',
        '.filo/defaults.json',
        '.filo/workspace.json',
      ]);
      // Each baseline is callable via getBaseline with the exact mtime
      // and size returned by the mock.
      expect(getBaseline('.filo/defaults.json')).toEqual({
        mtimeMs: FAKE_MTIME + 1,
        size: 100,
      });
      expect(getBaseline('.filo/app.json')).toEqual({
        mtimeMs: FAKE_MTIME + 2,
        size: 200,
      });
      expect(getBaseline('.filo/appearance.json')).toEqual({
        mtimeMs: FAKE_MTIME + 3,
        size: 300,
      });
      expect(getBaseline('.filo/workspace.json')).toEqual({
        mtimeMs: FAKE_MTIME + 4,
        size: 400,
      });
    });

    it('skips ENOENT configs silently (fresh vault before any save)', async () => {
      // Default happyPathRoutes already returns ENOENT for vault:stat.
      installFiloMock(happyPathRoutes());

      const candidate = await loadVaultCandidate('/vault');
      expect(candidate.seededConfigBaselinePaths).toEqual([]);
      expect(getBaseline('.filo/defaults.json')).toBeUndefined();
      expect(getBaseline('.filo/app.json')).toBeUndefined();
      expect(getBaseline('.filo/appearance.json')).toBeUndefined();
      expect(getBaseline('.filo/workspace.json')).toBeUndefined();
    });

    it('seeds a partial set when only some configs exist on disk', async () => {
      installFiloMock(
        happyPathRoutes({
          'vault:stat': async (_root, relPath) => {
            if (relPath === '.filo/defaults.json') {
              return { success: true, mtimeMs: 1000, size: 50 };
            }
            if (relPath === '.filo/workspace.json') {
              return { success: true, mtimeMs: 2000, size: 75 };
            }
            return { success: false, code: 'ENOENT', error: 'not found' };
          },
        }),
      );

      const candidate = await loadVaultCandidate('/vault');
      expect(candidate.seededConfigBaselinePaths.sort()).toEqual([
        '.filo/defaults.json',
        '.filo/workspace.json',
      ]);
      expect(getBaseline('.filo/app.json')).toBeUndefined();
      expect(getBaseline('.filo/appearance.json')).toBeUndefined();
    });

    it('survives non-ENOENT stat failures (EACCES) — load still succeeds, no baseline', async () => {
      // Suppress the `reportError` console.error breadcrumb — it's the
      // asserted behaviour (the candidate surfaces the failure via the
      // bus), but we don't want it polluting test output.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        installFiloMock(
          happyPathRoutes({
            'vault:stat': async () => ({
              success: false,
              code: 'EACCES',
              error: 'permission denied',
            }),
          }),
        );

        // Should NOT throw — non-fatal failure is reported via the bus but
        // the load returns. Without a baseline, the writer's drift check
        // no-ops on the next save (pre-5.1 behaviour).
        const candidate = await loadVaultCandidate('/vault');
        expect(candidate.seededConfigBaselinePaths).toEqual([]);
        // Sanity: reportError did fire (once per failed config) so the
        // failure surface stays observable in dev.
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});

describe('loadAllConfigsWithRetry (L3)', () => {
  // Inject a no-op sleep so these stay wall-clock-free.
  const noSleep = async (): Promise<void> => undefined;

  it('isConfigLoadAllFailed only matches the top-level __loadAllFailed tag', () => {
    expect(isConfigLoadAllFailed({ __loadAllFailed: 'EACCES' })).toBe(true);
    expect(isConfigLoadAllFailed({ app: { __corrupt: true } })).toBe(false);
    expect(isConfigLoadAllFailed({ app: {} })).toBe(false);
    expect(isConfigLoadAllFailed({})).toBe(false);
    expect(isConfigLoadAllFailed(null)).toBe(false);
    expect(isConfigLoadAllFailed(undefined)).toBe(false);
    // Non-string __loadAllFailed (defensive) is not a real failure tag.
    expect(isConfigLoadAllFailed({ __loadAllFailed: true })).toBe(false);
  });

  it('returns the first readable bag without retrying', async () => {
    let calls = 0;
    const bag = await loadAllConfigsWithRetry(async () => {
      calls++;
      return { app: { ok: true } };
    }, noSleep);
    expect(calls).toBe(1);
    expect(bag).toEqual({ app: { ok: true } });
  });

  it('retries a __loadAllFailed bag and returns the first success', async () => {
    let calls = 0;
    const bag = await loadAllConfigsWithRetry(async () => {
      calls++;
      return calls < 3 ? { __loadAllFailed: 'locked' } : { app: { ok: true } };
    }, noSleep);
    expect(calls).toBe(3);
    expect(bag).toEqual({ app: { ok: true } });
  });

  it('gives up after exhausting the backoff and returns the last failed bag', async () => {
    let calls = 0;
    const failed = { app: {}, __loadAllFailed: 'still locked' };
    const bag = await loadAllConfigsWithRetry(
      async () => { calls++; return failed; },
      noSleep,
      [1, 2], // two retries
    );
    expect(calls).toBe(3); // initial + 2 retries
    expect(bag).toBe(failed);
  });

  it('sleeps between retries with the configured backoff delays', async () => {
    const slept: number[] = [];
    let calls = 0;
    await loadAllConfigsWithRetry(
      async () => { calls++; return { __loadAllFailed: 'locked' }; },
      async (ms) => { slept.push(ms); },
      [150, 400, 900],
    );
    expect(slept).toEqual([150, 400, 900]);
    expect(calls).toBe(4);
  });
});
