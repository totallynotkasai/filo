/**
 * Zod default-tree snapshots — pinned on Zod 3 BEFORE the Zod 4 migration
 * (DEPENDENCY_UPGRADE_REPORT_2026-09-23 §0.7).
 *
 * Zod 4 changed two default semantics that would silently alter what a
 * fresh / partial settings or board file hydrates to:
 *
 *   1. `.default({})` short-circuits: the default value is returned as-is
 *      and is NOT parsed through the inner schema, so inner field defaults
 *      are no longer applied (v3 `{ s: { a: 1 } }` → v4 `{ s: {} }`). The
 *      fix is `.prefault({})`.
 *   2. A non-getter mutable default (`.default([])`, `.default({ openTabs:
 *      [] })`) is shared (core 4.0) or only SHALLOW-cloned (later 4.x)
 *      between parses — a mutation on one board / settings object leaks
 *      into the next parse. The fix is getter defaults `.default(() => [])`.
 *
 * These snapshots were recorded on Zod 3.25.76 and must pass UNCHANGED on
 * Zod 4. If one differs after a Zod change, fix the schema, not the
 * snapshot.
 */
import { describe, it, expect } from 'vitest';
import {
  ProjectSettingsSchema,
  GeneralSettingsSchema,
  MindMapDefaultsSchema,
  KanbanDefaultsSchema,
  TaskListDefaultsSchema,
  DocumentDefaultsSchema,
  BoardSchema,
  ProjectSchema,
  WorkspaceStateSchema,
  ConnectionSchema,
  ConnectionLabelSchema,
  FrameSchema,
  LayoutTemplateConnectionSchema,
  BoardFileDataSchema,
  defaultProjectSettings,
} from '../../renderer/schema';

/**
 * Walk two parse results in lockstep and collect the path of every
 * object/array that is the SAME reference in both. Two independent parses
 * must never share a mutable node, or a mutation on one leaks into the
 * other.
 */
function sharedMutableNodes(a: unknown, b: unknown, path = '$'): string[] {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [];
  const out: string[] = [];
  if (a === b) out.push(path);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) out.push(...sharedMutableNodes(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of Object.keys(ra)) {
    if (key in rb) out.push(...sharedMutableNodes(ra[key], rb[key], `${path}.${key}`));
  }
  return out;
}

const T = 1_700_000_000_000;

function minimalBoards(): Record<string, unknown>[] {
  return [
    { id: 'mm1', type: 'mindmap', createdAt: T, updatedAt: T },
    { id: 'kb1', type: 'kanban', createdAt: T, updatedAt: T },
    { id: 'tl1', type: 'tasklist', createdAt: T, updatedAt: T },
    { id: 'doc1', type: 'document', filePath: 'c1.md', createdAt: T, updatedAt: T },
  ];
}

/** Boards with nested partial objects whose inner defaults must still fill. */
function partialBoards(): Record<string, unknown>[] {
  return [
    {
      id: 'mm2',
      type: 'mindmap',
      createdAt: T,
      updatedAt: T,
      settings: {},
      placements: { t1: { x: 1, y: 2 } },
      waypoints: [{ id: 'w1', name: 'W', x: 0, y: 0 }],
      groups: [{ id: 'g1', tileIds: ['t1'], boardId: 'mm2' }],
    },
    {
      id: 'kb2',
      type: 'kanban',
      createdAt: T,
      updatedAt: T,
      settings: { lastView: {}, savedViews: [{ id: 'v1', name: 'V' }] },
      columns: [{ id: 'col1', title: 'Todo', tilePlacements: [{ tileId: 't1' }] }],
    },
    {
      id: 'tl2',
      type: 'tasklist',
      createdAt: T,
      updatedAt: T,
      settings: { lastView: {}, savedViews: [{ id: 'v1', name: 'V' }] },
      tasks: [{ tileId: 't1' }],
      sections: [{ id: 's1', title: 'S', position: 0 }],
    },
    { id: 'doc2', type: 'document', filePath: 'c2.md', createdAt: T, updatedAt: T, settings: {} },
  ];
}

