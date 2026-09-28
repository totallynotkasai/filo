/**
 * What the Themes settings tab does: pick a theme (and keep that choice
 * across relaunches), delete a custom theme into Filo's trash, and open the
 * theme editor on new, edited, duplicated or imported colours.
 */
import type { ThemeId } from '../../../shared/types';
import { themeStore } from '../../stores/theme.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { settleUnappliedEdits } from '../settings/unappliedEditsPrompt';
import { reportError } from '../utils/errorBus';
import { clearDefaultColours, customisedDefaultColours } from './defaultColours';
import {
  BUILTIN_THEME_LABELS,
  copyName,
  freeThemeName,
  parseImportedTheme,
  themeNameProblem,
  type ThemeEditorSession,
} from './themeFiles';
import { listBuiltinThemes, readBuiltinThemeVariables, snapshotThemeVariables } from './themeManager';

export function isBuiltinTheme(id: string): id is ThemeId {
  return (listBuiltinThemes() as readonly string[]).includes(id);
}

export function themeLabel(id: string): string {
  return isBuiltinTheme(id) ? BUILTIN_THEME_LABELS[id] : (themeStore.cache[id]?.name ?? id);
}

/**
 * Asks whether the Global Defaults colours the user set give way to the new
 * theme's. Resolves `'theme'`, `'keep'`, or null on Cancel.
 */
function askAboutSetColours(count: number, themeName: string): Promise<'theme' | 'keep' | null> {
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: 'Use the theme\'s colours?',
      body:
        `You have set ${count} Global Defaults colour${count === 1 ? '' : 's'}. "${themeName}" can replace `
        + `${count === 1 ? 'it' : 'them'} with its own colours, or you can keep yours. Boards follow the `
        + 'Global Defaults unless a board sets its own colour.',
      confirmLabel: 'Use theme colours',
      cancelLabel: 'Cancel',
      secondaryAction: { label: 'Keep my colours', onClick: () => resolve('keep') },
      onConfirm: () => resolve('theme'),
      onCancel: () => resolve(null),
    });
  });
}

/**
 * Makes `id` the active theme and saves the choice to `appearance.json`, so a
 * relaunch opens on it (custom themes included). Unless "System colours only"
 * is on, the Global Defaults colours go back to the theme's, after asking
 * when the user had set any. Resolves false when nothing changed.
 */
export async function selectTheme(id: string): Promise<boolean> {
  const vaultRoot = vaultStore.path;
  const project = vaultStore.project;
  if (!vaultRoot || !project) return false;
  const systemOnly = themeStore.systemOnly;
  let clearColours = !systemOnly;
  if (clearColours) {
    const set = customisedDefaultColours(project.settings);
    if (set.length > 0) {
      const choice = await askAboutSetColours(set.length, themeLabel(id));
      if (choice === null) return false;
      clearColours = choice === 'theme';
    }
  }
  // The Global Defaults tab holds a copy of those colours: its edits are
  // settled first and the copy taken again after, or an Apply of the old copy
  // would put the old colours back.
  if (clearColours && !(await settleUnappliedEdits('global', 'switch theme'))) return false;
  try {
    const result = await themeStore.applyById(vaultRoot, id);
    if (!result.ok) {
      reportError(
        'themeActions.select',
        result.error ?? `Theme "${id}" could not be applied`,
        `Theme "${themeLabel(id)}" could not be applied${result.error ? `: ${result.error}` : ''}. Reverted to Light.`,
      );
      return false;
    }
    // "System colours only" is a session-only look over the saved theme, so
    // it doesn't change what the vault opens with.
    if (systemOnly) return true;
    vaultStore.setTheme(id);
    if (clearColours) {
      clearDefaultColours(project.settings);
      vaultStore.markMetaDirty();
    }
    // Written now rather than on the 300 ms debounce, so a quit straight
    // after the pick still reopens on it.
    try {
      await vaultStore.save();
    } catch (err) {
      reportError('themeActions.persist', err, 'Failed to save the theme choice');
    }
    return true;
  } finally {
    if (clearColours) pendingSettingsStore.startGlobal();
  }
}

/**
 * Turns "System colours only" on or off and repaints at once. On: the active
 * theme's chrome goes over the boards' theme. Off: the whole app goes back to
 * the theme the vault opens with (a pick made while it was on was for the
 * session only).
 */
