import type { ProjectSettings, Board } from '../../schema/index';
import { defaultProjectSettings } from '../../schema/index';

/**
 * Board settings blocks built from the Global Defaults or the theme.
 *
 * The rule (stated in Settings → Global Defaults and Current Board): a board
 * follows the Global Defaults for every style field it leaves blank, live, so
 * a Global Defaults change reaches it; a field set in its Current Board tab is
 * its own and wins. The cascade (`effectiveStyle.ts`, and the board
 * background / accent fallbacks in each board view) reads the board layer
 * first and skips blanks.
 *
 * Used by:
 *   1. `boardRegistry.createDefault(...)`: a new board starts with no style of
 *      its own (`buildBoardSettingsFromGlobal`), so it follows the Global
 *      Defaults.
 *   2. "Apply Current Global Defaults to all Boards" merges the same block's
 *      style keys into every board (`mergeBoardStyleSettings`), clearing
 *      their own style so they follow the Global Defaults again.
 *   3. "Apply Theme Defaults to all Boards" writes the schema defaults into
 *      every board (`buildBoardSettingsFromTheme`): theme colours, factory
 *      shapes, whatever the Global Defaults say.
 */

type BoardSettings = Record<string, unknown>;

/**
 * A board's settings with no style of its own: blank colours, no pattern and
 * an empty `defaults` block, so every style field follows the Global
 * Defaults. `backgroundPattern` is present as `undefined` so a merge clears a
 * board's own pattern. The Task List title size is the one creation-time seed
 * (`general.defaultBoardFontSize.taskListTitle`).
 */
export function buildBoardSettingsFromGlobal(
  type: Board['type'],
  src: ProjectSettings,
): BoardSettings {
  const style = { backgroundColor: '', backgroundPattern: undefined, defaults: {} };
  switch (type) {
    case 'mindmap':
      return {
        ...style,
        // Per-board flags that the global defaults don't carry.
        semanticZoom: true,
        snapToGrid: false,
        connectionsVisible: true,
        labelsVisible: true,
      };
    case 'kanban':
      return { ...style, accentColor: '' };
    case 'tasklist': {
      const titleFontSize = src.general?.defaultBoardFontSize?.taskListTitle;
      return {
        ...style,
        accentColor: '',
        groupBy: 'status',
        sortBy: 'priority',
        ...(typeof titleFontSize === 'number' && { titleFontSize }),
      };
    }
    case 'document':
      return { ...style, accentColor: '' };
  }
}

/** Every style field of `src` written into a board's own settings. */
function bakeBoardSettings(type: Board['type'], src: ProjectSettings): BoardSettings {
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
  return bakeBoardSettings(type, themeDefaults);
}