function boardFileInput(): Record<string, unknown> {
  return {
    version: 8,
    board: {
      id: 'board1',
      type: 'mindmap',
      createdAt: T,
      updatedAt: T,
      placements: { t1: { x: 0, y: 0 }, t2: { x: 300, y: 0, width: 200, height: 100 } },
      connections: ['conn1'],
      frames: ['frame1'],
    },
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'a.md',
        style: { headerColor: '', bodyColor: '' },
        createdAt: T,
        updatedAt: T,
      },
      t2: {
        id: 't2',
        type: 'timer',
        style: { headerColor: '', bodyColor: '' },
        createdAt: T,
        updatedAt: T,
      },
    },
    connections: {
      conn1: {
        id: 'conn1',
        boardId: 'board1',
        fromTileId: 't1',
        toTileId: 't2',
        fromBubble: 0,
        toBubble: 4,
        createdAt: T,
        updatedAt: T,
      },
    },
    frames: [
      {
        id: 'frame1',
        boardId: 'board1',
        position: { x: 0, y: 0 },
        size: { width: 400, height: 300 },
        createdAt: T,
        updatedAt: T,
      },
    ],
  };
}

describe('zod default trees (pinned on v3 before the v4 migration)', () => {
  it('ProjectSettingsSchema.parse({})', () => {
    expect(ProjectSettingsSchema.parse({})).toMatchInlineSnapshot(`
      {
        "document": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "document": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
        },
        "general": {
          "activeRootFolder": "",
          "boardToolbarScale": 1,
          "defaultBoardFontSize": {
            "connectionLabel": 12,
            "frameTitle": 15,
            "kanbanCardBody": 12,
            "kanbanCardTitle": 13,
            "kanbanColumnTitle": 14,
            "taskItem": 13,
            "taskItemBody": 12,
            "taskListTitle": 16,
            "taskSectionTitle": 14,
            "tileBody": 13,
            "tileTitle": 14,
          },
          "defaultLineSpacing": 1.5,
          "globalFont": "'Arial Rounded MT', 'Arial', system-ui, sans-serif",
          "globalFontSize": 13,
          "globalToolbarScale": 1,
          "historyLimit": 500,
          "hoverButtons": {
            "cards": true,
            "columns": true,
            "connectionLabels": true,
            "frames": true,
            "tasks": true,
            "tiles": true,
          },
          "minimapScale": 1,
          "radarEnabled": true,
          "recentColors": [],
          "showFileExtensions": false,
          "sidebarGroupDirection": "asc",
          "sidebarGroupField": "none",
          "sidebarSortDirection": "asc",
          "sidebarSortField": "none",
          "systemFonts": [
            "Arial Rounded MT",
            "Arial",
            "Georgia",
            "Courier New",
            "Verdana",
          ],
          "tabBarColor": "",
          "tabBarScale": 1,
          "toolbarColor": "",
          "waypointScale": 1,
        },
        "kanban": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "card": {
            "backgroundColor": "",
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
            "shape": "rounded",
          },
          "column": {
            "accent": "",
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "width": 380,
          },
        },
        "mindmap": {
          "backgroundColor": "",
          "backgroundPattern": "grid",
          "connectionLabel": {
            "backgroundColor": "",
            "defaultText": "",
            "textColor": "",
          },
          "connectionPath": {
            "arrowColor": "",
            "arrowSize": 10,
            "arrowType": "none",
            "pathColor": "",
            "pathSize": 2,
            "pathStyle": "solid",
            "pathType": "curved",
          },
          "frame": {
            "backgroundImage": "",
            "backgroundOpacity": 1,
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "shape": "rounded",
          },
          "tile": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "shape": "rounded",
          },
        },
        "tasklist": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "section": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
          "task": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
        },
      }
    `);
  });

  it('defaultProjectSettings() equals ProjectSettingsSchema.parse({})', () => {
    expect(defaultProjectSettings()).toEqual(ProjectSettingsSchema.parse({}));
  });

  it('per-board-type global defaults schemas parse({})', () => {
    expect({
      general: GeneralSettingsSchema.parse({}),
      mindmap: MindMapDefaultsSchema.parse({}),
      kanban: KanbanDefaultsSchema.parse({}),
      tasklist: TaskListDefaultsSchema.parse({}),
      document: DocumentDefaultsSchema.parse({}),
    }).toEqual(ProjectSettingsSchema.parse({}));
  });

  it('ProjectSettingsSchema fills inner defaults of a partial sub-object', () => {
    expect(
      ProjectSettingsSchema.parse({
        general: { defaultBoardFontSize: {}, hoverButtons: { tiles: false } },
        mindmap: { tile: {}, frame: { borderWidth: 3 } },
        kanban: { column: {} },
      }),
    ).toMatchInlineSnapshot(`
      {
        "document": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "document": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
        },
        "general": {
          "activeRootFolder": "",
          "boardToolbarScale": 1,
          "defaultBoardFontSize": {
            "connectionLabel": 12,
            "frameTitle": 15,
            "kanbanCardBody": 12,
            "kanbanCardTitle": 13,
            "kanbanColumnTitle": 14,
            "taskItem": 13,
            "taskItemBody": 12,
            "taskListTitle": 16,
            "taskSectionTitle": 14,
            "tileBody": 13,
            "tileTitle": 14,
          },
          "defaultLineSpacing": 1.5,
          "globalFont": "'Arial Rounded MT', 'Arial', system-ui, sans-serif",
          "globalFontSize": 13,
          "globalToolbarScale": 1,
          "historyLimit": 500,
          "hoverButtons": {
            "cards": true,
            "columns": true,
            "connectionLabels": true,
            "frames": true,
            "tasks": true,
            "tiles": false,
          },
          "minimapScale": 1,
          "radarEnabled": true,
          "recentColors": [],
          "showFileExtensions": false,
          "sidebarGroupDirection": "asc",
          "sidebarGroupField": "none",
          "sidebarSortDirection": "asc",
          "sidebarSortField": "none",
          "systemFonts": [
            "Arial Rounded MT",
            "Arial",
            "Georgia",
            "Courier New",
            "Verdana",
          ],
          "tabBarColor": "",
          "tabBarScale": 1,
          "toolbarColor": "",
          "waypointScale": 1,
        },
        "kanban": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "card": {
            "backgroundColor": "",
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
            "shape": "rounded",
          },
          "column": {
            "accent": "",
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "width": 380,
          },
        },
        "mindmap": {
          "backgroundColor": "",
          "backgroundPattern": "grid",
          "connectionLabel": {
            "backgroundColor": "",
            "defaultText": "",
            "textColor": "",
          },
          "connectionPath": {
            "arrowColor": "",
            "arrowSize": 10,
            "arrowType": "none",
            "pathColor": "",
            "pathSize": 2,
            "pathStyle": "solid",
            "pathType": "curved",
          },
          "frame": {
            "backgroundImage": "",
            "backgroundOpacity": 1,
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 3,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "shape": "rounded",
          },
          "tile": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.3,
            "shape": "rounded",
          },
        },
        "tasklist": {
          "accentColor": "",
          "backgroundColor": "",
          "backgroundPattern": "none",
          "section": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
          "task": {
            "bodyColor": "",
            "borderColor": "",
            "borderStyle": "solid",
            "borderWidth": 1,
            "dynamicContrastText": true,
            "headerColor": "",
            "shadowIntensity": 0.2,
          },
        },
      }
    `);
  });

  it('every board type (and its settings schema) parses a minimal board', () => {
    expect(minimalBoards().map((b) => BoardSchema.parse(b))).toMatchInlineSnapshot(`
      [
        {
          "connections": [],
          "createdAt": 1700000000000,
          "emoji": "",
          "frames": [],
          "groups": [],
          "id": "mm1",
          "inlineTiles": {},
          "name": "Untitled Board",
          "placements": {},
          "settings": {
            "backgroundColor": "",
            "connectionsVisible": true,
            "defaultFolder": "",
            "labelsVisible": true,
            "semanticZoom": true,
            "snapToGrid": false,
          },
          "type": "mindmap",
          "updatedAt": 1700000000000,
          "waypoints": [],
        },
        {
          "columns": [],
          "createdAt": 1700000000000,
          "emoji": "",
          "id": "kb1",
          "name": "Untitled Board",
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
          },
          "type": "kanban",
          "updatedAt": 1700000000000,
        },
        {
          "collapsedSubtasks": [],
          "createdAt": 1700000000000,
          "emoji": "",
          "id": "tl1",
          "name": "Untitled Board",
          "sections": [],
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
            "groupBy": "status",
            "sortBy": "priority",
          },
          "tasks": [],
          "type": "tasklist",
          "updatedAt": 1700000000000,
        },
        {
          "createdAt": 1700000000000,
          "emoji": "",
          "filePath": "c1.md",
          "id": "doc1",
          "name": "Untitled Board",
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
          },
          "type": "document",
          "updatedAt": 1700000000000,
        },
      ]
    `);
  });

  it('every board type fills inner defaults of partial nested objects', () => {
    expect(partialBoards().map((b) => BoardSchema.parse(b))).toMatchInlineSnapshot(`
      [
        {
          "connections": [],
          "createdAt": 1700000000000,
          "emoji": "",
          "frames": [],
          "groups": [
            {
              "boardId": "mm2",
              "id": "g1",
              "tileIds": [
                "t1",
              ],
            },
          ],
          "id": "mm2",
          "inlineTiles": {},
          "name": "Untitled Board",
          "placements": {
            "t1": {
              "faded": false,
              "frameless": false,
              "height": 160,
              "locked": false,
              "width": 240,
              "x": 1,
              "y": 2,
            },
          },
          "settings": {
            "backgroundColor": "",
            "connectionsVisible": true,
            "defaultFolder": "",
            "labelsVisible": true,
            "semanticZoom": true,
            "snapToGrid": false,
          },
          "type": "mindmap",
          "updatedAt": 1700000000000,
          "waypoints": [
            {
              "icon": "📌",
              "id": "w1",
              "locked": false,
              "name": "W",
              "x": 0,
              "y": 0,
              "zoom": 1,
            },
          ],
        },
        {
          "columns": [
            {
              "collapsed": false,
              "id": "col1",
              "position": 0,
              "tilePlacements": [
                {
                  "position": 0,
                  "tileId": "t1",
                },
              ],
              "title": "Todo",
            },
          ],
          "createdAt": 1700000000000,
          "emoji": "",
          "id": "kb2",
          "name": "Untitled Board",
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
            "lastView": {
              "filterProp": null,
              "filterTags": [],
              "sortBy": "manual",
            },
            "savedViews": [
              {
                "filterProp": null,
                "filterTags": [],
                "id": "v1",
                "name": "V",
                "sortBy": "manual",
              },
            ],
          },
          "type": "kanban",
          "updatedAt": 1700000000000,
        },
        {
          "collapsedSubtasks": [],
          "createdAt": 1700000000000,
          "emoji": "",
          "id": "tl2",
          "name": "Untitled Board",
          "sections": [
            {
              "collapsed": false,
              "id": "s1",
              "position": 0,
              "title": "S",
            },
          ],
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
            "groupBy": "status",
            "lastView": {
              "filterPriority": null,
              "filterStatus": null,
              "filterTags": [],
              "groupBy": "status",
              "showCompleted": true,
              "smartList": "all",
              "sortBy": "priority",
            },
            "savedViews": [
              {
                "filterPriority": null,
                "filterStatus": null,
                "filterTags": [],
                "groupBy": "status",
                "id": "v1",
                "name": "V",
                "showCompleted": true,
                "smartList": "all",
                "sortBy": "priority",
              },
            ],
            "sortBy": "priority",
          },
          "tasks": [
            {
              "position": 0,
              "tileId": "t1",
            },
          ],
          "type": "tasklist",
          "updatedAt": 1700000000000,
        },
        {
          "createdAt": 1700000000000,
          "emoji": "",
          "filePath": "c2.md",
          "id": "doc2",
          "name": "Untitled Board",
          "settings": {
            "accentColor": "#6c63ff",
            "backgroundColor": "",
            "defaultFolder": "",
          },
          "type": "document",
          "updatedAt": 1700000000000,
        },
      ]
    `);
  });

  it('ProjectSchema / WorkspaceStateSchema defaults', () => {
    expect(ProjectSchema.parse({ createdAt: T, updatedAt: T })).toMatchInlineSnapshot(`
      {
        "boards": [],
        "connections": {},
        "createdAt": 1700000000000,
        "frames": [],
        "name": "",
        "settings": {
          "document": {
            "accentColor": "",
            "backgroundColor": "",
            "backgroundPattern": "none",
            "document": {
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.2,
            },
          },
          "general": {
            "activeRootFolder": "",
            "boardToolbarScale": 1,
            "defaultBoardFontSize": {
              "connectionLabel": 12,
              "frameTitle": 15,
              "kanbanCardBody": 12,
              "kanbanCardTitle": 13,
              "kanbanColumnTitle": 14,
              "taskItem": 13,
              "taskItemBody": 12,
              "taskListTitle": 16,
              "taskSectionTitle": 14,
              "tileBody": 13,
              "tileTitle": 14,
            },
            "defaultLineSpacing": 1.5,
            "globalFont": "'Arial Rounded MT', 'Arial', system-ui, sans-serif",
            "globalFontSize": 13,
            "globalToolbarScale": 1,
            "historyLimit": 500,
            "hoverButtons": {
              "cards": true,
              "columns": true,
              "connectionLabels": true,
              "frames": true,
              "tasks": true,
              "tiles": true,
            },
            "minimapScale": 1,
            "radarEnabled": true,
            "recentColors": [],
            "showFileExtensions": false,
            "sidebarGroupDirection": "asc",
            "sidebarGroupField": "none",
            "sidebarSortDirection": "asc",
            "sidebarSortField": "none",
            "systemFonts": [
              "Arial Rounded MT",
              "Arial",
              "Georgia",
              "Courier New",
              "Verdana",
            ],
            "tabBarColor": "",
            "tabBarScale": 1,
            "toolbarColor": "",
            "waypointScale": 1,
          },
          "kanban": {
            "accentColor": "",
            "backgroundColor": "",
            "backgroundPattern": "none",
            "card": {
              "backgroundColor": "",
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.2,
              "shape": "rounded",
            },
            "column": {
              "accent": "",
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.3,
              "width": 380,
            },
          },
          "mindmap": {
            "backgroundColor": "",
            "backgroundPattern": "grid",
            "connectionLabel": {
              "backgroundColor": "",
              "defaultText": "",
              "textColor": "",
            },
            "connectionPath": {
              "arrowColor": "",
              "arrowSize": 10,
              "arrowType": "none",
              "pathColor": "",
              "pathSize": 2,
              "pathStyle": "solid",
              "pathType": "curved",
            },
            "frame": {
              "backgroundImage": "",
              "backgroundOpacity": 1,
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.3,
              "shape": "rounded",
            },
            "tile": {
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.3,
              "shape": "rounded",
            },
          },
          "tasklist": {
            "accentColor": "",
            "backgroundColor": "",
            "backgroundPattern": "none",
            "section": {
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.2,
            },
            "task": {
              "bodyColor": "",
              "borderColor": "",
              "borderStyle": "solid",
              "borderWidth": 1,
              "dynamicContrastText": true,
              "headerColor": "",
              "shadowIntensity": 0.2,
            },
          },
        },
        "theme": "light",
        "updatedAt": 1700000000000,
        "vaultPath": "",
        "workspace": {
          "activeTabId": "",
          "openTabs": [],
        },
      }
    `);
    expect(WorkspaceStateSchema.parse({})).toMatchInlineSnapshot(`
      {
        "activeTabId": "",
        "openTabs": [],
      }
    `);
  });

  it('Connection / ConnectionLabel / Frame / LayoutTemplateConnection defaults', () => {
    expect(ConnectionLabelSchema.parse({})).toMatchInlineSnapshot(`
      {
        "backgroundColor": "",
        "locked": false,
        "position": 0.5,
        "text": "",
        "textColor": "",
      }
    `);
    expect(
      ConnectionSchema.parse((boardFileInput().connections as Record<string, unknown>).conn1),
    ).toMatchInlineSnapshot(`
      {
        "arrowColor": "",
        "boardId": "board1",
        "createdAt": 1700000000000,
        "fromBubble": 0,
        "fromTileId": "t1",
        "id": "conn1",
        "label": {
          "backgroundColor": "",
          "locked": false,
          "position": 0.5,
          "text": "",
          "textColor": "",
        },
        "labelVisibility": "visible",
        "pathColor": "",
        "toBubble": 4,
        "toTileId": "t2",
        "updatedAt": 1700000000000,
        "visibility": "visible",
      }
    `);
    expect(FrameSchema.parse((boardFileInput().frames as unknown[])[0])).toMatchInlineSnapshot(`
      {
        "boardId": "board1",
        "collapsed": false,
        "createdAt": 1700000000000,
        "id": "frame1",
        "position": {
          "x": 0,
          "y": 0,
        },
        "size": {
          "height": 300,
          "width": 400,
        },
        "style": {
          "backgroundImage": "",
          "borderColor": "",
        },
        "tileIds": [],
        "title": "Frame",
        "updatedAt": 1700000000000,
      }
    `);
    expect(
      LayoutTemplateConnectionSchema.parse({ fromTileIndex: 0, toTileIndex: 1, fromBubble: 0, toBubble: 4 }),
    ).toMatchInlineSnapshot(`
      {
        "arrowColor": "",
        "fromBubble": 0,
        "fromTileIndex": 0,
        "label": {
          "backgroundColor": "",
          "locked": false,
          "position": 0.5,
          "text": "",
          "textColor": "",
        },
        "labelVisibility": "visible",
        "pathColor": "",
        "toBubble": 4,
        "toTileIndex": 1,
        "visibility": "visible",
      }
    `);
  });

  it('representative BoardFileDataSchema parse', () => {
    expect(BoardFileDataSchema.parse(boardFileInput())).toMatchInlineSnapshot(`
      {
        "board": {
          "connections": [
            "conn1",
          ],
          "createdAt": 1700000000000,
          "emoji": "",
          "frames": [
            "frame1",
          ],
          "groups": [],
          "id": "board1",
          "inlineTiles": {},
          "name": "Untitled Board",
          "placements": {
            "t1": {
              "faded": false,
              "frameless": false,
              "height": 160,
              "locked": false,
              "width": 240,
              "x": 0,
              "y": 0,
            },
            "t2": {
              "faded": false,
              "frameless": false,
              "height": 100,
              "locked": false,
              "width": 200,
              "x": 300,
              "y": 0,
            },
          },
          "settings": {
            "backgroundColor": "",
            "connectionsVisible": true,
            "defaultFolder": "",
            "labelsVisible": true,
            "semanticZoom": true,
            "snapToGrid": false,
          },
          "type": "mindmap",
          "updatedAt": 1700000000000,
          "waypoints": [],
        },
        "connections": {
          "conn1": {
            "arrowColor": "",
            "boardId": "board1",
            "createdAt": 1700000000000,
            "fromBubble": 0,
            "fromTileId": "t1",
            "id": "conn1",
            "label": {
              "backgroundColor": "",
              "locked": false,
              "position": 0.5,
              "text": "",
              "textColor": "",
            },
            "labelVisibility": "visible",
            "pathColor": "",
            "toBubble": 4,
            "toTileId": "t2",
            "updatedAt": 1700000000000,
            "visibility": "visible",
          },
        },
        "frames": [
          {
            "boardId": "board1",
            "collapsed": false,
            "createdAt": 1700000000000,
            "id": "frame1",
            "position": {
              "x": 0,
              "y": 0,
            },
            "size": {
              "height": 300,
              "width": 400,
            },
            "style": {
              "backgroundImage": "",
              "borderColor": "",
            },
            "tileIds": [],
            "title": "Frame",
            "updatedAt": 1700000000000,
          },
        ],
        "tileDefs": {
          "t1": {
            "createdAt": 1700000000000,
            "filePath": "a.md",
            "id": "t1",
            "style": {
              "bodyColor": "",
              "borderColor": "",
              "headerColor": "",
            },
            "type": "text",
            "updatedAt": 1700000000000,
          },
          "t2": {
            "createdAt": 1700000000000,
            "duration": 0,
            "id": "t2",
            "isRunning": false,
            "mode": "hms",
            "remaining": 0,
            "style": {
              "bodyColor": "",
              "borderColor": "",
              "headerColor": "",
            },
            "tags": [],
            "title": "",
            "type": "timer",
            "updatedAt": 1700000000000,
          },
        },
        "version": 8,
      }
    `);
  });
});

