import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';

/**
 * Audit2 5.3 — the live-event reconciler is now also invoked at vault open.
 *
 * Before the fix, `reconcileBoardCacheWithFrontmatter` only ran when the file
 * watcher / external-change pipeline fired for a specific .md path. Any
 * drift between `.board.json` (cached completed / priority / date) and the
 * canonical `.md` frontmatter that landed BETWEEN sessions (a `git pull`, an
 * Obsidian edit, a manual file-system tweak) stayed in the cache until
 * something happened to touch the file again. Renders aren't visibly broken
 * (they read frontmatter), but the on-disk cache stays stale and any
 * downstream consumer that DOES read the cache sees out-of-date values.
 *
 * The fix iterates `vaultIndexStore.allMetadata()` after index rebuild in
 * `runPostCommitTasks` (vault.svelte.ts) and calls
 * `boardCacheStore.applyFrontmatterToBackedTiles(path, metadata)` for each.
 * This file exercises that loop body in isolation: a stale cache + fresh
 * frontmatter metadata reconciles correctly when the loop runs.
 */

function taskTile(overrides: Partial<TileDefinition> & Record<string, unknown> = {}): TileDefinition {
  const base: TileDefinition = {
    id: 't1',
    type: 'text',
    title: 'Ship the thing',
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    file: 'Ship the thing.md',
  } as TileDefinition;
  return { ...base, ...overrides } as TileDefinition;
}

function kanbanBoardWith(tile: TileDefinition): V7BoardFileData {
  return {
    board: {
      id: 'b1',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId: tile.id }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { [tile.id]: tile },
    connections: {},
    frames: [],
  };
}

describe('boardCacheStore — on-load reconciliation pass (5.3)', () => {
  beforeEach(() => {
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
  });

  it('updates cached tile fields when canonical frontmatter diverges (priority/completed)', () => {
    // Cache holds stale values (priority='low', completed=false) — what was
    // saved to .board.json the LAST time Filo wrote.
    const stale = taskTile({});
    (stale as Record<string, unknown>).priority = 'low';
    (stale as Record<string, unknown>).completed = false;
    boardCacheStore.hydrate({ b1: kanbanBoardWith(stale) }, { b1: 'tasks.board.json' });

    // The .md was edited externally between sessions — frontmatter now says
    // priority='high', completed=true.
    const md = parseMarkdown(
      'Ship the thing.md',
      '---\npriority: high\ncompleted: true\n---\n# Ship the thing',
    );

    // Loop body from runPostCommitTasks: for each indexed metadata, reconcile
    // the cache against the canonical frontmatter.
    const changed = boardCacheStore.applyFrontmatterToBackedTiles(md.path, md);

    expect(changed).toEqual(['b1']);
    const patched = boardCacheStore.cache.b1.tileDefs.t1 as Record<string, unknown>;
    expect(patched.priority).toBe('high');
    expect(patched.completed).toBe(true);
  });

  it('iterates a multi-file index and reconciles each backed tile', () => {
    const t1 = taskTile({ id: 't1', file: 'A.md' });
    const t2 = taskTile({ id: 't2', file: 'B.md', title: 'B Task' });
    (t1 as Record<string, unknown>).status = 'todo';
    (t2 as Record<string, unknown>).status = 'todo';
    boardCacheStore.hydrate(
      {
        b1: {
          ...kanbanBoardWith(t1),
          tileDefs: { t1, t2 },
          board: {
            ...kanbanBoardWith(t1).board,
            columns: [
              {
                id: 'c1',
                title: 'To Do',
                position: 0,
                collapsed: false,
                tilePlacements: [{ tileId: 't1' }, { tileId: 't2' }],
              },
            ],
          } as unknown as KanbanBoard,
        },
      },
      { b1: 'tasks.board.json' },
    );

    // Both files were externally bumped to status='done'.
    const aMeta = parseMarkdown('A.md', '---\nstatus: done\n---\n# A');
    const bMeta = parseMarkdown('B.md', '---\nstatus: done\n---\n# B');

    // Simulate the loop from runPostCommitTasks.
    for (const md of [aMeta, bMeta]) {
      boardCacheStore.applyFrontmatterToBackedTiles(md.path, md);
    }

    const patched1 = boardCacheStore.cache.b1.tileDefs.t1 as Record<string, unknown>;
    const patched2 = boardCacheStore.cache.b1.tileDefs.t2 as Record<string, unknown>;
    expect(patched1.status).toBe('done');
    expect(patched2.status).toBe('done');
  });

  it('is a no-op when cache already matches frontmatter (idempotent)', () => {
    const t = taskTile({});
    (t as Record<string, unknown>).priority = 'high';
    boardCacheStore.hydrate({ b1: kanbanBoardWith(t) }, { b1: 'tasks.board.json' });

    const md = parseMarkdown(
      'Ship the thing.md',
      '---\npriority: high\n---\n# Ship the thing',
    );

    const changed = boardCacheStore.applyFrontmatterToBackedTiles(md.path, md);
    expect(changed).toEqual([]);
  });
});