export async function setSystemColoursOnly(on: boolean): Promise<void> {
  themeStore.setSystemOnly(on);
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  const id = on ? themeStore.activeFileId : (vaultStore.project?.theme || themeStore.activeFileId);
  const result = await themeStore.applyById(vaultRoot, id);
  if (!result.ok) {
    reportError(
      'themeActions.systemOnly',
      result.error ?? `Theme "${id}" could not be applied`,
      `Theme "${themeLabel(id)}" could not be applied${result.error ? `: ${result.error}` : ''}. Reverted to Light.`,
    );
  }
}

/** The colours a theme card shows. */
export interface ThemePreview {
  background: string;
  bar: string;
  accent: string;
  text: string;
}

const PREVIEW_TOKENS = ['--ui-bg', '--toolbar-bg', '--accent-primary', '--text-secondary'] as const;

/**
 * A theme's own colours for its card: a built-in's read off its stylesheet
 * block, a custom theme's from its file over its base. Null when they can't be
 * read (no stylesheet, as in tests).
 */
export function themePreview(id: string): ThemePreview | null {
  const file = isBuiltinTheme(id) ? null : themeStore.cache[id];
  const base = isBuiltinTheme(id) ? id : (file?.base ?? 'dark');
  const vars = { ...readBuiltinThemeVariables(base, PREVIEW_TOKENS), ...(file?.variables ?? {}) };
  const [bg, bar, accent, text] = PREVIEW_TOKENS.map((name) => vars[name]);
  if (!bg || !bar || !accent || !text) return null;
  return { background: bg, bar, accent, text };
}

/**
 * Moves a custom theme into Filo's trash after a confirm. The active theme
 * falls back to the built-in it was based on.
 */
export async function deleteCustomTheme(id: string): Promise<void> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot || isBuiltinTheme(id)) return;
  const name = themeLabel(id);
  const confirmed = await uiStore.confirmAsync({
    title: `Delete theme "${name}"?`,
    body: "It moves to Filo's trash. Settings → Trash can restore it.",
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  const wasActive = themeStore.activeFileId === id;
  const base = themeStore.cache[id]?.base ?? 'dark';
  const ok = await themeStore.deleteTheme(vaultRoot, id);
  if (!ok) {
    uiStore.toast(`Couldn't delete theme "${name}"`, 'error');
    return;
  }
  uiStore.toast(`Theme "${name}" moved to Filo's trash`, 'info');
  if (wasActive) {
    await themeStore.applyById(vaultRoot, base);
    vaultStore.setTheme(base);
    try {
      await vaultStore.save();
    } catch (err) {
      reportError('themeActions.delete', err, 'Failed to save the theme choice');
    }
  }
}

/** The editor on the colours on screen now (the active theme). */
export function newThemeSession(): ThemeEditorSession {
  return {
    mode: 'new',
    ownId: null,
    name: freeThemeName('My theme', themeStore.available),
    base: themeStore.active,
    variables: snapshotThemeVariables(),
  };
}

/** The editor on a copy of `id` (built-in or custom), saved as a new theme. */
export function duplicateThemeSession(id: string): ThemeEditorSession {
  if (isBuiltinTheme(id)) {
    return {
      mode: 'new',
      ownId: null,
      name: copyName(BUILTIN_THEME_LABELS[id], themeStore.available),
      base: id,
      variables: readBuiltinThemeVariables(id),
    };
  }
  const file = themeStore.cache[id];
  const base = file?.base ?? 'dark';
  return {
    mode: 'new',
    ownId: null,
    name: copyName(file?.name ?? id, themeStore.available),
    base,
    variables: { ...readBuiltinThemeVariables(base), ...(file?.variables ?? {}) },
  };
}

/** The editor on custom theme `id`; Save writes over it. */
export function editThemeSession(id: string): ThemeEditorSession | null {
  const file = themeStore.cache[id];
  if (!file || isBuiltinTheme(id)) return null;
  const base = file.base ?? 'dark';
  return {
    mode: 'edit',
    ownId: id,
    name: file.name,
    base,
    variables: { ...readBuiltinThemeVariables(base), ...file.variables },
  };
}

/**
 * The editor on an imported theme file's colours, over its base theme so
 * every colour has a value. Nothing is saved until the user clicks Save.
 */
export function importThemeSession(text: string): ThemeEditorSession | { error: string } {
  const parsed = parseImportedTheme(text);
  if (!parsed.ok) return { error: parsed.message };
  const taken = themeStore.available;
  const name = themeNameProblem(parsed.name, taken) ? freeThemeName(parsed.name, taken) : parsed.name;
  return {
    mode: 'new',
    ownId: null,
    name,
    base: parsed.base,
    variables: { ...readBuiltinThemeVariables(parsed.base), ...parsed.variables },
  };
}
