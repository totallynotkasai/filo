/**
 * The Global Defaults colours a theme switch hands back to the theme.
 *
 * An empty colour means "the theme's colour". Picking a theme clears these so
 * the new theme shows everywhere; any the user set are listed first, so the
 * switch can ask before it drops them. Shape, border and other non-colour
 * defaults are never touched.
 */
import type { ProjectSettings } from '../../schema/index';

const SLICES = ['mindmap', 'kanban', 'tasklist', 'document'] as const;

type Visit = (holder: Record<string, unknown>, key: string, path: string) => void;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every string field named `…Color` under the style-default slices. */
function eachColour(settings: ProjectSettings, visit: Visit): void {
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;
      if (isObject(value)) walk(value, path);
      else if (typeof value === 'string' && key.endsWith('Color')) visit(node, key, path);
    }
  };
  for (const slice of SLICES) {
    const node: unknown = settings[slice];
    if (isObject(node)) walk(node, slice);
  }
}

/** The default-colour paths the user has set (a non-empty colour). */
export function customisedDefaultColours(settings: ProjectSettings): string[] {
  const out: string[] = [];
  eachColour(settings, (holder, key, path) => {
    if (holder[key] !== '') out.push(path);
  });
  return out;
}

/** Sets every default colour back to empty (the theme's colour). */
export function clearDefaultColours(settings: ProjectSettings): void {
  eachColour(settings, (holder, key) => {
    holder[key] = '';
  });
}
