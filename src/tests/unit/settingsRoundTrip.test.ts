import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadVaultCandidate } from '@renderer/lib/vault/vaultCandidate';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * DI-1 (AUDIT_REMEDIATION_PLAN_2026-05-29 follow-up) — app.json keys the
 * running build doesn't recognise must survive a load → save round-trip.
 *
 * `GeneralSettingsSchema` is `.passthrough()`, but the load path
 * (`parseSettingsSlices`) and the save serialiser (`buildConfigPayloads`) used
 * to hand-pick a fixed list of keys. Anything outside that list — a
 * forward-compat field written by a newer Filo, or the vault `name` seeded by
 * `newVault` — was dropped on load and lost on the next save. Both paths now
 * spread the raw object first, then layer the normalisations on top.
 */

type InvokeRoutes = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;

const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

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

describe('settings round-trip — DI-1 unknown-key preservation', () => {
  beforeEach(() => {
    restoreFiloDefault();
  });
  afterEach(() => {
    restoreFiloDefault();
  });

  it('keeps an unknown app.json key on the load side', async () => {
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({
          app: { plannedFutureSetting: 42, globalFont: 'Test Font' },
        }),
      }),
    );

    const candidate = await loadVaultCandidate('/vault');
    const general = candidate.settings.general as Record<string, unknown>;

    expect(general.plannedFutureSetting).toBe(42);
    // The known key still normalises exactly as before the spread.
    expect(general.globalFont).toBe('Test Font');
  });

  it('keeps an unknown general key through the full load → save round-trip', async () => {
    // Load leg — the unknown key is present in app.json on disk.
    installFiloMock(
      happyPathRoutes({
        'config:load-all': async () => ({ app: { plannedFutureSetting: 42 } }),
      }),
    );
    const candidate = await loadVaultCandidate('/vault');
    expect((candidate.settings.general as Record<string, unknown>).plannedFutureSetting).toBe(42);

    // Save leg — capture the serialised app.json payload.
    const captured: Record<string, string> = {};
    installFiloMock({
      'config:save': async (...args: unknown[]) => {
        const [, target, payload] = args;
        captured[String(target)] = payload as string;
        return { ok: true };
      },
      'config:save-workspace': async () => ({ ok: true }),
    });

    const result = await writeConfigs('/vault', candidate.settings, candidate.activeThemeId, {
      openTabs: [],
      activeTabId: '',
    });

    expect(result.failed).toEqual([]);
    expect(captured['app.json']).toBeDefined();
    const appJson = JSON.parse(captured['app.json']) as Record<string, unknown>;
    expect(appJson.plannedFutureSetting).toBe(42);
  });
});
