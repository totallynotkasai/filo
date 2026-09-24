import type { TileType } from '../../shared/types';
import { createId } from '../lib/utils/ids';

/**
 * Metadata entry for a tile type in the registry.
 *
 * Carries only type metadata + creation defaults. Tile bodies are rendered by
 * the parent board through a Svelte snippet (TileContainer's `children` prop),
 * not through this registry. Don't import tile components here: this module
 * loads at boot, and e.g. `TextTile` would drag TipTap (~1.8 MB) into the
 * entry chunk before the Home screen is interactive.
 */
export interface TileRegistryEntry {
  /** The tile type identifier. */
  type: TileType;
  /** Human-readable display name. */
  name: string;
  /** Whether this tile type appears in the "add tile" menu. */
  selectable: boolean;
  /** Type-specific default fields merged into the tile on creation. */
  defaultOverrides: Record<string, unknown>;
}

/**
 * Registry of all tile types with their metadata and creation defaults.
 * Consumed by the tile factory (`getTileDefaults`) for new-tile defaults; tile
 * rendering is handled by the boards via snippets, not by this registry.
 */
export const tileRegistry: Record<TileType, TileRegistryEntry> = {
  text: {
    type: 'text',
    name: 'Text',
    selectable: true,
    defaultOverrides: { contentId: () => createId(), content: '' },
  },
  image: {
    type: 'image',
    name: 'Image',
    selectable: true,
    defaultOverrides: { src: '' },
  },
  video: {
    type: 'video',
    name: 'Video',
    selectable: true,
    defaultOverrides: { src: '', isPlaying: false },
  },
  file: {
    type: 'file',
    name: 'File',
    selectable: true,
    defaultOverrides: { filePath: '', fileName: '', fileExtension: '' },
  },
  audio: {
    type: 'audio',
    name: 'Audio',
    selectable: true,
    defaultOverrides: { src: '', isRecording: false, isPlaying: false },
  },
  link: {
    type: 'link',
    name: 'Link',
    selectable: true,
    defaultOverrides: { url: '' },
  },
  iframe: {
    type: 'iframe',
    name: 'Embed',
    selectable: true,
    defaultOverrides: { url: '' },
  },
  timer: {
    type: 'timer',
    name: 'Timer',
    selectable: true,
    defaultOverrides: { duration: 0, remaining: 0, mode: 'hms', isRunning: false },
  },
};

/**
 * Returns the default overrides for a tile type, resolving any factory functions.
 */
export function getTileDefaults(type: TileType): Record<string, unknown> {
  const entry = tileRegistry[type];
  if (!entry) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.defaultOverrides)) {
    resolved[key] = typeof value === 'function' ? value() : value;
  }
  return resolved;
}
