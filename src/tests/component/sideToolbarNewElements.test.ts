/**
 * A tile or frame made from the Mind Map side toolbar follows the Global
 * Defaults: it carries none of their colours or shapes, so a later change to
 * a default reaches it. Mounts the real toolbar inside a fake board scope.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SideToolbar from '@renderer/components/boards/SideToolbar.svelte';
import { BOARD_SCOPE_KEY } from '@renderer/lib/boards/boardScope.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { workspaceStore } from '@renderer/stores/workspace.svelte';
import { effectiveFrameStyle, effectiveTileStyle } from '@renderer/lib/styles/effectiveStyle';
import { defaultProjectSettings, type Frame, type Project, type Tile } from '@renderer/schema/index';

let instance: ReturnType<typeof mount> | null = null;

function mountToolbar(): { tiles: Tile[]; frames: Frame[]; root: HTMLElement } {
  const tiles: Tile[] = [];
  const frames: Frame[] = [];
  const target = document.createElement('div');
  document.body.appendChild(target);
  const scope = {
    board: {
      current: { id: 'mm' },
      tiles: {},
      connections: [],
      groups: [],
      getNextTileName: () => 'Tile 1',
      addTileWithHistory: (tile: Tile) => { tiles.push(tile); },
      addFrameWithHistory: (frame: Frame) => { frames.push(frame); },
    },
    canvas: {
      viewportRect: { left: 0, top: 0, width: 1000, height: 800 },
      snapEnabled: false,
      minimapVisible: true,
      waypointsVisible: true,
      semanticZoomEnabled: true,
    },
    selection: { selectedIds: new Set<string>() },
  };
  instance = mount(SideToolbar, {
    target,
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, scope]]),
  });
  flushSync();
  return { tiles, frames, root: target };
}

function openNewMenuAndPick(root: HTMLElement, label: string): void {
  root.querySelector<HTMLButtonElement>('button[title="New Tile (Ctrl+N)"]')?.click();
  flushSync();
  const item = [...root.querySelectorAll<HTMLButtonElement>('.dropdown-item')]
    .find((b) => b.textContent?.trim() === label);
  if (!item) throw new Error(`no "${label}" item`);
  item.click();
  flushSync();
}

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  vi.restoreAllMocks();
  workspaceStore.reset();
  document.body.innerHTML = '';
});

describe('Mind Map side toolbar: new elements follow the Global Defaults', () => {
  const settings = defaultProjectSettings();
  settings.mindmap.tile.headerColor = '#aa0000';
  settings.mindmap.tile.shape = 'rounded';
  settings.mindmap.frame.borderColor = '#00aa00';

  it('a new tile carries no default colour or shape, and follows a later change', () => {
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({ settings } as unknown as Project);
    const { tiles, root } = mountToolbar();
    openNewMenuAndPick(root, 'Text');

    expect(tiles).toHaveLength(1);
    const tile = tiles[0];
    expect(tile.style.headerColor).toBe('');
    expect(tile.style.shape).toBeUndefined();
    expect(tile.title).toBe('Tile 1');

    const later = structuredClone(settings);
    later.mindmap.tile.headerColor = '#0000aa';
    expect(effectiveTileStyle(tile, later).headerColor).toBe('#0000aa');
  });

  it('a new frame carries no default colour, and follows a later change', () => {
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({ settings } as unknown as Project);
    const { frames, root } = mountToolbar();
    openNewMenuAndPick(root, 'Frame');

    expect(frames).toHaveLength(1);
    expect(frames[0].style.borderColor).toBe('');

    const later = structuredClone(settings);
    later.mindmap.frame.borderColor = '#0000aa';
    expect(effectiveFrameStyle(frames[0], later).borderColor).toBe('#0000aa');
  });
});
