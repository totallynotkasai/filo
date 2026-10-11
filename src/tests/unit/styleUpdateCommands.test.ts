/**
 * Style-popup command regression guard.
 *
 * Style popups (Frame, Kanban card/column, Task item/section, Connection)
 * dispatch a single Update*StyleCommand on close so the whole styling session
 * is one Ctrl+Z. Previously only `TileStylePopup` did this — every other popup
 * wrote directly with no command, and the "Restore to Theme Defaults" button
 * irreversibly wiped the style block.
 *
 * These tests assert each new command:
 *   1. execute() applies the "after" snapshot.
 *   2. undo() restores the "before" snapshot (including the
 *      `null`/clear case, which is the "Restore Defaults" path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  UpdateFrameStyleCommand,
  UpdateKanbanCardStyleCommand,
  UpdateKanbanColumnStyleCommand,
  UpdateTaskItemStyleCommand,
  UpdateTaskSectionStyleCommand,
  UpdateConnectionCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  KanbanBoard,
  TaskListBoard,
  MindMapBoard,
  Frame,
  Connection,
} from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function installSilentBridge(): void {
  installFiloMock(() => null);
}

// ── Frame fixture ──

function makeMindMapWithFrame(frameStyle: Frame['style']): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [
      {
        id: 'f1',
        boardId: 'mm',
        title: 'Frame',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 200 },
        tileIds: [],
        collapsed: false,
        style: frameStyle,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as Frame,
    ],
  };
}

describe('UpdateFrameStyleCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute applies after, undo restores before', () => {
    const before = { headerColor: '#fff' };
    const after = { headerColor: '#000', borderColor: '#abc' };
    const fixture = makeMindMapWithFrame(before as Frame['style']);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    boardStore.setBoard(fixture.board);

    const cmd = new UpdateFrameStyleCommand('f1', before as Frame['style'], after as Frame['style']);
    cmd.execute();
    expect(boardStore.frames[0]?.style).toMatchObject({ headerColor: '#000', borderColor: '#abc' });

    cmd.undo();
    expect(boardStore.frames[0]?.style).toMatchObject({ headerColor: '#fff' });
    // borderColor wasn't in `before`, so undo lands on the schema default
    // (empty string — the cascade resolver treats '' as "inherit").
    expect(boardStore.frames[0]?.style.borderColor).toBe('');
  });

  it('undo from after-empty back to before captures the Restore Defaults path', () => {
    const before = { headerColor: '#fff', borderColor: '#abc' };
    const after = {};
    const fixture = makeMindMapWithFrame(before as Frame['style']);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    boardStore.setBoard(fixture.board);

    const cmd = new UpdateFrameStyleCommand('f1', before as Frame['style'], after as Frame['style']);
    cmd.execute();
    expect(boardStore.frames[0]?.style.headerColor).toBeUndefined();

    cmd.undo();
    expect(boardStore.frames[0]?.style).toMatchObject({ headerColor: '#fff', borderColor: '#abc' });
  });
});

// ── Kanban card fixture ──

function makeKanbanWithCardStyle(style: Record<string, unknown> | undefined): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'col-1',
          title: 'A',
          position: 0,
          collapsed: false,
          tilePlacements: [
            style
              ? { tileId: 't1', position: 0, style }
              : { tileId: 't1', position: 0 },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        title: 'A',
        style: {} as never,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      } as unknown as BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

function getCardStyle(boardId: string, tileId: string): Record<string, unknown> | undefined {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return undefined;
  const kb = cached.board as unknown as { columns: Array<{ tilePlacements?: Array<{ tileId: string; style?: Record<string, unknown> }> }> };
  for (const c of kb.columns ?? []) {
    const p = (c.tilePlacements ?? []).find((pl) => pl.tileId === tileId);
    if (p) return p.style;
  }
  return undefined;
}

describe('UpdateKanbanCardStyleCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute applies after, undo restores before', () => {
    const before = { headerColor: '#fff' };
    const after = { headerColor: '#000', borderColor: '#abc' };
    const fixture = makeKanbanWithCardStyle(before);
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new UpdateKanbanCardStyleCommand('kb', 't1', before, after);
    cmd.execute();
    expect(getCardStyle('kb', 't1')).toMatchObject(after);

    cmd.undo();
    expect(getCardStyle('kb', 't1')).toMatchObject(before);
    // The borderColor from `after` must be gone after undo (replace semantic).
    expect(getCardStyle('kb', 't1')?.borderColor).toBeUndefined();
  });

  it('undo from cleared (Restore Defaults) restores the original style', () => {
    const before = { headerColor: '#fff', borderColor: '#abc' };
    const fixture = makeKanbanWithCardStyle(before);
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new UpdateKanbanCardStyleCommand('kb', 't1', before, undefined);
    cmd.execute();
    expect(getCardStyle('kb', 't1')).toBeUndefined();

    cmd.undo();
    expect(getCardStyle('kb', 't1')).toMatchObject(before);
  });
});

// ── Kanban column fixture (same board type, different element) ──

function getColumnStyle(boardId: string, columnId: string): Record<string, unknown> | undefined {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return undefined;
  const kb = cached.board as unknown as { columns: Array<{ id: string; style?: Record<string, unknown> }> };
  const c = kb.columns?.find((c) => c.id === columnId);
  return c?.style;
}

describe('UpdateKanbanColumnStyleCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute + undo round-trip', () => {
    const before = { headerColor: '#aaa' };
    const after = { headerColor: '#bbb', accent: '#ff0' };
    const fixture: BoardFileData = {
      board: {
        id: 'kb',
        type: 'kanban',
        name: 'K',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        columns: [
          { id: 'col-1', title: 'A', position: 0, collapsed: false, tilePlacements: [], style: before },
        ],
      } as unknown as KanbanBoard,
      tileDefs: {},
      connections: {},
      frames: [],
    };
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new UpdateKanbanColumnStyleCommand('kb', 'col-1', before, after);
    cmd.execute();
    expect(getColumnStyle('kb', 'col-1')).toMatchObject(after);

    cmd.undo();
    expect(getColumnStyle('kb', 'col-1')).toMatchObject(before);
    expect(getColumnStyle('kb', 'col-1')?.accent).toBeUndefined();
  });
});

// ── Task list placement + section ──

function makeTaskListBoard(taskStyle?: Record<string, unknown>, sectionStyle?: Record<string, unknown>): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'TL',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      sections: [
        sectionStyle
          ? { id: 'sec-1', title: 'Today', position: 0, collapsed: false, style: sectionStyle }
          : { id: 'sec-1', title: 'Today', position: 0, collapsed: false },
      ],
      tasks: [
        taskStyle
          ? { tileId: 't1', position: 0, style: taskStyle }
          : { tileId: 't1', position: 0 },
      ],
    } as unknown as TaskListBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        title: 'A',
        style: {} as never,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      } as unknown as BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

function getTaskStyle(boardId: string, tileId: string): Record<string, unknown> | undefined {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return undefined;
  const tl = cached.board as unknown as { tasks?: Array<{ tileId: string; style?: Record<string, unknown> }> };
  return tl.tasks?.find((p) => p.tileId === tileId)?.style;
}

function getSectionStyle(boardId: string, sectionId: string): Record<string, unknown> | undefined {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return undefined;
  const tl = cached.board as unknown as { sections?: Array<{ id: string; style?: Record<string, unknown> }> };
  return tl.sections?.find((s) => s.id === sectionId)?.style;
}

describe('UpdateTaskItemStyleCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute + undo round-trip for task placement style', () => {
    const before = { headerColor: '#aaa' };
    const after = { headerColor: '#bbb', borderColor: '#xyz' };
    const fixture = makeTaskListBoard(before);
    boardCacheStore.hydrate({ tl: fixture }, { tl: 'tl.board.json' });

    const cmd = new UpdateTaskItemStyleCommand('tl', 't1', before, after);
    cmd.execute();
    expect(getTaskStyle('tl', 't1')).toMatchObject(after);

    cmd.undo();
    expect(getTaskStyle('tl', 't1')).toMatchObject(before);
    expect(getTaskStyle('tl', 't1')?.borderColor).toBeUndefined();
  });
});

describe('UpdateTaskSectionStyleCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute + undo round-trip for section style', () => {
    const before = { headerColor: '#111' };
    const after = { headerColor: '#222', fontSizeTitle: 18 };
    const fixture = makeTaskListBoard(undefined, before);
    boardCacheStore.hydrate({ tl: fixture }, { tl: 'tl.board.json' });

    const cmd = new UpdateTaskSectionStyleCommand('tl', 'sec-1', before, after);
    cmd.execute();
    expect(getSectionStyle('tl', 'sec-1')).toMatchObject(after);

    cmd.undo();
    expect(getSectionStyle('tl', 'sec-1')).toMatchObject(before);
    expect(getSectionStyle('tl', 'sec-1')?.fontSizeTitle).toBeUndefined();
  });

  it('undo from cleared section restores the original', () => {
    const before = { headerColor: '#111' };
    const fixture = makeTaskListBoard(undefined, before);
    boardCacheStore.hydrate({ tl: fixture }, { tl: 'tl.board.json' });

    const cmd = new UpdateTaskSectionStyleCommand('tl', 'sec-1', before, undefined);
    cmd.execute();
    expect(getSectionStyle('tl', 'sec-1')).toBeUndefined();

    cmd.undo();
    expect(getSectionStyle('tl', 'sec-1')).toMatchObject(before);
  });
});

// ── Connection — using existing UpdateConnectionCommand ──

describe('UpdateConnectionCommand (reused for ConnectionStylePopup)', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute + undo round-trip a connection style snapshot', () => {
    const conn: Connection = {
      id: 'c1',
      boardId: 'mm',
      fromTileId: 't1',
      toTileId: 't2',
      fromBubble: 0,
      toBubble: 1,
      pathColor: '#fff',
      arrowColor: '#fff',
      pathType: 'curved',
      pathStyle: 'solid',
      arrowType: 'end',
      visibility: 'visible',
      labelVisibility: 'visible',
      label: { text: '', position: 0.5, locked: false, textColor: '#000', backgroundColor: '#fff' },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Connection;
    const fixture: BoardFileData = {
      board: {
        id: 'mm',
        type: 'mindmap',
        name: 'M',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: {},
        inlineTiles: {},
        waypoints: [],
      } as unknown as MindMapBoard,
      tileDefs: {},
      connections: { c1: conn },
      frames: [],
    };
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    boardStore.setBoard(fixture.board);

    const before = {
      pathColor: '#fff',
      arrowColor: '#fff',
      pathType: 'curved',
      pathStyle: 'solid',
      arrowType: 'end',
      label: { ...conn.label },
    } as Partial<Connection>;
    const after = {
      pathColor: '#f00',
      arrowColor: '#0f0',
      pathType: 'straight',
      pathStyle: 'dashed',
      arrowType: 'none',
      label: { ...conn.label, textColor: '#abc' },
    } as Partial<Connection>;

    const cmd = new UpdateConnectionCommand('c1', before, after);
    cmd.execute();
    expect(boardStore.connections['c1']?.pathColor).toBe('#f00');
    expect(boardStore.connections['c1']?.pathType).toBe('straight');
    expect(boardStore.connections['c1']?.label.textColor).toBe('#abc');

    cmd.undo();
    expect(boardStore.connections['c1']?.pathColor).toBe('#fff');
    expect(boardStore.connections['c1']?.pathType).toBe('curved');
    expect(boardStore.connections['c1']?.label.textColor).toBe('#000');
  });
});
