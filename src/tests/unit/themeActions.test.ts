/**
 * What the Themes tab does, beyond "System colours only" and the card
 * previews (covered in themeActionsSession.test.ts):
 *  - picking a theme saves the choice at once, and only clears the Global
 *    Defaults colours the user set after asking (Keep / Cancel honoured, and
 *    never while "System colours only" makes the pick session-only);
 *  - deleting a custom theme asks first and, when it was active, falls back
 *    to its base and saves that;
 *  - the editor sessions (new / duplicate / edit / import) get a free name,
 *    the right base, and the theme's own colours over the base's.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { themeStore } from '@renderer/stores/theme.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore, type ConfirmDialogConfig } from '@renderer/stores/ui.svelte';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { __resetThemeManagerForTests, type ThemeFile } from '@renderer/lib/themes/themeManager';
import {
  isBuiltinTheme,
  themeLabel,
  selectTheme,
  deleteCustomTheme,
  newThemeSession,
  duplicateThemeSession,
  editThemeSession,
  importThemeSession,
} from '@renderer/lib/themes/themeActions';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import { defaultProjectSettings, type Project } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function sunset(overrides: Partial<ThemeFile> = {}): ThemeFile {
  return {
    id: 'sunset',
    name: 'Sunset',
    base: 'blueprint',
    variables: { '--ui-bg': '#201010', '--accent-primary': '#ff6600' },
    ...overrides,
  };
}

let project: Project;
let confirms: ConfirmDialogConfig[];
let reported: ReportedError[];
let stopListening: () => void = () => undefined;
let applyById: MockInstance<(typeof themeStore)['applyById']>;
let setTheme: MockInstance<(typeof vaultStore)['setTheme']>;
let save: MockInstance<(typeof vaultStore)['save']>;
let markMetaDirty: MockInstance<(typeof vaultStore)['markMetaDirty']>;
let startGlobal: MockInstance<(typeof pendingSettingsStore)['startGlobal']>;
let hasGlobalChanges: MockInstance<(typeof pendingSettingsStore)['hasGlobalChanges']>;
let toast: MockInstance<(typeof uiStore)['toast']>;

/** The confirm on screen now; fails the test when there is none. */
function lastConfirm(): ConfirmDialogConfig {
  const c = confirms.at(-1);
  if (!c) throw new Error('no confirm was opened');
  return c;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  installFiloMock(() => null);
  __resetThemeManagerForTests();
  themeStore.clear();
  vaultStore.setPath('/vault');
  project = { theme: 'light', settings: defaultProjectSettings() } as Project;
  vi.spyOn(vaultStore, 'project', 'get').mockImplementation(() => project);
  confirms = [];
  vi.spyOn(uiStore, 'openConfirm').mockImplementation((c: ConfirmDialogConfig) => {
    confirms.push(c);
  });
  toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
  applyById = vi.spyOn(themeStore, 'applyById').mockResolvedValue({ ok: true });
  setTheme = vi.spyOn(vaultStore, 'setTheme').mockImplementation(() => undefined);
  save = vi.spyOn(vaultStore, 'save').mockResolvedValue(true);
  markMetaDirty = vi.spyOn(vaultStore, 'markMetaDirty').mockImplementation(() => undefined);
  startGlobal = vi.spyOn(pendingSettingsStore, 'startGlobal').mockImplementation(() => undefined);
  hasGlobalChanges = vi.spyOn(pendingSettingsStore, 'hasGlobalChanges').mockReturnValue(false);
  reported = [];
  stopListening = onError((e) => { reported.push(e); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stopListening();
  vi.restoreAllMocks();
  vaultStore.setPath('');
  themeStore.clear();
  __resetThemeManagerForTests();
  restoreFiloDefault();
});

describe('isBuiltinTheme / themeLabel', () => {
  it('knows the five built-ins and nothing else', () => {
    for (const id of ['light', 'dark', 'blueprint', 'retro', 'nature']) expect(isBuiltinTheme(id)).toBe(true);
    expect(isBuiltinTheme('sunset')).toBe(false);
    expect(isBuiltinTheme('Dark')).toBe(false);
  });

  it('labels a built-in by its display name, a custom theme by its file name, else by id', () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset() });
    expect(themeLabel('dark')).toBe('Dark Mode');
    expect(themeLabel('sunset')).toBe('Sunset');
    expect(themeLabel('gone')).toBe('gone');
  });
});

