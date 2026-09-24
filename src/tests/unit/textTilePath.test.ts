import { describe, it, expect, afterEach } from 'vitest';
import { resolveTextTileVaultPath } from '@renderer/lib/boards/textTilePath';
import { documentStore } from '@renderer/stores/document.svelte';
import type { TextTile, Tile } from '@renderer/schema/index';

function tile(overrides: Partial<TextTile> & Pick<TextTile, 'id'>): Tile {
  return {
    boardId: '',
    type: overrides.type ?? 'text',
    title: '',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {} as never,
    tags: [],
    locked: false,
    faded: false,
    contentId: overrides.contentId,
    content: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Tile;
}

describe('textTilePath.resolveTextTileVaultPath', () => {
  afterEach(() => {
    // documentStore is module-singleton — drop any docs we loaded so cases
    // don't bleed into each other.
    documentStore.unloadDocument('doc-A');
  });

  it('returns null for non-text tiles', () => {
    const t = tile({ id: 't1', title: 'X', type: 'link' } as never);
    expect(resolveTextTileVaultPath(t)).toBeNull();
  });

  it('returns the filePath, even when an open doc names a different file', () => {
    documentStore.loadDocument({
      docId: 'doc-A', filename: 'FromDoc.md', title: 'X',
      body: '', htmlContent: '', richText: [],
    });
    const t = tile({ id: 't1', title: 'X', contentId: 'doc-A', filePath: 'Sub/Explicit.md' } as never);
    expect(resolveTextTileVaultPath(t)).toBe('Sub/Explicit.md');
  });

  // The path is the note's only identity: no title-derived guess exists, so
  // an unplaced tile has no path rather than a wrong one.
  it('returns null for a text tile without a filePath, whatever its title or doc', () => {
    documentStore.loadDocument({
      docId: 'doc-A', filename: 'Notes/Real.md', title: 'Hello',
      body: '', htmlContent: '', richText: [],
    });
    expect(resolveTextTileVaultPath(tile({ id: 't1', title: 'Hello', contentId: 'doc-A' }))).toBeNull();
    expect(resolveTextTileVaultPath(tile({ id: 't2', title: '' }))).toBeNull();
  });

  it('returns null for an empty filePath', () => {
    const t = tile({ id: 't1', title: 'Hello', filePath: '' } as never);
    expect(resolveTextTileVaultPath(t)).toBeNull();
  });
});
