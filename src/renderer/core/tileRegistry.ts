import type { Component } from 'svelte';
import type { TileType } from '../../shared/types';
import TextTile from '../components/tiles/TextTile.svelte';
import ImageTile from '../components/tiles/ImageTile.svelte';
import VideoTile from '../components/tiles/VideoTile.svelte';
import FileTile from '../components/tiles/FileTile.svelte';
import AudioTile from '../components/tiles/AudioTile.svelte';
import LinkTile from '../components/tiles/LinkTile.svelte';
import IframeTile from '../components/tiles/IframeTile.svelte';
import TimerTile from '../components/tiles/TimerTile.svelte';
import { createId } from '../lib/utils/ids';

/**
 * Metadata entry for a tile type in the registry.
 */
export interface TileRegistryEntry {
  /** The tile type identifier. */
  type: TileType;
  /** Human-readable display name. */
  name: string;
  /** The Svelte component used to render this tile's body. */
  component: Component<Record<string, unknown>>;
  /** Whether this tile type appears in the "add tile" menu. */
  selectable: boolean;
  /** Type-specific default fields merged into the tile on creation. */
  defaultOverrides: Record<string, unknown>;
}

/**
 * Registry of all tile types with their metadata and components.
 * Used by TileContainer for dynamic rendering and by the tile factory for defaults.
 */
export const tileRegistry: Record<TileType, TileRegistryEntry> = {
  text: {
    type: 'text',
    name: 'Text',
    component: TextTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { contentId: () => createId(), content: '' },
  },
  image: {
    type: 'image',
    name: 'Image',
    component: ImageTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { src: '' },
  },
  video: {
    type: 'video',
    name: 'Video',
    component: VideoTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { src: '', isPlaying: false },
  },
  file: {
    type: 'file',
    name: 'File',
    component: FileTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { filePath: '', fileName: '', fileExtension: '' },
  },
  audio: {
    type: 'audio',
    name: 'Audio',
    component: AudioTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { src: '', isRecording: false, isPlaying: false },
  },
  link: {
    type: 'link',
    name: 'Link',
    component: LinkTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { url: '' },
  },
  iframe: {
    type: 'iframe',
    name: 'Embed',
    component: IframeTile as Component<Record<string, unknown>>,
    selectable: true,
    defaultOverrides: { url: '' },
  },
  timer: {
    type: 'timer',
    name: 'Timer',
    component: TimerTile as Component<Record<string, unknown>>,
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
