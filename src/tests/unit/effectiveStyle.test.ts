import { describe, it, expect } from 'vitest';
import {
  effectiveTileStyle,
  effectiveColumnStyle,
  effectiveCardStyle,
  effectiveTaskStyle,
  effectiveDocumentStyle,
  effectiveFrameStyle,
  effectiveConnectionPathStyle,
  effectiveConnectionLabelStyle,
  effectiveTaskSectionStyle,
} from '@renderer/lib/styles/effectiveStyle';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { Tile, Connection, ProjectSettings, Board } from '@renderer/schema/index';

function makeProjectSettings(overrides?: Partial<{
  headerColor: string;
  bodyColor: string;
  borderColor: string;
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
}>): ProjectSettings {
  const base = ProjectSettingsSchema.parse({});
  if (overrides) {
    base.mindmap.tile = { ...base.mindmap.tile, ...overrides };
  }
  return base;
}

function makeTile(style: Partial<Tile['style']> = {}): Tile {
  return {
    id: 't1',
    type: 'text',
    title: 'X',
    filePath: 'X.md',
    content: '',
    boardId: 'b1',
    position: { x: 0, y: 0 },
    size: { width: 240, height: 160 },
    locked: false,
    faded: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    style: {
      headerColor: '',
      bodyColor: '',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
      ...style,
    },
  } as Tile;
}

describe('effectiveTileStyle cascade integration', () => {
  it('per-element wins over global defaults', () => {
    const tile = makeTile({ headerColor: '#ff0000' });
    const settings = makeProjectSettings({ headerColor: '#00ff00' });
    const out = effectiveTileStyle(tile, settings);
    expect(out.headerColor).toBe('#ff0000');
  });

  it('falls through to global defaults when per-element is empty', () => {
    const tile = makeTile({ headerColor: '' });
    const settings = makeProjectSettings({ headerColor: '#00ff00' });
    const out = effectiveTileStyle(tile, settings);
    expect(out.headerColor).toBe('#00ff00');
  });

  it('returns empty string for a colour that is unset everywhere (renderer falls back to CSS var)', () => {
    const tile = makeTile({ headerColor: '' });
    const settings = makeProjectSettings();
    const out = effectiveTileStyle(tile, settings);
    expect(out.headerColor).toBe('');
  });

  it('Dynamic Contrast Text picks #000 on a light background', () => {
    const tile = makeTile({ headerColor: '#ffffff', bodyColor: '#ffffff' });
    const settings = makeProjectSettings({ dynamicContrastText: true });
    const out = effectiveTileStyle(tile, settings);
    expect(out.dynamicContrastText).toBe(true);
    expect(out.headerTextColor).toBe('#000000');
    expect(out.bodyTextColor).toBe('#000000');
  });

  it('Dynamic Contrast Text picks #fff on a dark background', () => {
    const tile = makeTile({ headerColor: '#111111', bodyColor: '#111111' });
    const settings = makeProjectSettings({ dynamicContrastText: true });
    const out = effectiveTileStyle(tile, settings);
    expect(out.headerTextColor).toBe('#ffffff');
    expect(out.bodyTextColor).toBe('#ffffff');
  });

  it('per-element override turns Dynamic Contrast Text off', () => {
    const tile = makeTile({ headerColor: '#ffffff', dynamicContrastText: false });
    const settings = makeProjectSettings({ dynamicContrastText: true });
    const out = effectiveTileStyle(tile, settings);
    expect(out.dynamicContrastText).toBe(false);
    expect(out.headerTextColor).toBeNull();
  });

  it('per-element `null` override defers to the cascade', () => {
    const tile = makeTile({ headerColor: '#ffffff', dynamicContrastText: null });
    const settings = makeProjectSettings({ dynamicContrastText: false });
    const out = effectiveTileStyle(tile, settings);
    expect(out.dynamicContrastText).toBe(false);
  });

  it('handles missing project settings without throwing', () => {
    const tile = makeTile({ headerColor: '#ffffff' });
    const out = effectiveTileStyle(tile, null);
    expect(out.headerColor).toBe('#ffffff');
    // No global defaults available, but per-element flag is unset, so the
    // resolver omits dynamicContrastText. The helper coerces missing → true
    // (matches the schema default).
    expect(out.dynamicContrastText).toBe(true);
  });
});

