import { DEFAULT_FONT, fontStack } from './fontStack';

/**
 * Default values of the General settings (`.filo/app.json`).
 *
 * The one list: `GeneralSettingsSchema` (renderer) takes its `.default()`s
 * from here, and the main process seeds a new vault's `app.json` from it,
 * because main can't import the renderer schema. A unit test checks that
 * `GeneralSettingsSchema.parse({})` equals this object, so a field added to
 * the schema without a default here fails CI instead of seeding a vault
 * without it.
 */
export const GENERAL_SETTINGS_DEFAULTS = {
  globalFont: fontStack(DEFAULT_FONT),
  globalFontSize: 13,
  defaultLineSpacing: 1.5,
  defaultBoardFontSize: {
    tileTitle: 14,
    tileBody: 13,
    connectionLabel: 12,
    frameTitle: 15,
    kanbanColumnTitle: 14,
    kanbanCardTitle: 13,
    kanbanCardBody: 12,
    taskListTitle: 16,
    taskItem: 13,
    taskItemBody: 12,
    taskSectionTitle: 14,
  },
  systemFonts: [DEFAULT_FONT, 'Arial', 'Georgia', 'Courier New', 'Verdana'],
  globalToolbarScale: 1,
  boardToolbarScale: 1,
  tabBarScale: 1,
  minimapScale: 1,
  waypointScale: 1,
  toolbarColor: '',
  tabBarColor: '',
  radarEnabled: true,
  recentColors: [] as string[],
  historyLimit: 500,
  activeRootFolder: '',
  showFileExtensions: false,
  sidebarSortField: 'none',
  sidebarSortDirection: 'asc',
  sidebarGroupField: 'none',
  sidebarGroupDirection: 'asc',
  vaultColor: '',
  boardFolders: false,
  hoverButtons: {
    tiles: true,
    cards: true,
    tasks: true,
    frames: true,
    connectionLabels: true,
    columns: true,
  },
} as const;

/** A fresh, mutable copy (the constant's arrays and objects are shared). */
export function generalSettingsDefaults(): typeof GENERAL_SETTINGS_DEFAULTS {
  return JSON.parse(JSON.stringify(GENERAL_SETTINGS_DEFAULTS)) as typeof GENERAL_SETTINGS_DEFAULTS;
}

type NewVaultGeneralSettings = Omit<typeof GENERAL_SETTINGS_DEFAULTS, 'boardFolders'> & { boardFolders: boolean };

/**
 * A brand-new vault's `app.json`: the defaults with board-specific folders
 * on, so each board's notes go in a folder of its own instead of beside the
 * user's own notes at the top of the vault. The schema default stays off: an
 * existing vault whose `app.json` has no `boardFolders` key reads as off, so
 * its new notes keep going where they always went.
 */
export function newVaultGeneralSettings(): NewVaultGeneralSettings {
  return { ...generalSettingsDefaults(), boardFolders: true };
}
