import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadVaultCandidate, parseSettingsSlices, type SalvagedSettingsFile, type VaultCandidateWarning } from '@renderer/lib/vault/vaultCandidate';
import { markSalvagedSettingsFile, seedConfigSnapshots, writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { GENERAL_SETTINGS_DEFAULTS } from '@shared/generalSettingsDefaults';

/**
 * One invalid field in `.filo/app.json` or `.filo/defaults.json` resets that
 * field alone, not the whole slice: the next settings save writes the slice
 * back over the file, so every other value (and every key a newer Filo wrote)
 * would have gone with it. The file is copied to `.filo/recovery/` before
 * that first write.
 */

const APP = {
  globalFont: 'Mine',
  globalFontSize: 99, // out of range (10–20)
  tabBarScale: 1.5,
  sidebarSortField: 'priority', // a value a newer Filo might add
  radarEnabled: false,
  plannedFutureSetting: 42,
};

const DEFAULTS = {
  mindmap: { backgroundColor: '#101010', futureKey: 'kept' },
  kanban: { accentColor: '#123456', card: { backgroundColor: '#abcdef', borderWidth: 99, cardFuture: 1 } },
  tasklist: {},
  document: {},
};

describe('parseSettingsSlices — field by field', () => {
  it('resets only the invalid fields, keeps the rest and every unknown key, and says which', () => {
    const warnings: VaultCandidateWarning[] = [];
    const salvaged: SalvagedSettingsFile[] = [];
    const s = parseSettingsSlices(APP, DEFAULTS, warnings, salvaged);

    expect(s.general.globalFontSize).toBe(GENERAL_SETTINGS_DEFAULTS.globalFontSize);
    expect(s.general.sidebarSortField).toBe(GENERAL_SETTINGS_DEFAULTS.sidebarSortField);
    expect(s.general.globalFont).toBe('Mine');
    expect(s.general.tabBarScale).toBe(1.5);
    expect(s.general.radarEnabled).toBe(false);
    expect((s.general as Record<string, unknown>).plannedFutureSetting).toBe(42);

    expect(s.kanban.card.borderWidth).toBe(1);
    expect(s.kanban.card.backgroundColor).toBe('#abcdef');
    expect(s.kanban.accentColor).toBe('#123456');
    expect((s.kanban.card as Record<string, unknown>).cardFuture).toBe(1);
    expect(s.mindmap.backgroundColor).toBe('#101010');
    expect((s.mindmap as Record<string, unknown>).futureKey).toBe('kept');

    expect(salvaged).toEqual(['app.json', 'defaults.json']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.text).toContain('.filo/app.json');
    expect(warnings[0]?.text).toContain('globalFontSize');
    expect(warnings[0]?.text).toContain('sidebarSortField');
    expect(warnings[0]?.text).not.toContain('globalFont,');
    expect(warnings[1]?.text).toContain('kanban.card.borderWidth');
    expect(warnings[1]?.text).toContain('.filo/recovery/');
  });

  it('a clean file: no warning, nothing salvaged', () => {
    const warnings: VaultCandidateWarning[] = [];
    const salvaged: SalvagedSettingsFile[] = [];
    parseSettingsSlices({ globalFont: 'Mine' }, { mindmap: {} }, warnings, salvaged);
    expect(warnings).toEqual([]);
    expect(salvaged).toEqual([]);
  });

  it('one bad colour in a list resets that list, not the slice', () => {
    const s = parseSettingsSlices({ recentColors: ['#fff', 7], globalFont: 'Mine' }, {}, []);
    expect(s.general.recentColors).toEqual([]);
    expect(s.general.globalFont).toBe('Mine');
  });
});

interface Call { channel: string; args: unknown[] }

function loadRoutes(calls: Call[], snapshot: () => unknown = () => ({ ok: true, path: '/vault/.filo/recovery/x-keep/app.json' })) {
  const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });
  installFiloMock((channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    switch (channel) {
      case 'vault:init-config': return { ok: true };
      case 'config:load-all': return { app: APP, defaults: DEFAULTS };
      case 'board:list': return [];
      case 'vault:read-tree': return { ok: true, tree: [] };
      case 'theme:list': return [];
      case 'tags:load': return VALID_TAGS_JSON;
      case 'recovery:snapshot': return snapshot();
      case 'config:save':
      case 'config:save-workspace': return { ok: true };
      default: return undefined;
    }
  });
}

describe('the first write over a salvaged settings file', () => {
  beforeEach(() => __resetDirtyTrackingForTests());
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
  });

  it('copies the file to .filo/recovery/ first, and changes only the bad field and the edited one', async () => {
    const calls: Call[] = [];
    loadRoutes(calls);
    const candidate = await loadVaultCandidate('/vault');
    expect(candidate.salvagedSettings).toEqual(['app.json', 'defaults.json']);
    const workspace = { openTabs: [], activeTabId: '' };
    seedConfigSnapshots(candidate.settings, candidate.activeThemeId, workspace);
    for (const f of candidate.salvagedSettings) markSalvagedSettingsFile(f);

    calls.length = 0;
    const edited = { ...candidate.settings, general: { ...candidate.settings.general, radarEnabled: true } };
    const result = await writeConfigs('/vault', edited, candidate.activeThemeId, workspace);
    expect(result.failed).toEqual([]);

    const snap = calls.findIndex((c) => c.channel === 'recovery:snapshot' && c.args[1] === '.filo/app.json');
    const save = calls.findIndex((c) => c.channel === 'config:save' && c.args[1] === 'app.json');
    expect(calls[snap]?.args).toEqual(['/vault', '.filo/app.json', 'keep']);
    expect(save).toBeGreaterThan(snap);
    const written = JSON.parse(String(calls[save]?.args[2])) as Record<string, unknown>;
    expect(written).toMatchObject({
      globalFont: 'Mine',
      tabBarScale: 1.5,
      radarEnabled: true,
      plannedFutureSetting: 42,
      globalFontSize: GENERAL_SETTINGS_DEFAULTS.globalFontSize,
    });

    // One copy per file: the next write doesn't copy again.
    calls.length = 0;
    await writeConfigs('/vault', { ...edited, general: { ...edited.general, radarEnabled: false } }, candidate.activeThemeId, workspace);
    expect(calls.some((c) => c.channel === 'recovery:snapshot')).toBe(false);
    expect(calls.some((c) => c.channel === 'config:save' && c.args[1] === 'app.json')).toBe(true);
  });

  it("no copy, no write: the change waits (kept for Retry) rather than go over the file", async () => {
    const calls: Call[] = [];
    loadRoutes(calls, () => ({ ok: false, code: 'EBUSY', error: 'locked' }));
    const candidate = await loadVaultCandidate('/vault');
    const workspace = { openTabs: [], activeTabId: '' };
    seedConfigSnapshots(candidate.settings, candidate.activeThemeId, workspace);
    markSalvagedSettingsFile('app.json');

    calls.length = 0;
    const edited = { ...candidate.settings, general: { ...candidate.settings.general, radarEnabled: true } };
    const result = await writeConfigs('/vault', edited, candidate.activeThemeId, workspace);
    expect(result.failed).toEqual(['app.json']);
    expect((result.error as { code?: string } | undefined)?.code).toBe('EBUSY');
    expect(calls.some((c) => c.channel === 'config:save' && c.args[1] === 'app.json')).toBe(false);
  });
});