// ── Board-layer cascade ──────────────────────────────────────────────
//
// A board can carry a `settings.defaults.*` block that overrides the
// global defaults for that board only. Every field is optional; unset
// fields fall through to the global defaults layer.

function makeMindMapBoard(
  tileDefaults?: Record<string, unknown>,
  frameDefaults?: Record<string, unknown>,
): Board {
  return {
    id: 'b1',
    name: 'Test',
    emoji: '',
    type: 'mindmap',
    createdAt: 0,
    updatedAt: 0,
    settings: {
      backgroundColor: '',
      backgroundPattern: 'grid',
      semanticZoom: true,
      snapToGrid: false,
      connectionsVisible: true,
      labelsVisible: true,
      defaults: {
        ...(tileDefaults ? { tile: tileDefaults } : {}),
        ...(frameDefaults ? { frame: frameDefaults } : {}),
      },
    },
    viewport: { x: 0, y: 0, scale: 1 },
    placements: {},
    inlineTiles: {},
    connections: [],
    frames: [],
    waypoints: [],
    groups: [],
  } as unknown as Board;
}

function makeKanbanBoard(
  columnDefaults?: Record<string, unknown>,
  cardDefaults?: Record<string, unknown>,
): Board {
  return {
    id: 'k1',
    name: 'K',
    emoji: '',
    type: 'kanban',
    createdAt: 0,
    updatedAt: 0,
    settings: {
      backgroundColor: '',
      backgroundPattern: 'none',
      accentColor: '',
      defaults: {
        ...(columnDefaults ? { column: columnDefaults } : {}),
        ...(cardDefaults ? { card: cardDefaults } : {}),
      },
    },
    columns: [],
  } as unknown as Board;
}

function makeTaskListBoard(taskDefaults?: Record<string, unknown>): Board {
  return {
    id: 't1',
    name: 'T',
    emoji: '',
    type: 'tasklist',
    createdAt: 0,
    updatedAt: 0,
    settings: {
      backgroundColor: '',
      backgroundPattern: 'none',
      accentColor: '',
      defaults: taskDefaults ? { task: taskDefaults } : undefined,
    },
    tasks: [],
  } as unknown as Board;
}

