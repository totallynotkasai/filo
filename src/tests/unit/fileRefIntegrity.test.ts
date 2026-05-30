import { describe, it, expect } from 'vitest';
import {
  rewriteRenameInBoard,
  propagateRenameAcrossBoards,
  propagateMarkdownRenameToTextTiles,
  findTilesToCascadeDelete,
  collectFileRefs,
  detectBrokenRefs,
  getConventionFolderForBoardType,
  joinConventionPath,
} from '@renderer/lib/vault/fileRefIntegrity';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';

function makeBoard(defs: Record<string, Record<string, unknown>>): V7BoardFileData {
  return {
    board: {
      id: 'b1',
      type: 'mindmap',
      name: 'Test',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as any,
    tileDefs: defs as any,
    connections: {},
    frames: [],
  };
}

describe('fileRefIntegrity.rewriteRenameInBoard', () => {
  it('rewrites exact path matches on src and filePath', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'images/foo.png', title: 'Foo' },
      t2: { id: 't2', type: 'file', filePath: 'images/foo.png', title: 'Foo' },
      t3: { id: 't3', type: 'image', src: 'other.png', title: 'Other' },
    });
    const n = rewriteRenameInBoard(board, 'images/foo.png', 'media/renamed.png');
    expect(n).toBe(2);
    expect((board.tileDefs as any).t1.src).toBe('media/renamed.png');
    expect((board.tileDefs as any).t2.filePath).toBe('media/renamed.png');
    expect((board.tileDefs as any).t3.src).toBe('other.png');
  });

  it('rewrites folder renames (prefix match)', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'images/sub/a.png' },
      t2: { id: 't2', type: 'image', src: 'images/b.png' },
      t3: { id: 't3', type: 'image', src: 'other/c.png' },
    });
    const n = rewriteRenameInBoard(board, 'images', 'media');
    expect(n).toBe(2);
    expect((board.tileDefs as any).t1.src).toBe('media/sub/a.png');
    expect((board.tileDefs as any).t2.src).toBe('media/b.png');
    expect((board.tileDefs as any).t3.src).toBe('other/c.png');
  });

  it('normalizes backslash paths on Windows', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'images\\foo.png' },
    });
    const n = rewriteRenameInBoard(board, 'images/foo.png', 'media/bar.png');
    expect(n).toBe(1);
    expect((board.tileDefs as any).t1.src).toBe('media/bar.png');
  });

  it('leaves unrelated URLs untouched', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'https://example.com/x.png' },
    });
    expect(rewriteRenameInBoard(board, 'images', 'media')).toBe(0);
    expect((board.tileDefs as any).t1.src).toBe('https://example.com/x.png');
  });
});

describe('fileRefIntegrity.propagateRenameAcrossBoards', () => {
  it('updates multiple boards and reports changed board ids', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({ t1: { id: 't1', type: 'image', src: 'images/a.png' } }),
      b2: makeBoard({ t2: { id: 't2', type: 'image', src: 'other/b.png' } }),
      b3: makeBoard({ t3: { id: 't3', type: 'file', filePath: 'images/a.png' } }),
    };
    const result = propagateRenameAcrossBoards(boards, 'images/a.png', 'media/a.png');
    expect(result.updatedCount).toBe(2);
    expect(result.changedBoardIds.sort()).toEqual(['b1', 'b3']);
  });
});

describe('fileRefIntegrity.propagateMarkdownRenameToTextTiles', () => {
  it('rewrites text-tile titles when their convention-backed .md is renamed', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', title: 'Notes', tags: [] },
        t2: { id: 't2', type: 'text', title: 'Other', tags: [] },
      }),
      b2: makeBoard({
        t3: { id: 't3', type: 'text', title: 'Notes', tags: [] },
      }),
    };
    const r = propagateMarkdownRenameToTextTiles(boards, 'Notes.md', 'Renamed.md');
    expect(r.updatedCount).toBe(2);
    expect(r.changedBoardIds.sort()).toEqual(['b1', 'b2']);
    expect((boards.b1.tileDefs as any).t1.title).toBe('Renamed');
    expect((boards.b1.tileDefs as any).t2.title).toBe('Other');
    expect((boards.b2.tileDefs as any).t3.title).toBe('Renamed');
  });

  it('skips text tiles that already use an explicit file field', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', title: 'Notes', file: 'sub/Notes.md' },
      }),
    };
    const r = propagateMarkdownRenameToTextTiles(boards, 'Notes.md', 'Renamed.md');
    expect(r.updatedCount).toBe(0);
    expect((boards.b1.tileDefs as any).t1.title).toBe('Notes');
  });

  it('returns no-op when either path is not .md', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({ t1: { id: 't1', type: 'text', title: 'Notes' } }),
    };
    expect(propagateMarkdownRenameToTextTiles(boards, 'Notes.md', 'Renamed.txt').updatedCount).toBe(0);
    expect(propagateMarkdownRenameToTextTiles(boards, 'image.png', 'image2.png').updatedCount).toBe(0);
  });
});

