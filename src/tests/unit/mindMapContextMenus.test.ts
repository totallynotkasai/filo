import { describe, it, expect, vi } from 'vitest';
import {
  buildCanvasContextMenu,
  buildFrameContextMenu,
  buildTileContextMenu,
  type CanvasSelectionActions,
} from '@renderer/lib/mindmap/mindMapContextMenus';
import { STYLE_ICON_PATH } from '@renderer/constants/icons';
import type { Frame } from '@renderer/schema/index';

/**
 * The canvas menu gains a "N tiles selected" group when two or more tiles are
 * selected; the tile menu labels every action with the selection count.
 */

function canvasMenu(selection?: CanvasSelectionActions): ReturnType<typeof buildCanvasContextMenu> {
  const noop = (): void => {};
  return buildCanvasContextMenu({
    selection,
    brokenCount: 0,
    onNewTile: noop,
    onNewFrame: noop,
    onInsertTemplate: noop,
    onSaveWaypoint: noop,
    onSelectAll: noop,
    onOrphanCatcher: noop,
  });
}

function selection(count: number, anyUnlocked = true): CanvasSelectionActions {
  return {
    count,
    anyUnlocked,
    onToggleLock: vi.fn(),
    onTags: vi.fn(),
    onStyle: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe('buildCanvasContextMenu', () => {
  it('has no selection group with nothing or one tile selected', () => {
    for (const items of [canvasMenu(), canvasMenu(selection(1))]) {
      expect(items[0]?.id).toBe('new-tile');
      expect(items.some((i) => i.id.startsWith('selection-'))).toBe(false);
    }
  });

  it('leads with a selection group when several tiles are selected', () => {
    const items = canvasMenu(selection(3));
    expect(items.slice(0, 6).map((i) => [i.id, i.label])).toEqual([
      ['selection-heading', '3 tiles selected'],
      ['selection-lock', 'Lock (3 tiles)'],
      ['selection-tags', 'Tags (3 tiles)'],
      ['selection-style', 'Style (3 tiles)'],
      ['selection-delete', 'Delete (3 tiles)'],
      ['selection-div', ''],
    ]);
    expect(items[0]?.heading).toBe(true);
    expect(items[5]?.divider).toBe(true);
    expect(items[6]?.id).toBe('new-tile');
  });

  it('offers Unlock when every selected tile is locked', () => {
    const lock = canvasMenu(selection(2, false)).find((i) => i.id === 'selection-lock');
    expect(lock?.label).toBe('Unlock (2 tiles)');
  });

  it('wires each entry to its selection action', () => {
    const sel = selection(2);
    const items = canvasMenu(sel);
    for (const [id, fn] of [
      ['selection-lock', sel.onToggleLock],
      ['selection-tags', sel.onTags],
      ['selection-style', sel.onStyle],
      ['selection-delete', sel.onDelete],
    ] as const) {
      items.find((i) => i.id === id)?.action?.();
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('buildTileContextMenu', () => {
  function tileMenu(selectedCount: number): ReturnType<typeof buildTileContextMenu> {
    const noop = (): void => {};
    return buildTileContextMenu({
      selectedCount,
      hasBrokenTiles: false,
      brokenCount: 0,
      onStyle: noop,
      onTags: noop,
      onSaveTemplate: noop,
      onToggleLock: noop,
      onDelete: noop,
    });
  }

  it('labels selection-wide actions with the count when several are selected', () => {
    const labels = tileMenu(4).filter((i) => !i.divider).map((i) => i.label);
    expect(labels).toEqual([
      'Style (4 tiles)', 'Tags (4 tiles)', 'Save as Template', 'Lock / Unlock (4 tiles)', 'Delete (4 tiles)',
    ]);
  });

  it('uses plain labels for one tile', () => {
    const labels = tileMenu(1).filter((i) => !i.divider).map((i) => i.label);
    expect(labels).toEqual(['Style', 'Tags', 'Save as Template', 'Lock / Unlock', 'Delete']);
  });
});

describe('Style entries use the shared palette-and-brush icon', () => {
  it('tile, frame and selection menus all carry STYLE_ICON_PATH', () => {
    const noop = (): void => {};
    const tile = buildTileContextMenu({
      selectedCount: 1, hasBrokenTiles: false, brokenCount: 0,
      onStyle: noop, onTags: noop, onSaveTemplate: noop, onToggleLock: noop, onDelete: noop,
    });
    const frame = buildFrameContextMenu({
      frame: { id: 'f1', title: 'F', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as Frame,
      onStyle: noop, onToggleCollapse: noop, onSelectAll: noop, onDelete: noop,
    });
    const canvas = canvasMenu(selection(2));
    const styleIcons = [
      tile.find((i) => i.id === 'style')?.icon,
      frame.find((i) => i.id === 'style')?.icon,
      canvas.find((i) => i.id === 'selection-style')?.icon,
    ];
    expect(styleIcons).toEqual([STYLE_ICON_PATH, STYLE_ICON_PATH, STYLE_ICON_PATH]);
  });
});
