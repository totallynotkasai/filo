/**
 * Command-pattern objects that participate in the per-board undo/redo
 * history stack. This file is a re-export shim over the sibling modules
 * below, so `from '../commands/index'` imports keep working.
 *
 * One concern per file (all re-exported below):
 *  - tileCommands          — tile add/delete/move/resize/style/lock
 *  - tileTagCommands       — tile/path tag add/remove + fade-by-tag (dispatched by fileTagsStore)
 *  - connectionCommands    — connection add/delete/update
 *  - frameCommands         — frame add/update/move/delete
 *  - sectionCommands       — Task List section add/delete/rename/reorder
 *  - taskCommands          — Task List add/delete/move/field/lock/style + snapshot helpers
 *  - kanbanCommands        — Kanban card + column add/delete/move/rename
 *  - waypointCommands      — Mind Map waypoint add/remove/rename/move/icon/lock
 *  - groupAndBoardCommands — BatchCommand, ToggleGroupCommand,
 *                            CascadeDeleteCommand, UpdateBoardSettingsCommand
 *  - styleCommands         — style-popup commands
 *  - propertiesCommands    — UpdatePropertiesCommand
 *  - attachmentSrcCommand  — Image/Video/Audio/File source swap
 *  - updateTitleCommand    — tile title edit (note frontmatter or board title)
 *  - renameFileCommand     — undo of "Rename file to match title" (the reverse rename)
 *  - savedViewsCommand     — UpdateSavedViewsCommand
 *  - noteLayoutCommands    — SetLineSpacingCommand (note frontmatter `lineSpacing:`)
 *
 * Not re-exported here: `Command.ts` (the base interface + abstract class) and
 * `trashedFiles.ts` (moving a delete's files into Filo's trash and back) are
 * imported directly by the command modules, and `replaceAllCommand.ts`
 * (vault-wide find-and-replace) is dynamically imported by the search panel.
 */

export * from './tileCommands';
export * from './tileTagCommands';
export * from './connectionCommands';
export * from './frameCommands';
export * from './sectionCommands';
export * from './taskCommands';
export * from './kanbanCommands';
export * from './waypointCommands';
export * from './groupAndBoardCommands';
export * from './styleCommands';
export * from './propertiesCommands';
export * from './attachmentSrcCommand';
export * from './updateTitleCommand';
export * from './renameFileCommand';
export * from './savedViewsCommand';
export * from './noteLayoutCommands';
