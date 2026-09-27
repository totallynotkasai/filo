/**
 * Custom theme files (`.filo/themes/<id>.json`): what a name may be, the id a
 * name gets, and reading a theme file the user imports.
 *
 * A theme's id is its file name, derived from its name. Two rules keep every
 * saved theme visible in the picker:
 *   - no built-in name or id: the picker lists built-ins by id, so a custom
 *     `light.json` would be hidden behind the built-in Light theme;
 *   - no id another custom theme already has: saving would overwrite it.
 */
import { z } from 'zod';
import type { ThemeId } from '../../../shared/types';
import { asSafeThemeValue } from '../../../shared/untrusted';
import type { ThemeFile, ThemeVariableMap } from './themeManager';
import { SETTINGS_VAR_NAMES } from './themeTokens';

export const BUILTIN_THEME_LABELS: Record<ThemeId, string> = {
  light: 'Light Mode',
  dark: 'Dark Mode',
  blueprint: 'Blueprint',
  retro: 'Retro',
  nature: 'Nature',
};

const BUILTIN_IDS = Object.keys(BUILTIN_THEME_LABELS) as ThemeId[];

/** What the theme editor opens on. */
export interface ThemeEditorSession {
  /** `edit` saves over `ownId`; `new` always creates a theme. */
  mode: 'new' | 'edit';
  ownId: string | null;
  name: string;
  base: ThemeId;
  variables: ThemeVariableMap;
}

/** Longest theme name the editor accepts. */
export const THEME_NAME_MAX = 60;

export function themeIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'theme';
}

/**
 * Why `name` can't be saved as a theme, or null when it can. `ownId` is the
 * theme being saved over (Save on an edited theme), which may keep its id.
 */
export function themeNameProblem(
  name: string,
  takenIds: readonly string[],
  ownId: string | null = null,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the theme a name.';
  if (trimmed.length > THEME_NAME_MAX) return `Keep the name under ${THEME_NAME_MAX} characters.`;
  const id = themeIdFromName(trimmed);
  const lower = trimmed.toLowerCase();
  const builtin = BUILTIN_IDS.find(
    (b) => b === id || b === lower || BUILTIN_THEME_LABELS[b].toLowerCase() === lower
      || themeIdFromName(BUILTIN_THEME_LABELS[b]) === id,
  );
  if (builtin) return `"${BUILTIN_THEME_LABELS[builtin]}" is a built-in theme. Choose another name.`;
  if (id !== ownId && takenIds.includes(id)) return 'Another theme already has this name.';
  return null;
}

/** `base` if a theme may take it, else `base 2`, `base 3` … */
export function freeThemeName(base: string, takenIds: readonly string[]): string {
  const stem = base.trim().slice(0, THEME_NAME_MAX - 5);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? stem : `${stem} ${n}`;
    if (themeNameProblem(candidate, takenIds) === null) return candidate;
  }
  return stem;
}

/** A name for a copy of `name` that no theme uses yet: `Name copy`, `Name copy 2` … */
export function copyName(name: string, takenIds: readonly string[]): string {
  return freeThemeName(`${name.trim().slice(0, THEME_NAME_MAX - 10)} copy`, takenIds);
}

/**
 * The variables a theme may carry: CSS custom properties whose values pass
 * the theme-value sanitiser, minus the user's settings. Anything else is
 * dropped, not refused, so a theme from a newer version still loads.
 */
export function cleanThemeVariables(raw: Record<string, unknown>): ThemeVariableMap {
  const out: ThemeVariableMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^--[a-z0-9-]+$/i.test(name) || SETTINGS_VAR_NAMES.includes(name)) continue;
    if (typeof value !== 'string') continue;
    const safe = asSafeThemeValue(value);
    if (safe !== null) out[name] = safe;
  }
  return out;
}

const ImportedThemeSchema = z.object({
  name: z.string().trim().min(1),
  base: z.enum(['light', 'dark', 'blueprint', 'retro', 'nature']).optional(),
  variables: z.record(z.string(), z.unknown()),
});

export type ImportResult =
  | { ok: true; name: string; base: ThemeId; variables: ThemeVariableMap }
  | { ok: false; message: string };

/** Reads the text of a theme `.json` file the user picked. */
export function parseImportedTheme(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "That file isn't valid JSON." };
  }
  const parsed = ImportedThemeSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, message: 'That file is not a Filo theme: it needs a "name" and a "variables" map.' };
  }
  const variables = cleanThemeVariables(parsed.data.variables);
  if (Object.keys(variables).length === 0) {
    return { ok: false, message: 'That theme has no colours Filo can use.' };
  }
  return { ok: true, name: parsed.data.name, base: parsed.data.base ?? 'dark', variables };
}

/** The theme file written for `name`. */
export function buildThemeFile(name: string, base: ThemeId, variables: ThemeVariableMap): ThemeFile {
  return { id: themeIdFromName(name), name: name.trim(), base, variables: cleanThemeVariables(variables) };
}
