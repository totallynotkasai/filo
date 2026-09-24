import { describe, it, expect } from 'vitest';
import {
  rewriteRenameInBoard,
  propagateRenameAcrossBoards,
  findTilesToCascadeDelete,
  collectFileRefs,
  detectBrokenRefs,
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

  it('flags a text tile by its filePath', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', filePath: 'Notes.md' },
        t2: { id: 't2', type: 'text', filePath: 'Other.md' },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Notes.md');
    expect(r.byBoard).toEqual({ b1: ['t1'] });
  });

  it('a text tile is matched by its path, not by a file named after it elsewhere', () => {
    const boards: Record<string, V7BoardFileData> = {
      b1: makeBoard({
        t1: { id: 't1', type: 'text', filePath: 'sub/Notes.md' },
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
      t3: { id: 't3', type: 'link', url: 'https://example.com' },
    });
    const refs = collectFileRefs(board);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.tileId === 't1')).toMatchObject({ field: 'src', path: 'a.png' });
    expect(refs.find((r) => r.tileId === 't2')).toMatchObject({
      field: 'filePath',
      path: 'b.pdf',
    });
  });

  it("includes a text tile's filePath", () => {
    const board = makeBoard({
      t1: { id: 't1', type: 'text', filePath: 'Notes/A.md' },
    });
    expect(collectFileRefs(board)).toEqual([
      { tileId: 't1', field: 'filePath', path: 'Notes/A.md' },
    ]);
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
    // `data:` URLs have no `//`, so a `://`-only skip predicate would treat
    // them as vault-relative paths and give a data-URL image tile a phantom
    // broken badge.
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

function makeDocumentBoard(filePath: string): V7BoardFileData {
  return {
    board: {
      id: 'd1',
      type: 'document',
      name: 'Doc',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      filePath,
    } as any,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('fileRefIntegrity — note renames rewrite filePath on every board type', () => {
  it('rewrites a Task List text tile when its note is renamed, leaving other notes alone', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', filePath: 'Tasks/Buy milk.md' },
          t2: { id: 't2', type: 'text', filePath: 'Tasks/Other.md' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
    };
    const r = propagateRenameAcrossBoards(boards, 'Tasks/Buy milk.md', 'Tasks/Buy bread.md');
    expect(r.updatedCount).toBe(1);
    expect((boards.tl1.tileDefs as any).t1.filePath).toBe('Tasks/Buy bread.md');
    expect((boards.tl1.tileDefs as any).t2.filePath).toBe('Tasks/Other.md');
  });

  it('rewrites the same note on several boards (Kanban card and Mind Map tile)', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        defs: { t1: { id: 't1', type: 'text', filePath: 'Kanban/Spec.md' } },
        columns: [{ id: 'c1', tilePlacements: [{ tileId: 't1' }] }],
      }),
      mm1: makeMindMapBoardWithPlacements({
        defs: { t2: { id: 't2', type: 'text', filePath: 'Kanban/Spec.md' } },
      }),
    };
    const r = propagateRenameAcrossBoards(boards, 'Kanban/Spec.md', 'Kanban/Design.md');
    expect(r.changedBoardIds.sort()).toEqual(['k1', 'mm1']);
    expect((boards.k1.tileDefs as any).t1.filePath).toBe('Kanban/Design.md');
    expect((boards.mm1.tileDefs as any).t2.filePath).toBe('Kanban/Design.md');
  });

  it('follows a folder move for every note inside it', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', filePath: 'Tasks/A.md' },
          t2: { id: 't2', type: 'text', filePath: 'Tasks/sub/B.md' },
          t3: { id: 't3', type: 'text', filePath: 'Other/C.md' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }, { tileId: 't3' }],
      }),
    };
    const r = propagateRenameAcrossBoards(boards, 'Tasks', 'Archive/Tasks');
    expect(r.updatedCount).toBe(2);
    expect((boards.tl1.tileDefs as any).t1.filePath).toBe('Archive/Tasks/A.md');
    expect((boards.tl1.tileDefs as any).t2.filePath).toBe('Archive/Tasks/sub/B.md');
    expect((boards.tl1.tileDefs as any).t3.filePath).toBe('Other/C.md');
  });

  // The title lives in the note's frontmatter, so a rename only moves the
  // path: nothing title-shaped is written onto the board.
  it('a rename writes only filePath on the def', () => {
    const boards: Record<string, V7BoardFileData> = {
      mm1: makeMindMapBoardWithPlacements({
        defs: { t1: { id: 't1', type: 'text', filePath: 'Notes.md' } },
      }),
    };
    propagateRenameAcrossBoards(boards, 'Notes.md', 'Sub/Notes.md');
    expect((boards.mm1.tileDefs as any).t1).toEqual({ id: 't1', type: 'text', filePath: 'Sub/Notes.md' });
  });

  it("rewrites a Document board's filePath", () => {
    const boards: Record<string, V7BoardFileData> = { d1: makeDocumentBoard('Docs/Plan.md') };
    const r = propagateRenameAcrossBoards(boards, 'Docs/Plan.md', 'Docs/Roadmap.md');
    expect(r.changedBoardIds).toEqual(['d1']);
    expect((boards.d1.board as any).filePath).toBe('Docs/Roadmap.md');
  });
});