describe('board-layer cascade', () => {
  describe('Tile', () => {
    it('board override wins over global when per-element is unset', () => {
      const tile = makeTile({ headerColor: '' });
      const settings = makeProjectSettings({ headerColor: '#ff0000' });
      const board = makeMindMapBoard({ headerColor: '#00ff00' });
      const out = effectiveTileStyle(tile, settings, board);
      expect(out.headerColor).toBe('#00ff00');
    });

    it('per-element still wins over both board and global', () => {
      const tile = makeTile({ headerColor: '#0000ff' });
      const settings = makeProjectSettings({ headerColor: '#ff0000' });
      const board = makeMindMapBoard({ headerColor: '#00ff00' });
      const out = effectiveTileStyle(tile, settings, board);
      expect(out.headerColor).toBe('#0000ff');
    });

    it('falls through board when a specific field is unset there', () => {
      const tile = makeTile({ headerColor: '' });
      const settings = makeProjectSettings({ headerColor: '#ff0000' });
      const board = makeMindMapBoard({ bodyColor: '#00ffff' });
      const out = effectiveTileStyle(tile, settings, board);
      expect(out.headerColor).toBe('#ff0000');
      expect(out.bodyColor).toBe('#00ffff');
    });

    it('board-level dynamicContrastText=false suppresses the override', () => {
      const tile = makeTile({ headerColor: '#ffffff' });
      const settings = makeProjectSettings({ dynamicContrastText: true });
      const board = makeMindMapBoard({ dynamicContrastText: false });
      const out = effectiveTileStyle(tile, settings, board);
      expect(out.dynamicContrastText).toBe(false);
      expect(out.headerTextColor).toBeNull();
    });

    it('boards without a `defaults` block collapse to per-element > global', () => {
      const tile = makeTile({ headerColor: '' });
      const settings = makeProjectSettings({ headerColor: '#ff0000' });
      const boardWithoutDefaults = {
        ...makeMindMapBoard(),
        settings: { backgroundColor: '', backgroundPattern: 'grid' },
      } as Board;
      const out = effectiveTileStyle(tile, settings, boardWithoutDefaults);
      expect(out.headerColor).toBe('#ff0000');
    });
  });

  describe('Kanban column', () => {
    it('board override wins over global', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.kanban.column = { ...settings.kanban.column, headerColor: '#111111' };
      const board = makeKanbanBoard({ headerColor: '#222222' });
      const out = effectiveColumnStyle(null, settings, board);
      expect(out.headerColor).toBe('#222222');
    });

    it('falls through to global when board has no override for that field', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.kanban.column = { ...settings.kanban.column, headerColor: '#111111' };
      const board = makeKanbanBoard({ bodyColor: '#333333' });
      const out = effectiveColumnStyle(null, settings, board);
      expect(out.headerColor).toBe('#111111');
      expect(out.bodyColor).toBe('#333333');
    });
  });

  describe('Kanban card', () => {
    it('board override wins over global for backgroundColor', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.kanban.card = { ...settings.kanban.card, backgroundColor: '#111111' };
      const board = makeKanbanBoard(undefined, { backgroundColor: '#222222' });
      const out = effectiveCardStyle(null, settings, board);
      expect(out.backgroundColor).toBe('#222222');
    });
  });

  describe('Task', () => {
    it('board override wins over global for bodyColor', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.tasklist.task = { ...settings.tasklist.task, bodyColor: '#111111' };
      const board = makeTaskListBoard({ bodyColor: '#222222' });
      const out = effectiveTaskStyle(null, settings, board);
      expect(out.bodyColor).toBe('#222222');
    });

    it('per-task override wins over board and global for borderColor', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.tasklist.task = { ...settings.tasklist.task, borderColor: '#111111' };
      const board = makeTaskListBoard({ borderColor: '#222222' });
      const out = effectiveTaskStyle({ borderColor: '#333333' }, settings, board);
      expect(out.borderColor).toBe('#333333');
    });

    it('falls through to global default for borderColor when no override', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.tasklist.task = { ...settings.tasklist.task, borderColor: '#abcdef' };
      const board = makeTaskListBoard();
      const out = effectiveTaskStyle(null, settings, board);
      expect(out.borderColor).toBe('#abcdef');
    });

    it('fontSizeBody falls to General → Default Board Font Size when unset everywhere else', () => {
      const settings = ProjectSettingsSchema.parse({});
      const board = makeTaskListBoard();
      const out = effectiveTaskStyle(null, settings, board);
      expect(out.fontSizeBody).toBe(settings.general.defaultBoardFontSize.taskItemBody);
    });

    it('per-task fontSizeBody override wins over board and global', () => {
      const settings = ProjectSettingsSchema.parse({});
      settings.tasklist.task = { ...settings.tasklist.task, fontSizeBody: 12 };
      const board = makeTaskListBoard({ fontSizeBody: 14 });
      const out = effectiveTaskStyle({ fontSizeBody: 18 }, settings, board);
      expect(out.fontSizeBody).toBe(18);
    });
  });
});

describe('effectiveDocumentStyle cascade', () => {
  it('falls through to global defaults when no per-board override', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.document.document = {
      ...settings.document.document,
      bodyColor: '#abcdef',
    };
    const out = effectiveDocumentStyle(settings);
    expect(out.bodyColor).toBe('#abcdef');
  });

  it('per-board override wins over global default', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.document.document = {
      ...settings.document.document,
      bodyColor: '#bbbbbb',
    };
    const board = {
      id: 'b',
      name: 'Doc',
      emoji: '',
      type: 'document',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        backgroundColor: '',
        backgroundPattern: 'grid',
        accentColor: '',
        defaults: { document: { bodyColor: '#111111' } },
      },
      content: '',
    } as unknown as Board;
    const out = effectiveDocumentStyle(settings, board);
    expect(out.bodyColor).toBe('#111111');
  });

  it('handles missing project settings without throwing', () => {
    const out = effectiveDocumentStyle(null);
    expect(out.borderStyle).toBe('solid');
    expect(out.dynamicContrastText).toBe(true);
  });
});

