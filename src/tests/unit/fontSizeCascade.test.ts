/**
 * Font sizes follow the style cascade: per-element > Current Board > Global
 * Defaults > General → Default Board Font Size. A new element gets no size of
 * its own, so a Global Defaults size reaches it, and a later change of any
 * default reaches it too.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@renderer/stores/board.svelte', () => ({
  boardStore: { getNextTileName: () => 'Tile 1' },
}));

import { createTile } from '@renderer/stores/tiles.svelte';
import {
  effectiveCardStyle,
  effectiveColumnStyle,
  effectiveConnectionLabelStyle,
  effectiveFrameStyle,
  effectiveTaskSectionStyle,
  effectiveTaskStyle,
  effectiveTileStyle,
  taskListTitleFontSize,
} from '@renderer/lib/styles/effectiveStyle';
import { defaultProjectSettings, type Board, type Frame, type ProjectSettings } from '@renderer/schema/index';

function settings(edit: (s: ProjectSettings) => void = () => {}): ProjectSettings {
  const s = defaultProjectSettings();
  edit(s);
  return s;
}

describe('a new tile', () => {
  it('carries no font size of its own', () => {
    const tile = createTile('text', { x: 0, y: 0 }, 'board-1');
    expect(tile.style.fontSizeTitle).toBeUndefined();
    expect(tile.style.fontSizeBody).toBeUndefined();
  });

  it('renders the Global Defaults title size, and follows it when it changes', () => {
    const tile = createTile('text', { x: 0, y: 0 }, 'board-1');
    const s = settings((x) => { x.mindmap.tile.fontSizeTitle = 24; });
    expect(effectiveTileStyle(tile, s).fontSizeTitle).toBe(24);
    s.mindmap.tile.fontSizeTitle = 30;
    expect(effectiveTileStyle(tile, s).fontSizeTitle).toBe(30);
  });

  it('with no Global Defaults size, renders General → Default Board Font Size, and follows it', () => {
    const tile = createTile('text', { x: 0, y: 0 }, 'board-1');
    const s = settings((x) => { x.general.defaultBoardFontSize.tileTitle = 19; x.general.defaultBoardFontSize.tileBody = 11; });
    expect(effectiveTileStyle(tile, s)).toMatchObject({ fontSizeTitle: 19, fontSizeBody: 11 });
    s.general.defaultBoardFontSize.tileTitle = 21;
    expect(effectiveTileStyle(tile, s).fontSizeTitle).toBe(21);
  });

  it('a size the element or its board sets still wins', () => {
    const tile = createTile('text', { x: 0, y: 0 }, 'board-1');
    const s = settings((x) => { x.mindmap.tile.fontSizeTitle = 24; });
    const board = { settings: { defaults: { tile: { fontSizeTitle: 26 } } } } as unknown as Board;
    expect(effectiveTileStyle(tile, s, board).fontSizeTitle).toBe(26);
    tile.style.fontSizeTitle = 12;
    expect(effectiveTileStyle(tile, s, board).fontSizeTitle).toBe(12);
  });
});

describe('every element kind has General → Default Board Font Size under its cascade', () => {
  const s = settings((x) => {
    Object.assign(x.general.defaultBoardFontSize, {
      connectionLabel: 10, frameTitle: 11, kanbanColumnTitle: 12, kanbanCardTitle: 13, kanbanCardBody: 14,
      taskItem: 15, taskItemBody: 16, taskSectionTitle: 17, taskListTitle: 18,
    });
  });

  it('with nothing set above it', () => {
    expect(effectiveConnectionLabelStyle(null, s).fontSize).toBe(10);
    expect(effectiveFrameStyle({ style: {} } as unknown as Frame, s).fontSizeTitle).toBe(11);
    expect(effectiveColumnStyle(null, s).fontSizeTitle).toBe(12);
    expect(effectiveCardStyle(null, s)).toMatchObject({ fontSizeTitle: 13, fontSizeBody: 14 });
    expect(effectiveTaskStyle(null, s)).toMatchObject({ fontSizeTitle: 15, fontSizeBody: 16 });
    expect(effectiveTaskSectionStyle(null, s).fontSizeTitle).toBe(17);
    expect(taskListTitleFontSize({ settings: {} } as unknown as Board, s)).toBe(18);
  });

  it('under the Global Defaults and the element', () => {
    const g = settings((x) => {
      Object.assign(x.general.defaultBoardFontSize, { taskItem: 15, kanbanColumnTitle: 12 });
      x.tasklist.task.fontSizeTitle = 22;
    });
    expect(effectiveTaskStyle(null, g).fontSizeTitle).toBe(22);
    expect(effectiveTaskStyle({ fontSizeTitle: 9 }, g).fontSizeTitle).toBe(9);
    expect(effectiveColumnStyle({ fontSizeTitle: 30 }, g).fontSizeTitle).toBe(30);
    expect(taskListTitleFontSize({ settings: { titleFontSize: 25 } } as unknown as Board, g)).toBe(25);
  });
});
