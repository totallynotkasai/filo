import type { Tile } from '../schema/index';
import type { TileType } from '../../shared/types';
import { createId } from '../lib/utils/ids';
import { TILE_DEFAULTS, defaultTileStyleSnapshot } from '../constants/defaults';
import { boardStore } from './board.svelte';
import { getTileDefaults } from '../core/tileRegistry';

/**
 * Tile factory — centralised tile creation with correct defaults per type.
 * Uses the tile registry for type-specific defaults.
 */

export function createTile(
  type: TileType,
  position: { x: number; y: number },
  boardId: string,
  overrides?: Partial<Tile>,
): Tile {
  const now = Date.now();

  const base = {
    id: createId(),
    title: boardStore.getNextTileName(),
    position: { ...position },
    size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
    // No font sizes: the tile follows the style cascade, down to General →
    // Default Board Font Size (`effectiveStyle.ts`).
    style: defaultTileStyleSnapshot(),
    locked: false,
    faded: false,
    frameless: false,
    tags: [] as string[],
    boardId,
    createdAt: now,
    updatedAt: now,
  };

  // Get type-specific defaults from registry, then apply overrides on top
  const typeDefaults = getTileDefaults(type);
  return { ...base, type, ...typeDefaults, ...overrides } as Tile;
}

/**
 * Determines tile type from a file's MIME type.
 */
export function getTileTypeFromMime(mimeType: string): TileType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'text';
  return 'file';
}

/**
 * Determines tile type from a file extension.
 */
export function getTileTypeFromExtension(ext: string): TileType {
  const lower = ext.toLowerCase().replace('.', '');
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const videoExts = ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'wma', 'm4a'];
  const textExts = ['md', 'markdown'];

  if (imageExts.includes(lower)) return 'image';
  if (videoExts.includes(lower)) return 'video';
  if (audioExts.includes(lower)) return 'audio';
  if (textExts.includes(lower)) return 'text';
  return 'file';
}
