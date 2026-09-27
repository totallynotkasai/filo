import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { parseQuery } from '@renderer/lib/search/queryParser';
import { runVaultSearch } from '@renderer/lib/search/runSearch';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMap(name: string, id: string, tileDefs: Record<string, unknown> = {}): BoardFileData {
  return {
    board: {
      id,
      name,
      type: 'mindmap',
      placements: {},
      inlineTiles: {},
      waypoints: [],
      settings: {},
      createdAt: 0,
      updatedAt: 0,
    } as never,
    tileDefs: tileDefs as never,
    connections: {},
    frames: [],
  } as BoardFileData;
}

function makeTextDef(id: string, title: string, filePath?: string): Record<string, unknown> {
  return {
    id,
    type: 'text',
    title,
    titleHtml: undefined,
    style: { headerColor: '', bodyColor: '' },
    tags: [],
    filePath,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeImageDef(id: string, title: string, src = 'image.png'): Record<string, unknown> {
  return {
    id,
    type: 'image',
    title,
    titleHtml: undefined,
    style: { headerColor: '', bodyColor: '' },
    tags: [],
    src,
    alt: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function seedVaultStub(project: { id: string; name: string; boards: Array<{ id: string; name: string }> }): void {
  // vaultStore is a real store; we can't easily mock its getters. Use the
  // public setter API. For tests, project is bootstrapped via the IPC
  // path, but here we just need vaultStore.project to return our fixture.
  // The simplest path is to set `vaultStore.bootstrapProject` if it
  // exists; otherwise we'll do a direct field write via Object.defineProperty.
  Object.defineProperty(vaultStore, 'project', {
    configurable: true,
    get: () => project,
  });
}

const FIXTURE_PROJECT = {
  id: 'p',
  name: 'Test Vault',
  boards: [
    { id: 'mm', name: 'Mind Map A' },
    { id: 'mm2', name: 'Mind Map B' },
  ],
};

beforeEach(() => {
  installFiloStub();
  vaultIndexStore.clear();
  boardCacheStore.clear();
  seedVaultStub(FIXTURE_PROJECT);
});

afterEach(() => {
  // Restore the original prototype-defined getter so other suites that
  // touch vaultStore.project (e.g. through openVault) aren't poisoned.
  delete (vaultStore as unknown as Record<string, unknown>).project;
});

describe('runVaultSearch — operator filtering', () => {
  it('returns no matches for an empty query', () => {
    const result = runVaultSearch(parseQuery(''));
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('finds free-text matches in text-tile body content', () => {
    vaultIndexStore.restoreMetadata(
      'a.md',
      parseMarkdown('a.md', '# Title\nSome body text mentioning frodo and bilbo.'),
    );
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'A', 'a.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('frodo'));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchKind).toBe('body');
    expect(result.matches[0].matchText.toLowerCase()).toBe('frodo');
    expect(result.matches[0].filePath).toBe('a.md');
  });

  it('also finds a note on no board, after the boards, with no tile to jump to', () => {
    vaultIndexStore.restoreMetadata('placed.md', parseMarkdown('placed.md', 'frodo here'));
    vaultIndexStore.restoreMetadata('loose.md', parseMarkdown('loose.md', '---\ntitle: Loose\n---\nfrodo there'));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Mind Map A', 'mm', { t1: makeTextDef('t1', 'A', 'placed.md') }) },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('frodo'));
    expect(result.matches.map((m) => m.filePath)).toEqual(['placed.md', 'loose.md']);
    const loose = result.matches[1];
    expect(loose.tileId).toBe('');
    expect(loose.boardId).toBe('');
    expect(loose.tileTitle).toBe('Loose');
    expect(loose.matchKind).toBe('body');
  });

  it('a note placed on a board is not listed a second time as a loose note', () => {
    vaultIndexStore.restoreMetadata('Placed.md', parseMarkdown('Placed.md', 'frodo'));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Mind Map A', 'mm', { t1: makeTextDef('t1', 'A', 'placed.md') }) },
      { mm: 'a.board.json' },
    );
    expect(runVaultSearch(parseQuery('frodo')).matches).toHaveLength(1);
  });

  it('board: and type: filters leave loose notes out or in as they should', () => {
    vaultIndexStore.restoreMetadata('loose.md', parseMarkdown('loose.md', 'frodo'));
    expect(runVaultSearch(parseQuery('frodo board:"Mind Map A"')).matches).toHaveLength(0);
    expect(runVaultSearch(parseQuery('frodo type:text')).matches).toHaveLength(1);
  });

  it('finds matches in tile titles even when there is no body hit', () => {
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeImageDef('t1', 'Castle Photo'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('Castle'));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchKind).toBe('title');
    expect(result.matches[0].tileTitle).toBe('Castle Photo');
  });

  it('filters by tag using frontmatter tags from the vault index', () => {
    vaultIndexStore.restoreMetadata(
      'a.md',
      parseMarkdown('a.md', '---\ntags: [urgent]\n---\n# A\nfrodo'),
    );
    vaultIndexStore.restoreMetadata(
      'b.md',
      parseMarkdown('b.md', '---\ntags: [chill]\n---\n# B\nfrodo'),
    );
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'A', 'a.md'),
          t2: makeTextDef('t2', 'B', 'b.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('frodo tag:#urgent'));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].filePath).toBe('a.md');
  });

  it('filters by board name', () => {
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', 'frodo'));
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', 'frodo'));
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'A', 'a.md'),
        }),
        mm2: makeMindMap('Mind Map B', 'mm2', {
          t2: makeTextDef('t2', 'B', 'b.md'),
        }),
      },
      { mm: 'a.board.json', mm2: 'b.board.json' },
    );

    const result = runVaultSearch(parseQuery('frodo board:"Mind Map A"'));
    expect(result.matches.every((m) => m.boardId === 'mm')).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  it('filters by tile type', () => {
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeImageDef('t1', 'A picture'),
          t2: makeTextDef('t2', 'A document'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('type:image A'));
    // Only the image tile title contains "A" and survives the type filter.
    expect(result.matches.every((m) => m.tileType === 'image')).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('filters by property=value from frontmatter', () => {
    vaultIndexStore.restoreMetadata(
      'a.md',
      parseMarkdown('a.md', '---\nstatus: active\n---\nfrodo'),
    );
    vaultIndexStore.restoreMetadata(
      'b.md',
      parseMarkdown('b.md', '---\nstatus: archived\n---\nfrodo'),
    );
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'A', 'a.md'),
          t2: makeTextDef('t2', 'B', 'b.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('frodo property:status=active'));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].filePath).toBe('a.md');
  });

  it('filters by has:connections', () => {
    boardCacheStore.hydrate(
      {
        mm: {
          ...makeMindMap('Mind Map A', 'mm', {
            t1: makeImageDef('t1', 'Connected tile'),
            t2: makeImageDef('t2', 'Lonely tile'),
          }),
          connections: {
            c1: {
              id: 'c1',
              boardId: 'mm',
              fromTileId: 't1',
              toTileId: 't2',
              fromBubbleIndex: 0,
              toBubbleIndex: 0,
            } as never,
          },
        } as BoardFileData,
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('tile has:connections'));
    // Both tiles have the connection, but only those whose title contains
    // "tile" match the free text.
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.tileId === 't1' || m.tileId === 't2')).toBe(true);
  });

  it('supports regex queries', () => {
    vaultIndexStore.restoreMetadata(
      'a.md',
      parseMarkdown('a.md', '# A\nfoo1 foo22 foo333'),
    );
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'A', 'a.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    const result = runVaultSearch(parseQuery('/foo\\d+/'));
    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((m) => m.matchText).sort()).toEqual(['foo1', 'foo22', 'foo333']);
  });

  it('orders matches by board name then tile title', () => {
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', 'needle'));
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', 'needle'));
    boardCacheStore.hydrate(
      {
        mm2: makeMindMap('Mind Map B', 'mm2', {
          z: makeTextDef('z', 'Zeppelin', 'b.md'),
        }),
        mm: makeMindMap('Mind Map A', 'mm', {
          a: makeTextDef('a', 'Apple', 'a.md'),
        }),
      },
      { mm: 'a.board.json', mm2: 'b.board.json' },
    );

    const result = runVaultSearch(parseQuery('needle'));
    expect(result.matches.map((m) => m.boardName)).toEqual(['Mind Map A', 'Mind Map B']);
  });

  it('dedupes body matches when a single .md appears on multiple boards', () => {
    vaultIndexStore.restoreMetadata('shared.md', parseMarkdown('shared.md', 'needle'));
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Mind Map A', 'mm', {
          t1: makeTextDef('t1', 'On A', 'shared.md'),
        }),
        mm2: makeMindMap('Mind Map B', 'mm2', {
          t2: makeTextDef('t2', 'On B', 'shared.md'),
        }),
      },
      { mm: 'a.board.json', mm2: 'b.board.json' },
    );

    const result = runVaultSearch(parseQuery('needle'));
    // The shared body should contribute one body match — under whichever
    // tile appears first in the ordering — even though two tiles back the
    // same file.
    const bodyMatches = result.matches.filter((m) => m.matchKind === 'body');
    expect(bodyMatches).toHaveLength(1);
  });
});
