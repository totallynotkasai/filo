export { TileSchema, TileDefinitionSchema, ImageTileSchema, TimerTileSchema, TimerModeSchema, TextTileDefSchema, TimerTileDefSchema } from './tile';
export type { Tile, TileDefinition, TileStyle, TextTile, ImageTile, VideoTile, FileTile, AudioTile, LinkTile, IframeTile, TimerTile, TimerMode, TextTileDef } from './tile';

export {
  TilePlacementSchema,
  InlineTileSchema,
  KanbanTilePlacementSchema,
} from './placement';
export type {
  InlineTile,
  KanbanTilePlacement,
  TaskPlacement,
  PartialKanbanCardStyle,
  PartialTaskStyle,
} from './placement';

export { BoardSchema, MindMapBoardSchema, KanbanBoardSchema, TaskListBoardSchema, DocumentBoardSchema, boardSettingsSchemaFor } from './board';
export type { Board, MindMapBoard, KanbanBoard, TaskListBoard, TaskListSection, DocumentBoard, TileGroup } from './board';

export { ConnectionSchema, ConnectionLabelSchema } from './connection';
export type { Connection, ConnectionLabel } from './connection';

export { FrameSchema } from './frame';
export type { Frame } from './frame';

export { ProjectSchema, WorkspaceStateSchema } from './project';
export type { Project, WorkspaceState } from './project';

export { ProjectSettingsSchema, GeneralSettingsSchema, MindMapDefaultsSchema, KanbanDefaultsSchema, TaskListDefaultsSchema, DocumentDefaultsSchema, defaultProjectSettings } from './settings';
export type { ProjectSettings } from './settings';

export { decodeFiloLink } from './link';

export { TagsFileSchema } from './tagsFile';

export { LayoutTemplateSchema, LayoutTemplateConnectionSchema } from './layoutTemplate';
export type { LayoutTemplate, LayoutTemplateTile, LayoutTemplateConnection } from './layoutTemplate';

export { BoardFileDataSchema, CURRENT_BOARD_FILE_VERSION } from './boardFile';
export { migrateBoardFile } from './migrations';