describe('fileRefIntegrity.findTilesToCascadeDelete', () => {
  it('flags tiles by file-ref field exact match', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'image', src: 'images/a.png' },
        t2: { id: 't2', type: 'image', src: 'images/b.png' },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'images/a.png');
    expect(r.totalCount).toBe(1);
    expect(r.byBoard).toEqual({ b1: ['t1'] });
  });

  it('flags every tile under a deleted folder', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'image', src: 'images/a.png' },
        t2: { id: 't2', type: 'file', filePath: 'images/sub/b.pdf' },
        t3: { id: 't3', type: 'image', src: 'other/c.png' },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'images');
    expect(r.byBoard.b1.sort()).toEqual(['t1', 't2']);
  });

  it('flags root-level text tiles by ${title}.md convention', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', title: 'Notes' },
        t2: { id: 't2', type: 'text', title: 'Other' },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Notes.md');
    expect(r.byBoard).toEqual({ b1: ['t1'] });
  });

  it('skips text tiles with explicit file fields when matching by title', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', title: 'Notes', file: 'sub/Notes.md' },
      }),
    };
    expect(findTilesToCascadeDelete(boards, 'Notes.md').totalCount).toBe(0);
  });
});

describe('fileRefIntegrity.collectFileRefs', () => {
  it('gathers every file reference with its tile id and field', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'a.png' },
      t2: { id: 't2', type: 'file', filePath: 'b.pdf' },
      t3: { id: 't3', type: 'text' },
    });
    const refs = collectFileRefs(board);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.tileId === 't1')).toMatchObject({ field: 'src', path: 'a.png' });
    expect(refs.find((r) => r.tileId === 't2')).toMatchObject({
      field: 'filePath',
      path: 'b.pdf',
    });
  });
});

describe('fileRefIntegrity.detectBrokenRefs', () => {
  it('returns refs whose path is not in knownPaths', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'good.png' },
      t2: { id: 't2', type: 'image', src: 'missing.png' },
      t3: { id: 't3', type: 'file', filePath: 'sub/also-missing.pdf' },
    });
    const broken = detectBrokenRefs(board, new Set(['good.png']));
    expect(broken).toHaveLength(2);
    expect(broken.map((b) => b.tileId).sort()).toEqual(['t2', 't3']);
  });

  it('ignores absolute and URL references', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'https://example.com/x.png' },
      t2: { id: 't2', type: 'image', src: '/absolute/path.png' },
      t3: { id: 't3', type: 'image', src: 'C:/abs.png' },
    });
    expect(detectBrokenRefs(board, new Set())).toEqual([]);
  });

  it('ignores data: blob: and file: refs (non-vault sources)', () => {
    // Regression: previously the URL-skip predicate required `://`, so
    // `data:` URLs (which have no `//`) were treated as vault-relative
    // paths and flagged as broken. After dragging a small image with no
    // `webUtils` path, the resulting data-URL tile got a phantom badge.
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' },
      t2: { id: 't2', type: 'image', src: 'blob:http://localhost/abc-123' },
      t3: { id: 't3', type: 'image', src: 'file:///C:/Users/me/photo.png' },
      t4: { id: 't4', type: 'image', src: 'C:\\Users\\me\\photo.png' },
    });
    expect(detectBrokenRefs(board, new Set())).toEqual([]);
  });

  it('accepts an iterable of paths', () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'image', src: 'a.png' },
    });
    expect(detectBrokenRefs(board, ['a.png'])).toEqual([]);
    expect(detectBrokenRefs(board, [])).toHaveLength(1);
  });
});