describe('selectTheme', () => {
  it('does nothing with no vault open', async () => {
    vaultStore.setPath('');
    expect(await selectTheme('dark')).toBe(false);
    expect(applyById).not.toHaveBeenCalled();
  });

  it('applies the theme, records it and saves at once when no default colour is set', async () => {
    expect(await selectTheme('dark')).toBe(true);
    expect(confirms).toHaveLength(0);
    expect(applyById).toHaveBeenCalledWith('/vault', 'dark');
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(save).toHaveBeenCalledTimes(1);
    // The Global Defaults copy is taken again so a later Apply can't restore old colours.
    expect(startGlobal).toHaveBeenCalledTimes(1);
  });

  it('asks before replacing colours the user set; "Use theme colours" clears them', async () => {
    project.settings.mindmap.backgroundColor = '#ff0000';
    project.settings.kanban.accentColor = '#00ff00';
    const picking = selectTheme('retro');
    await settle();

    const ask = lastConfirm();
    expect(ask.body).toContain('2 Global Defaults colours');
    expect(ask.body).toContain('"Retro"');
    expect(applyById).not.toHaveBeenCalled();
    ask.onConfirm(false);

    expect(await picking).toBe(true);
    expect(project.settings.mindmap.backgroundColor).toBe('');
    expect(project.settings.kanban.accentColor).toBe('');
    expect(markMetaDirty).toHaveBeenCalled();
    expect(setTheme).toHaveBeenCalledWith('retro');
    expect(startGlobal).toHaveBeenCalledTimes(1);
  });

  it('"Keep my colours" applies the theme and leaves them', async () => {
    project.settings.mindmap.backgroundColor = '#ff0000';
    const picking = selectTheme('retro');
    await settle();
    const ask = lastConfirm();
    expect(ask.body).toContain('1 Global Defaults colour.');
    ask.secondaryAction?.onClick();

    expect(await picking).toBe(true);
    expect(project.settings.mindmap.backgroundColor).toBe('#ff0000');
    expect(applyById).toHaveBeenCalledWith('/vault', 'retro');
    expect(setTheme).toHaveBeenCalledWith('retro');
    expect(markMetaDirty).not.toHaveBeenCalled();
    expect(startGlobal).not.toHaveBeenCalled();
  });

  it('Cancel changes nothing', async () => {
    project.settings.mindmap.backgroundColor = '#ff0000';
    const picking = selectTheme('retro');
    await settle();
    lastConfirm().onCancel?.();

    expect(await picking).toBe(false);
    expect(applyById).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
    expect(project.settings.mindmap.backgroundColor).toBe('#ff0000');
  });

  it('stops when the user cancels over unapplied Global Defaults edits', async () => {
    hasGlobalChanges.mockReturnValue(true);
    const picking = selectTheme('dark');
    await settle();
    expect(lastConfirm().title).toContain('Global Defaults has unapplied changes');
    lastConfirm().onCancel?.();

    expect(await picking).toBe(false);
    expect(applyById).not.toHaveBeenCalled();
  });

  it('with "System colours only" on, applies for the session only: no prompt, no save, colours kept', async () => {
    vi.spyOn(themeStore, 'systemOnly', 'get').mockReturnValue(true);
    project.settings.mindmap.backgroundColor = '#ff0000';

    expect(await selectTheme('retro')).toBe(true);

    expect(confirms).toHaveLength(0);
    expect(applyById).toHaveBeenCalledWith('/vault', 'retro');
    expect(setTheme).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(project.settings.mindmap.backgroundColor).toBe('#ff0000');
    expect(startGlobal).not.toHaveBeenCalled();
  });

  it('a theme that fails to apply is reported by name and not recorded', async () => {
    applyById.mockResolvedValue({ ok: false, error: 'bad file' });

    expect(await selectTheme('dark')).toBe(false);

    expect(setTheme).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toBe('Theme "Dark Mode" could not be applied: bad file. Reverted to Light.');
    // The Global Defaults copy is re-armed whatever the outcome.
    expect(startGlobal).toHaveBeenCalledTimes(1);
  });

  it('a failed save is reported but the pick still counts', async () => {
    save.mockRejectedValue(new Error('locked'));
    expect(await selectTheme('dark')).toBe(true);
    expect(reported.map((r) => r.context)).toEqual(['themeActions.persist']);
  });
});

