import { describe, it, expect } from 'vitest';
import { buildTextTileDefForNote } from '@renderer/lib/canvas/markdownTileSeed';
import { defaultTileStyleSnapshot } from '@renderer/constants/defaults';

type ExistingTile = { type: string; filePath?: string };

describe('buildTextTileDefForNote — def shape', () => {
  // The note keeps its title, tags and body in the file, so the def is only
  // the path plus visuals: nothing from the note is copied onto the board.
  it('builds a def that names the note by path and nothing else', () => {
    const { def, duplicate } = buildTextTileDefForNote({
      vaultRelPath: 'Notes/Foo.md',
      existingTiles: [],
      tileId: 'tile_1',
      now: 1_000,
    });
    expect(def).toEqual({
      id: 'tile_1',
      type: 'text',
      filePath: 'Notes/Foo.md',
      style: defaultTileStyleSnapshot(),
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(duplicate).toBe(false);
  });

  it('keeps the dropped path wherever the note sits (no folder convention)', () => {
    for (const p of ['Foo.md', 'Tasks/Buy milk.md', 'Kanban/My Board/Spec.md', 'deep/a/b/c.md']) {
      expect(buildTextTileDefForNote({ vaultRelPath: p, existingTiles: [] }).def.filePath).toBe(p);
    }
  });

  it('normalises Windows separators and leading slashes in the stored path', () => {
    expect(
      buildTextTileDefForNote({ vaultRelPath: 'Notes\\Sub\\Foo.md', existingTiles: [] }).def.filePath,
    ).toBe('Notes/Sub/Foo.md');
    expect(
      buildTextTileDefForNote({ vaultRelPath: '/Notes/Foo.md', existingTiles: [] }).def.filePath,
    ).toBe('Notes/Foo.md');
  });

  it('mints a fresh tile id and timestamp when none are given', () => {
    const before = Date.now();
    const a = buildTextTileDefForNote({ vaultRelPath: 'A.md', existingTiles: [] }).def;
    const b = buildTextTileDefForNote({ vaultRelPath: 'A.md', existingTiles: [] }).def;
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBeGreaterThanOrEqual(before);
    expect(a.updatedAt).toBe(a.createdAt);
  });

  it('gives each def its own style object', () => {
    const a = buildTextTileDefForNote({ vaultRelPath: 'A.md', existingTiles: [] }).def;
    const b = buildTextTileDefForNote({ vaultRelPath: 'B.md', existingTiles: [] }).def;
    expect(a.style).not.toBe(b.style);
  });
});

describe('buildTextTileDefForNote — duplicate detection', () => {
  const drop = (existingTiles: ExistingTile[], vaultRelPath = 'Notes/Foo.md'): boolean =>
    buildTextTileDefForNote({ vaultRelPath, existingTiles }).duplicate;

  it('returns duplicate=false when no text tiles exist', () => {
    expect(drop([])).toBe(false);
  });

  it('detects a duplicate when a text tile already shows the same path', () => {
    expect(drop([{ type: 'text', filePath: 'Notes/Foo.md' }])).toBe(true);
  });

  it('is case-insensitive and separator-agnostic on the path comparison', () => {
    expect(drop([{ type: 'text', filePath: 'notes/foo.md' }])).toBe(true);
    expect(drop([{ type: 'text', filePath: 'Notes\\Foo.md' }])).toBe(true);
    expect(drop([{ type: 'text', filePath: 'Notes/Foo.md' }], '/Notes/Foo.md')).toBe(true);
  });

  it('does not flag a same-named note in another folder', () => {
    expect(drop([{ type: 'text', filePath: 'Foo.md' }])).toBe(false);
    expect(drop([{ type: 'text', filePath: 'Other/Foo.md' }])).toBe(false);
  });

  it('ignores non-text tiles pointing at the same path', () => {
    expect(
      drop([
        { type: 'image', filePath: 'Notes/Foo.md' },
        { type: 'file', filePath: 'Notes/Foo.md' },
      ]),
    ).toBe(false);
  });

  it('ignores text tiles that have no path yet', () => {
    expect(drop([{ type: 'text' }, { type: 'text', filePath: '' }])).toBe(false);
  });

  it('still builds a def for a duplicate drop (the caller decides what to surface)', () => {
    const r = buildTextTileDefForNote({
      vaultRelPath: 'Notes/Foo.md',
      existingTiles: [{ type: 'text', filePath: 'Notes/Foo.md' }],
      tileId: 'tile_dup',
    });
    expect(r.duplicate).toBe(true);
    expect(r.def.id).toBe('tile_dup');
    expect(r.def.filePath).toBe('Notes/Foo.md');
  });
});