// ── V7 placement-aware integrity (Phase G) ──

function makeKanbanBoard(opts: {
  name?: string;
  defs: Record<string, Record<string, unknown>>;
  columns?: Array<{ id: string; tilePlacements: Array<{ tileId: string; position?: number }> }>;
}): V7BoardFileData {
  return {
    board: {
      id: 'k1',
      type: 'kanban',
      name: opts.name ?? 'My Kanban',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: opts.columns ?? [],
    } as any,
    tileDefs: opts.defs as any,
    connections: {},
    frames: [],
  };
}

function makeTaskListBoard(opts: {
  defs: Record<string, Record<string, unknown>>;
  tasks?: Array<{ tileId: string; position?: number }>;
}): V7BoardFileData {
  return {
    board: {
      id: 'tl1',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: opts.tasks ?? [],
    } as any,
    tileDefs: opts.defs as any,
    connections: {},
    frames: [],
  };
}

function makeMindMapBoardWithPlacements(opts: {
  defs: Record<string, Record<string, unknown>>;
  placements?: Record<string, unknown>;
}): V7BoardFileData {
  return {
    board: {
      id: 'mm1',
      type: 'mindmap',
      name: 'Mind Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      viewport: { x: 0, y: 0, scale: 1 },
      placements: opts.placements ?? {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as any,
    tileDefs: opts.defs as any,
    connections: {},
    frames: [],
  };
}

describe('fileRefIntegrity.propagateMarkdownRenameToTextTiles — V7 conventions', () => {
  it('rewrites Tasks/<title>.md text tiles when the board pins Tasks/ as its default folder', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', title: 'Buy milk', tags: [] },
          t2: { id: 't2', type: 'text', title: 'Other', tags: [] },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
    };
    // After dropping the hardcoded 'Tasks' convention, the tasklist board only
    // resolves into Tasks/ when the per-board defaultFolder pin is set there.
    const r = propagateMarkdownRenameToTextTiles(
      boards,
      'Tasks/Buy milk.md',
      'Tasks/Buy bread.md',
      { boardDefaultFolders: { tl1: 'Tasks' } },
    );
    expect(r.updatedCount).toBe(1);
    expect((boards.tl1.tileDefs as any).t1.title).toBe('Buy bread');
    expect((boards.tl1.tileDefs as any).t2.title).toBe('Other');
  });

  it('rewrites root-level <title>.md text tiles on a tasklist board with no pin', () => {
    // Without a pin, the cascade resolves to vault root — so Buy milk.md (not
    // Tasks/Buy milk.md) is the convention path for the tile.
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: { t1: { id: 't1', type: 'text', title: 'Buy milk', tags: [] } },
        tasks: [{ tileId: 't1' }],
      }),
    };
    const r = propagateMarkdownRenameToTextTiles(boards, 'Buy milk.md', 'Buy bread.md');
    expect(r.updatedCount).toBe(1);
    expect((boards.tl1.tileDefs as any).t1.title).toBe('Buy bread');
  });

  it('rewrites Kanban/<board>/<title>.md tiles, sanitizing the board name', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        name: 'My: Board',
        defs: { t1: { id: 't1', type: 'text', title: 'Spec', tags: [] } },
      }),
    };
    // Board name "My: Board" sanitizes to "My Board" (colon stripped).
    const r = propagateMarkdownRenameToTextTiles(boards, 'Kanban/My Board/Spec.md', 'Kanban/My Board/Design.md');
    expect(r.updatedCount).toBe(1);
    expect((boards.k1.tileDefs as any).t1.title).toBe('Design');
  });

  it('matches a root-level rename against an unpinned TaskList tile (cascade=vault root)', () => {
    // After the per-board-default plan, an unpinned TaskList board's tiles
    // resolve to the vault root convention. A root-level Notes.md → Renamed.md
    // rename DOES propagate to the tile title, the inverse of the previous
    // hardcoded-Tasks/ behaviour.
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: { t1: { id: 't1', type: 'text', title: 'Notes', tags: [] } },
        tasks: [{ tileId: 't1' }],
      }),
    };
    const r = propagateMarkdownRenameToTextTiles(boards, 'Notes.md', 'Renamed.md');
    expect(r.updatedCount).toBe(1);
    expect((boards.tl1.tileDefs as any).t1.title).toBe('Renamed');
  });

  it('does NOT match a Tasks/ rename against a mindmap text tile', () => {
    const boards: Record<string, V7BoardFileData> = {
      mm1: makeMindMapBoardWithPlacements({
        defs: { t1: { id: 't1', type: 'text', title: 'Foo', tags: [] } },
      }),
    };
    const r = propagateMarkdownRenameToTextTiles(boards, 'Tasks/Foo.md', 'Tasks/Bar.md');
    expect(r.updatedCount).toBe(0);
    expect((boards.mm1.tileDefs as any).t1.title).toBe('Foo');
  });

  it('stamps an explicit filePath when a file moves out of the convention folder', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: { t1: { id: 't1', type: 'text', title: 'Notes', tags: [] } },
        tasks: [{ tileId: 't1' }],
      }),
    };
    // Tasks/Notes.md → Notes.md, with the board pinning Tasks/ as its default.
    // The title stays the same — the tile gets an explicit filePath so the next
    // save lands at the new location instead of recreating Tasks/Notes.md.
    const r = propagateMarkdownRenameToTextTiles(
      boards,
      'Tasks/Notes.md',
      'Notes.md',
      { boardDefaultFolders: { tl1: 'Tasks' } },
    );
    expect(r.updatedCount).toBe(1);
    expect((boards.tl1.tileDefs as any).t1.title).toBe('Notes');
    expect((boards.tl1.tileDefs as any).t1.filePath).toBe('Notes.md');
  });

  it('stamps an explicit filePath when a mindmap text tile moves into a subfolder', () => {
    const boards: Record<string, V7BoardFileData> = {
      mm1: makeMindMapBoardWithPlacements({
        defs: { t1: { id: 't1', type: 'text', title: 'Notes', tags: [] } },
      }),
    };
    // Root → Sub/ for a mindmap tile (mindmap convention folder = root).
    // Without this stamp, TextTile.writeMarkdownToDisk would fall back to
    // ${title}.md at the root and recreate the file there (the duplicate
    // bug the user reported).
    const r = propagateMarkdownRenameToTextTiles(boards, 'Notes.md', 'Sub/Notes.md');
    expect(r.updatedCount).toBe(1);
    expect((boards.mm1.tileDefs as any).t1.title).toBe('Notes');
    expect((boards.mm1.tileDefs as any).t1.filePath).toBe('Sub/Notes.md');
  });
});

