import type { TileType } from '../../shared/types';
import { createId } from '../lib/utils/ids';

/**
 * Metadata entry for a tile type in the registry.
 *
 * Audit2 4.4 — the former `component` field, and the eager
 * `import TextTile/ImageTile/… from '../components/tiles/*.svelte'` lines that
 * fed it, were removed. Tile bodies are rendered by the parent board through a
 * Svelte snippet (TileContainer's `children` prop, supplied by MindMapBoard /
 * KanbanCard), NOT through this registry — so the field had zero readers. Its
 * static `TextTile` import nonetheless dragged createEditor → TipTap + lowlight
 * + markdown-tools (~1.8 MB) into the entry chunk's modulepreload graph, parsed
 * before the no-vault Home screen was interactive (this module is pulled at
 * boot by tiles.svelte.ts → getTileDefaults). The registry now carries only the
 * type metadata + creation defaults, which is all any code actually reads.
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
