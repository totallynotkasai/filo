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
 * The Mind Map menus use the shared vocabulary in the shared order (Open,
 * Style, Tags, Lock, Remove), and a selection of several tiles gets a
 * "N tiles selected" heading.
 */

const noop = (): void => {};

function canvasMenu(selection?: CanvasSelectionActions): ReturnType<typeof buildCanvasContextMenu> {
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
    onRemove: vi.fn(),
  };
}

function labels(items: ReturnType<typeof buildCanvasContextMenu>): string[] {
  return items.filter((i) => !i.divider).map((i) => i.label);
}

describe('buildCanvasContextMenu', () => {
  it('has no selection group with nothing or one tile selected', () => {
    for (const items of [canvasMenu(), canvasMenu(selection(1))]) {
      expect(items[0]?.id).toBe('new-tile');
      expect(items.some((i) => i.id.startsWith('selection-'))).toBe(false);
    }
  });

  it('leads with a headed selection group in the shared order', () => {
    const items = canvasMenu(selection(3));
    expect(items.slice(0, 6).map((i) => [i.id, i.label])).toEqual([
      ['selection-heading', '3 tiles selected'],
      ['selection-style', 'Style…'],
      ['selection-tags', 'Tags…'],
      ['selection-lock', 'Lock'],
      ['selection-remove', 'Remove from board'],
      ['selection-div', ''],
    ]);
    expect(items[0]?.heading).toBe(true);
    expect(items[5]?.divider).toBe(true);
    expect(items[6]?.id).toBe('new-tile');
  });

  it('offers Unlock when every selected tile is locked', () => {
    const lock = canvasMenu(selection(2, false)).find((i) => i.id === 'selection-lock');
    expect(lock?.label).toBe('Unlock');
  });

  it('wires each entry to its selection action', () => {
    const sel = selection(2);
    const items = canvasMenu(sel);
    for (const [id, fn] of [
      ['selection-lock', sel.onToggleLock],
      ['selection-tags', sel.onTags],
      ['selection-style', sel.onStyle],
      ['selection-remove', sel.onRemove],
    ] as const) {
      items.find((i) => i.id === id)?.action?.();
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('buildTileContextMenu', () => {
  function tileMenu(
    selectedCount: number,
    extra: { anyUnlocked?: boolean; onOpenAsDocument?: () => void } = {},
  ): ReturnType<typeof buildTileContextMenu> {
    return buildTileContextMenu({
      selectedCount,
      anyUnlocked: extra.anyUnlocked ?? true,
      onOpenAsDocument: extra.onOpenAsDocument,
      onStyle: noop,
      onTags: noop,
      onSaveTemplate: noop,
      onToggleLock: noop,
      onRemove: noop,
    });
  }

  it('offers Open as document first for one note-backed tile', () => {
    const open = vi.fn();
    const items = tileMenu(1, { onOpenAsDocument: open });
    expect(labels(items)).toEqual([
      'Open as document', 'Style…', 'Tags…', 'Lock', 'Save as template…', 'Remove from board',
    ]);
    items.find((i) => i.id === 'open-as-document')?.action?.();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves Open out for a tile with no note', () => {
    expect(labels(tileMenu(1))).toEqual(['Style…', 'Tags…', 'Lock', 'Save as template…', 'Remove from board']);
  });

  it('heads a selection of several with its count and leaves Open out', () => {
    const items = tileMenu(4, { onOpenAsDocument: noop });
    expect(items[0]).toMatchObject({ label: '4 tiles selected', heading: true });
    expect(labels(items)).toEqual([
      '4 tiles selected', 'Style…', 'Tags…', 'Lock', 'Save as template…', 'Remove from board',
    ]);
  });

  it('says Unlock when every selected tile is locked', () => {
    expect(tileMenu(1, { anyUnlocked: false }).find((i) => i.id === 'lock')?.label).toBe('Unlock');
  });
});

describe('buildFrameContextMenu', () => {
  it('uses the shared Style label and says the frame is removed', () => {
    const frame = buildFrameContextMenu({
      frame: { id: 'f1', title: 'F', collapsed: false, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as Frame,
      onStyle: noop, onToggleCollapse: noop, onSelectAll: noop, onRemove: noop,
    });
    expect(labels(frame)).toEqual(['Style…', 'Collapse', 'Select all in frame', 'Remove frame']);
  });
});

describe('Style entries use the shared palette-and-brush icon', () => {
  it('tile, frame and selection menus all carry STYLE_ICON_PATH', () => {
    const tile = buildTileContextMenu({
      selectedCount: 1, anyUnlocked: true,
      onStyle: noop, onTags: noop, onSaveTemplate: noop, onToggleLock: noop, onRemove: noop,
    });
    const frame = buildFrameContextMenu({
      frame: { id: 'f1', title: 'F', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as Frame,
      onStyle: noop, onToggleCollapse: noop, onSelectAll: noop, onRemove: noop,
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
