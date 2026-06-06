/**
 * Audit-12 H2 — the single-tag add/remove path must resolve a text tile's backing
 * `.md` through the canonical `resolveTextTileVaultPath` (filePath → docState →
 * folder cascade), NOT the deleted local helper whose fallback ended at
 * `${title}.md` at the vault ROOT.
 *
 * The bug: on a cold-loaded subfolder text tile / Task row (no docState, and —
 * per H1 — possibly no `filePath`), the old helper wrote the tag and the
 * `.filo/tags.json` key to a ROOT file, corrupting an unrelated same-named root
 * note or creating a ghost.
 *
 * These tests drive `fileTagsStore.addTagToTile` for a cold tile (not on the
 * active board, no docState) and assert BOTH the synchronous `tags.json` key AND
 * the fire-and-forget `.md` write land in the subfolder. Bite-verify: restore the
 * old root-fallback helper → the key/path collapse to `a.md` / `A.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { cancelAllPendingWrites, __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { TaskListBoard as TaskListBoardType } from '@renderer/schema/index';

function emptyTagsFile(): string {
  return JSON.stringify({ version: 1, tags: {}, fileTags: {} });
}

async function drainFireAndForget(): Promise<void> {
  // writeTagChangeToTileMarkdown is fire-and-forget — let the read +
  // serialized write + reconcile chain settle.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('Audit-12 H2 — fileTags tag write honors subfolders', () => {
  let mdWrites: string[];

  beforeEach(async () => {
    mdWrites = [];
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    fileTagsStore.reset();

    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return emptyTagsFile();
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 1, size: 20 };
      }
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        mdWrites.push(String(args[1]));
        return { success: true };
      }
      if (channel === 'vault:file-exists') return true;
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 20 };
      return { success: true };
    });
    vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    await fileTagsStore.hydrate('/vault');
  });

  afterEach(() => {
    cancelAllPendingWrites();
    vi.restoreAllMocks();
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  function hydrateColdTextTile(opts: { folder?: string; filePath?: string }): void {
    const tileDef: Record<string, unknown> = {
      id: 't1',
      type: 'text',
      title: 'A',
      boardId: 'k1',
      contentId: 'c1',
      style: {},
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };
    if (opts.filePath) tileDef.filePath = opts.filePath;
    boardCacheStore.hydrate(
      {
        k1: {
          board: {
            id: 'k1',
            type: 'tasklist',
            name: 'T',
            emoji: '',
            createdAt: 0,
            updatedAt: 0,
            settings: opts.folder ? { defaultFolder: opts.folder } : {},
            sections: [],
            tasks: [],
          } as unknown as TaskListBoardType,
          tileDefs: { t1: tileDef as never },
          connections: {},
          frames: [],
        },
      },
      { k1: 'T.board.json' },
    );
  }

  it('no filePath + a board content-folder → resolves the tag write to the subfolder (NOT root)', async () => {
    hydrateColdTextTile({ folder: 'Notes' });
    // Cold: not on the active board, no live docState.
    expect(boardStore.getTile('t1')).toBeUndefined();
    expect(documentStore.getDocument('c1')).toBeUndefined();

    fileTagsStore.addTagToTile('t1', 'newtag');

    // tags.json key (synchronous) — subfolder, NOT root. Keys are canonical lowercase.
    expect(fileTagsStore.file.fileTags['notes/a.md']).toContain('newtag');
    expect(fileTagsStore.file.fileTags['a.md']).toBeUndefined();

    // Fire-and-forget .md write targets the subfolder file (case preserved).
    await drainFireAndForget();
    expect(mdWrites).toContain('Notes/A.md');
    expect(mdWrites).not.toContain('A.md');
  });

  it('explicit subfolder filePath → resolves the tag write to that path', async () => {
    hydrateColdTextTile({ filePath: 'Sub/B.md' });

    fileTagsStore.addTagToTile('t1', 'newtag');

    expect(fileTagsStore.file.fileTags['sub/b.md']).toContain('newtag');
    await drainFireAndForget();
    expect(mdWrites).toContain('Sub/B.md');
  });
});
