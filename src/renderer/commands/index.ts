/**
 * Command-pattern objects that participate in the per-board undo/redo
 * history stack. Sprint 39 / 39.7 — what used to live in this one file
 * (~2200 LOC) is now sharded across eight sibling modules below. This
 * file is a re-export shim — every existing import path
 * (`from '../commands/index'`) keeps working.
 *
 * One concern per file:
 *  - tileCommands         — tile add/delete/move/resize/style/lock
 *  - tileTagCommands      — tile/path tag add/remove + fade-by-tag (dispatched by fileTagsStore)
 *  - connectionCommands   — connection add/delete/update
 *  - frameCommands        — frame add/update/move/delete
 *  - sectionCommands      — Task List section add/delete/rename/reorder
 *  - taskCommands         — Task List add/delete/move/field/lock/style + snapshot helpers
 *  - kanbanCommands       — Kanban card + column add/delete/move/rename
 *  - waypointCommands     — Mind Map waypoint add/remove/rename/move/icon/lock
 *  - groupAndBoardCommands — BatchCommand, ToggleGroupCommand,
 *                            CascadeDeleteCommand, UpdateBoardSettingsCommand
 *  - styleCommands        — Phase 15 style-popup commands (existing file)
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
export * from './renameTitleCommand';
export * from './savedViewsCommand';
