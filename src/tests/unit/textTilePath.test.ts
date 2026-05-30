import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveTextTileVaultPath,
  replaceTitleInVaultPath,
} from '@renderer/lib/boards/textTilePath';
import { documentStore } from '@renderer/stores/document.svelte';
import type { TextTile, Tile } from '@renderer/schema/index';

function tile(overrides: Partial<TextTile> & Pick<TextTile, 'id' | 'title'>): Tile {
  return {
    id: overrides.id,
    boardId: '',
    type: overrides.type ?? 'text',
    title: overrides.title,
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
    documentStore.unloadDocument('doc-B');
  });

  it('returns null for non-text tiles', () => {
    const t = tile({ id: 't1', title: 'X', type: 'link' } as never);
    expect(resolveTextTileVaultPath(t)).toBeNull();
  });

  it('priority 1: explicit filePath wins over title and docState', () => {
    documentStore.loadDocument({
      docId: 'doc-A', filename: 'FromDoc.md', title: 'X',
      body: '', htmlContent: '', richText: [],
    });
    const t = tile({ id: 't1', title: 'X', contentId: 'doc-A', filePath: 'Sub/Explicit.md' } as never);
    expect(resolveTextTileVaultPath(t)).toBe('Sub/Explicit.md');
  });

  it('priority 2: docState.filename wins over title convention', () => {
    documentStore.loadDocument({
      docId: 'doc-A', filename: 'Notes/Real.md', title: 'X',
      body: '', htmlContent: '', richText: [],
    });
    const t = tile({ id: 't1', title: 'X', contentId: 'doc-A' });
    expect(resolveTextTileVaultPath(t)).toBe('Notes/Real.md');
  });

  it('priority 3: convention fallback when no filePath / docState', () => {
    const t = tile({ id: 't1', title: 'Hello' });
    expect(resolveTextTileVaultPath(t)).toBe('Hello.md');
  });

  it('convention uses Untitled when title is empty', () => {
    const t = tile({ id: 't1', title: '' });
    expect(resolveTextTileVaultPath(t)).toBe('Untitled.md');
  });
});

describe('textTilePath.replaceTitleInVaultPath', () => {
  it('replaces basename at root', () => {
    expect(replaceTitleInVaultPath('Old.md', 'New')).toBe('New.md');
  });

  it('preserves the folder portion', () => {
    expect(replaceTitleInVaultPath('Notes/Sub/Old.md', 'New')).toBe('Notes/Sub/New.md');
  });

  it('normalises Windows separators', () => {
    expect(replaceTitleInVaultPath('Notes\\Sub\\Old.md', 'New')).toBe('Notes/Sub/New.md');
  });

  it('strips leading slashes', () => {
    expect(replaceTitleInVaultPath('/Notes/Old.md', 'New')).toBe('Notes/New.md');
  });
});
