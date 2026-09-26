/**
 * tileDefBuilder — pure builders for board file payloads.
 *
 * Extracts vault-storable tile definitions from full runtime Tiles and
 * defines the inline-tile-type set the write pipeline uses.
 */

import type {
  Tile,
  TileDefinition,
  InlineTile,
  Board,
  Connection,
  Frame,
} from '../../schema/index';

// ── Board File Data ──

export interface BoardFileData {
  /**
   * Envelope version stamped at write time. Narrowed to the literal `8` so
   * accidental writes of a stale or future version are caught at the type
   * level — `CURRENT_BOARD_FILE_VERSION` is the only sanctioned writer
   * (`boardWriteScheduler.writeBoardFile`). Optional on the in-memory type
   * so newly-built payloads don't need to set it explicitly — the saver
   * fills it in before serialise. Consumers should not branch on this
   * field; see `schema/boardFile.ts` note for the contract.
   */
  version?: 8;
  board: Board;
  tileDefs: Record<string, TileDefinition>;
  connections: Record<string, Connection>;
  frames: Frame[];
}

// ── Inline tile type detection ──

// allow-module-state: immutable lookup table for inline tile type detection
const INLINE_TILE_TYPES = new Set<string>(['link', 'iframe', 'timer']);

export function isInlineTileType(type: string): boolean {
  return INLINE_TILE_TYPES.has(type);
}

// ── Tile definition builders ──

/**
 * Extracts the vault-storable tile definition from a full runtime Tile.
 * Strips placement fields (position, size, locked, faded, boardId) and every
 * field the board doesn't own: a text tile's title, tags and body live in its
 * note, and a media file's tags live in `.filo/tags.json`.
 *
 * Per-type fields are emitted via a discriminated switch over `tile.type`
 * so TypeScript narrows each branch to the matching schema variant.
 *
 * Throws for a text tile with no `filePath`: every creation site stamps the
 * note's path before the def is built (`stampTextTileSeedPath`), and a def
 * without one would name no note at all.
 */
export function buildTileDefinition(tile: Tile): TileDefinition {
  const base = {
    id: tile.id,
    style: tile.style,
    createdAt: tile.createdAt,
    updatedAt: tile.updatedAt,
    ...(tile.titleHtml !== undefined ? { titleHtml: tile.titleHtml } : {}),
  };
  switch (tile.type) {
    case 'text': {
      if (!tile.filePath) {
        throw new Error(`[buildTileDefinition] text tile "${tile.id}" has no filePath`);
      }
      return { ...base, type: 'text', filePath: tile.filePath };
    }
    case 'image': {
      const alt = tile.alt !== undefined ? { alt: tile.alt } : {};
      return { ...base, type: 'image', title: tile.title, src: tile.src, ...alt };
    }
    case 'video':
      return { ...base, type: 'video', title: tile.title, src: tile.src, isPlaying: tile.isPlaying };
    case 'audio':
      return {
        ...base,
        type: 'audio',
        title: tile.title,
        src: tile.src,
        isPlaying: tile.isPlaying,
        isRecording: tile.isRecording,
      };
    case 'file':
      return { ...base, type: 'file', title: tile.title, filePath: tile.filePath };
    case 'link':
    case 'iframe':
      return { ...base, type: tile.type, title: tile.title, tags: tile.tags, url: tile.url };
    case 'timer':
      return {
        ...base,
        type: 'timer',
        title: tile.title,
        tags: tile.tags,
        duration: tile.duration,
        remaining: tile.remaining,
        mode: tile.mode,
        isRunning: tile.isRunning,
      };
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
 * The fields a board file stores on each tile-def variant (besides `id`,
 * `type` and the timestamps). A tile update keeps only these on the def; the
 * rest of a `Partial<Tile>` is placement data or a projection of the note.
 */
// allow-module-state: immutable lookup table
const DEF_FIELDS: Record<TileDefinition['type'], ReadonlySet<string>> = {
  text: new Set(['titleHtml', 'style', 'filePath']),
  image: new Set(['title', 'titleHtml', 'style', 'src', 'alt']),
  video: new Set(['title', 'titleHtml', 'style', 'src', 'isPlaying']),
  audio: new Set(['title', 'titleHtml', 'style', 'src', 'isPlaying', 'isRecording']),
  file: new Set(['title', 'titleHtml', 'style', 'filePath']),
  link: new Set(['title', 'titleHtml', 'style', 'tags', 'url']),
  iframe: new Set(['title', 'titleHtml', 'style', 'tags', 'url']),
  timer: new Set(['title', 'titleHtml', 'style', 'tags', 'duration', 'remaining', 'mode', 'isRunning']),
};

/**
 * The part of `updates` that belongs on a def of `def.type`. Empty when the
 * update touched nothing the board file stores for this tile.
 */
export function defPatchFor(def: TileDefinition, updates: Partial<Tile>): Record<string, unknown> {
  const allowed = DEF_FIELDS[def.type];
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.has(k)) patch[k] = v;
  }
  return patch;
}
