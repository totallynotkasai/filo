/**
 * Characterisation — themes and the settings dialog.
 *
 * A custom theme picked in Settings is the one the vault opens with next
 * time. Deleting a theme moves it to Filo's trash, and Settings → Trash
 * brings it back. A theme can't take a built-in theme's name. Picking a
 * theme asks before it replaces Global Defaults colours the user set. The
 * Current Board tab never edits a board hidden behind a note's Document tab.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, reopenVault, waitFor } from './harness/app';
import {
  answerConfirm,
  closeModal,
  confirmText,
  createBoard,
  openNoteFromSidebar,
  restoreFromTrashSettings,
  trashedPaths,
} from './harness/actions';
import {
  activeThemeName,
  answerConfirmSecondary,
  clickDeleteTheme,
  createTheme,
  customThemeNames,
  openSettingsTab,
  pickTheme,
  settingsTabEnabled,
} from './harness/themes';

afterEach(async () => {
  await stopApp();
});

const appearance = (app: { read(rel: string): string }): { activeTheme: string } =>
  JSON.parse(app.read('.filo/appearance.json')) as { activeTheme: string };

describe('custom themes', () => {
  it('a new theme becomes the active theme and is still active after a relaunch', async () => {
    const app = await startApp();
    await openSettingsTab(app, 'Themes');
    expect(await createTheme('Sunset')).toBe('');

    expect(app.exists('.filo/themes/sunset.json')).toBe(true);
    await waitFor(() => appearance(app).activeTheme === 'sunset', 'appearance.json names the theme');
    await closeModal();

    await reopenVault(app);
    await openSettingsTab(app, 'Themes');
    expect(activeThemeName()).toBe('Sunset');
    expect(appearance(app).activeTheme).toBe('sunset');
  });

  it('picking a custom theme is saved too', async () => {
    const app = await startApp({
      '.filo/themes/forest.json': JSON.stringify({ id: 'forest', name: 'Forest', base: 'dark', variables: { '--ui-bg': '#102010' } }),
    });
    await openSettingsTab(app, 'Themes');
    await pickTheme('Forest');
    await waitFor(() => appearance(app).activeTheme === 'forest', 'appearance.json names Forest');
    await closeModal();
    await reopenVault(app);
    await openSettingsTab(app, 'Themes');
    expect(activeThemeName()).toBe('Forest');
  });

  it('a built-in theme\'s name is refused, and nothing is written', async () => {
    const app = await startApp();
    await openSettingsTab(app, 'Themes');
    expect(await createTheme('Light Mode')).toMatch(/built-in theme/);
    expect(await createTheme('dark')).toMatch(/built-in theme/);
    expect(app.exists('.filo/themes/light-mode.json')).toBe(false);
    expect(app.exists('.filo/themes/dark.json')).toBe(false);
  });

  it('another custom theme\'s name is refused rather than overwriting it', async () => {
    const forest = JSON.stringify({ id: 'forest', name: 'Forest', base: 'dark', variables: { '--ui-bg': '#102010' } });
    const app = await startApp({ '.filo/themes/forest.json': forest });
    await openSettingsTab(app, 'Themes');
    expect(await createTheme('forest')).toMatch(/already has this name/);
    expect(app.read('.filo/themes/forest.json')).toBe(forest);
  });

  it('delete asks first, moves the theme to Filo\'s trash, and Settings → Trash brings it back', async () => {
    const forest = JSON.stringify({ id: 'forest', name: 'Forest', base: 'dark', variables: { '--ui-bg': '#102010' } });
    const app = await startApp({ '.filo/themes/forest.json': forest });
    await openSettingsTab(app, 'Themes');
    await waitFor(() => customThemeNames().includes('Forest'), 'Forest listed');

    await clickDeleteTheme('Forest');
    expect(confirmText()).toMatch(/Delete theme "Forest"/);
    await answerConfirm(app, { confirm: true });

    expect(app.exists('.filo/themes/forest.json')).toBe(false);
    expect(trashedPaths(app)).toEqual(['.filo/themes/forest.json']);
    expect(customThemeNames()).not.toContain('Forest');

    await openSettingsTab(app, 'Trash');
    await restoreFromTrashSettings('.filo/themes/forest.json');
    expect(app.read('.filo/themes/forest.json')).toBe(forest);
    await openSettingsTab(app, 'Themes');
    await waitFor(() => customThemeNames().includes('Forest'), 'Forest listed again');
  });
});

describe('picking a theme with Global Defaults colours set', () => {
  const defaults = JSON.stringify({ mindmap: { tile: { headerColor: '#ff0000' } } });

  it('asks, and "Keep my colours" keeps them', async () => {
    const app = await startApp({ '.filo/defaults.json': defaults });
    await openSettingsTab(app, 'Themes');
    await pickTheme('Dark Mode');
    expect(confirmText()).toMatch(/set 1 Global Defaults colour/);
    await answerConfirmSecondary();

    await waitFor(() => appearance(app).activeTheme === 'dark', 'Dark saved');
    expect(app.read('.filo/defaults.json')).toContain('#ff0000');
  });

  it('asks, and "Use theme colours" clears them', async () => {
    const app = await startApp({ '.filo/defaults.json': defaults });
    await openSettingsTab(app, 'Themes');
    await pickTheme('Dark Mode');
    await answerConfirm(app, { confirm: true });

    await waitFor(() => appearance(app).activeTheme === 'dark', 'Dark saved');
    expect(app.read('.filo/defaults.json')).not.toContain('#ff0000');
  });

  it('Cancel changes nothing', async () => {
    const app = await startApp({ '.filo/defaults.json': defaults });
    await openSettingsTab(app, 'Themes');
    const before = activeThemeName();
    await pickTheme('Dark Mode');
    await answerConfirm(app, { confirm: false });
    expect(activeThemeName()).toBe(before);
    expect(app.read('.filo/defaults.json')).toContain('#ff0000');
  });
});

describe('the Current Board tab', () => {
  it('is off while a note\'s Document tab is showing, though a board is open behind it', async () => {
    const app = await startApp({ 'Plan.md': '# Plan\n' });
    await createBoard(app, 'kanban');
    await openSettingsTab(app, 'Current Board');
    expect(settingsTabEnabled('Current Board')).toBe(true);
    await closeModal();

    await openNoteFromSidebar(app, 'Plan.md');
    await openSettingsTab(app, 'Themes');
    expect(settingsTabEnabled('Current Board')).toBe(false);
  });
});