describe('fileRefIntegrity.findTilesToCascadeDelete — V7 conventions', () => {
  it('flags a Tasks tile when its convention .md is deleted (with per-board pin to Tasks/)', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', title: 'Buy milk' },
          t2: { id: 't2', type: 'text', title: 'Other' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Tasks/Buy milk.md', {
      boardDefaultFolders: { tl1: 'Tasks' },
    });
    expect(r.byBoard).toEqual({ tl1: ['t1'] });
  });

  it('flags every Tasks tile when the entire Tasks/ folder is deleted (with per-board pin)', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', title: 'A' },
          t2: { id: 't2', type: 'text', title: 'B' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
      mm1: makeMindMapBoardWithPlacements({
        defs: { t3: { id: 't3', type: 'text', title: 'A' } },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Tasks', {
      boardDefaultFolders: { tl1: 'Tasks' },
    });
    expect(r.byBoard.tl1.sort()).toEqual(['t1', 't2']);
    expect(r.byBoard.mm1).toBeUndefined();
  });

  it('cross-cascades root-level delete to TaskList tile with no pin (now lives at root)', () => {
    // After the per-board-default plan, an unpinned TaskList tile titled
    // 'Notes' resolves to root-level 'Notes.md' — so deleting Notes.md DOES
    // cascade to its tile (the inverse of the previous Tasks/-only behaviour).
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: { t1: { id: 't1', type: 'text', title: 'Notes' } },
        tasks: [{ tileId: 't1' }],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Notes.md');
    expect(r.byBoard).toEqual({ tl1: ['t1'] });
  });

  it('flags Kanban tile when Kanban/<board>/<title>.md is deleted', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        name: 'Project',
        defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
        columns: [{ id: 'c1', tilePlacements: [{ tileId: 't1' }] }],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Kanban/Project/Spec.md');
    expect(r.byBoard).toEqual({ k1: ['t1'] });
  });

  it('returns coverImage clears for Kanban placements pointing at the deleted file', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        name: 'Project',
        defs: {
          t1: { id: 't1', type: 'text', title: 'CardA' },
          t2: { id: 't2', type: 'text', title: 'CardB' },
        },
        columns: [
          {
            id: 'c1',
            tilePlacements: [
              { tileId: 't1', coverImage: 'attachments/cover.png' } as any,
              { tileId: 't2', coverImage: 'attachments/other.png' } as any,
            ],
          },
        ],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'attachments/cover.png');
    // Cards themselves stay — only the matching cover clear is reported.
    expect(r.byBoard.k1).toBeUndefined();
    expect(r.coverImageClears.k1).toEqual([
      { columnId: 'c1', tileId: 't1', matchedPath: 'attachments/cover.png' },
    ]);
  });

  it('reports coverImage clears for every placement under a deleted folder', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        defs: {
          t1: { id: 't1', type: 'text', title: 'A' },
          t2: { id: 't2', type: 'text', title: 'B' },
        },
        columns: [
          {
            id: 'c1',
            tilePlacements: [
              { tileId: 't1', coverImage: 'attachments/sub/a.png' } as any,
              { tileId: 't2', coverImage: 'attachments/sub/b.png' } as any,
            ],
          },
        ],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'attachments/sub');
    expect(r.coverImageClears.k1?.map((c) => c.tileId).sort()).toEqual(['t1', 't2']);
  });

  it('does not double-report a cover-image clear when the tile is also queued for removal', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        defs: {
          // Tile points at the same image AND uses it as its file ref → the
          // whole tile is removed; reporting a coverImage clear on top
          // would be redundant.
          t1: { id: 't1', type: 'image', src: 'attachments/cover.png' },
        },
        columns: [
          {
            id: 'c1',
            tilePlacements: [{ tileId: 't1', coverImage: 'attachments/cover.png' } as any],
          },
        ],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'attachments/cover.png');
    expect(r.byBoard.k1).toEqual(['t1']);
    expect(r.coverImageClears.k1).toBeUndefined();
  });

  it('leaves unrelated cover images untouched', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        defs: { t1: { id: 't1', type: 'text', title: 'A' } },
        columns: [
          {
            id: 'c1',
            tilePlacements: [{ tileId: 't1', coverImage: 'attachments/keep.png' } as any],
          },
        ],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'attachments/delete.png');
    expect(r.coverImageClears).toEqual({});
  });
});

