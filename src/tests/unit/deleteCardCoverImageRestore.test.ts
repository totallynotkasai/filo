/**
 * 6.4.M11 — DeleteCardCommand must restore a card's coverImage faithfully.
 *
 * Pre-fix, undo() restored the placement via persistAddKanbanPlacement (which
 * carried no coverImage) and then issued a SEPARATE setKanbanPlacementCoverImage
 * write. That setter sanitizes the path and silently drops anything it deems
 * unsafe (absolute / traversal / scheme). A coverImage that reached the cache
 * via a hand-edited or older-version .board.json (which hydrate does not
 * sanitize) therefore vanished on delete→undo — undo wasn't faithful.
 *
 * The fix restores the trusted snapshot value atomically as part of the
 * placement add. Undo is not an input boundary; it returns the card to its
 * exact pre-delete state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { DeleteCardCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function makeKanban(coverImage: string): V7BoardFileData {
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
          title: 'Todo',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId: 't1', position: 0, coverImage }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'Card A.md',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as V7BoardFileData['tileDefs'][string],
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

describe('DeleteCardCommand — faithful coverImage restore (6.4.M11)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    historyStore.clear();
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    historyStore.clear();
  });

  it('restores a normal vault-relative coverImage on undo', () => {
    boardCacheStore.hydrate({ kb: makeKanban('attachments/hero.png') }, { kb: 'k.board.json' });
    expect(getCover('kb', 't1')).toBe('attachments/hero.png');

    const cmd = new DeleteCardCommand('kb', 't1');
    cmd.execute();
    expect(getCover('kb', 't1')).toBeNull();

    cmd.undo();
    expect(getCover('kb', 't1')).toBe('attachments/hero.png');
  });

  it('restores a coverImage the setter sanitizer would reject (no silent loss)', () => {
    // A leading-slash path reaches the cache via an unsanitized hydrate (e.g. a
    // hand-edited / older-version .board.json). setKanbanPlacementCoverImage
    // rejects it as "absolute", so the pre-fix separate-write undo dropped it.
    const cover = '/legacy/hero.png';
    boardCacheStore.hydrate({ kb: makeKanban(cover) }, { kb: 'k.board.json' });
    expect(getCover('kb', 't1')).toBe(cover);

    const cmd = new DeleteCardCommand('kb', 't1');
    cmd.execute();
    cmd.undo();

    // Undo must faithfully restore the pre-delete state.
    expect(getCover('kb', 't1')).toBe(cover);
  });
});
