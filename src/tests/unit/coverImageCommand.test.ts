/**
 * Phase 5 / 5.4 — UpdateCoverImageCommand regression guard.
 *
 * Set cover → Ctrl+Z clears. Clear cover → Ctrl+Z restores. Before this
 * phase both paths called `setKanbanPlacementCoverImage` directly with no
 * history entry, so accidental clicks silently destroyed the prior choice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { UpdateCoverImageCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function installSilentBridge(): void {
  installFiloMock(() => null);
}

function makeKanban(coverImage?: string): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'col-1',
          title: 'A',
          position: 0,
          collapsed: false,
          tilePlacements: [
            coverImage
              ? { tileId: 't1', position: 0, coverImage }
              : { tileId: 't1', position: 0 },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        title: 'A',
        style: {} as never,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      } as unknown as BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

function getCover(boardId: string, tileId: string): string | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return null;
  const kb = cached.board as unknown as {
    columns: Array<{ tilePlacements?: Array<{ tileId: string; coverImage?: string }> }>;
  };
  for (const c of kb.columns ?? []) {
    const p = (c.tilePlacements ?? []).find((pl) => pl.tileId === tileId);
    if (p) return p.coverImage ?? null;
  }
  return null;
}

describe('UpdateCoverImageCommand', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('set cover then undo clears it', () => {
    const fixture = makeKanban();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });
    expect(getCover('kb', 't1')).toBeNull();

    const cmd = new UpdateCoverImageCommand('kb', 't1', null, 'attachments/hero.png');
    cmd.execute();
    expect(getCover('kb', 't1')).toBe('attachments/hero.png');

    cmd.undo();
    expect(getCover('kb', 't1')).toBeNull();
  });

  it('clear cover then undo restores it', () => {
    const fixture = makeKanban('attachments/hero.png');
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });
    expect(getCover('kb', 't1')).toBe('attachments/hero.png');

    const cmd = new UpdateCoverImageCommand('kb', 't1', 'attachments/hero.png', null);
    cmd.execute();
    expect(getCover('kb', 't1')).toBeNull();

    cmd.undo();
    expect(getCover('kb', 't1')).toBe('attachments/hero.png');
  });

  it('redo (execute again) re-applies the after value', () => {
    const fixture = makeKanban('attachments/old.png');
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new UpdateCoverImageCommand('kb', 't1', 'attachments/old.png', 'attachments/new.png');
    cmd.execute();
    expect(getCover('kb', 't1')).toBe('attachments/new.png');
    cmd.undo();
    expect(getCover('kb', 't1')).toBe('attachments/old.png');
    cmd.execute();
    expect(getCover('kb', 't1')).toBe('attachments/new.png');
  });

  it('description reflects the action (set vs clear)', () => {
    expect(new UpdateCoverImageCommand('kb', 't1', null, 'a.png').description).toBe('Set cover image');
    expect(new UpdateCoverImageCommand('kb', 't1', 'a.png', null).description).toBe('Clear cover image');
  });
});