describe('zod mutable defaults are fresh per parse', () => {
  const cases: Array<[string, () => unknown]> = [
    ['ProjectSettingsSchema.parse({})', () => ProjectSettingsSchema.parse({})],
    ['defaultProjectSettings()', () => defaultProjectSettings()],
    ['GeneralSettingsSchema.parse({})', () => GeneralSettingsSchema.parse({})],
    ['MindMapDefaultsSchema.parse({})', () => MindMapDefaultsSchema.parse({})],
    ['KanbanDefaultsSchema.parse({})', () => KanbanDefaultsSchema.parse({})],
    ['TaskListDefaultsSchema.parse({})', () => TaskListDefaultsSchema.parse({})],
    ['DocumentDefaultsSchema.parse({})', () => DocumentDefaultsSchema.parse({})],
    ['ProjectSchema.parse(min)', () => ProjectSchema.parse({ createdAt: T, updatedAt: T })],
    ['WorkspaceStateSchema.parse({})', () => WorkspaceStateSchema.parse({})],
    ['ConnectionLabelSchema.parse({})', () => ConnectionLabelSchema.parse({})],
    ['minimal boards', () => minimalBoards().map((b) => BoardSchema.parse(b))],
    ['partial boards', () => partialBoards().map((b) => BoardSchema.parse(b))],
    ['BoardFileDataSchema.parse', () => BoardFileDataSchema.parse(boardFileInput())],
  ];

  for (const [name, parse] of cases) {
    it(`${name}: no object/array node is shared between two parses`, () => {
      expect(sharedMutableNodes(parse(), parse())).toEqual([]);
    });
  }

  it('project workspace.openTabs (nested array in an object default) is fresh', () => {
    const a = ProjectSchema.parse({ createdAt: T, updatedAt: T });
    const b = ProjectSchema.parse({ createdAt: T, updatedAt: T });
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.workspace.openTabs).not.toBe(b.workspace.openTabs);
    a.workspace.openTabs.push({ id: 'x', boardId: 'y' });
    expect(ProjectSchema.parse({ createdAt: T, updatedAt: T }).workspace.openTabs).toEqual([]);
  });

  it('mutating a parsed default does not leak into the next parse', () => {
    const a = ProjectSettingsSchema.parse({});
    a.general.systemFonts.push('Leaked');
    a.general.recentColors.push('#ff0000');
    a.mindmap.tile.headerColor = '#leaked';
    const b = ProjectSettingsSchema.parse({});
    expect(b.general.systemFonts).not.toContain('Leaked');
    expect(b.general.recentColors).toEqual([]);
    expect(b.mindmap.tile.headerColor).toBe('');
  });
});
