/**
 * tileDefBuilder — pure builders for V7 board file payloads.
 *
 * Extracts vault-storable tile definitions from full runtime Tiles and
 * defines the constants the write pipeline uses to keep board JSON clean
 * (inline-tile-type set, task-metadata strip list).
 */

import type {
  Tile,
  TileDefinition,
  InlineTile,
  Board,
  Connection,
  Frame,
} from '../../schema/index';
import { TASK_METADATA_FIELDS } from '../../schema/tile';

// ── V7 Board File Data ──

export interface V7BoardFileData {
  /**
   * Envelope version stamped at write time. Narrowed to the literal `7` so
   * accidental writes of a stale or future version are caught at the type
   * level — `CURRENT_BOARD_FILE_VERSION` is the only sanctioned writer
   * (`boardWriteScheduler.writeBoardFile`). Optional on the in-memory type
   * so newly-built payloads don't need to set it explicitly — the saver
   * fills it in before serialise. Consumers should not branch on this
   * field; see `schema/boardFile.ts` note for the contract.
   */
  version?: 7;
  board: Board;
  tileDefs: Record<string, TileDefinition>;
  connections: Record<string, Connection>;
  frames: Frame[];
}

// ── Inline tile type detection ──

const INLINE_TILE_TYPES = new Set<string>(['link', 'iframe', 'timer']);

export function isInlineTileType(type: string): boolean {
  return INLINE_TILE_TYPES.has(type);
}

// ── Tile definition builders ──

/**
 * Extracts the vault-storable tile definition from a full runtime Tile.
 * Strips placement fields (position, size, locked, faded, boardId).
 *
 * Per-type fields are emitted via a discriminated switch over `tile.type`
 * so TypeScript narrows each branch to the matching schema variant —
 * a renamed field can no longer slip through a stringly-typed accessor.
 */
export function buildTileDefinition(tile: Tile): TileDefinition {
  const base = {
    id: tile.id,
    type: tile.type,
    title: tile.title,
    style: tile.style,
    tags: tile.tags,
    createdAt: tile.createdAt,
    updatedAt: tile.updatedAt,
  };
  switch (tile.type) {
    case 'text': {
      const def: Record<string, unknown> = {
        ...base,
        contentId: tile.contentId,
        content: '',
      };
      if (tile.filePath !== undefined) def.filePath = tile.filePath;
      return def as TileDefinition;
    }
    case 'image':
      return { ...base, src: tile.src } as TileDefinition;
    case 'video':
      return { ...base, src: tile.src, isPlaying: tile.isPlaying } as TileDefinition;
    case 'audio':
      return {
        ...base,
        src: tile.src,
        isPlaying: tile.isPlaying,
        isRecording: tile.isRecording,
      } as TileDefinition;
    case 'file':
      return {
        ...base,
        filePath: tile.filePath,
        fileName: tile.fileName,
        fileExtension: tile.fileExtension,
      } as TileDefinition;
    case 'link':
    case 'iframe':
      return { ...base, url: tile.url } as TileDefinition;
    case 'timer':
      return {
        ...base,
        duration: tile.duration,
        remaining: tile.remaining,
        mode: tile.mode,
        isRunning: tile.isRunning,
      } as TileDefinition;
  }
}

/**
 * Builds an inline tile object (link/iframe/timer) from a full Tile.
 * Merges definition + placement since inline tiles are not vault-backed.
 *
 * Only the three inline tile types are supported; other types raise a
 * developer-visible error so callers never silently produce malformed
 * inline payloads.
 */
export function buildInlineTileFromTile(tile: Tile): InlineTile {
  const base = {
    id: tile.id,
    title: tile.title,
    style: tile.style,
    tags: tile.tags,
    x: tile.position.x,
    y: tile.position.y,
    width: tile.size.width,
    height: tile.size.height,
    locked: tile.locked,
    faded: tile.faded,
    createdAt: tile.createdAt,
    updatedAt: tile.updatedAt,
  };
  switch (tile.type) {
    case 'link':
      return { ...base, type: 'link', url: tile.url } as InlineTile;
    case 'iframe':
      return { ...base, type: 'iframe', url: tile.url } as InlineTile;
    case 'timer':
      return {
        ...base,
        type: 'timer',
        duration: tile.duration,
        remaining: tile.remaining,
        mode: tile.mode,
        isRunning: tile.isRunning,
      } as InlineTile;
    default:
      throw new Error(
        `[buildInlineTileFromTile] Tile type "${tile.type}" is not an inline tile`,
      );
  }
}

/**
 * Task / Kanban-card metadata fields that belong in `.md` YAML frontmatter,
 * never in board JSON tile defs. Wraps the canonical `TASK_METADATA_FIELDS`
 * list from `schema/tile.ts` as a Set for the write pipeline. Stripped on
 * write so the disk file stays clean even if an in-memory def somehow
 * carries them — defense in depth against future regressions in
 * `buildTileDefinition` or stale data restored from undo.
 */
export const TASK_METADATA_FIELDS_ON_WRITE = new Set<string>(TASK_METADATA_FIELDS);
