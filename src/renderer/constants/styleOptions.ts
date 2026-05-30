/**
 * Shared option lists for the settings panels (Global Defaults + Current
 * Board). Mirrors the Zod enums in `schema/settings.ts` — keep both in
 * sync when adding/removing an option.
 */

export const SHAPE_OPTIONS = ['rectangle', 'rounded'] as const;
export const BORDER_STYLE_OPTIONS = ['solid', 'dashed', 'dotted'] as const;
export const BACKGROUND_PATTERN_OPTIONS = ['grid', 'dots', 'lines', 'none'] as const;
export const PATH_TYPE_OPTIONS = ['curved', 'straight', 'elbow', 'smart'] as const;
export const ARROW_TYPE_OPTIONS = ['none', 'start', 'end', 'both'] as const;
