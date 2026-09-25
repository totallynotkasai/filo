/**
 * Board format v8: a board file holds only visuals, and the loader accepts
 * exactly the current version.
 */
import { describe, it, expect } from 'vitest';
import {
  BoardFileDataSchema,
  TileDefinitionSchema,
  migrateBoardFile,
  CURRENT_BOARD_FILE_VERSION,
} from '@renderer/schema/index';
import { buildTileDefinition, defPatchFor } from '@renderer/lib/boards/tileDefBuilder';
import type { Tile, TileDefinition } from '@renderer/schema/index';

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

function v8File(): Record<string, unknown> {
  return {
    version: 8,
    board: {
      id: 'b1', type: 'mindmap', name: 'Map', emoji: '', createdAt: 1, updatedAt: 1,
      settings: {},
      placements: {
        t1: { x: 0, y: 0, width: 240, height: 160, locked: false, faded: false, frameless: false },
        t2: { x: 300, y: 0, width: 240, height: 160, locked: false, faded: false, frameless: false },
      },
      inlineTiles: {},
      groups: [],
      waypoints: [],
    },
    tileDefs: {
      t1: { id: 't1', style: STYLE, createdAt: 1, updatedAt: 1, titleHtml: '<p><b>Plans</b></p>', type: 'text', filePath: 'Notes/Plans.md' },
      t2: { id: 't2', style: STYLE, createdAt: 1, updatedAt: 1, type: 'image', title: 'Photo', src: 'pic.png' },
    },
    connections: {},
    frames: [],
  };
}

describe('board format v8', () => {
  it('is the current version', () => {
    expect(CURRENT_BOARD_FILE_VERSION).toBe(8);
  });

  it('refuses a board from an older Filo (or one with no version) instead of migrating it', () => {
    for (const version of [7, 6, undefined, 7.5]) {
      const raw = { ...v8File(), version };
      const res = migrateBoardFile(raw);
      expect(res.noMigrationPath).toBe(true);
      expect(res.data).toBe(raw);
    }
  });

  it('refuses a board from a newer Filo', () => {
    const res = migrateBoardFile({ ...v8File(), version: 9 });
    expect(res.fromFuture).toBe(true);
  });

  it('loads and re-saves a v8 file Filo wrote byte for byte', () => {
    // The saver writes the parsed cache object, so what Filo writes is the
    // schema's output; loading that again must give back the same bytes.
    const written = JSON.stringify(BoardFileDataSchema.parse(v8File()), null, 2);
    const resaved = JSON.stringify(BoardFileDataSchema.parse(JSON.parse(written)), null, 2);
    expect(resaved).toBe(written);
    const defs = (JSON.parse(written) as { tileDefs: Record<string, Record<string, unknown>> }).tileDefs;
    expect(defs.t1).toEqual(v8File().tileDefs && (v8File().tileDefs as Record<string, unknown>).t1);
  });

  it('drops a copy of the note from a text def on parse, so it cannot survive a save', () => {
    const def = TileDefinitionSchema.parse({
      id: 't1', type: 'text', filePath: 'A.md', style: STYLE, createdAt: 1, updatedAt: 1,
      title: 'A', tags: ['x'], content: '<p>body</p>', file: 'A.md', completed: true,
    });
    expect(Object.keys(def).sort()).toEqual(['createdAt', 'filePath', 'id', 'style', 'type', 'updatedAt']);
  });

  it('drops tags and derived name fields from a file def, keeping its caption title', () => {
    const def = TileDefinitionSchema.parse({
      id: 'f1', type: 'file', title: 'Report', filePath: 'docs/r.pdf', style: STYLE, createdAt: 1, updatedAt: 1,
      tags: ['x'], fileName: 'r.pdf', fileExtension: 'pdf',
    });
    expect(def).toEqual({ id: 'f1', type: 'file', title: 'Report', filePath: 'docs/r.pdf', style: STYLE, createdAt: 1, updatedAt: 1 });
  });

  it('keeps title and tags on a board-only tile', () => {
    const def = TileDefinitionSchema.parse({
      id: 'l1', type: 'link', title: 'Site', tags: ['web'], url: 'https://example.com', style: STYLE, createdAt: 1, updatedAt: 1,
    });
    expect(def).toMatchObject({ title: 'Site', tags: ['web'] });
  });

  it('requires a text def to name its note', () => {
    expect(TileDefinitionSchema.safeParse({ id: 't1', type: 'text', style: STYLE, createdAt: 1, updatedAt: 1 }).success).toBe(false);
  });

  it('builds a text def from a runtime tile without its title, tags or body', () => {
    const tile = {
      id: 't1', type: 'text', title: 'Plans', tags: ['a'], content: '<p>x</p>', filePath: 'Plans.md',
      titleHtml: '<b>Plans</b>', style: STYLE, position: { x: 0, y: 0 }, size: { width: 240, height: 160 },
      locked: false, faded: false, boardId: 'b1', createdAt: 1, updatedAt: 2,
    } as Tile;
    expect(buildTileDefinition(tile)).toEqual({
      id: 't1', type: 'text', filePath: 'Plans.md', titleHtml: '<b>Plans</b>', style: STYLE, createdAt: 1, updatedAt: 2,
    });
  });

  it('refuses to build a text def that names no note', () => {
    const tile = { id: 't1', type: 'text', title: 'x', tags: [], style: STYLE, createdAt: 1, updatedAt: 1 } as unknown as Tile;
    expect(() => buildTileDefinition(tile)).toThrow(/no filePath/);
  });

  it('keeps only board-owned fields from a tile update', () => {
    const def = { id: 't1', type: 'text', filePath: 'A.md', style: STYLE, createdAt: 1, updatedAt: 1 } as TileDefinition;
    expect(defPatchFor(def, { title: 'X', tags: ['y'], content: 'z', titleHtml: '<b>X</b>' } as Partial<Tile>)).toEqual({ titleHtml: '<b>X</b>' });
  });
});
