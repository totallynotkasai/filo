import { describe, it, expect } from 'vitest';
import {
  buildBoardSettingsFromGlobal,
  buildBoardSettingsFromTheme,
  mergeBoardStyleSettings,
} from '@renderer/lib/styles/buildBoardDefaults';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import { effectiveTileStyle } from '@renderer/lib/styles/effectiveStyle';
import type { Board, Tile } from '@renderer/schema/index';

/**
 * The rule: a board follows the Global Defaults for every style field it
 * leaves blank, live. A new board has no style of its own.
 */
describe('buildBoardSettingsFromGlobal', () => {
  function makeGlobals() {
    const defaults = ProjectSettingsSchema.parse({});
    defaults.mindmap.backgroundColor = '#1a1a2e';
    defaults.mindmap.backgroundPattern = 'dots';
    defaults.mindmap.tile.headerColor = '#ff8855';
    defaults.mindmap.tile.borderWidth = 4;
    defaults.kanban.backgroundColor = '#0f1923';
    defaults.kanban.accentColor = '#ff5555';
    defaults.tasklist.accentColor = '#33ee33';
    defaults.document.backgroundColor = '#fafafa';
    return defaults;
  }

  it('gives a new board no style of its own, for every board type', () => {
    for (const type of ['mindmap', 'kanban', 'tasklist', 'document'] as const) {
      const out = buildBoardSettingsFromGlobal(type, makeGlobals());
      expect(out.backgroundColor).toBe('');
      expect(out.backgroundPattern).toBeUndefined();
      expect(out.defaults).toEqual({});
      if (type !== 'mindmap') expect(out.accentColor).toBe('');
    }
  });

  it('keeps the per-board flags a new board needs', () => {
    const mm = buildBoardSettingsFromGlobal('mindmap', makeGlobals());
    expect(mm).toMatchObject({ semanticZoom: true, snapToGrid: false, connectionsVisible: true, labelsVisible: true });
    const tl = buildBoardSettingsFromGlobal('tasklist', makeGlobals());
    expect(tl).toMatchObject({ groupBy: 'status', sortBy: 'priority' });
  });

  it('gives a new Task List no title size of its own, so the General size reaches it', () => {
    const globals = makeGlobals();
    globals.general.defaultBoardFontSize.taskListTitle = 31;
    expect(buildBoardSettingsFromGlobal('tasklist', globals).titleFontSize).toBeUndefined();
  });

  it('a Global Defaults change after creation reaches the new board', () => {
    const globals = makeGlobals();
    const board = { type: 'mindmap', settings: buildBoardSettingsFromGlobal('mindmap', globals) } as unknown as Board;
    const tile = { style: {} } as unknown as Tile;
    expect(effectiveTileStyle(tile, globals, board).borderWidth).toBe(4);
    globals.mindmap.tile.borderWidth = 7;
    globals.mindmap.tile.headerColor = '#123456';
    const after = effectiveTileStyle(tile, globals, board);
    expect(after.borderWidth).toBe(7);
    expect(after.headerColor).toBe('#123456');
  });

  it('merged into a board, clears its own style (so it follows the Global Defaults) and keeps the rest', () => {
    const existing = {
      backgroundColor: '#111',
      backgroundPattern: 'lines',
      defaults: { tile: { borderWidth: 5 } },
      snapToGrid: true,
      defaultFolder: 'Notes',
    };
    const next = mergeBoardStyleSettings(existing, buildBoardSettingsFromGlobal('mindmap', makeGlobals()));
    expect(next.backgroundColor).toBe('');
    expect(next.backgroundPattern).toBeUndefined();
    expect(next.defaults).toEqual({});
    expect(next.snapToGrid).toBe(true);
    expect(next.defaultFolder).toBe('Notes');
  });
});

describe('buildBoardSettingsFromTheme', () => {
  it('writes the schema defaults: empty colours so the theme shows, factory shapes', () => {
    const out = buildBoardSettingsFromTheme('mindmap') as {
      backgroundColor: string;
      defaults: { tile: { headerColor: string; borderWidth: number } };
    };
    expect(out.backgroundColor).toBe('');
    expect(out.defaults.tile.headerColor).toBe('');
    expect(out.defaults.tile.borderWidth).toBe(ProjectSettingsSchema.parse({}).mindmap.tile.borderWidth);
  });
});
