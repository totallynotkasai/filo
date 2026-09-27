import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { parseSettingsSlices, type VaultCandidateWarning } from '@renderer/lib/vault/vaultCandidate';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { GeneralSettingsSchema, defaultProjectSettings } from '@renderer/schema/settings';
import type { WorkspaceState } from '@renderer/schema/index';
import { safeVaultColor } from '@shared/vaultColor';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * The Vault Sidebar section's two new General keys: the vault colour and
 * the board-folders switch. Both default off, survive an `app.json` write
 * and read, and a bad value on disk reads as the default without resetting
 * the rest of General.
 */
describe('Vault Sidebar settings keys', () => {
  it('default to no colour and board folders off', () => {
    const general = GeneralSettingsSchema.parse({});
    expect(general.vaultColor).toBe('');
    expect(general.boardFolders).toBe(false);
  });

  it('keep a hex colour and board folders on when read from app.json', () => {
    const warnings: VaultCandidateWarning[] = [];
    const settings = parseSettingsSlices({ vaultColor: '#1A73E8', boardFolders: true, historyLimit: 42 }, {}, warnings);
    expect(settings.general.vaultColor).toBe('#1a73e8');
    expect(settings.general.boardFolders).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('read a bad colour or switch as the default and keep the rest of General', () => {
    const warnings: VaultCandidateWarning[] = [];
    const settings = parseSettingsSlices(
      { vaultColor: 'red; background: url(x)', boardFolders: 'yes', historyLimit: 42 },
      {},
      warnings,
    );
    expect(settings.general.vaultColor).toBe('');
    expect(settings.general.boardFolders).toBe(false);
    expect(settings.general.historyLimit).toBe(42);
    expect(warnings).toEqual([]);
  });

  describe('app.json round-trip', () => {
    let saved: Map<string, unknown>;

    beforeEach(() => {
      __resetDirtyTrackingForTests();
      saved = new Map();
      installFiloMock({
        'config:save': (...args: unknown[]) => {
          saved.set(String(args[1]), args[2]);
          return null;
        },
        'config:save-workspace': () => null,
      });
    });
    afterEach(() => {
      __resetDirtyTrackingForTests();
      restoreFiloDefault();
    });

    it('writes the colour and switch, and reads them back', async () => {
      const settings = defaultProjectSettings();
      settings.general.vaultColor = '#43a047';
      settings.general.boardFolders = true;
      const workspace = { openTabs: [], activeTabId: '' } as WorkspaceState;

      await writeConfigs('/vault-sidebar-settings', settings, 'light', workspace, undefined, 'Vault');

      const raw = saved.get('app.json');
      const app = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
      expect(app.vaultColor).toBe('#43a047');
      expect(app.boardFolders).toBe(true);

      const reread = parseSettingsSlices(app, {}, []);
      expect(reread.general.vaultColor).toBe('#43a047');
      expect(reread.general.boardFolders).toBe(true);
    });
  });
});

describe('safeVaultColor', () => {
  it('keeps #rgb and #rrggbb, lower-cased', () => {
    expect(safeVaultColor('#ABC')).toBe('#abc');
    expect(safeVaultColor('#00897B')).toBe('#00897b');
  });

  it('reads anything else as no colour', () => {
    for (const bad of [undefined, null, 12, '', 'red', '#12345', '#1234567', 'rgb(0,0,0)', '#fff;x:y']) {
      expect(safeVaultColor(bad)).toBe('');
    }
  });
});
