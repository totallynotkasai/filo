/**
 * One list of General defaults: the schema, the new-vault `app.json` seed
 * and the General tab's fallback all come from `GENERAL_SETTINGS_DEFAULTS`.
 * The seed differs in one key: a new vault has board-specific folders on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeneralSettingsSchema, defaultProjectSettings } from '@renderer/schema/settings';
import {
  GENERAL_SETTINGS_DEFAULTS,
  generalSettingsDefaults,
  newVaultGeneralSettings,
} from '@shared/generalSettingsDefaults';
import { initVaultConfig } from '../../main/vault/configOps';

describe('General settings defaults', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('the schema parses an empty object to exactly the shared defaults', () => {
    expect(GeneralSettingsSchema.parse({})).toEqual(GENERAL_SETTINGS_DEFAULTS);
    expect(defaultProjectSettings().general).toEqual(GENERAL_SETTINGS_DEFAULTS);
  });

  it('hands out copies that do not share arrays or objects', () => {
    const a = generalSettingsDefaults();
    const b = generalSettingsDefaults();
    expect(a.systemFonts).not.toBe(b.systemFonts);
    expect(a.hoverButtons).not.toBe(GENERAL_SETTINGS_DEFAULTS.hoverButtons);
  });

  it('a new vault is seeded with every General default, with board-specific folders on', async () => {
    dir = await mkdtemp(join(tmpdir(), 'filo-seed-'));
    await initVaultConfig(dir);
    const app = JSON.parse(await readFile(join(dir, '.filo', 'app.json'), 'utf8')) as unknown;
    expect(app).toEqual({ ...GENERAL_SETTINGS_DEFAULTS, boardFolders: true });
    expect(app).toEqual(newVaultGeneralSettings());
    const appearance = JSON.parse(await readFile(join(dir, '.filo', 'appearance.json'), 'utf8')) as { font: string };
    expect(appearance.font).toBe(GENERAL_SETTINGS_DEFAULTS.globalFont);
  });

  it('an existing vault whose app.json has no boardFolders key keeps them off', () => {
    expect(GeneralSettingsSchema.parse({ vaultColor: '#1A73E8' }).boardFolders).toBe(false);
  });
});
