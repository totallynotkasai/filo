import { describe, it, expect } from 'vitest';
import { buildTextTileDefFromMarkdownFile } from '@renderer/lib/canvas/markdownTileSeed';

describe('buildTextTileDefFromMarkdownFile', () => {
  it('produces a text-tile def from an empty markdown file', () => {
    const { def, duplicate, tagFileKey } = buildTextTileDefFromMarkdownFile({
      rawContent: '',
      vaultRelPath: 'Notes.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_test_1',
      now: 1_000,
    });

    expect(def.id).toBe('tile_test_1');
    expect(def.type).toBe('text');
    expect(def.title).toBe('Notes');
    expect(def.tags).toEqual([]);
    expect((def as { contentId?: string }).contentId).toBeTruthy();
    expect((def as { content?: string }).content).toBe('');
    // Convention path for a mindmap drop at the vault root is `${title}.md`,
    // which matches the dropped path — so no explicit filePath is stamped.
    expect((def as { filePath?: string }).filePath).toBeUndefined();
    expect(duplicate).toBe(false);
    expect(tagFileKey).toBe('Notes.md');
  });

  it('reuses the frontmatter docId so re-drops share editor state', () => {
    const raw = '---\nid: doc_shared\n---\nhello world';
    const { def } = buildTextTileDefFromMarkdownFile({
      rawContent: raw,
      vaultRelPath: 'Notes.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_reuse',
      now: 2_000,
    });

    expect((def as { contentId?: string }).contentId).toBe('doc_shared');
    expect((def as { content?: string }).content).toBe('hello world');
  });

  it('extracts frontmatter tags onto the def and exposes the tagFileKey', () => {
    const raw = '---\nid: doc_a\ntags: [alpha, beta]\n---\nbody';
    const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
      rawContent: raw,
      vaultRelPath: 'Notes.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_tagged',
      now: 3_000,
    });

    expect(def.tags).toEqual(['alpha', 'beta']);
    // No explicit filePath needed (drop is at the convention path), so the
    // tagFileKey falls back to `${title}.md`.
    expect(tagFileKey).toBe('Notes.md');
  });

  it('stamps an explicit filePath when the drop sits outside the convention path', () => {
    // Mind Map's convention folder is the vault root, so `${title}.md` is
    // expected. A subfolder drop diverges and must be stamped.
    const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
      rawContent: '---\ntags: [x]\n---\nbody',
      vaultRelPath: 'Inbox/Foo.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_nonconv',
      now: 4_000,
    });

    expect(def.title).toBe('Foo');
    expect((def as { filePath?: string }).filePath).toBe('Inbox/Foo.md');
    expect(tagFileKey).toBe('Inbox/Foo.md');
  });

  it('flags duplicate when another text tile on the board already points at the file', () => {
    const { duplicate } = buildTextTileDefFromMarkdownFile({
      rawContent: '',
      vaultRelPath: 'Notes/Project.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [
        { type: 'text', title: 'Project', filePath: 'Notes/Project.md' },
      ],
      tileId: 'tile_dup',
      now: 5_000,
    });

    expect(duplicate).toBe(true);
  });

  it('does not flag duplicate against non-text tiles', () => {
    const { duplicate } = buildTextTileDefFromMarkdownFile({
      rawContent: '',
      vaultRelPath: 'Notes/Project.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [
        { type: 'image', title: 'Project', filePath: 'Notes/Project.md' },
      ],
      tileId: 'tile_nondup',
      now: 6_000,
    });

    expect(duplicate).toBe(false);
  });

  it('mints a fresh contentId when the file has no docId frontmatter', () => {
    const a = buildTextTileDefFromMarkdownFile({
      rawContent: 'no frontmatter here',
      vaultRelPath: 'A.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_a',
      now: 7_000,
    });
    const b = buildTextTileDefFromMarkdownFile({
      rawContent: 'different file',
      vaultRelPath: 'B.md',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [],
      tileId: 'tile_b',
      now: 7_001,
    });

    const aId = (a.def as { contentId?: string }).contentId;
    const bId = (b.def as { contentId?: string }).contentId;
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId);
  });
});