// ── Connection path cascade ─────────────────────────────────────────

function makeConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    boardId: 'b1',
    fromTileId: 't1',
    toTileId: 't2',
    fromBubble: 0,
    toBubble: 0,
    pathType: 'curved',
    pathColor: '',
    pathSize: 2,
    pathStyle: 'solid',
    arrowType: 'none',
    arrowColor: '',
    arrowSize: 10,
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Connection;
}

describe('effectiveConnectionPathStyle cascade', () => {
  it('per-element pathColor wins over global default', () => {
    const conn = makeConnection({ pathColor: '#ff0000' });
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionPath = { ...settings.mindmap.connectionPath, pathColor: '#00ff00' };
    const out = effectiveConnectionPathStyle(conn, settings);
    expect(out.pathColor).toBe('#ff0000');
  });

  it('board override wins over global when per-connection is empty', () => {
    const conn = makeConnection({ pathColor: '' });
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionPath = { ...settings.mindmap.connectionPath, pathColor: '#00ff00' };
    const board = makeMindMapBoard() as Board & { settings: { defaults: Record<string, unknown> } };
    board.settings.defaults = { connectionPath: { pathColor: '#0000ff' } };
    const out = effectiveConnectionPathStyle(conn, settings, board);
    expect(out.pathColor).toBe('#0000ff');
  });

  it('falls through to global when board override is unset', () => {
    const conn = makeConnection({ pathColor: '' });
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionPath = { ...settings.mindmap.connectionPath, pathColor: '#abcdef' };
    const out = effectiveConnectionPathStyle(conn, settings);
    expect(out.pathColor).toBe('#abcdef');
  });

  it('returns empty pathColor when nothing is set anywhere', () => {
    const conn = makeConnection();
    const settings = ProjectSettingsSchema.parse({});
    const out = effectiveConnectionPathStyle(conn, settings);
    expect(out.pathColor).toBe('');
    expect(out.arrowColor).toBe('');
    expect(out.pathSize).toBe(2);
    expect(out.arrowSize).toBe(10);
  });

  it('per-element pathType wins over board override', () => {
    const conn = makeConnection({ pathType: 'elbow' });
    const settings = ProjectSettingsSchema.parse({});
    const board = makeMindMapBoard() as Board & { settings: { defaults: Record<string, unknown> } };
    board.settings.defaults = { connectionPath: { pathType: 'smart' } };
    const out = effectiveConnectionPathStyle(conn, settings, board);
    expect(out.pathType).toBe('elbow');
  });
});

describe('effectiveConnectionLabelStyle textColor + fontSize cascade', () => {
  it('per-element textColor wins over global', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionLabel = { ...settings.mindmap.connectionLabel, textColor: '#00ff00' };
    const out = effectiveConnectionLabelStyle({ textColor: '#ff0000' }, settings);
    expect(out.textColor).toBe('#ff0000');
  });

  it('board override wins over global when per-element textColor is empty', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionLabel = { ...settings.mindmap.connectionLabel, textColor: '#00ff00' };
    const board = makeMindMapBoard() as Board & { settings: { defaults: Record<string, unknown> } };
    board.settings.defaults = { connectionLabel: { textColor: '#0000ff' } };
    const out = effectiveConnectionLabelStyle({ textColor: '' }, settings, board);
    expect(out.textColor).toBe('#0000ff');
  });

  it('per-element fontSize wins over global', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionLabel = { ...settings.mindmap.connectionLabel, fontSize: 12 };
    const out = effectiveConnectionLabelStyle({ fontSize: 20 }, settings);
    expect(out.fontSize).toBe(20);
  });

  it('fontSize falls through to global when per-element is undefined', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.connectionLabel = { ...settings.mindmap.connectionLabel, fontSize: 18 };
    const out = effectiveConnectionLabelStyle({}, settings);
    expect(out.fontSize).toBe(18);
  });

  it('falls to General → Default Board Font Size when unset everywhere else', () => {
    const settings = ProjectSettingsSchema.parse({});
    const out = effectiveConnectionLabelStyle({}, settings);
    expect(out.fontSize).toBe(settings.general.defaultBoardFontSize.connectionLabel);
    expect(out.textColor).toBe('');
    expect(out.backgroundColor).toBe('');
  });
});