describe('fileRefIntegrity.detectBrokenRefs — V7 conventions', () => {
  it('flags a Tasks placement whose convention .md is missing (with per-board pin to Tasks/)', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Missing' } },
      tasks: [{ tileId: 't1' }],
    });
    const broken = detectBrokenRefs(board, new Set<string>(), {
      boardDefaultFolder: 'Tasks',
    });
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      tileId: 't1',
      field: 'title',
      missingPath: 'Tasks/Missing.md',
    });
  });

  it('does NOT flag tasks whose convention .md exists (with per-board pin)', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Present' } },
      tasks: [{ tileId: 't1' }],
    });
    expect(
      detectBrokenRefs(board, ['Tasks/Present.md'], { boardDefaultFolder: 'Tasks' }),
    ).toEqual([]);
  });

  it('flags an unpinned TaskList tile against the root-level .md path', () => {
    // Without any pin, the cascade resolves the convention path to root-level
    // <title>.md — matching the new TaskList default placement behaviour.
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Buy milk' } },
      tasks: [{ tileId: 't1' }],
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Buy milk.md');
  });

  it('does NOT flag orphaned tileDefs that have no placement on the board', () => {
    // tileDef exists but no placement references it — it is invisible to the
    // user, so a broken-ref badge would be a phantom.
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Orphan' } },
      tasks: [],
    });
    expect(detectBrokenRefs(board, new Set<string>())).toEqual([]);
  });

  it('flags Kanban placement whose convention .md is missing', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
      columns: [{ id: 'c1', tilePlacements: [{ tileId: 't1' }] }],
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Kanban/Project/Spec.md');
  });

  it('flags MindMap placement whose root <title>.md is missing', () => {
    const board = makeMindMapBoardWithPlacements({
      defs: { t1: { id: 't1', type: 'text', title: 'Notes' } },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Notes.md');
  });

  it('skips text tiles with explicit file/filePath fields (defer to field check)', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'X', file: 'custom/path.md' } },
      tasks: [{ tileId: 't1' }],
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    // Only the field-based "file" check applies here; convention check is
    // suppressed by `d.file` presence. Field check finds 'custom/path.md'
    // missing, but `file` isn't in FILE_REF_FIELDS so it's not flagged.
    // (FILE_REF_FIELDS = file/src/filePath — `file` IS in there.)
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ field: 'file', missingPath: 'custom/path.md' });
  });

  it('honours activeRootFolder option for convention-backed text tiles', () => {
    // Mirrors resolveTextTileVaultPath: when the user pins a Root Directory
    // in the vault sidebar, new tiles' .md files land inside that folder.
    // The broken-ref check must look there too, otherwise the tile
    // false-flags immediately after creation.
    const board = makeMindMapBoardWithPlacements({
      defs: { t1: { id: 't1', type: 'text', title: 'Foo' } },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const paths = new Set(['Notes/Foo.md']);
    // Without the option, the detector looks at vault root and flags it.
    const flagged = detectBrokenRefs(board, paths);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].missingPath).toBe('Foo.md');
    // With activeRootFolder set, the detector resolves to Notes/Foo.md and clears.
    expect(detectBrokenRefs(board, paths, { activeRootFolder: 'Notes' })).toEqual([]);
  });

  it('normalises backslashes and trailing slashes in activeRootFolder', () => {
    const board = makeMindMapBoardWithPlacements({
      defs: { t1: { id: 't1', type: 'text', title: 'Foo' } },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const paths = new Set(['Notes/Sub/Foo.md']);
    expect(detectBrokenRefs(board, paths, { activeRootFolder: 'Notes\\Sub\\' })).toEqual([]);
  });

  it('does NOT apply activeRootFolder to Kanban boards (hardcoded convention folder wins)', () => {
    // Regression: previously, pinning a "Root Directory" rewrote the convention
    // path for EVERY board type, false-flagging Kanban text cards whose .md
    // lives in Kanban/<board>/ rather than the pinned root.
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
      columns: [{ id: 'c1', tilePlacements: [{ tileId: 't1' }] }],
    });
    const paths = new Set(['Kanban/Project/Spec.md']);
    expect(detectBrokenRefs(board, paths, { activeRootFolder: 'Notes' })).toEqual([]);
  });

  it('applies activeRootFolder to TaskList boards (cascade now covers TaskList)', () => {
    // After the per-board-default plan, TaskList boards participate in the
    // root-folder cascade like Mind Map. activeRootFolder='Notes' resolves
    // the convention path to Notes/Buy milk.md (not Tasks/Buy milk.md).
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Buy milk' } },
      tasks: [{ tileId: 't1' }],
    });
    expect(
      detectBrokenRefs(board, new Set(['Notes/Buy milk.md']), { activeRootFolder: 'Notes' }),
    ).toEqual([]);
    // And the unpinned default lands at vault root, not Tasks/.
    expect(detectBrokenRefs(board, new Set(['Buy milk.md']))).toEqual([]);
  });

  it('vault-wide pin overrides per-board pin in the cascade', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', title: 'Foo' } },
      tasks: [{ tileId: 't1' }],
    });
    // Per-board pin says 'Inbox', vault-wide pin says 'Notes' — vault wins.
    expect(
      detectBrokenRefs(board, new Set(['Notes/Foo.md']), {
        activeRootFolder: 'Notes',
        boardDefaultFolder: 'Inbox',
      }),
    ).toEqual([]);
    // Per-board pin alone applies when no vault pin is set.
    expect(
      detectBrokenRefs(board, new Set(['Inbox/Foo.md']), {
        boardDefaultFolder: 'Inbox',
      }),
    ).toEqual([]);
  });

  it('skips text tiles with explicit filePath regardless of activeRootFolder', () => {
    // After the fix, every newly-created text tile gets `filePath` stamped on
    // it at write time. The convention branch must defer to the explicit-field
    // check so toggling the Root Directory does not shift the tile's identity.
    const board = makeMindMapBoardWithPlacements({
      defs: {
        t1: { id: 't1', type: 'text', title: 'Foo', filePath: 'Notes/Foo.md' },
      },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const paths = new Set(['Notes/Foo.md']);
    for (const root of [undefined, '', 'Notes', 'Other']) {
      expect(detectBrokenRefs(board, paths, { activeRootFolder: root })).toEqual([]);
    }
  });
});

