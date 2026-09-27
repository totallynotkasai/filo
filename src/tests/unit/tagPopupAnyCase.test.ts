import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * The Tags Browser counts every spelling of a tag (`Project`, `project`) as
 * one tag, so the popup it opens lists the tiles and files of every spelling
 * too, not only the exact one.
 */

beforeEach(() => {
  (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
  vaultStore.setPath('/vault');
  vaultIndexStore.clear();
  boardCacheStore.clear();
});
afterEach(() => {
  vaultStore.setPath('');
  vaultIndexStore.clear();
  boardCacheStore.clear();
});

describe('the tag popup lists every spelling', () => {
  it('tiles and notes tagged Project show up for project', () => {
    const board: BoardFileData = {
      board: {
        id: 'mm', type: 'mindmap', name: 'M', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
        placements: { l1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
        inlineTiles: {
          l1: { id: 'l1', type: 'link', title: 'Site', url: 'https://example.com', tags: ['Project'], style: {}, createdAt: 0, updatedAt: 0 },
        },
        waypoints: [],
      } as unknown as MindMapBoard,
      tileDefs: {},
      connections: {},
      frames: [],
    };
    boardCacheStore.hydrate({ mm: board }, { mm: 'm.board.json' });
    vaultIndexStore.restoreMetadata('Plan.md', parseMarkdown('Plan.md', '---\ntags: [PROJECT]\n---\nBody'));

    expect(fileTagsStore.getTilesWithTag('project').map((t) => t.id)).toEqual(['l1']);
    expect(fileTagsStore.getFilesWithTag('project').map((f) => f.path)).toEqual(['Plan.md']);
  });

  it('the list a delete acts on stays exact', () => {
    vaultIndexStore.restoreMetadata('Plan.md', parseMarkdown('Plan.md', '---\ntags: [PROJECT]\n---\nBody'));
    expect(fileTagsStore.filesForTag('project')).toEqual([]);
    expect(fileTagsStore.filesForTag('project', true)).toEqual(['Plan.md']);
  });
});
