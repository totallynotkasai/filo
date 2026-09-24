export { TileSchema, TileDefinitionSchema, TileStyleSchema, TextTileSchema, ImageTileSchema, VideoTileSchema, FileTileSchema, AudioTileSchema, LinkTileSchema, IframeTileSchema, TimerTileSchema, TextTileDefSchema, ImageTileDefSchema, VideoTileDefSchema, FileTileDefSchema, AudioTileDefSchema, LinkTileDefSchema, IframeTileDefSchema, TimerTileDefSchema } from './tile';
export type { Tile, TileDefinition, TileStyle, TextTile, ImageTile, VideoTile, FileTile, AudioTile, LinkTile, IframeTile, TimerTile, TextTileDef } from './tile';

export {
  TilePlacementSchema,
  InlineTileSchema,
  KanbanTilePlacementSchema,
  TaskPlacementSchema,
  PartialKanbanCardStyleSchema,
  PartialTaskStyleSchema,
} from './placement';
export type {
  TilePlacement,
  InlineTile,
  KanbanTilePlacement,
  TaskPlacement,
  PartialKanbanCardStyle,
  PartialTaskStyle,
} from './placement';

export { BoardSchema, MindMapBoardSchema, KanbanBoardSchema, TaskListBoardSchema, DocumentBoardSchema, TileGroupSchema } from './board';
export type { Board, MindMapBoard, KanbanBoard, TaskListBoard, TaskListSection, DocumentBoard, TileGroup } from './board';

export { ConnectionSchema, ConnectionLabelSchema } from './connection';
export type { Connection, ConnectionLabel } from './connection';

export { FrameSchema } from './frame';
export type { Frame } from './frame';

export { ProjectSchema, WorkspaceStateSchema } from './project';
export type { Project, WorkspaceState } from './project';

export { ProjectSettingsSchema, GeneralSettingsSchema, MindMapDefaultsSchema, KanbanDefaultsSchema, TaskListDefaultsSchema, DocumentDefaultsSchema, defaultProjectSettings } from './settings';
export type { ProjectSettings, GeneralSettings, MindMapDefaults, KanbanDefaults, TaskListDefaults, DocumentDefaults } from './settings';

export { FiloLinkSchema, DecodedFiloLinkSchema, encodeFiloLink, decodeFiloLink, isFiloLink } from './link';
export type { FiloLink, DecodedFiloLink } from './link';

export { TagsFileSchema } from './tagsFile';
export type { TagsFile } from './tagsFile';

// V3 Document (.md) types
export type { RichTextAnnotation } from './document';

export { LayoutTemplateSchema, LayoutTemplateTileSchema, LayoutTemplateConnectionSchema } from './layoutTemplate';
export type { LayoutTemplate, LayoutTemplateTile, LayoutTemplateConnection } from './layoutTemplate';

export { V7BoardFileDataSchema, CURRENT_BOARD_FILE_VERSION } from './boardFile';
export { migrateBoardFile, type MigrateBoardFileResult } from './migrations';