describe('fileRefIntegrity — Kanban placement coverImage (H7)', () => {
  it('rewrites a coverImage path on exact match', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
      columns: [
        {
          id: 'c1',
          tilePlacements: [
            { tileId: 't1', coverImage: 'media/cover.png' } as unknown as {
              tileId: string;
            },
          ],
        },
      ],
    });
    const n = rewriteRenameInBoard(board, 'media/cover.png', 'images/renamed.png');
    expect(n).toBe(1);
    const cols = (board.board as any).columns as Array<{
      tilePlacements: Array<{ coverImage?: string }>;
    }>;
    expect(cols[0].tilePlacements[0].coverImage).toBe('images/renamed.png');
  });

  it('rewrites coverImage when its parent folder is renamed', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
      columns: [
        {
          id: 'c1',
          tilePlacements: [
            { tileId: 't1', coverImage: 'media/sub/photo.png' } as unknown as {
              tileId: string;
            },
            { tileId: 't1', coverImage: 'other/keep.png' } as unknown as {
              tileId: string;
            },
          ],
        },
      ],
    });
    const n = rewriteRenameInBoard(board, 'media', 'images');
    expect(n).toBe(1);
    const cols = (board.board as any).columns as Array<{
      tilePlacements: Array<{ coverImage?: string }>;
    }>;
    expect(cols[0].tilePlacements[0].coverImage).toBe('images/sub/photo.png');
    expect(cols[0].tilePlacements[1].coverImage).toBe('other/keep.png');
  });

  it('flags a placement coverImage as broken when its file is missing', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', title: 'Spec' } },
      columns: [
        {
          id: 'c1',
          tilePlacements: [
            { tileId: 't1', coverImage: 'media/missing.png' } as unknown as {
              tileId: string;
            },
          ],
        },
      ],
    });
    // Convention title path is present, so the only broken ref should be the
    // coverImage. Provide the convention .md so it doesn't false-flag.
    const broken = detectBrokenRefs(board, new Set(['Kanban/Project/Spec.md']));
    const coverBroken = broken.find((b) => b.field === 'coverImage');
    expect(coverBroken).toBeDefined();
    expect(coverBroken?.missingPath).toBe('media/missing.png');
  });
});