describe('deleteCustomTheme', () => {
  let deleteTheme: MockInstance<(typeof themeStore)['deleteTheme']>;

  beforeEach(() => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset() });
    deleteTheme = vi.spyOn(themeStore, 'deleteTheme').mockResolvedValue(true);
  });

  it('never deletes a built-in', async () => {
    await deleteCustomTheme('dark');
    expect(confirms).toHaveLength(0);
    expect(deleteTheme).not.toHaveBeenCalled();
  });

  it('asks first, and a No keeps the theme', async () => {
    const deleting = deleteCustomTheme('sunset');
    await settle();
    const ask = lastConfirm();
    expect(ask.title).toBe('Delete theme "Sunset"?');
    expect(ask.danger).toBe(true);
    ask.onCancel?.();
    await deleting;
    expect(deleteTheme).not.toHaveBeenCalled();
  });

  it('moves an inactive theme to the trash and leaves the active theme alone', async () => {
    vi.spyOn(themeStore, 'activeFileId', 'get').mockReturnValue('dark');
    const deleting = deleteCustomTheme('sunset');
    await settle();
    lastConfirm().onConfirm(false);
    await deleting;

    expect(deleteTheme).toHaveBeenCalledWith('/vault', 'sunset');
    expect(toast).toHaveBeenCalledWith('Theme "Sunset" moved to Filo\'s trash', 'info');
    expect(applyById).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('falls back to the base of the active theme it deleted, and saves that', async () => {
    vi.spyOn(themeStore, 'activeFileId', 'get').mockReturnValue('sunset');
    const deleting = deleteCustomTheme('sunset');
    await settle();
    lastConfirm().onConfirm(false);
    await deleting;

    expect(applyById).toHaveBeenCalledWith('/vault', 'blueprint');
    expect(setTheme).toHaveBeenCalledWith('blueprint');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('falls back to Dark for an active theme with no base', async () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset({ base: undefined }) });
    vi.spyOn(themeStore, 'activeFileId', 'get').mockReturnValue('sunset');
    const deleting = deleteCustomTheme('sunset');
    await settle();
    lastConfirm().onConfirm(false);
    await deleting;
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('says so when the delete fails, and keeps the active theme', async () => {
    deleteTheme.mockResolvedValue(false);
    vi.spyOn(themeStore, 'activeFileId', 'get').mockReturnValue('sunset');
    const deleting = deleteCustomTheme('sunset');
    await settle();
    lastConfirm().onConfirm(false);
    await deleting;

    expect(toast).toHaveBeenCalledWith('Couldn\'t delete theme "Sunset"', 'error');
    expect(applyById).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe('editor sessions', () => {
  it('a new theme starts from the active base under a free name', () => {
    vi.spyOn(themeStore, 'active', 'get').mockReturnValue('retro');
    vi.spyOn(themeStore, 'available', 'get').mockReturnValue(['my-theme', 'my-theme-2']);
    const s = newThemeSession();
    expect(s).toMatchObject({ mode: 'new', ownId: null, name: 'My theme 3', base: 'retro' });
  });

  it('a duplicate of a built-in is a new theme named "<label> copy" on that base', () => {
    vi.spyOn(themeStore, 'available', 'get').mockReturnValue([]);
    expect(duplicateThemeSession('nature')).toMatchObject({ mode: 'new', ownId: null, name: 'Nature copy', base: 'nature' });
  });

  it('a duplicate of a custom theme keeps its base and its own colours, under a free copy name', () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset() });
    vi.spyOn(themeStore, 'available', 'get').mockReturnValue(['sunset', 'sunset-copy']);
    const s = duplicateThemeSession('sunset');
    expect(s).toMatchObject({ mode: 'new', ownId: null, name: 'Sunset copy 2', base: 'blueprint' });
    expect(s.variables).toMatchObject({ '--ui-bg': '#201010', '--accent-primary': '#ff6600' });
  });

  it('edit opens a custom theme to save over itself, and refuses built-ins and unknown ids', () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset() });
    const s = editThemeSession('sunset');
    expect(s).toMatchObject({ mode: 'edit', ownId: 'sunset', name: 'Sunset', base: 'blueprint' });
    expect(s?.variables['--accent-primary']).toBe('#ff6600');
    expect(editThemeSession('dark')).toBeNull();
    expect(editThemeSession('gone')).toBeNull();
  });

  it('edit of a theme with no base uses Dark', () => {
    vi.spyOn(themeStore, 'cache', 'get').mockReturnValue({ sunset: sunset({ base: undefined }) });
    expect(editThemeSession('sunset')?.base).toBe('dark');
  });

  describe('importThemeSession', () => {
    beforeEach(() => {
      vi.spyOn(themeStore, 'available', 'get').mockReturnValue(['sunset']);
    });

    it('opens an imported theme as a new one, keeping its name, base and colours', () => {
      const s = importThemeSession(JSON.stringify({ name: 'Ocean', base: 'light', variables: { '--ui-bg': '#001122' } }));
      expect(s).toMatchObject({ mode: 'new', ownId: null, name: 'Ocean', base: 'light' });
      expect('variables' in s ? s.variables['--ui-bg'] : null).toBe('#001122');
    });

    it('renames an import whose name is taken or is a built-in\'s', () => {
      const taken = importThemeSession(JSON.stringify({ name: 'Sunset', variables: { '--ui-bg': '#001122' } }));
      expect('name' in taken ? taken.name : null).toBe('Sunset 2');
      const builtin = importThemeSession(JSON.stringify({ name: 'Dark Mode', variables: { '--ui-bg': '#001122' } }));
      expect('name' in builtin ? builtin.name : null).toBe('Dark Mode 2');
    });

    it('drops variables that are not theme colours', () => {
      const s = importThemeSession(JSON.stringify({ name: 'Ocean', variables: { '--ui-bg': '#001122', '--z-modal': '-1' } }));
      expect('variables' in s ? s.variables['--z-modal'] : 'error').toBeUndefined();
    });

    it('returns an error for a file that isn\'t a theme', () => {
      expect(importThemeSession('not json')).toEqual({ error: "That file isn't valid JSON." });
      expect(importThemeSession(JSON.stringify({ variables: {} }))).toHaveProperty('error');
      expect(importThemeSession(JSON.stringify({ name: 'Empty', variables: { '--z-modal': '1' } }))).toEqual({
        error: 'That theme has no colours Filo can use.',
      });
    });
  });
});
