import type { ProjectSettings, Board } from '../../schema/index';
import { defaultProjectSettings } from '../../schema/index';

/**
 * Builds a fresh `Board['settings']` block from a `ProjectSettings`
 * source for a given board type.
 *
 * Used in two places:
 *   1. `boardRegistry.createDefault(...)` — every newly-created board
 *      bakes the active Global Defaults into its own `settings`, so
 *      future edits to Global Defaults don't retroactively change it.
 *   2. The "Apply Current Global Defaults to all Boards" / "Apply
 *      Theme Defaults to all Boards" buttons, which merge the style keys
 *      of this block into every board (`mergeBoardStyleSettings`).
 *
 * The shape mirrors what the per-type `*SettingsSchema` produces, with
 * a `defaults` sub-block that mirrors the corresponding
 * `*BoardDefaultsSchema` from `schema/board.ts`. The cascade in
 * `effectiveStyle.ts` reads `defaults` first, so this is what makes the
 * snapshot stick.
 */

type BoardSettings = Record<string, unknown>;

export function buildBoardSettingsFromGlobal(
  type: Board['type'],
  src: ProjectSettings,
): BoardSettings {
  switch (type) {
    case 'mindmap': {
      const mm = src.mindmap;
      return {
        backgroundColor: mm.backgroundColor,
        backgroundPattern: mm.backgroundPattern,
        // Per-board flags that the global defaults don't carry — keep
        // sensible defaults so a fresh board renders correctly.
        semanticZoom: true,
        snapToGrid: false,
        connectionsVisible: true,
        labelsVisible: true,
        defaults: {
          tile: { ...mm.tile },
          connectionPath: { ...mm.connectionPath },
          connectionLabel: { ...mm.connectionLabel },
          frame: { ...mm.frame },
        },
      };
    }
    case 'kanban': {
      const kb = src.kanban;
      return {
        backgroundColor: kb.backgroundColor,
        backgroundPattern: kb.backgroundPattern,
        accentColor: kb.accentColor,
        defaults: {
          column: { ...kb.column },
          card: { ...kb.card },
        },
      };
    }
    case 'tasklist': {
      const tl = src.tasklist;
      // Bake the current Default Board Font Size for "Task List Title"
      // into the new board's `titleFontSize`. Subsequent changes to the
      // global default never retroactively update this board (per the
      // creation-time-seed semantics for font sizes).
      const titleFontSize = src.general?.defaultBoardFontSize?.taskListTitle;
      return {
        backgroundColor: tl.backgroundColor,
        backgroundPattern: tl.backgroundPattern,
        accentColor: tl.accentColor,
        groupBy: 'status',
        sortBy: 'priority',
        ...(typeof titleFontSize === 'number' && { titleFontSize }),
        defaults: {
          task: { ...tl.task },
          section: { ...tl.section },
        },
      };
    }
    case 'document': {
      const doc = src.document;
      return {
        backgroundColor: doc.backgroundColor,
        backgroundPattern: doc.backgroundPattern,
        accentColor: doc.accentColor,
        defaults: {
          document: { ...doc.document },
        },
      };
    }
  }
}

/**
 * The board-settings keys that are style: colours, pattern, title font size
 * and the per-board `defaults` cascade block. "Apply … Defaults to all
 * Boards" overwrites only these. Everything else a board keeps (Kanban
 * saved views, its default folder, Mind Map snap / semantic zoom /
 * visibility, Task List group and sort) is not style and must survive.
 */
export const BOARD_STYLE_SETTING_KEYS = [
  'backgroundColor',
  'backgroundPattern',
  'accentColor',
  'titleFontSize',
  'defaults',
] as const;

/**
 * `existing` with its style keys replaced by the ones in `built` (from
 * `buildBoardSettingsFromGlobal` / `…FromTheme`). A style key `built`
 * doesn't carry is left as the board has it.
 */
export function mergeBoardStyleSettings(
  existing: BoardSettings,
  built: BoardSettings,
): BoardSettings {
  const next: BoardSettings = { ...existing };
  for (const key of BOARD_STYLE_SETTING_KEYS) {
    if (key in built) next[key] = built[key];
  }
  return next;
}

/**
 * Returns a settings block populated entirely from schema defaults —
 * empty string colours, schema-default enums, etc. Renders against the
 * active CSS theme's variables (which `BoardBackground` and the various
 * tile/frame/column/card/task components fall back to when their
 * effective colour is empty).
 *
 * Used by "Apply Theme Defaults to all Boards" to reset every board to
 * the active theme's appearance.
 */
export function buildBoardSettingsFromTheme(
  type: Board['type'],
): BoardSettings {
  const themeDefaults = defaultProjectSettings();
  return buildBoardSettingsFromGlobal(type, themeDefaults);
}