// ── Task-list section cascade ───────────────────────────────────────

describe('effectiveTaskSectionStyle cascade', () => {
  it('falls through to global defaults when no per-element override', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.tasklist.section = { ...settings.tasklist.section, headerColor: '#abcdef' };
    const out = effectiveTaskSectionStyle(null, settings);
    expect(out.headerColor).toBe('#abcdef');
  });

  it('board override wins over global', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.tasklist.section = { ...settings.tasklist.section, headerColor: '#111111' };
    const board = makeTaskListBoard() as Board & { settings: { defaults: Record<string, unknown> } };
    board.settings.defaults = { section: { headerColor: '#222222' } };
    const out = effectiveTaskSectionStyle(null, settings, board);
    expect(out.headerColor).toBe('#222222');
  });

  it('per-element override wins over board and global', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.tasklist.section = { ...settings.tasklist.section, headerColor: '#111111' };
    const board = makeTaskListBoard() as Board & { settings: { defaults: Record<string, unknown> } };
    board.settings.defaults = { section: { headerColor: '#222222' } };
    const out = effectiveTaskSectionStyle({ headerColor: '#333333' }, settings, board);
    expect(out.headerColor).toBe('#333333');
  });

  it('DCT picks #000 on a light background', () => {
    const settings = ProjectSettingsSchema.parse({});
    const out = effectiveTaskSectionStyle({ headerColor: '#ffffff', bodyColor: '#ffffff' }, settings);
    expect(out.dynamicContrastText).toBe(true);
    expect(out.headerTextColor).toBe('#000000');
    expect(out.bodyTextColor).toBe('#000000');
  });
});

// ── Schema defaults round-trip ──────────────────────────────────────

describe('ProjectSettingsSchema round-trip', () => {
  it('tasklist.section block hydrates with full defaults from `{}`', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(s.tasklist.section).toBeDefined();
    expect(s.tasklist.section.borderStyle).toBe('solid');
    expect(s.tasklist.section.dynamicContrastText).toBe(true);
    expect(s.tasklist.section.borderWidth).toBe(1);
    expect(s.tasklist.section.shadowIntensity).toBe(0.2);
  });

  it('connection label textColor + fontSize are first-class fields', () => {
    const s = ProjectSettingsSchema.parse({});
    expect('textColor' in s.mindmap.connectionLabel).toBe(true);
    expect(s.mindmap.connectionLabel.textColor).toBe('');
    // fontSize is optional with no default, so it should be absent
    expect(s.mindmap.connectionLabel.fontSize).toBeUndefined();
  });
});

describe('effectiveFrameStyle per-board cascade (new fields)', () => {
  it('per-board borderColor wins over global default', () => {
    const settings = ProjectSettingsSchema.parse({});
    settings.mindmap.frame = {
      ...settings.mindmap.frame,
      borderColor: '#aaaaaa',
    };
    const board = {
      id: 'b',
      name: 'M',
      emoji: '',
      type: 'mindmap',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        backgroundColor: '',
        backgroundPattern: 'grid',
        semanticZoom: true,
        snapToGrid: false,
        connectionsVisible: true,
        labelsVisible: true,
        defaults: { frame: { borderColor: '#cccccc' } },
      },
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as Board;
    const frame = {
      id: 'f',
      boardId: 'b',
      title: 'F',
      position: { x: 0, y: 0 },
      size: { width: 200, height: 150 },
      style: {
        backgroundColor: '',
        backgroundImage: '',
        backgroundOpacity: 1,
        borderColor: '',
        borderStyle: 'solid',
        borderWidth: 1,
      },
      collapsed: false,
      tileIds: [],
      createdAt: 0,
      updatedAt: 0,
    } as Parameters<typeof effectiveFrameStyle>[0];
    const out = effectiveFrameStyle(frame, settings, board);
    expect(out.borderColor).toBe('#cccccc');
  });
});