describe('fileRefIntegrity.getConventionFolderForBoardType', () => {
  it('returns vault root for mindmap', () => {
    expect(getConventionFolderForBoardType('mindmap', undefined)).toBe('');
  });

  it('returns Kanban/<sanitized name> for kanban', () => {
    expect(getConventionFolderForBoardType('kanban', 'My Board')).toBe('Kanban/My Board');
  });

  it('sanitises filesystem-unsafe characters in kanban board name', () => {
    expect(getConventionFolderForBoardType('kanban', 'Foo:/Bar*?')).toBe('Kanban/FooBar');
  });

  it('returns empty string for tasklist (cascade-resolved at runtime)', () => {
    // After the per-board-default plan, TaskList no longer pins to a fixed
    // 'Tasks' folder; '' signals "resolve via getActiveContentFolder cascade".
    expect(getConventionFolderForBoardType('tasklist', 'whatever')).toBe('');
  });

  it('returns null for board types without a convention folder', () => {
    expect(getConventionFolderForBoardType('document', undefined)).toBeNull();
    expect(getConventionFolderForBoardType('unknown', undefined)).toBeNull();
  });
});

describe('fileRefIntegrity.joinConventionPath', () => {
  it('joins folder and title with .md extension', () => {
    expect(joinConventionPath('Notes', 'Foo')).toBe('Notes/Foo.md');
    expect(joinConventionPath('Kanban/My Board', 'Card')).toBe('Kanban/My Board/Card.md');
  });

  it('produces a root-level path when folder is empty', () => {
    expect(joinConventionPath('', 'Foo')).toBe('Foo.md');
  });
});