describe('fileRefIntegrity.findTilesToCascadeDelete — text tiles and covers', () => {
  it('flags a Task List tile when its note is deleted', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', filePath: 'Tasks/Buy milk.md' },
          t2: { id: 't2', type: 'text', filePath: 'Tasks/Other.md' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Tasks/Buy milk.md');
    expect(r.byBoard).toEqual({ tl1: ['t1'] });
  });

  it('flags every tile whose note sits under a deleted folder, on every board', () => {
    const boards: Record<string, V7BoardFileData> = {
      tl1: makeTaskListBoard({
        defs: {
          t1: { id: 't1', type: 'text', filePath: 'Tasks/A.md' },
          t2: { id: 't2', type: 'text', filePath: 'Tasks/B.md' },
        },
        tasks: [{ tileId: 't1' }, { tileId: 't2' }],
      }),
      mm1: makeMindMapBoardWithPlacements({
        defs: {
          t3: { id: 't3', type: 'text', filePath: 'A.md' },
          t4: { id: 't4', type: 'text', filePath: 'Tasks/B.md' },
        },
      }),
    };
    const r = findTilesToCascadeDelete(boards, 'Tasks');
    expect(r.byBoard.tl1.sort()).toEqual(['t1', 't2']);
    expect(r.byBoard.mm1).toEqual(['t4']);
  });

  it('flags a Kanban card when its note is deleted', () => {
    const boards: Record<string, V7BoardFileData> = {
      k1: makeKanbanBoard({
        name: 'Project',
        defs: { t1: { id: 't1', type: 'text', filePath: 'Kanban/Project/Spec.md' } },
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
          t1: { id: 't1', type: 'text', filePath: 'CardA.md' },
          t2: { id: 't2', type: 'text', filePath: 'CardB.md' },
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
          t1: { id: 't1', type: 'text', filePath: 'A.md' },
          t2: { id: 't2', type: 'text', filePath: 'B.md' },
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
        defs: { t1: { id: 't1', type: 'text', filePath: 'A.md' } },
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

describe('fileRefIntegrity.detectBrokenRefs — text tiles', () => {
  it('flags a Task List tile whose note is missing', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', filePath: 'Tasks/Missing.md' } },
      tasks: [{ tileId: 't1' }],
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toEqual([
      { tileId: 't1', field: 'filePath', missingPath: 'Tasks/Missing.md' },
    ]);
  });

  it('does NOT flag a tile whose note exists (case-insensitive, either separator)', () => {
    const board = makeTaskListBoard({
      defs: { t1: { id: 't1', type: 'text', filePath: 'Tasks/Present.md' } },
      tasks: [{ tileId: 't1' }],
    });
    expect(detectBrokenRefs(board, ['Tasks/Present.md'])).toEqual([]);
    expect(detectBrokenRefs(board, ['tasks\\present.md'])).toEqual([]);
  });

  it('flags a Kanban card whose note is missing', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', filePath: 'Kanban/Project/Spec.md' } },
      columns: [{ id: 'c1', tilePlacements: [{ tileId: 't1' }] }],
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Kanban/Project/Spec.md');
  });

  it('flags a Mind Map tile whose note is missing', () => {
    const board = makeMindMapBoardWithPlacements({
      defs: { t1: { id: 't1', type: 'text', filePath: 'Notes.md' } },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const broken = detectBrokenRefs(board, new Set<string>());
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Notes.md');
  });

  // The path is the tile's identity, so a same-named note in another folder
  // (e.g. under a pinned root folder) must not satisfy it.
  it('a same-named note in another folder does not satisfy the reference', () => {
    const board = makeMindMapBoardWithPlacements({
      defs: { t1: { id: 't1', type: 'text', filePath: 'Foo.md' } },
      placements: { t1: { x: 0, y: 0, w: 240, h: 160, locked: false, faded: false } },
    });
    const broken = detectBrokenRefs(board, new Set(['Notes/Foo.md']));
    expect(broken).toHaveLength(1);
    expect(broken[0].missingPath).toBe('Foo.md');
  });

  it("flags a Document board whose note is missing", () => {
    const broken = detectBrokenRefs(makeDocumentBoard('Docs/Plan.md'), new Set<string>());
    expect(broken).toEqual([{ tileId: 'd1', field: 'filePath', missingPath: 'Docs/Plan.md' }]);
    expect(detectBrokenRefs(makeDocumentBoard('Docs/Plan.md'), ['Docs/Plan.md'])).toEqual([]);
  });
});

describe('fileRefIntegrity — Kanban placement coverImage (H7)', () => {
  it('rewrites a coverImage path on exact match', () => {
    const board = makeKanbanBoard({
      name: 'Project',
      defs: { t1: { id: 't1', type: 'text', filePath: 'Spec.md' } },
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
      defs: { t1: { id: 't1', type: 'text', filePath: 'Spec.md' } },
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
      defs: { t1: { id: 't1', type: 'text', filePath: 'Kanban/Project/Spec.md' } },
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
    // The card's note is present, so the only broken ref is the cover image.
    const broken = detectBrokenRefs(board, new Set(['Kanban/Project/Spec.md']));
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ field: 'coverImage', missingPath: 'media/missing.png' });
  });
});
