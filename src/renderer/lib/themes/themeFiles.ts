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
import { THEME_TOKEN_NAMES } from './themeTokens';
import { isThemeTokenValue } from './themeValues';

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

const THEME_TOKENS: ReadonlySet<string> = new Set(THEME_TOKEN_NAMES);

/**
 * The variables a theme may carry: the theme tokens (`themeTokens.ts`) whose
 * values pass the theme-value sanitiser and are values a theme can hold
 * (`themeValues.ts`: a colour, or a shadow for the shadow tokens). Anything
 * else is dropped, not refused, so a theme from a newer version still loads.
 * A theme that could set any variable could also set the app's own
 * (`--z-modal` would put every dialog behind the app) or the user's settings.
 */
export function cleanThemeVariables(raw: Record<string, unknown>): ThemeVariableMap {
  const out: ThemeVariableMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!THEME_TOKENS.has(name)) continue;
    if (typeof value !== 'string') continue;
    const safe = asSafeThemeValue(value);
    if (safe !== null && isThemeTokenValue(name, safe)) out[name] = safe;
  }
  return out;
}

const ThemeShapeSchema = z.object({
  name: z.string().optional(),
  base: z.string().optional(),
  variables: z.record(z.string(), z.unknown()),
});

/**
 * The built-in a theme file's `base` names: `dark` when it names none (the
 * default since custom themes began), Light with a note when it names one Filo
 * doesn't have. A theme is only colours, so a bad base never stops a vault
 * opening.
 */
function themeBase(raw: string | undefined, label: string): { base: ThemeId; problem: string | null } {
  if (raw === undefined) return { base: 'dark', problem: null };
  if ((BUILTIN_IDS as string[]).includes(raw)) return { base: raw as ThemeId, problem: null };
  return {
    base: 'light',
    problem: `Theme "${label}" is based on "${raw}", which isn't a built-in theme. Light is used under its colours.`,
  };
}

export type DiskThemeResult =
  | { ok: true; file: ThemeFile; problem: string | null }
  | { ok: false };

/**
 * Reads a `.filo/themes/<id>.json` file's parsed JSON. It goes through the same
 * shape check and variable filter as an import: the file syncs and can be
 * edited by hand. `ok: false` when it isn't a theme at all.
 */
export function readThemeFile(id: string, data: unknown): DiskThemeResult {
  const parsed = ThemeShapeSchema.safeParse(data);
  if (!parsed.success) return { ok: false };
  const name = parsed.data.name?.trim() || id;
  const { base, problem } = themeBase(parsed.data.base, name);
  return { ok: true, file: { id, name, base, variables: cleanThemeVariables(parsed.data.variables) }, problem };
}

/**
 * What `theme:load` answered, read as a theme: the file (with a note when its
 * `base` had to be replaced), `'invalid'` when the file isn't valid JSON (the
 * main side's `{ ok: false, code: 'invalid-json' }`) or isn't a theme, or null
 * when there is no file.
 */
export function loadedTheme(
  id: string,
  value: unknown,
): { file: ThemeFile; problem: string | null } | 'invalid' | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && (value as { ok?: unknown }).ok === false) return 'invalid';
  const read = readThemeFile(id, value);
  return read.ok ? { file: read.file, problem: read.problem } : 'invalid';
}

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
  const parsed = ThemeShapeSchema.safeParse(data);
  const name = parsed.success ? parsed.data.name?.trim() : '';
  if (!parsed.success || !name) {
    return { ok: false, message: 'That file is not a Filo theme: it needs a "name" and a "variables" map.' };
  }
  const variables = cleanThemeVariables(parsed.data.variables);
  if (Object.keys(variables).length === 0) {
    return { ok: false, message: 'That theme has no colours Filo can use.' };
  }
  return { ok: true, name, base: themeBase(parsed.data.base, name).base, variables };
}

/** The theme file written for `name`. */
export function buildThemeFile(name: string, base: ThemeId, variables: ThemeVariableMap): ThemeFile {
  return { id: themeIdFromName(name), name: name.trim(), base, variables: cleanThemeVariables(variables) };
}
