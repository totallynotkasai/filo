import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadVaultCandidate } from '@renderer/lib/vault/vaultCandidate';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase R4 — `loadVaultCandidate` is the load-side of vault-open as a
 * transaction. These tests cover the acceptance criteria from
 * REFACTOR_PLAN_2026-05-26.md §R4:
 *
 *   1. Theme load throws → loadVaultCandidate throws.
 *   2. Tags hydration fails → loadVaultCandidate throws.
 *   3. Vault opens cleanly → returns a fully-populated candidate.
 *   4. Hand-corrupt theme with unknown base → throws naming the file.
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
    ...overrides,
  };
}

describe('loadVaultCandidate', () => {
  beforeEach(() => {
    restoreFiloDefault();
  });
  afterEach(() => {
    restoreFiloDefault();
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

  it('throws when active custom theme has an unknown base — audit repro', async () => {
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

    await expect(loadVaultCandidate('/vault')).rejects.toThrow(/unknown base/);
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
    // mindmap is a non-object → schema rejects → fallback + warning.
    const sliceWarning = candidate.warnings.find((w) =>
      w.text.includes('Settings slice'),
    );
    expect(sliceWarning).toBeDefined();
    expect(sliceWarning?.type).toBe('warning');
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
});
